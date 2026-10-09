package backup

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"math"
	"os"
	"path/filepath"

	"xdrive/internal/config"
	"xdrive/internal/db"
	"xdrive/internal/storage"
)

// Restore validates the completed backup before writing to an empty target.
// This version requires the configured database, object storage and secret to
// share one data root so the prepared tree can be activated by one rename.
func Restore(ctx context.Context, settings config.Config, source string) (err error) {
	return RestoreGeneration(ctx, settings, source, "")
}

// RestoreGeneration restores the requested generation into an empty target.
// An empty generation selects CURRENT and an explicit ID does not change it.
func RestoreGeneration(ctx context.Context, settings config.Config, source, generation string) (err error) {
	return restoreGeneration(ctx, settings, source, generation, true)
}

// RestoreGenerationStaged copies and resets recovery-sensitive state without
// applying database migrations. It is intended for an isolated target that
// will be checked by the exact release selected to use the restored data.
func RestoreGenerationStaged(ctx context.Context, settings config.Config, source, generation string) (err error) {
	return restoreGeneration(ctx, settings, source, generation, false)
}

func restoreGeneration(ctx context.Context, settings config.Config, source, generation string, applyMigrations bool) (err error) {
	lease, err := storage.AcquireDeletionLease(ctx, source)
	if err != nil {
		return err
	}
	defer lease.Close()
	selected, err := resolveGeneration(source, generation)
	if err != nil {
		return err
	}
	header, manifest, snapshotPath, err := inspectGeneration(ctx, source, selected, true)
	if err != nil {
		return fmt.Errorf("refuse invalid backup: %w", err)
	}
	dataRoot, relativeDB, relativeStorage, relativeSecret, err := restoreTargetLayout(settings)
	if err != nil {
		return err
	}
	parent := filepath.Dir(dataRoot)
	targetName := filepath.Base(dataRoot)
	parentFD, err := openRestoreParent(parent, true)
	if err != nil {
		return fmt.Errorf("restore target parent must be a real directory path: %w", err)
	}
	parentHandle := os.NewFile(uintptr(parentFD), parent)
	defer parentHandle.Close()
	if err := requireEmptyDataRootAt(parentFD, targetName); err != nil {
		return err
	}
	stageName, ownedStage, err := createRestoreStage(parentFD)
	if err != nil {
		return err
	}
	defer ownedStage.Close()
	activated := false
	defer func() {
		if !activated {
			err = errors.Join(err, cleanupRestoreStage(ownedStage, parentFD, stageName), parentHandle.Sync())
		}
	}()
	if err := verifyRestoreStageIdentity(ownedStage, parentFD, stageName); err != nil {
		return err
	}
	// An empty backup has no object files to create this directory as a side
	// effect of copyRestoredObject. Keep the restored data-root layout complete
	// so staged recovery can pass doctor before the service is started.
	if err := ownedStage.MkdirAll(relativeStorage, 0o700); err != nil {
		return fmt.Errorf("create restored object storage: %w", err)
	}
	validateStage := func() error { return validatePreparedRestore(parent, stageName, parentFD, ownedStage) }
	for _, item := range manifest.Objects {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := validateStage(); err != nil {
			return err
		}
		if err := copyRestoredObject(ctx, filepath.Join(source, "objects"), ownedStage, relativeStorage, item); err != nil {
			return fmt.Errorf("copy verified restore object: %w", err)
		}
	}
	if err := validateStage(); err != nil {
		return err
	}
	snapshotIdentity, err := copyRestoredSnapshotWithIdentity(ctx, snapshotPath, ownedStage, relativeDB, header.SnapshotSHA256)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, snapshotIdentity.guard.Close()) }()
	if err := prepareRestoredDatabase(ctx, ownedStage, relativeDB, snapshotIdentity.info, header.CreatedAt, settings, applyMigrations); err != nil {
		return err
	}
	if err := validateStage(); err != nil {
		return err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return err
	}
	defer clear(secret)
	if err := writeRestoredSecret(ownedStage, relativeSecret, secret); err != nil {
		return err
	}
	if err := syncRestoreTree(ctx, ownedStage); err != nil {
		return err
	}
	if err := validateStage(); err != nil {
		return err
	}
	if err := verifyRestoredDatabaseIdentity(ctx, ownedStage, relativeDB, snapshotIdentity.info); err != nil {
		return err
	}
	// The destination was checked before staging; check again before activation
	// to avoid replacing a service that appeared during validation/copying.
	if err := requireEmptyDataRootAt(parentFD, targetName); err != nil {
		return err
	}
	var targetStat unix.Stat_t
	if err := unix.Fstatat(parentFD, targetName, &targetStat, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		if targetStat.Mode&unix.S_IFMT != unix.S_IFDIR {
			return errors.New("restore activation target is not a directory")
		}
		if err := unix.Unlinkat(parentFD, targetName, unix.AT_REMOVEDIR); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := validateStage(); err != nil {
		return err
	}
	if err := renameRestoreExclusive(parentFD, stageName, targetName); err != nil {
		_ = unix.Mkdirat(parentFD, targetName, 0o700)
		return err
	}
	activated = true
	return parentHandle.Sync()
}

