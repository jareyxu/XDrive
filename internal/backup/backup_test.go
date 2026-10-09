package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
	"xdrive/internal/server"
	"xdrive/internal/storage"
)

func backupFixture(t *testing.T) (config.Config, string, string, []byte) {
	t.Helper()
	root := t.TempDir()
	settings := config.Config{
		DatabasePath: filepath.Join(root, "data", "drive.db"),
		StoragePath:  filepath.Join(root, "data", "objects"),
		SecretPath:   filepath.Join(root, "data", "server.secret"),
	}
	destination := filepath.Join(root, "external-backup")
	if err := os.MkdirAll(destination, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(settings.StoragePath, 0o700); err != nil {
		t.Fatal(err)
	}
	objectID := "abcdefghijklmnopqrstuvwx"
	content := bytes.Repeat([]byte{0x5a}, 128)
	path := objectPath(settings.StoragePath, objectID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	database, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	if _, err := database.Exec(`INSERT INTO objects (id, size_bytes, sha256, state, created_at) VALUES (?, ?, ?, 'live', ?)`, objectID, len(content), digest[:], time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	return settings, destination, objectID, content
}

type cancelOnFirstWrite struct {
	cancel context.CancelFunc
	writes int
}

func (writer *cancelOnFirstWrite) Write(data []byte) (int, error) {
	if writer.writes == 0 {
		writer.cancel()
	}
	writer.writes++
	return len(data), nil
}

func TestBackupHashStopsInsideWindowWhenContextIsCancelled(t *testing.T) {
	const size = 4 << 20
	path := filepath.Join(t.TempDir(), "object")
	if err := os.WriteFile(path, bytes.Repeat([]byte{0x31}, size), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writer := &cancelOnFirstWrite{cancel: cancel}

	read, err := hashBackupFileWindows(ctx, writer, file, size)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("hash should propagate cancellation, read=%d err=%v", read, err)
	}
	if read != 128*1024 || writer.writes != 1 {
		t.Fatalf("hash continued after cancellation: read=%d writes=%d", read, writer.writes)
	}
}

func TestCreateCancellationDuringObjectCopyDoesNotPublishOrLeaveStage(t *testing.T) {
	settings, destination, objectID, _ := backupFixture(t)
	const objectSize = 8 << 20
	sourcePath := objectPath(settings.StoragePath, objectID)
	source, err := os.OpenFile(sourcePath, os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := source.Truncate(objectSize); err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(make([]byte, objectSize))
	database, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE objects SET size_bytes = ?, sha256 = ? WHERE id = ?`, objectSize, digest[:], objectID); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelledDuringCopy := false
	err = createWithHooks(ctx, settings, destination, false, createHooks{afterStep: func(step string) {
		if step == "object-0-copy-partial" {
			cancelledDuringCopy = true
			cancel()
		}
	}})
	if !cancelledDuringCopy || !errors.Is(err, context.Canceled) {
		t.Fatalf("backup did not stop at the copy cancellation point: reached=%v err=%v", cancelledDuringCopy, err)
	}
	current, err := readCurrent(destination)
	if err != nil || current != "" {
		t.Fatalf("cancelled backup published CURRENT: %q %v", current, err)
	}
	stages, err := os.ReadDir(filepath.Join(destination, "snapshots"))
	if err != nil || len(stages) != 0 {
		t.Fatalf("cancelled backup left staging state: %v %v", stages, err)
	}
	if err := filepath.WalkDir(filepath.Join(destination, "objects"), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Name() == objectID || strings.HasPrefix(entry.Name(), ".copy-") {
			return fmt.Errorf("cancelled backup left published or temporary object %s", path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBackupSnapshotRetainsObjectAfterConcurrentLogicalPurge(t *testing.T) {
	settings, destination, objectID, content := backupFixture(t)
	err := create(context.Background(), settings, destination, true, func() error {
		live, err := db.Open(context.Background(), settings.DatabasePath)
		if err != nil {
			return err
		}
		defer live.Close()
		if _, err := live.Exec("UPDATE objects SET state = 'deleted' WHERE id = ?", objectID); err != nil {
			return err
		}
		return server.CleanupOnce(context.Background(), live, settings.StoragePath, time.Now())
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(context.Background(), destination); err != nil {
		t.Fatalf("published backup did not verify: %v", err)
	}
	if got, err := os.ReadFile(objectPath(filepath.Join(destination, "objects"), objectID)); err != nil || !bytes.Equal(got, content) {
		t.Fatalf("snapshot object was not retained: bytes=%d error=%v", len(got), err)
	}
	if _, err := os.Stat(objectPath(settings.StoragePath, objectID)); err != nil {
		t.Fatalf("cleanup bypassed active backup lock: %v", err)
	}
	live, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	if err := server.CleanupOnce(context.Background(), live, settings.StoragePath, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(objectPath(settings.StoragePath, objectID)); !os.IsNotExist(err) {
		t.Fatalf("deferred cleanup did not remove source object: %v", err)
	}
}

func TestInspectReturnsVerifiedNonSensitiveBackupSummary(t *testing.T) {
	settings, destination, objectID, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	info, err := Inspect(context.Background(), destination)
	if err != nil {
		t.Fatal(err)
	}
	if info.Generation == "" || info.CreatedAt.IsZero() || info.SchemaVersion != db.CurrentSchemaVersion || info.ObjectCount != 1 || info.TotalObjectBytes != 128 {
		t.Fatalf("unexpected verified backup summary: %+v", info)
	}
	encoded, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), objectID) {
		t.Fatalf("summary disclosed an opaque object identifier: %s", encoded)
	}
	if err := os.WriteFile(objectPath(filepath.Join(destination, "objects"), objectID), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(context.Background(), destination); err == nil {
		t.Fatal("inspection returned recovery details for a corrupt backup")
	}
}

func TestInspectBackupDoesNotModifyBackupDirectory(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(destination, 0500); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(destination, 0700) }()
	if _, err := Inspect(context.Background(), destination); err != nil {
		t.Fatalf("inspection failed on a read-only backup directory: %v", err)
	}
}

func TestInspectBackupFailsWithoutCreatingMissingLock(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(destination, ".backup.lock")
	if err := os.Remove(lockPath); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(context.Background(), destination); err == nil {
		t.Fatal("inspection succeeded without the backup coordination lock")
	}
	if _, err := os.Lstat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("inspection recreated the missing coordination lock: %v", err)
	}
}

func TestInspectAndRestoreExplicitGeneration(t *testing.T) {
	settings, destination, objectID, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	first, err := Inspect(context.Background(), destination)
	if err != nil {
		t.Fatal(err)
	}

	database, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("UPDATE objects SET state = 'deleted' WHERE id = ?", objectID); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	latest, err := Inspect(context.Background(), destination)
	if err != nil {
		t.Fatal(err)
	}
	if latest.Generation == first.Generation || latest.ObjectCount != 0 {
		t.Fatalf("second snapshot did not advance CURRENT: first=%+v latest=%+v", first, latest)
	}
	selected, err := InspectGeneration(context.Background(), destination, first.Generation)
	if err != nil {
		t.Fatal(err)
	}
	if selected.Generation != first.Generation || selected.ObjectCount != 1 {
		t.Fatalf("explicit generation did not inspect historical snapshot: %+v", selected)
	}
	if err := VerifyGeneration(context.Background(), destination, first.Generation); err != nil {
		t.Fatalf("verify selected historical generation: %v", err)
	}

	restored := config.Config{
		DatabasePath: filepath.Join(filepath.Dir(settings.DatabasePath), "restore-old", "xdrive.db"),
		StoragePath:  filepath.Join(filepath.Dir(settings.DatabasePath), "restore-old", "objects"),
		SecretPath:   filepath.Join(filepath.Dir(settings.DatabasePath), "restore-old", "server.secret"),
	}
	if err := RestoreGeneration(context.Background(), restored, destination, first.Generation); err != nil {
		t.Fatalf("restore selected historical generation: %v", err)
	}
	restoredDB, err := db.Open(context.Background(), restored.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer restoredDB.Close()
	var liveObjects int
	if err := restoredDB.QueryRow("SELECT COUNT(*) FROM objects WHERE state = 'live'").Scan(&liveObjects); err != nil {
		t.Fatal(err)
	}
	if liveObjects != 1 {
		t.Fatalf("restore selected the wrong generation: live object count=%d", liveObjects)
	}
	current, err := readCurrent(destination)
	if err != nil || current != latest.Generation {
		t.Fatalf("historical restore changed CURRENT: current=%q want=%q err=%v", current, latest.Generation, err)
	}
}

func TestRestoreGenerationStagedPreservesSchemaSevenAndResetsGCProgress(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	database, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("UPDATE object_gc_state SET cursor = 'recovery-test-cursor', generation = 3 WHERE id = 1"); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	restored := config.Config{
		DatabasePath: filepath.Join(filepath.Dir(settings.DatabasePath), "restore-staged", "xdrive.db"),
		StoragePath:  filepath.Join(filepath.Dir(settings.DatabasePath), "restore-staged", "objects"),
		SecretPath:   filepath.Join(filepath.Dir(settings.DatabasePath), "restore-staged", "server.secret"),
	}
	if err := RestoreGenerationStaged(context.Background(), restored, destination, ""); err != nil {
		t.Fatalf("restore schema-7 snapshot without migration: %v", err)
	}
	restoredDB, err := db.OpenBackupMetadata(context.Background(), restored.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer restoredDB.Close()
	var schemaVersion, generation int
	var cursor string
	if err := restoredDB.QueryRow("PRAGMA user_version").Scan(&schemaVersion); err != nil || schemaVersion != 7 {
		t.Fatalf("schema changed during staged restore: got %d, want 7: %v", schemaVersion, err)
	}
	if err := restoredDB.QueryRow("SELECT cursor,generation FROM object_gc_state WHERE id=1").Scan(&cursor, &generation); err != nil || cursor != "" || generation != 0 {
		t.Fatalf("staged restore retained an obsolete GC cursor: cursor=%q generation=%d err=%v", cursor, generation, err)
	}
}

func TestBackupSnapshotExcludesConcurrentPostSnapshotObjectWrite(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	objectID := "post_snapshot_object"
	content := bytes.Repeat([]byte{0x7c}, 96)
	err := create(context.Background(), settings, destination, true, func() error {
		path := objectPath(settings.StoragePath, objectID)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		if err := os.WriteFile(path, content, 0600); err != nil {
			return err
		}
		digest := sha256.Sum256(content)
		live, err := db.Open(context.Background(), settings.DatabasePath)
		if err != nil {
			return err
		}
		defer live.Close()
		_, err = live.Exec(`INSERT INTO objects (id, size_bytes, sha256, state, created_at) VALUES (?, ?, ?, 'live', ?)`, objectID, len(content), digest[:], time.Now().Unix())
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(context.Background(), destination); err != nil {
		t.Fatalf("backup made from the earlier SQLite snapshot did not verify: %v", err)
	}
	generation, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	_, manifest, _, err := inspectGeneration(context.Background(), destination, generation, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, object := range manifest.Objects {
		if object.ID == objectID {
			t.Fatal("backup included an object created after its SQLite snapshot")
		}
	}
	if _, err := os.Stat(objectPath(filepath.Join(destination, "objects"), objectID)); !os.IsNotExist(err) {
		t.Fatalf("post-snapshot object was copied into backup: %v", err)
	}
	if _, err := os.Stat(objectPath(settings.StoragePath, objectID)); err != nil {
		t.Fatalf("concurrent source object write was not retained: %v", err)
	}
}

func TestServerStartupWaitsForActiveBackup(t *testing.T) {
	settings, _, _, _ := backupFixture(t)
	settings.ListenAddr = "127.0.0.1:0"
	settings.Username = "admin"
	lease, err := storage.AcquireBackupLease(context.Background(), settings.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		handler, err := server.New(settings)
		if err == nil {
			err = handler.Close()
		}
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("server started while backup held deletion lock: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not start after backup released deletion lock")
	}
}

func TestBackupFailureKeepsPreviouslyPublishedGeneration(t *testing.T) {
	settings, destination, objectID, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	prior, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(objectPath(settings.StoragePath, objectID), bytes.Repeat([]byte{0x31}, 128), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Create(context.Background(), settings, destination, false); err == nil {
		t.Fatal("backup accepted source corruption")
	}
	after, err := readCurrent(destination)
	if err != nil || after != prior {
		t.Fatalf("failed backup replaced completed generation: before=%q after=%q error=%v", prior, after, err)
	}
	if err := Verify(context.Background(), destination); err != nil {
		t.Fatalf("previous completed backup was damaged: %v", err)
	}
}

func TestBackupObjectDirectorySyncFailureKeepsPreviouslyPublishedGeneration(t *testing.T) {
	for _, syncTarget := range []string{"destination", "objects"} {
		t.Run(syncTarget, func(t *testing.T) {
			settings, destination, _, _ := backupFixture(t)
			if err := Create(context.Background(), settings, destination, true); err != nil {
				t.Fatal(err)
			}
			prior, err := readCurrent(destination)
			if err != nil || prior == "" {
				t.Fatalf("read prior generation: %q %v", prior, err)
			}
			fault := errors.New("injected directory fsync failure")
			resolvedDestination, err := filepath.EvalSymlinks(destination)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(resolvedDestination, "objects")
			if syncTarget == "destination" {
				path = resolvedDestination
			}
			var synced []string
			err = createWithHooks(context.Background(), settings, destination, true, createHooks{
				syncDirectory: func(directory string) error {
					synced = append(synced, directory)
					if directory == path {
						return fault
					}
					return syncDirectory(directory)
				},
			})
			if !errors.Is(err, fault) {
				t.Fatalf("expected injected sync error at %q, got %v; synced=%q", path, err, synced)
			}
			current, err := readCurrent(destination)
			if err != nil || current != prior {
				t.Fatalf("failed durability barrier published a generation: before=%q after=%q error=%v", prior, current, err)
			}
			if err := Verify(context.Background(), destination); err != nil {
				t.Fatalf("prior completed generation became unusable: %v", err)
			}
		})
	}
}

func TestBackupProcessCrashAtPublicationBoundaries(t *testing.T) {
	checkpoints := []string{
		"snapshot-synced",
		"object-0-synced",
		"object-1-copy-partial",
		"object-1-copy-temp-synced",
		"object-1-copy-renamed",
		"object-1-copy-shard-synced",
		"object-1-synced",
		"objects-root-synced",
		"manifest-synced",
		"header-synced",
		"staging-synced",
		"generation-renamed",
		"snapshots-synced",
		"current-temp-synced",
		"current-renamed",
		"current-directory-synced",
	}
	for _, checkpointName := range checkpoints {
		t.Run(checkpointName, func(t *testing.T) {
			settings, destination, _, _ := backupFixture(t)
			if err := Create(context.Background(), settings, destination, true); err != nil {
				t.Fatal(err)
			}
			prior, err := readCurrent(destination)
			if err != nil || prior == "" {
				t.Fatalf("read prior generation: %q %v", prior, err)
			}
			addBackupFixtureObject(t, settings, "zyxwvutsrqponmlkjihgfedc", bytes.Repeat([]byte{0x27}, 256*1024+64))

			payload, err := json.Marshal(struct {
				Settings    config.Config `json:"settings"`
				Destination string        `json:"destination"`
				Checkpoint  string        `json:"checkpoint"`
			}{settings, destination, checkpointName})
			if err != nil {
				t.Fatal(err)
			}
			command := exec.Command(os.Args[0], "-test.run=^TestBackupCrashChild$")
			command.Env = append(os.Environ(), "XDRIVE_BACKUP_CRASH_CONFIG="+base64.StdEncoding.EncodeToString(payload))
			output, err := command.CombinedOutput()
			var exitError *exec.ExitError
			if !errors.As(err, &exitError) || exitError.ExitCode() != 86 {
				t.Fatalf("child did not terminate at %q with the injected exit code: err=%v output=%s", checkpointName, err, output)
			}
			switch checkpointName {
			case "object-1-copy-partial":
				assertInterruptedCopySize(t, destination, 128*1024)
			case "object-1-copy-temp-synced":
				assertInterruptedCopySize(t, destination, 256*1024+64)
			}

			current, err := readCurrent(destination)
			if err != nil {
				t.Fatal(err)
			}
			publishedBeforePointerRename := checkpointName != "current-renamed" && checkpointName != "current-directory-synced"
			if publishedBeforePointerRename && current != prior {
				t.Fatalf("crashed unpublished generation changed CURRENT: before=%q after=%q", prior, current)
			}
			if !publishedBeforePointerRename && current == prior {
				t.Fatalf("CURRENT rename checkpoint did not publish the new generation: %q", current)
			}
			if _, _, _, err := inspectGeneration(context.Background(), destination, prior, true); err != nil {
				t.Fatalf("previous completed generation is unusable after crash: %v", err)
			}
			if err := Verify(context.Background(), destination); err != nil {
				t.Fatalf("CURRENT does not identify a complete generation after crash: %v", err)
			}

			// A new process must acquire both backup leases and clean any
			// unpublished stage/temp files before publishing another generation.
			if err := Create(context.Background(), settings, destination, true); err != nil {
				t.Fatalf("backup could not recover after child process exit: %v", err)
			}
			assertNoInterruptedBackupWork(t, destination)
			if err := Verify(context.Background(), destination); err != nil {
				t.Fatalf("recovered backup does not verify: %v", err)
			}
		})
	}
}

// TestBackupCrashChild runs only in a subprocess launched by
// TestBackupProcessCrashAtPublicationBoundaries. os.Exit deliberately skips
// defers so the test exercises process death rather than graceful cleanup.
func TestBackupCrashChild(t *testing.T) {
	encoded := os.Getenv("XDRIVE_BACKUP_CRASH_CONFIG")
	if encoded == "" {
		return
	}
	payload, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Settings    config.Config `json:"settings"`
		Destination string        `json:"destination"`
		Checkpoint  string        `json:"checkpoint"`
	}
	if err := json.Unmarshal(payload, &input); err != nil {
		t.Fatal(err)
	}
	err = createWithHooks(context.Background(), input.Settings, input.Destination, true, createHooks{
		afterStep: func(step string) {
			if step == input.Checkpoint {
				os.Exit(86)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Fatalf("backup completed without reaching requested crash checkpoint %q", input.Checkpoint)
}

func addBackupFixtureObject(t *testing.T, settings config.Config, objectID string, content []byte) {
	t.Helper()
	path := objectPath(settings.StoragePath, objectID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	database, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO objects (id, size_bytes, sha256, state, created_at) VALUES (?, ?, ?, 'live', ?)`, objectID, len(content), digest[:], time.Now().Unix()); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
}

func assertNoInterruptedBackupWork(t *testing.T, destination string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(destination, "snapshots"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".staging-") {
			t.Errorf("interrupted stage remains after recovery: %s", entry.Name())
		}
	}
	entries, err = os.ReadDir(destination)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".current-") {
			t.Errorf("interrupted CURRENT temporary file remains after recovery: %s", entry.Name())
		}
	}
	shards, err := os.ReadDir(filepath.Join(destination, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	for _, shard := range shards {
		if !shard.IsDir() {
			continue
		}
		objects, err := os.ReadDir(filepath.Join(destination, "objects", shard.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, object := range objects {
			if strings.HasPrefix(object.Name(), ".copy-") {
				t.Errorf("interrupted object copy remains after recovery: %s", object.Name())
			}
		}
	}
}

func assertInterruptedCopySize(t *testing.T, destination string, expected int64) {
	t.Helper()
	shards, err := os.ReadDir(filepath.Join(destination, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	var temporaryPaths []string
	for _, shard := range shards {
		if !shard.IsDir() {
			continue
		}
		objects, err := os.ReadDir(filepath.Join(destination, "objects", shard.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, object := range objects {
			if strings.HasPrefix(object.Name(), ".copy-") {
				temporaryPaths = append(temporaryPaths, filepath.Join(destination, "objects", shard.Name(), object.Name()))
			}
		}
	}
	if len(temporaryPaths) != 1 {
		t.Fatalf("expected one interrupted object-copy file, found %d: %q", len(temporaryPaths), temporaryPaths)
	}
	info, err := os.Stat(temporaryPaths[0])
	if err != nil || info.Size() != expected {
		t.Fatalf("interrupted object-copy size = %v, want %d: %v", info, expected, err)
	}
}

func TestBackupRejectsDestinationContainingApplicationData(t *testing.T) {
	settings, _, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, filepath.Dir(filepath.Dir(settings.DatabasePath)), false); err == nil {
		t.Fatal("backup accepted a destination that contains its own application data")
	}
	if err := Create(context.Background(), settings, settings.StoragePath, false); err == nil {
		t.Fatal("backup accepted its own object store as a destination")
	}
}

func TestBackupVerifyDetectsSameSizeTargetCorruption(t *testing.T) {
	settings, destination, objectID, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(objectPath(filepath.Join(destination, "objects"), objectID), bytes.Repeat([]byte{0x31}, 128), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Verify(context.Background(), destination); err == nil {
		t.Fatal("full verification accepted same-size corrupted target object")
	}
}

func TestIncrementalBackupRepairsSameSizeTargetCorruption(t *testing.T) {
	settings, destination, objectID, content := backupFixture(t)
	if err := Create(context.Background(), settings, destination, false); err != nil {
		t.Fatal(err)
	}
	backupObject := objectPath(filepath.Join(destination, "objects"), objectID)
	if err := os.WriteFile(backupObject, bytes.Repeat([]byte{0x31}, len(content)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Create(context.Background(), settings, destination, false); err != nil {
		t.Fatalf("incremental backup should repair the damaged shared copy: %v", err)
	}
	if err := Verify(context.Background(), destination); err != nil {
		t.Fatalf("newly published generation references a damaged object: %v", err)
	}
}

func TestNextBackupRemovesInterruptedGenerationAndCopy(t *testing.T) {
	settings, destination, objectID, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, false); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(destination, "snapshots", ".staging-ABCDEFGHIJKLMNOPQRSTUVWX")
	if err := os.MkdirAll(stale, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, snapshotName), []byte("unfinished"), 0o600); err != nil {
		t.Fatal(err)
	}
	temporary := filepath.Join(filepath.Dir(objectPath(filepath.Join(destination, "objects"), objectID)), ".copy-interrupted")
	if err := os.WriteFile(temporary, []byte("unfinished"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Create(context.Background(), settings, destination, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("interrupted generation remains: %v", err)
	}
	if _, err := os.Stat(temporary); !os.IsNotExist(err) {
		t.Fatalf("interrupted object copy remains: %v", err)
	}
	if err := Verify(context.Background(), destination); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyWaitsForBackupDestinationWriter(t *testing.T) {
	_, destination, _, _ := backupFixture(t)
	lease, err := storage.AcquireBackupLease(context.Background(), destination)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if err := Verify(ctx, destination); err != context.DeadlineExceeded {
		t.Fatalf("verification read backup destination while writer held lock: %v", err)
	}
}

func TestRestoreValidatesBeforeActivationAndResetsAuthentication(t *testing.T) {
	settings, destination, objectID, content := backupFixture(t)
	live, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	if _, err := live.Exec(`INSERT INTO users (id, username, auth_salt, auth_hash, state, created_at) VALUES (1, 'admin', ?, ?, 'active', ?)`, bytes.Repeat([]byte{1}, 16), bytes.Repeat([]byte{2}, 32), now); err != nil {
		t.Fatal(err)
	}
	oldToken := "0123456789abcdefghijklmnopqrstuv"
	oldHash := sha256.Sum256([]byte(oldToken))
	if _, err := live.Exec(`INSERT INTO sessions (id_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, 'csrf', ?, ?, ?)`, oldHash[:], now, now, now+3600); err != nil {
		t.Fatal(err)
	}
	if _, err := live.Exec(`INSERT INTO upload_sessions (id, state, reserved_bytes, consumed_bytes, created_at, expires_at) VALUES ('pending-upload-session-012345', 'active', 4096, 64, ?, ?)`, now, now+3600); err != nil {
		t.Fatal(err)
	}
	if _, err := live.Exec("INSERT INTO upload_receive_fences VALUES ('receive-fence-012345678901','pending-upload-session-012345',36,?,?)", bytes.Repeat([]byte{3}, 32), now); err != nil {
		t.Fatal(err)
	}
	if _, err := live.Exec("INSERT INTO upload_object_claims VALUES ('pending-upload-session-012345','receive-fence-012345678901',36,?,?)", bytes.Repeat([]byte{3}, 32), now); err != nil {
		t.Fatal(err)
	}
	if _, err := live.Exec("INSERT INTO metadata_maintenance VALUES(1,'uncommitted-index-aaaaaaaa',36,?)", now); err != nil {
		t.Fatal(err)
	}
	if err := live.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings.SecretPath, bytes.Repeat([]byte{0x17}, 32), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	restoreRoot := filepath.Join(t.TempDir(), "restored-data")
	if err := os.Mkdir(restoreRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	restored := config.Config{
		ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(restoreRoot, "drive.db"),
		StoragePath: filepath.Join(restoreRoot, "objects"), SecretPath: filepath.Join(restoreRoot, "server.secret"), Username: "admin",
	}
	backupObject := objectPath(filepath.Join(destination, "objects"), objectID)
	if err := os.WriteFile(backupObject, bytes.Repeat([]byte{0x31}, len(content)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Restore(context.Background(), restored, destination); err == nil {
		t.Fatal("restore accepted corrupted object")
	}
	entries, err := os.ReadDir(restoreRoot)
	if err != nil || len(entries) != 0 {
		t.Fatalf("invalid backup activated partial data: entries=%d error=%v", len(entries), err)
	}
	if err := os.WriteFile(backupObject, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Restore(context.Background(), restored, destination); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(objectPath(restored.StoragePath, objectID)); err != nil || !bytes.Equal(got, content) {
		t.Fatalf("restored object differs: bytes=%d error=%v", len(got), err)
	}
	secret, err := os.ReadFile(restored.SecretPath)
	if err != nil || len(secret) != 32 || bytes.Equal(secret, bytes.Repeat([]byte{0x17}, 32)) {
		t.Fatalf("restored secret was not rotated: bytes=%d error=%v", len(secret), err)
	}
	database, err := db.Open(context.Background(), restored.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	var sessions, uploads int
	if err := database.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow("SELECT COUNT(*) FROM upload_sessions").Scan(&uploads); err != nil {
		t.Fatal(err)
	}
	var candidates int
	if err := database.QueryRow("SELECT COUNT(*) FROM metadata_maintenance").Scan(&candidates); err != nil || candidates != 0 {
		t.Fatal("restore revived maintenance candidate", err)
	}
	if sessions != 0 || uploads != 0 {
		t.Fatalf("restore revived transient state: sessions=%d uploads=%d", sessions, uploads)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	handler, err := server.New(restored)
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	request.AddCookie(&http.Cookie{Name: "xdrive_session", Value: oldToken})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !bytes.Contains(response.Body.Bytes(), []byte(`"authenticated":false`)) {
		t.Fatalf("old cookie was accepted after restore: %d %s", response.Code, response.Body.String())
	}
}

func TestRestoreSchemaTwoBackupMigratesBeforeActivation(t *testing.T) {
	settings, destination, objectID, content := backupFixture(t)
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	generation, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(destination, "snapshots", generation)
	snapshotPath := filepath.Join(stage, snapshotName)
	snapshot, err := sql.Open("sqlite", "file:"+snapshotPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := snapshot.Exec("DROP TABLE object_gc_state; DROP INDEX objects_deleted_gc_idx"); err != nil {
		t.Fatal(err)
	}
	if _, err := snapshot.Exec("DROP TABLE metadata_maintenance"); err != nil {
		t.Fatal(err)
	}
	if _, err := snapshot.Exec("DROP TABLE upload_receive_fences"); err != nil {
		t.Fatal(err)
	}
	if _, err := snapshot.Exec("PRAGMA user_version=2"); err != nil {
		t.Fatal(err)
	}
	if err := snapshot.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(stage, backupName))
	if err != nil {
		t.Fatal(err)
	}
	var header Header
	if err := json.Unmarshal(raw, &header); err != nil {
		t.Fatal(err)
	}
	header.SchemaVersion = 2
	header.SnapshotSHA256, err = hashFile(snapshotPath)
	if err != nil {
		t.Fatal(err)
	}
	raw, err = json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, backupName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Verify(context.Background(), destination); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	restored := config.Config{DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "server.secret")}
	if err := Restore(context.Background(), restored, destination); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(objectPath(restored.StoragePath, objectID)); err != nil || !bytes.Equal(got, content) {
		t.Fatalf("old backup bytes: %v", err)
	}
	database, err := db.Open(context.Background(), restored.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var version, fences int
	if err := database.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != db.CurrentSchemaVersion {
		t.Fatalf("migration: %d %v", version, err)
	}
	if err := database.QueryRow("SELECT COUNT(*) FROM upload_receive_fences").Scan(&fences); err != nil || fences != 0 {
		t.Fatalf("restored receive fences: %d %v", fences, err)
	}
}
