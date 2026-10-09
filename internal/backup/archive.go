package backup

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
	"xdrive/internal/storage"
)

var ErrBackupInProgress = errors.New("another backup or deletion is in progress")

// ArchiveExport is a point-in-time, restore-compatible backup streamed to a
// caller-owned writer. It keeps the object deletion lease until Close so every
// object named by the SQLite snapshot remains available during transmission.
type ArchiveExport struct {
	settings   config.Config
	lease      *storage.BackupLease
	tempDir    string
	snapshot   string
	manifest   ObjectManifest
	header     Header
	generation string
	rootName   string
	closed     bool
}

// PrepareArchive snapshots SQLite and validates the snapshot's live object
// set before an HTTP handler commits download headers. It does not copy object
// data to temporary storage; objects are verified as they stream to the
// output. The only temporary copy is the SQLite snapshot.
func PrepareArchive(ctx context.Context, settings config.Config) (*ArchiveExport, error) {
	lease, err := storage.TryBackupLease(settings.StoragePath)
	if err != nil {
		return nil, err
	}
	if lease == nil {
		return nil, ErrBackupInProgress
	}
	failed := true
	defer func() {
		if failed {
			_ = lease.Close()
		}
	}()

	tempDir, err := os.MkdirTemp(filepath.Dir(settings.DatabasePath), ".xdrive-web-backup-")
	if err != nil {
		return nil, fmt.Errorf("create backup snapshot staging directory: %w", err)
	}
	if err := os.Chmod(tempDir, 0o700); err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, err
	}
	cleanupTemp := func() { _ = os.RemoveAll(tempDir) }
	stage, err := os.Open(tempDir)
	if err != nil {
		cleanupTemp()
		return nil, err
	}
	snapshotPath := filepath.Join(tempDir, snapshotName)
	err = snapshotSQLiteDatabase(ctx, settings.DatabasePath, stage, tempDir, snapshotName, nil)
	if err == nil {
		err = os.Chmod(snapshotPath, 0o600)
	}
	if err == nil {
		err = stage.Sync()
	}
	err = errors.Join(err, stage.Close())
	if err != nil {
		cleanupTemp()
		return nil, fmt.Errorf("create consistent SQLite snapshot: %w", err)
	}

	manifest, schemaVersion, err := readSnapshotObjects(ctx, snapshotPath)
	if err != nil {
		cleanupTemp()
		return nil, err
	}
	root := lease.Directory()
	var total int64
	for _, item := range manifest.Objects {
		if item.SizeBytes > 0 && total > int64(^uint64(0)>>1)-item.SizeBytes {
			cleanupTemp()
			return nil, errors.New("backup object total overflows int64")
		}
		file, openErr := storage.OpenObjectReadAt(root, item.ID)
		if openErr != nil {
			cleanupTemp()
			return nil, fmt.Errorf("snapshot object %s is unavailable: %w", item.ID, openErr)
		}
		info, statErr := file.Stat()
		closeErr := file.Close()
		if statErr != nil || !info.Mode().IsRegular() || info.Size() != item.SizeBytes {
			cleanupTemp()
			return nil, errors.Join(fmt.Errorf("snapshot object %s has an invalid size", item.ID), statErr, closeErr)
		}
		if closeErr != nil {
			cleanupTemp()
			return nil, closeErr
		}
		total += item.SizeBytes
	}

	snapshotDigest, err := hashFileContext(ctx, snapshotPath)
	if err != nil {
		cleanupTemp()
		return nil, err
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		cleanupTemp()
		return nil, err
	}
	generation, err := randomID()
	if err != nil {
		cleanupTemp()
		return nil, err
	}
	createdAt := time.Now().UTC().Truncate(time.Second)
	header := Header{
		FormatVersion: formatVersion, CreatedAt: createdAt.Unix(), SchemaVersion: schemaVersion,
		SnapshotSHA256: snapshotDigest, ManifestSHA256: hexDigest(manifestBytes),
		ObjectCount: len(manifest.Objects), TotalObjectBytes: total,
	}
	rootName := "xdrive-backup-" + createdAt.Format("20060102T150405Z") + "-" + generation
	failed = false
	return &ArchiveExport{
		settings: settings, lease: lease, tempDir: tempDir, snapshot: snapshotPath,
		manifest: manifest, header: header, generation: generation, rootName: rootName,
	}, nil
}