func restoreTargetLayout(settings config.Config) (root, relativeDB, relativeStorage, relativeSecret string, err error) {
	databasePath, err := filepath.Abs(settings.DatabasePath)
	if err != nil {
		return "", "", "", "", err
	}
	storagePath, err := filepath.Abs(settings.StoragePath)
	if err != nil {
		return "", "", "", "", err
	}
	secretPath, err := filepath.Abs(settings.SecretPath)
	if err != nil {
		return "", "", "", "", err
	}
	root = filepath.Dir(databasePath)
	if relativeDB, err = filepath.Rel(root, databasePath); err != nil {
		return "", "", "", "", err
	}
	if relativeStorage, err = filepath.Rel(root, storagePath); err != nil {
		return "", "", "", "", err
	}
	if relativeSecret, err = filepath.Rel(root, secretPath); err != nil {
		return "", "", "", "", err
	}
	for _, relative := range []string{relativeDB, relativeStorage, relativeSecret} {
		if relative == "." || filepath.IsAbs(relative) || relative == ".." || len(relative) >= 3 && relative[:3] == ".."+string(os.PathSeparator) {
			return "", "", "", "", errors.New("restore requires database, object storage and secret under one empty data directory")
		}
	}
	if relativeDB == relativeSecret || relativeDB == relativeStorage || relativeSecret == relativeStorage || within(filepath.Join(root, relativeDB), filepath.Join(root, relativeStorage)) || within(filepath.Join(root, relativeSecret), filepath.Join(root, relativeStorage)) {
		return "", "", "", "", errors.New("restore data paths overlap")
	}
	return root, relativeDB, relativeStorage, relativeSecret, nil
}

func requireEmptyDataRoot(root string) error {
	cleaned := filepath.Clean(root)
	parentFD, err := openRestoreParent(filepath.Dir(cleaned), false)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return err
	}
	defer unix.Close(parentFD)
	return requireEmptyDataRootAt(parentFD, filepath.Base(cleaned))
}

func requireEmptyDataRootAt(parentFD int, name string) error {
	fd, err := unix.Openat(parentFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(fd), name)
	defer directory.Close()
	entries, err := directory.ReadDir(1)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if len(entries) != 0 {
		return errors.New("restore target data directory must be empty")
	}
	return nil
}

func copyVerifiedSnapshot(ctx context.Context, source, destination, expectedDigest string) error {
	return copySnapshotWithOutput(ctx, source, expectedDigest, func() (*os.File, error) {
		return os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	})
}

func copySnapshotWithOutput(ctx context.Context, source, expectedDigest string, openOutput func() (*os.File, error)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	input, err := openBackupRegular(source)
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if info.Size() < 0 || info.Size() == math.MaxInt64 {
		return errors.New("invalid restore snapshot size")
	}
	output, err := openOutput()
	if err != nil {
		return err
	}
	digest := sha256.New()
	copied, err := io.CopyBuffer(io.MultiWriter(output, digest), snapshotContextReader{ctx: ctx, reader: io.LimitReader(input, info.Size()+1)}, make([]byte, 128*1024))
	if err != nil {
		_ = output.Close()
		return err
	}
	if copied != info.Size() || hex.EncodeToString(digest.Sum(nil)) != expectedDigest {
		_ = output.Close()
		return errors.New("copied SQLite snapshot size or digest mismatch")
	}
	if err := ctx.Err(); err != nil {
		_ = output.Close()
		return err
	}
	if err := output.Sync(); err != nil {
		_ = output.Close()
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	return nil
}

func resetRestoredState(ctx context.Context, database *db.DB, backupAt int64, schemaVersion int) error {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		"DELETE FROM sessions",
		"DELETE FROM setup_tokens",
		"DELETE FROM login_attempts",
		"DELETE FROM tx_log",
		"DELETE FROM tombstone_build_members",
		"DELETE FROM tombstone_builds",
		"DELETE FROM upload_object_claims",
		"DELETE FROM upload_receive_fences",
		"DELETE FROM metadata_maintenance",
		"UPDATE objects SET state = 'deleted' WHERE state = 'pending'",
		"DELETE FROM upload_sessions",
	}
	if schemaVersion >= 7 {
		statements = append(statements, "UPDATE object_gc_state SET cursor = '', generation = 0 WHERE id = 1")
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("reset restored transient state: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE server_state SET last_backup_at = ? WHERE id = 1", backupAt); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	var result string
	if err := database.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&result); err != nil || result != "ok" {
		return fmt.Errorf("restored SQLite integrity check failed: %s: %v", result, err)
	}
	rows, err := database.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		_ = rows.Close()
		return errors.New("restored SQLite foreign key check failed")
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	return nil
}

func clear(bytes []byte) {
	for index := range bytes {
		bytes[index] = 0
	}
}
