package backup

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
	"xdrive/internal/fssecure"
	"xdrive/internal/storage"
)

const formatVersion = 1
const snapshotName = "db.sqlite.snapshot"
const objectsName = "OBJECTS.json"
const backupName = "BACKUP.json"
const backupStreamWindowBytes = int64(64 * 1024 * 1024)

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
var safeShard = regexp.MustCompile(`^[A-Za-z0-9_-]{2}$`)

type Object struct {
	ID        string `json:"objectId"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

type ObjectManifest struct {
	FormatVersion int      `json:"formatVersion"`
	Objects       []Object `json:"objects"`
}

type Header struct {
	FormatVersion    int    `json:"formatVersion"`
	CreatedAt        int64  `json:"createdAt"`
	SchemaVersion    int    `json:"schemaVersion"`
	SnapshotSHA256   string `json:"snapshotSha256"`
	ManifestSHA256   string `json:"manifestSha256"`
	ObjectCount      int    `json:"objectCount"`
	TotalObjectBytes int64  `json:"totalObjectBytes"`
}

// Create writes directly to the caller-selected destination. CURRENT is the
// sole completion marker; an interrupted generation never replaces it.
func Create(ctx context.Context, settings config.Config, destination string, verifyAll bool) (err error) {
	return create(ctx, settings, destination, verifyAll, nil)
}

type createHooks struct {
	afterSnapshot func() error
	afterPathname func(string) error
	syncDirectory func(string) error
	afterStep     func(string)
}

func create(ctx context.Context, settings config.Config, destination string, verifyAll bool, afterSnapshot func() error) (err error) {
	return createWithHooks(ctx, settings, destination, verifyAll, createHooks{afterSnapshot: afterSnapshot})
}

func createWithHooks(ctx context.Context, settings config.Config, destination string, verifyAll bool, hooks createHooks) (err error) {
	destination, err = validateDestination(destination, settings)
	if err != nil {
		return err
	}
	destinationLease, err := storage.AcquireBackupLease(ctx, destination)
	if err != nil {
		return err
	}
	defer destinationLease.Close()
	destinationRoot := destinationLease.Directory()
	if destinationRoot == nil {
		return errors.New("backup destination directory lease is unavailable")
	}
	if err := securePrivateDirectory(destinationRoot); err != nil {
		return fmt.Errorf("secure backup destination directory: %w", err)
	}
	snapshotsRoot, err := openOrCreateDirectoryAt(destinationRoot, "snapshots", 0o700)
	if err != nil {
		return err
	}
	defer snapshotsRoot.Close()
	if err := securePrivateDirectory(snapshotsRoot); err != nil {
		return fmt.Errorf("secure backup snapshots directory: %w", err)
	}
	objectsDirectory, err := openOrCreateDirectoryAt(destinationRoot, "objects", 0o700)
	if err != nil {
		return err
	}
	defer objectsDirectory.Close()
	if err := securePrivateDirectory(objectsDirectory); err != nil {
		return fmt.Errorf("secure backup objects directory: %w", err)
	}
	lease, err := storage.AcquireBackupLease(ctx, settings.StoragePath)
	if err != nil {
		return err
	}
	defer lease.Close()
	sourceRoot := lease.Directory()
	if sourceRoot == nil {
		return errors.New("source object directory lease is unavailable")
	}
	old, err := readCurrent(destination)
	if err != nil {
		return err
	}
	prior := make(map[string]Object)
	if old != "" {
		_, previous, _, err := inspectGeneration(ctx, destination, old, false)
		if err != nil {
			return fmt.Errorf("existing completed backup is invalid: %w", err)
		}
		for _, item := range previous.Objects {
			prior[item.ID] = item
		}
	}
	if err := removeInterruptedWorkAt(destinationRoot, destination); err != nil {
		return err
	}
	generation, err := randomID()
	if err != nil {
		return err
	}
	snapshots := filepath.Join(destination, "snapshots")
	stageName := ".staging-" + generation
	stage := filepath.Join(snapshots, stageName)
	parentFD := int(snapshotsRoot.Fd())
	if err := unix.Mkdirat(parentFD, stageName, 0o700); err != nil {
		return err
	}
	stageFD, err := unix.Openat(parentFD, stageName, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	stageParent := snapshotsRoot
	ownedStage := os.NewFile(uintptr(stageFD), stage)
	defer ownedStage.Close()
	if err := securePrivateDirectory(ownedStage); err != nil {
		return fmt.Errorf("secure backup staging directory: %w", err)
	}
	publishedStage := false
	defer func() {
		if !publishedStage {
			err = errors.Join(err, cleanOpenedStage(parentFD, filepath.Base(stage), ownedStage), stageParent.Sync())
		}
	}()
	validateStage := func() error { return validateOwnedStage(snapshots, stageName, stageParent, ownedStage) }
	if err := validateStage(); err != nil {
		return err
	}
	snapshotPath := filepath.Join(stage, snapshotName)
	if err := snapshotSQLiteDatabase(ctx, settings.DatabasePath, ownedStage, stage, snapshotName, hooks.afterPathname); err != nil {
		return fmt.Errorf("create consistent SQLite snapshot: %w", err)
	}
	if err := validateStage(); err != nil {
		return err
	}
	if err := syncPrivateSnapshot(stageFD); err != nil {
		return err
	}
	checkpoint(hooks, "snapshot-synced")
	manifest, schemaVersion, err := readSnapshotObjects(ctx, snapshotPath)
	if err != nil {
		return err
	}
	if hooks.afterSnapshot != nil {
		if err := hooks.afterSnapshot(); err != nil {
			return err
		}
	}
	objectsRoot := filepath.Join(destination, "objects")
	syncDir := hooks.syncDirectory
	if syncDir == nil {
		syncDir = func(path string) error {
			switch path {
			case destination:
				return destinationRoot.Sync()
			case objectsRoot:
				return objectsDirectory.Sync()
			default:
				return syncDirectory(path)
			}
		}
	}
	// Persist the objects/ directory entry before a generation can publish a
	// manifest that depends on it.
	if err := syncDir(destination); err != nil {
		return fmt.Errorf("sync backup destination after creating object store: %w", err)
	}
	var total int64
	for index, item := range manifest.Objects {
		if err := ctx.Err(); err != nil {
			return err
		}
		if item.SizeBytes > 0 && total > int64(^uint64(0)>>1)-item.SizeBytes {
			return errors.New("backup object total overflows int64")
		}
		total += item.SizeBytes
		source := objectPath(settings.StoragePath, item.ID)
		if objectFileSizeAt(sourceRoot, item.ID) != item.SizeBytes {
			return fmt.Errorf("source object %s is missing or has wrong size", item.ID)
		}
		target := objectPath(objectsRoot, item.ID)
		if previous, known := prior[item.ID]; known && previous != item {
			return fmt.Errorf("object ID %s changed between completed backups", item.ID)
		} else if known && objectFileSizeAt(objectsDirectory, item.ID) == item.SizeBytes {
			digest, err := hashObjectAtContext(ctx, sourceRoot, item.ID)
			if err != nil {
				return fmt.Errorf("source object %s failed SHA-256 verification: %w", item.ID, err)
			}
			if digest != item.SHA256 {
				return fmt.Errorf("source object %s failed SHA-256 verification", item.ID)
			}
			// A published manifest alone does not prove the shared backup copy
			// has survived disk damage since the previous generation.
			targetDigest, err := hashObjectAtContext(ctx, objectsDirectory, item.ID)
			if err == nil && targetDigest == item.SHA256 {
				checkpoint(hooks, fmt.Sprintf("object-%d-synced", index))
				continue
			}
		}
		var afterCopyStep func(string)
		if hooks.afterStep != nil {
			afterCopyStep = func(step string) {
				checkpoint(hooks, fmt.Sprintf("object-%d-copy-%s", index, step))
			}
		}
		if err := copyVerifiedObjectWithRootsContext(ctx, source, target, sourceRoot, objectsDirectory, item, afterCopyStep); err != nil {
			return err
		}
		checkpoint(hooks, fmt.Sprintf("object-%d-synced", index))
	}
	// Object files are synced before their shard directories. Sync objects/ as
	// well so newly created shard directory entries survive before CURRENT moves.
	if err := syncDir(objectsRoot); err != nil {
		return fmt.Errorf("sync backup object-store directory: %w", err)
	}
	checkpoint(hooks, "objects-root-synced")
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if err := validateStage(); err != nil {
		return err
	}
	if err := writeStageSynced(ownedStage, objectsName, manifestBytes); err != nil {
		return err
	}
	checkpoint(hooks, "manifest-synced")
	snapshotDigest, err := hashFileContext(ctx, snapshotPath)
	if err != nil {
		return err
	}
	header := Header{
		FormatVersion: formatVersion, CreatedAt: time.Now().Unix(), SchemaVersion: schemaVersion,
		SnapshotSHA256: snapshotDigest, ManifestSHA256: hexDigest(manifestBytes),
		ObjectCount: len(manifest.Objects), TotalObjectBytes: total,
	}
	headerBytes, err := json.Marshal(header)
	if err != nil {
		return err
	}
	if err := validateStage(); err != nil {
		return err
	}
	if err := writeStageSynced(ownedStage, backupName, headerBytes); err != nil {
		return err
	}
	checkpoint(hooks, "header-synced")
	if err := ownedStage.Sync(); err != nil {
		return err
	}
	checkpoint(hooks, "staging-synced")
	if verifyAll {
		if err := verifyObjectsAt(ctx, objectsDirectory, manifest.Objects); err != nil {
			return err
		}
	}
	if err := validateStage(); err != nil {
		return err
	}
	if err := unix.Renameat(parentFD, filepath.Base(stage), parentFD, generation); err != nil {
		return err
	}
	publishedStage = true
	checkpoint(hooks, "generation-renamed")
	if err := validateOwnedStage(snapshots, generation, stageParent, ownedStage); err != nil {
		return err
	}
	if err := stageParent.Sync(); err != nil {
		return err
	}
	checkpoint(hooks, "snapshots-synced")
	if err := validateOwnedStage(snapshots, generation, stageParent, ownedStage); err != nil {
		return err
	}
	if err := writeAtomicAtWithHook(destinationRoot, destination, "CURRENT", []byte(generation+"\n"), func(step string) {
		checkpoint(hooks, "current-"+step)
	}); err != nil {
		return err
	}
	live, err := db.OpenBackupMetadata(ctx, settings.DatabasePath)
	if err != nil {
		return fmt.Errorf("backup published, but reopening the application database failed: %w", err)
	}
	defer live.Close()
	if _, err := live.ExecContext(ctx, "UPDATE server_state SET last_backup_at = ? WHERE id = 1", header.CreatedAt); err != nil {
		return fmt.Errorf("backup published, but recording the last backup time failed: %w", err)
	}
	return nil
}

// A process exit can leave unpublished staging directories, object-copy temp
// files, or a temp CURRENT pointer. None of these is published by CURRENT.
// Verify checks the published generation, its snapshot and every object byte.
func Verify(ctx context.Context, source string) error {
	return VerifyGeneration(ctx, source, "")
}

// VerifyGeneration validates one published backup generation. An empty ID
// selects CURRENT; an explicit ID leaves CURRENT unchanged.
func VerifyGeneration(ctx context.Context, source, generation string) error {
	lease, err := storage.AcquireDeletionLease(ctx, source)
	if err != nil {
		return err
	}
	defer lease.Close()
	selected, err := resolveGeneration(source, generation)
	if err != nil {
		return err
	}
	_, _, _, err = inspectGeneration(ctx, source, selected, true)
	return err
}

// BackupInfo describes the currently published generation without revealing
// object identifiers or user file metadata. Inspect returns it only after the
// snapshot, manifest, and every encrypted object have passed verification.
type BackupInfo struct {
	Generation       string    `json:"generation"`
	CreatedAt        time.Time `json:"createdAt"`
	SchemaVersion    int       `json:"schemaVersion"`
	ObjectCount      int       `json:"objectCount"`
	TotalObjectBytes int64     `json:"totalObjectBytes"`
	SnapshotSHA256   string    `json:"snapshotSha256"`
	ManifestSHA256   string    `json:"manifestSha256"`
}

// Inspect verifies the complete current generation before returning its
// non-sensitive recovery summary. The shared inspection lease prevents the
// published generation from changing during validation without modifying the
// backup directory.
func Inspect(ctx context.Context, source string) (BackupInfo, error) {
	return InspectGeneration(ctx, source, "")
}

// InspectGeneration verifies a selected generation before returning its
// non-sensitive recovery summary. An empty ID selects CURRENT. The shared
// inspection lease prevents concurrent publication without modifying the
// backup directory.
func InspectGeneration(ctx context.Context, source, generation string) (BackupInfo, error) {
	lease, err := storage.AcquireInspectionLease(ctx, source)
	if err != nil {
		return BackupInfo{}, err
	}
	defer lease.Close()
	selected, err := resolveGeneration(source, generation)
	if err != nil {
		return BackupInfo{}, err
	}
	header, _, _, err := inspectGeneration(ctx, source, selected, true)
	if err != nil {
		return BackupInfo{}, err
	}
	return BackupInfo{
		Generation:       selected,
		CreatedAt:        time.Unix(header.CreatedAt, 0).UTC(),
		SchemaVersion:    header.SchemaVersion,
		ObjectCount:      header.ObjectCount,
		TotalObjectBytes: header.TotalObjectBytes,
		SnapshotSHA256:   header.SnapshotSHA256,
		ManifestSHA256:   header.ManifestSHA256,
	}, nil
}

func resolveGeneration(source, requested string) (string, error) {
	if requested != "" {
		if !safeID.MatchString(requested) {
			return "", errors.New("invalid backup generation ID")
		}
		return requested, nil
	}
	current, err := readCurrent(source)
	if err != nil {
		return "", err
	}
	if current == "" {
		return "", errors.New("backup has no completed generation")
	}
	return current, nil
}

func inspectGeneration(ctx context.Context, source, generation string, fullObjects bool) (Header, ObjectManifest, string, error) {
	var header Header
	var manifest ObjectManifest
	stage := filepath.Join(source, "snapshots", generation)
	if err := validateGenerationContents(source, generation); err != nil {
		return header, manifest, "", err
	}
	headerBytes, err := readRegularBounded(filepath.Join(stage, backupName), 1<<20)
	if err != nil {
		return header, manifest, "", err
	}
	if err := json.Unmarshal(headerBytes, &header); err != nil || header.FormatVersion != formatVersion || !db.SupportedBackupSchemaVersion(header.SchemaVersion) || !validDigest(header.SnapshotSHA256) || !validDigest(header.ManifestSHA256) || header.ObjectCount < 0 || header.TotalObjectBytes < 0 {
		return header, manifest, "", errors.New("invalid backup header")
	}
	manifestBytes, err := readRegularBounded(filepath.Join(stage, objectsName), 256<<20)
	if err != nil {
		return header, manifest, "", err
	}
	if hexDigest(manifestBytes) != header.ManifestSHA256 {
		return header, manifest, "", errors.New("object manifest digest mismatch")
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil || manifest.FormatVersion != formatVersion || len(manifest.Objects) != header.ObjectCount {
		return header, manifest, "", errors.New("invalid object manifest")
	}
	snapshotPath := filepath.Join(stage, snapshotName)
	snapshotDigest, err := hashFileContext(ctx, snapshotPath)
	if err != nil || snapshotDigest != header.SnapshotSHA256 {
		return header, manifest, "", errors.New("SQLite snapshot digest mismatch")
	}
	fromSnapshot, schema, err := readSnapshotObjectsWithDigest(ctx, snapshotPath, header.SnapshotSHA256)
	if err != nil || schema != header.SchemaVersion || len(fromSnapshot.Objects) != len(manifest.Objects) {
		return header, manifest, "", errors.New("snapshot object set differs from manifest")
	}
	var total int64
	for index, item := range manifest.Objects {
		if item != fromSnapshot.Objects[index] || !safeID.MatchString(item.ID) || item.SizeBytes < 36 || !validDigest(item.SHA256) || item.SizeBytes > int64(^uint64(0)>>1)-total {
			return header, manifest, "", errors.New("snapshot object set differs from manifest")
		}
		total += item.SizeBytes
		if regularFileSize(objectPath(filepath.Join(source, "objects"), item.ID)) != item.SizeBytes {
			return header, manifest, "", fmt.Errorf("backup object %s is missing or has wrong size", item.ID)
		}
	}
	if total != header.TotalObjectBytes {
		return header, manifest, "", errors.New("backup object byte total mismatch")
	}
	if fullObjects {
		if err := verifyObjects(ctx, filepath.Join(source, "objects"), manifest.Objects); err != nil {
			return header, manifest, "", err
		}
	}
	return header, manifest, snapshotPath, nil
}

func readSnapshotObjects(ctx context.Context, snapshotPath string) (ObjectManifest, int, error) {
	return readSnapshotObjectsWithDigest(ctx, snapshotPath, "")
}

func readSnapshotObjectsWithDigest(ctx context.Context, snapshotPath, expectedDigest string) (ObjectManifest, int, error) {
	manifest := ObjectManifest{FormatVersion: formatVersion, Objects: make([]Object, 0)}
	privatePath, cleanup, err := prepareSnapshotRead(ctx, snapshotPath, expectedDigest)
	if err != nil {
		return manifest, 0, err
	}
	defer cleanup()
	dsn := (&url.URL{Scheme: "file", Path: privatePath}).String() + "?mode=ro&immutable=1"
	snapshot, err := sql.Open("sqlite", dsn)
	if err != nil {
		return manifest, 0, err
	}
	defer snapshot.Close()
	var integrity string
	if err := snapshot.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil || integrity != "ok" {
		return manifest, 0, fmt.Errorf("SQLite snapshot integrity check failed: %s: %v", integrity, err)
	}
	foreignKeys, err := snapshot.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return manifest, 0, err
	}
	if foreignKeys.Next() {
		_ = foreignKeys.Close()
		return manifest, 0, errors.New("SQLite snapshot has a foreign key violation")
	}
	if err := foreignKeys.Err(); err != nil {
		_ = foreignKeys.Close()
		return manifest, 0, err
	}
	if err := foreignKeys.Close(); err != nil {
		return manifest, 0, err
	}
	var schemaVersion int
	if err := snapshot.QueryRowContext(ctx, "PRAGMA user_version").Scan(&schemaVersion); err != nil || !db.SupportedBackupSchemaVersion(schemaVersion) {
		return manifest, 0, fmt.Errorf("unsupported backup snapshot schema %d: %v", schemaVersion, err)
	}
	for _, query := range []string{
		`SELECT COUNT(*) FROM metadata_pointers p LEFT JOIN objects o ON o.id = p.object_id WHERE o.id IS NULL OR o.state <> 'live'`,
		`SELECT COUNT(*) FROM metadata_versions v LEFT JOIN objects o ON o.id = v.object_id WHERE o.id IS NULL OR o.state <> 'live'`,
		`SELECT COUNT(*) FROM tombstone_objects m JOIN tombstones t ON t.id = m.tombstone_id LEFT JOIN objects o ON o.id = m.object_id WHERE t.state = 'active' AND (o.id IS NULL OR o.state <> 'live')`,
	} {
		var invalid int
		if err := snapshot.QueryRowContext(ctx, query).Scan(&invalid); err != nil || invalid != 0 {
			return manifest, 0, fmt.Errorf("snapshot has %d non-live referenced objects: %v", invalid, err)
		}
	}
	rows, err := snapshot.QueryContext(ctx, "SELECT id, size_bytes, sha256 FROM objects WHERE state = 'live' ORDER BY id")
	if err != nil {
		return manifest, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var item Object
		var digest []byte
		if err := rows.Scan(&item.ID, &item.SizeBytes, &digest); err != nil {
			return manifest, 0, err
		}
		if !safeID.MatchString(item.ID) || item.SizeBytes < 36 || len(digest) != sha256.Size {
			return manifest, 0, errors.New("snapshot has an invalid live object")
		}
		item.SHA256 = hex.EncodeToString(digest)
		manifest.Objects = append(manifest.Objects, item)
	}
	return manifest, schemaVersion, rows.Err()
}

func verifyObjects(ctx context.Context, root string, objects []Object) error {
	directory, err := fssecure.OpenDirectory(root)
	if err != nil {
		return err
	}
	defer directory.Close()
	return verifyObjectsAt(ctx, directory, objects)
}

func verifyObjectsAt(ctx context.Context, root *os.File, objects []Object) error {
	if root == nil {
		return errors.New("missing anchored backup objects directory")
	}
	for _, item := range objects {
		if err := ctx.Err(); err != nil {
			return err
		}
		if objectFileSizeAt(root, item.ID) != item.SizeBytes {
			return fmt.Errorf("backup object %s is missing or has wrong size", item.ID)
		}
		digest, err := hashObjectAtContext(ctx, root, item.ID)
		if err != nil {
			return fmt.Errorf("backup object %s digest check failed: %w", item.ID, err)
		}
		if digest != item.SHA256 {
			return fmt.Errorf("backup object %s digest mismatch", item.ID)
		}
	}
	return nil
}

func copyVerifiedObject(source, destination string, item Object) error {
	return copyVerifiedObjectWithHook(source, destination, item, nil)
}

func copyVerifiedObjectWithHook(source, destination string, item Object, afterStep func(string)) error {
	return copyVerifiedObjectWithRoot(source, destination, nil, item, afterStep)
}

func copyVerifiedObjectWithRoot(source, destination string, targetRoot *os.File, item Object, afterStep func(string)) error {
	return copyVerifiedObjectWithRoots(source, destination, nil, targetRoot, item, afterStep)
}

func copyVerifiedObjectWithRoots(source, destination string, sourceRoot, targetRoot *os.File, item Object, afterStep func(string)) error {
	return copyVerifiedObjectWithRootsContext(context.Background(), source, destination, sourceRoot, targetRoot, item, afterStep)
}

func copyVerifiedObjectWithRootsContext(ctx context.Context, source, destination string, sourceRoot, targetRoot *os.File, item Object, afterStep func(string)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Resolve the opaque object through root/shard descriptors. The source
	// pathname is never reopened after validation when a lease root is supplied.
	var input *os.File
	var err error
	if sourceRoot == nil {
		input, err = storage.OpenObjectRead(filepath.Dir(filepath.Dir(source)), item.ID)
	} else {
		input, err = storage.OpenObjectReadAt(sourceRoot, item.ID)
	}
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil || info.Size() != item.SizeBytes {
		return fmt.Errorf("source object %s is missing or has wrong size", item.ID)
	}
	var directory *copyDirectory
	if targetRoot == nil {
		directory, err = openCopyDirectory(filepath.Dir(filepath.Dir(destination)), item.ID)
	} else {
		directory, err = openCopyDirectoryAt(targetRoot, filepath.Dir(filepath.Dir(destination)), item.ID)
	}
	if err != nil {
		return err
	}
	defer directory.close()
	temporary, name, err := directory.temporary()
	if err != nil {
		return err
	}
	defer directory.cleanup(name)
	defer temporary.Close()
	prepareBackupStream(input)
	prepareBackupStream(temporary)
	hasher := sha256.New()
	var copyTarget io.Writer = io.MultiWriter(temporary, hasher)
	if afterStep != nil {
		copyTarget = &backupCopyWriter{writer: copyTarget, afterPartial: func() { afterStep("partial") }}
	}
	written, err := copyBackupObjectWindows(ctx, copyTarget, input, temporary, item.SizeBytes)
	if err != nil {
		_ = temporary.Close()
		return fmt.Errorf("source object %s copy failed: %w", item.ID, err)
	}
	if written != item.SizeBytes || hex.EncodeToString(hasher.Sum(nil)) != item.SHA256 {
		_ = temporary.Close()
		return fmt.Errorf("source object %s failed size or SHA-256 verification", item.ID)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if afterStep != nil {
		afterStep("temp-synced")
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := directory.publish(name); err != nil {
		return err
	}
	if afterStep != nil {
		afterStep("renamed")
	}
	if err := directory.bucket.Sync(); err != nil {
		return err
	}
	if afterStep != nil {
		afterStep("shard-synced")
	}
	return directory.validate()
}

type backupCopyWriter struct {
	writer       io.Writer
	written      int64
	partialSent  bool
	afterPartial func()
}

func (w *backupCopyWriter) Write(data []byte) (int, error) {
	const checkpointBytes = 128 * 1024
	if !w.partialSent && w.written < checkpointBytes && int64(len(data)) > checkpointBytes-w.written {
		firstLength := int(checkpointBytes - w.written)
		firstWritten, err := w.writer.Write(data[:firstLength])
		w.written += int64(firstWritten)
		if firstWritten == firstLength {
			w.partialSent = true
			if w.afterPartial != nil {
				w.afterPartial()
			}
		}
		if err != nil {
			return firstWritten, err
		}
		if firstWritten != firstLength {
			return firstWritten, io.ErrShortWrite
		}
		remainingWritten, err := w.writer.Write(data[firstLength:])
		w.written += int64(remainingWritten)
		return firstWritten + remainingWritten, err
	}
	written, err := w.writer.Write(data)
	w.written += int64(written)
	if !w.partialSent && w.written >= checkpointBytes {
		w.partialSent = true
		if w.afterPartial != nil {
			w.afterPartial()
		}
	}
	return written, err
}

// copyBackupObjectWindows bounds dirty and cached file pages while copying a
// large encrypted object. Each destination window is written back before its
// cache is discarded; the final Sync below still provides the publication
// durability boundary.
func copyBackupObjectWindows(ctx context.Context, target io.Writer, source, destination *os.File, expectedSize int64) (int64, error) {
	buffer := make([]byte, 128*1024)
	var copied int64
	for copied < expectedSize {
		if err := ctx.Err(); err != nil {
			return copied, err
		}
		windowSize := min(backupStreamWindowBytes, expectedSize-copied)
		reader := snapshotContextReader{ctx: ctx, reader: io.LimitReader(source, windowSize)}
		written, err := io.CopyBuffer(target, reader, buffer)
		if err != nil {
			return copied + written, err
		}
		if written != windowSize {
			return copied + written, io.ErrUnexpectedEOF
		}
		if err := ctx.Err(); err != nil {
			return copied + written, err
		}
		if err := flushBackupStreamWindow(destination, copied, written); err != nil {
			return copied + written, err
		}
		discardBackupStreamWindow(source, copied, written)
		discardBackupStreamWindow(destination, copied, written)
		copied += written
	}
	var extra [1]byte
	reader := snapshotContextReader{ctx: ctx, reader: source}
	if n, err := reader.Read(extra[:]); n != 0 || err == nil {
		return copied + int64(n), errors.New("source object grew while backup copy was in progress")
	} else if !errors.Is(err, io.EOF) {
		return copied, err
	}
	return copied, nil
}

func validateDestination(destination string, settings config.Config) (string, error) {
	abs, err := filepath.Abs(destination)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return "", errors.New("backup destination must be an existing directory")
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	storagePath, err := filepath.Abs(settings.StoragePath)
	if err != nil {
		return "", err
	}
	databasePath, err := filepath.Abs(settings.DatabasePath)
	if err != nil {
		return "", err
	}
	dataRoot := filepath.Dir(databasePath)
	if canonicalStorage, err := filepath.EvalSymlinks(storagePath); err == nil {
		storagePath = canonicalStorage
	}
	if canonicalData, err := filepath.EvalSymlinks(dataRoot); err == nil {
		dataRoot = canonicalData
	}
	if within(resolved, storagePath) || within(storagePath, resolved) || within(resolved, dataRoot) || within(dataRoot, resolved) {
		return "", errors.New("backup destination must be outside the application data directory")
	}
	return resolved, nil
}

func within(path, parent string) bool {
	relative, err := filepath.Rel(parent, path)
	return err == nil && (relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)))
}

func readCurrent(destination string) (string, error) {
	path := filepath.Join(destination, "CURRENT")
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	bytes, err := readRegularBounded(path, 128)
	if err != nil {
		return "", err
	}
	id := strings.TrimSuffix(string(bytes), "\n")
	if !safeID.MatchString(id) {
		return "", errors.New("invalid backup CURRENT pointer")
	}
	return id, nil
}

func objectPath(root, id string) string { return filepath.Join(root, id[:2], id) }
func validDigest(value string) bool {
	_, err := hex.DecodeString(value)
	return len(value) == 64 && err == nil && value == strings.ToLower(value)
}
func hexDigest(bytes []byte) string { sum := sha256.Sum256(bytes); return hex.EncodeToString(sum[:]) }

// hashObject validates and hashes the same no-follow regular-file descriptor.
func hashObject(root, id string) (string, error) {
	file, err := storage.OpenObjectRead(root, id)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	prepareBackupStream(file)
	if _, err := hashBackupFileWindows(context.Background(), hasher, file, info.Size()); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func hashObjectAt(root *os.File, id string) (string, error) {
	return hashObjectAtContext(context.Background(), root, id)
}

func hashObjectAtContext(ctx context.Context, root *os.File, id string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	file, err := storage.OpenObjectReadAt(root, id)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	prepareBackupStream(file)
	if _, err := hashBackupFileWindows(ctx, hasher, file, info.Size()); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func hashBackupFileWindows(ctx context.Context, target io.Writer, source *os.File, expectedSize int64) (int64, error) {
	buffer := make([]byte, 128*1024)
	var read int64
	for read < expectedSize {
		if err := ctx.Err(); err != nil {
			return read, err
		}
		windowSize := min(backupStreamWindowBytes, expectedSize-read)
		reader := snapshotContextReader{ctx: ctx, reader: io.LimitReader(source, windowSize)}
		count, err := io.CopyBuffer(target, reader, buffer)
		if err != nil {
			return read + count, err
		}
		if count != windowSize {
			return read + count, io.ErrUnexpectedEOF
		}
		if err := ctx.Err(); err != nil {
			return read + count, err
		}
		discardBackupStreamWindow(source, read, count)
		read += count
	}
	var extra [1]byte
	reader := snapshotContextReader{ctx: ctx, reader: source}
	if n, err := reader.Read(extra[:]); n != 0 || err == nil {
		return read + int64(n), errors.New("backup object grew while hashing")
	} else if !errors.Is(err, io.EOF) {
		return read, err
	}
	return read, nil
}

func objectFileSizeAt(root *os.File, id string) int64 {
	file, err := storage.OpenObjectReadAt(root, id)
	if err != nil {
		return -1
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return -1
	}
	return info.Size()
}

func hashFile(path string) (string, error) {
	return hashFileContext(context.Background(), path)
}

func hashFileContext(ctx context.Context, path string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	file, err := openBackupRegular(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	hasher := sha256.New()
	prepareBackupStream(file)
	if _, err := hashBackupFileWindows(ctx, hasher, file, info.Size()); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func regularFileSize(path string) int64 {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return -1
	}
	return info.Size()
}

func syncPrivateSnapshot(stageFD int) (err error) {
	// VACUUM INTO uses SQLite's default creation mode. Set private permissions
	// on the regular file under the held stage, before syncing or publishing it.
	fd, err := unix.Openat(stageFD, snapshotName, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), snapshotName)
	defer func() { err = errors.Join(err, file.Close()) }()
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil {
		return err
	}
	if info.Mode&unix.S_IFMT != unix.S_IFREG || info.Nlink != 1 {
		return errors.New("backup snapshot must be a regular file with one link")
	}
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	return file.Sync()
}

func syncDirectory(path string) error {
	directory, err := fssecure.OpenDirectory(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func writeSynced(path string, bytes []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(bytes); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func writeAtomic(directory, name string, bytes []byte) error {
	return writeAtomicWithHook(directory, name, bytes, nil)
}

func checkpoint(hooks createHooks, name string) {
	if hooks.afterStep != nil {
		hooks.afterStep(name)
	}
}

func randomID() (string, error) {
	var bytes [24]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes[:]), nil
}