// WriteTo writes a plain tar archive that extracts to a directory accepted by
// xdrive verify-backup and xdrive restore. Memory use is bounded independently
// of the total object bytes.
func (export *ArchiveExport) WriteTo(ctx context.Context, output io.Writer) error {
	if export == nil || export.closed || output == nil {
		return errors.New("backup archive export is unavailable")
	}
	writer := tar.NewWriter(output)
	createdAt := time.Unix(export.header.CreatedAt, 0).UTC()
	root := export.rootName
	for _, directory := range []string{
		root,
		root + "/snapshots",
		root + "/snapshots/" + export.generation,
		root + "/objects",
	} {
		if err := writeTarDirectory(writer, directory, createdAt); err != nil {
			return err
		}
	}
	shards := make(map[string]struct{})
	if err := writer.WriteHeader(&tar.Header{Name: root + "/CURRENT", Mode: 0o600, Size: int64(len(export.generation) + 1), ModTime: createdAt, Typeflag: tar.TypeReg, Format: tar.FormatUSTAR}); err != nil {
		return err
	}
	if _, err := io.WriteString(writer, export.generation+"\n"); err != nil {
		return err
	}
	generationPath := root + "/snapshots/" + export.generation + "/"
	if err := export.writeVerifiedFile(ctx, writer, export.snapshot, generationPath+snapshotName, export.header.SnapshotSHA256); err != nil {
		return fmt.Errorf("write SQLite snapshot: %w", err)
	}
	manifestBytes, err := json.Marshal(export.manifest)
	if err != nil {
		return err
	}
	if err := writeTarBytes(writer, generationPath+objectsName, manifestBytes, createdAt); err != nil {
		return err
	}
	headerBytes, err := json.Marshal(export.header)
	if err != nil {
		return err
	}
	if err := writeTarBytes(writer, generationPath+backupName, headerBytes, createdAt); err != nil {
		return err
	}

	rootHandle := export.lease.Directory()
	for _, item := range export.manifest.Objects {
		if err := ctx.Err(); err != nil {
			return err
		}
		shard := item.ID[:2]
		if _, written := shards[shard]; !written {
			if err := writeTarDirectory(writer, root+"/objects/"+shard, createdAt); err != nil {
				return err
			}
			shards[shard] = struct{}{}
		}
		if err := writer.WriteHeader(&tar.Header{Name: root + "/objects/" + shard + "/" + item.ID, Mode: 0o600, Size: item.SizeBytes, ModTime: createdAt, Typeflag: tar.TypeReg, Format: tar.FormatUSTAR}); err != nil {
			return err
		}
		file, err := storage.OpenObjectReadAt(rootHandle, item.ID)
		if err != nil {
			return fmt.Errorf("open backup object %s: %w", item.ID, err)
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() || info.Size() != item.SizeBytes {
			_ = file.Close()
			return errors.Join(fmt.Errorf("backup object %s changed during export", item.ID), statErr)
		}
		prepareBackupStream(file)
		digest := sha256.New()
		_, copyErr := hashBackupFileWindows(ctx, io.MultiWriter(writer, digest), file, item.SizeBytes)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil {
			return errors.Join(fmt.Errorf("stream backup object %s", item.ID), copyErr, closeErr)
		}
		if hex.EncodeToString(digest.Sum(nil)) != item.SHA256 {
			return fmt.Errorf("backup object %s failed SHA-256 verification", item.ID)
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	live, err := db.OpenBackupMetadata(ctx, export.settings.DatabasePath)
	if err != nil {
		return fmt.Errorf("archive streamed, but opening the application database failed: %w", err)
	}
	defer live.Close()
	if _, err := live.ExecContext(ctx, "UPDATE server_state SET last_backup_at = ? WHERE id = 1", export.header.CreatedAt); err != nil {
		return fmt.Errorf("archive streamed, but recording the backup time failed: %w", err)
	}
	return nil
}

func (export *ArchiveExport) DownloadFilename() string {
	if export == nil {
		return "xdrive-backup.tar"
	}
	return export.rootName + ".tar"
}

// CleanupArchiveStaging removes abandoned web-export snapshots after the
// service has acquired its single-instance lease. No live export can still
// own one of these directories at that point.
func CleanupArchiveStaging(settings config.Config) error {
	parent := filepath.Dir(settings.DatabasePath)
	entries, err := os.ReadDir(parent)
	if err != nil {
		return fmt.Errorf("list backup staging directory: %w", err)
	}
	for _, entry := range entries {
		const prefix = ".xdrive-web-backup-"
		suffix := strings.TrimPrefix(entry.Name(), prefix)
		if suffix == entry.Name() || !validTempSuffix(suffix) || !entry.IsDir() {
			continue
		}
		if err := os.RemoveAll(filepath.Join(parent, entry.Name())); err != nil {
			return fmt.Errorf("remove abandoned backup staging directory: %w", err)
		}
	}
	return nil
}

func validTempSuffix(suffix string) bool {
	if len(suffix) != 10 {
		return false
	}
	for _, character := range suffix {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'z' {
				if character < 'A' || character > 'Z' {
					return false
				}
			}
		}
	}
	return true
}

func (export *ArchiveExport) writeVerifiedFile(ctx context.Context, writer *tar.Writer, source, name, expectedDigest string) error {
	file, err := openBackupRegular(source)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 0 {
		return errors.Join(errors.New("backup snapshot is not a regular file"), err)
	}
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: info.Size(), ModTime: time.Unix(export.header.CreatedAt, 0).UTC(), Typeflag: tar.TypeReg, Format: tar.FormatUSTAR}); err != nil {
		return err
	}
	digest := sha256.New()
	if _, err := hashBackupFileWindows(ctx, io.MultiWriter(writer, digest), file, info.Size()); err != nil {
		return err
	}
	if hex.EncodeToString(digest.Sum(nil)) != expectedDigest {
		return errors.New("SQLite snapshot failed SHA-256 verification")
	}
	return nil
}

// Close releases the deletion lease and removes the SQLite snapshot staging
// file. It is safe to call more than once.
func (export *ArchiveExport) Close() error {
	if export == nil || export.closed {
		return nil
	}
	export.closed = true
	return errors.Join(os.RemoveAll(export.tempDir), export.lease.Close())
}

func writeTarDirectory(writer *tar.Writer, name string, modified time.Time) error {
	if err := writer.WriteHeader(&tar.Header{Name: name + "/", Mode: 0o700, ModTime: modified, Typeflag: tar.TypeDir, Format: tar.FormatUSTAR}); err != nil {
		return err
	}
	return nil
}

func writeTarBytes(writer *tar.Writer, name string, data []byte, modified time.Time) error {
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(data)), ModTime: modified, Typeflag: tar.TypeReg, Format: tar.FormatUSTAR}); err != nil {
		return err
	}
	_, err := writer.Write(data)
	return err
}
