package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"xdrive/internal/backup"
	"xdrive/internal/config"
	"xdrive/internal/db"
)

func TestBackupCommandHonorsCancellationContext(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "data", "xdrive.db")
	storagePath := filepath.Join(root, "data", "objects")
	if err := os.MkdirAll(storagePath, 0700); err != nil {
		t.Fatal(err)
	}
	database, err := db.Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "backup")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_DATABASE_PATH", databasePath)
	t.Setenv("XDRIVE_STORAGE_PATH", storagePath)
	t.Setenv("XDRIVE_SECRET_PATH", filepath.Join(root, "data", "server.secret"))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err = runContext([]string{"backup", destination}, ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("backup command ignored cancellation: %v", err)
	}
	if current, err := os.Lstat(filepath.Join(destination, "CURRENT")); !os.IsNotExist(err) {
		t.Fatalf("cancelled CLI backup published CURRENT: info=%v err=%v", current, err)
	}
}

func TestServeListenFailureStopsCleanupLoop(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "data", "xdrive.db")
	storagePath := filepath.Join(root, "data", "objects")
	if err := os.MkdirAll(storagePath, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_DATABASE_PATH", databasePath)
	t.Setenv("XDRIVE_STORAGE_PATH", storagePath)
	t.Setenv("XDRIVE_SECRET_PATH", filepath.Join(root, "data", "server.secret"))
	t.Setenv("XDRIVE_LISTEN_ADDR", "127.0.0.1:65536")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- runContext(nil, ctx) }()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("serve unexpectedly accepted an invalid port")
		}
	case <-time.After(2 * time.Second):
		cancel()
		<-result
		t.Fatal("serve error returned without stopping the cleanup loop")
	}
}

func TestInspectBackupCommandPrintsVerifiedSummary(t *testing.T) {
	root := t.TempDir()
	settings := config.Config{
		DatabasePath: filepath.Join(root, "data", "xdrive.db"),
		StoragePath:  filepath.Join(root, "data", "objects"),
		SecretPath:   filepath.Join(root, "data", "server.secret"),
	}
	if err := os.MkdirAll(settings.StoragePath, 0700); err != nil {
		t.Fatal(err)
	}
	database, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "backup")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	if err := backup.Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}

	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	previousStdout := os.Stdout
	os.Stdout = write
	runErr := run([]string{"inspect-backup", destination})
	closeErr := write.Close()
	os.Stdout = previousStdout
	if runErr != nil {
		t.Fatal(runErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	output, err := io.ReadAll(read)
	if err != nil {
		t.Fatal(err)
	}
	if err := read.Close(); err != nil {
		t.Fatal(err)
	}
	var summary backup.BackupInfo
	if err := json.Unmarshal(output, &summary); err != nil {
		t.Fatalf("command output is not backup summary JSON: %s: %v", output, err)
	}
	if summary.Generation == "" || summary.SchemaVersion != db.CurrentSchemaVersion || summary.ObjectCount != 0 || summary.TotalObjectBytes != 0 {
		t.Fatalf("unexpected CLI summary: %+v", summary)
	}
}

func TestInspectBackupCommandAcceptsExplicitHistoricalGeneration(t *testing.T) {
	root := t.TempDir()
	settings := config.Config{
		DatabasePath: filepath.Join(root, "data", "xdrive.db"),
		StoragePath:  filepath.Join(root, "data", "objects"),
		SecretPath:   filepath.Join(root, "data", "server.secret"),
	}
	if err := os.MkdirAll(settings.StoragePath, 0700); err != nil {
		t.Fatal(err)
	}
	database, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "backup")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	if err := backup.Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	first, err := backup.Inspect(context.Background(), destination)
	if err != nil {
		t.Fatal(err)
	}
	if err := backup.Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}

	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	previousStdout := os.Stdout
	os.Stdout = write
	runErr := run([]string{"inspect-backup", "--generation", first.Generation, destination})
	closeErr := write.Close()
	os.Stdout = previousStdout
	if runErr != nil {
		t.Fatal(runErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	output, err := io.ReadAll(read)
	if err != nil {
		t.Fatal(err)
	}
	if err := read.Close(); err != nil {
		t.Fatal(err)
	}
	var summary backup.BackupInfo
	if err := json.Unmarshal(output, &summary); err != nil {
		t.Fatalf("command output is not backup summary JSON: %s: %v", output, err)
	}
	if summary.Generation != first.Generation {
		t.Fatalf("CLI inspected wrong generation: got %q, want %q", summary.Generation, first.Generation)
	}
}

func TestRestoreStagedPreservesSelectedSchemaWithoutMigration(t *testing.T) {
	root := t.TempDir()
	backupDir := filepath.Join(root, "backup")
	generation := createSchemaSixBackup(t, root, backupDir)
	info, err := backup.InspectGeneration(context.Background(), backupDir, generation)
	if err != nil || info.SchemaVersion != 6 {
		t.Fatalf("expected a verified schema-6 generation: info=%+v err=%v", info, err)
	}

	target := config.Config{
		DatabasePath: filepath.Join(root, "stage", "ready", "xdrive.db"),
		StoragePath:  filepath.Join(root, "stage", "ready", "objects"),
		SecretPath:   filepath.Join(root, "stage", "ready", "server.secret"),
	}
	t.Setenv("XDRIVE_DATABASE_PATH", target.DatabasePath)
	t.Setenv("XDRIVE_STORAGE_PATH", target.StoragePath)
	t.Setenv("XDRIVE_SECRET_PATH", target.SecretPath)
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	previousStdout := os.Stdout
	os.Stdout = write
	runErr := run([]string{"restore-staged", "--generation", info.Generation, backupDir})
	closeErr := write.Close()
	os.Stdout = previousStdout
	if runErr != nil {
		t.Fatal(runErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	output, err := io.ReadAll(read)
	if err != nil {
		t.Fatal(err)
	}
	if err := read.Close(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(output), "without application migration") {
		t.Fatalf("restore-staged did not state its migration behavior: %s", output)
	}
	staged, err := db.OpenBackupMetadata(context.Background(), target.DatabasePath)
	if err != nil {
		t.Fatalf("staged database was migrated or is not readable as an old schema: %v", err)
	}
	defer staged.Close()
	var schemaVersion int
	if err := staged.QueryRow("PRAGMA user_version").Scan(&schemaVersion); err != nil || schemaVersion != 6 {
		t.Fatalf("restore-staged changed schema version: got %d, want 6: %v", schemaVersion, err)
	}
}

func TestRestoreStagedCLIUsesConfiguredDataRoot(t *testing.T) {
	root := t.TempDir()
	source := config.Config{
		DatabasePath: filepath.Join(root, "active", "xdrive.db"),
		StoragePath:  filepath.Join(root, "active", "objects"),
		SecretPath:   filepath.Join(root, "active", "server.secret"),
	}
	if err := os.MkdirAll(source.StoragePath, 0700); err != nil {
		t.Fatal(err)
	}
	database, err := db.Open(context.Background(), source.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	backupDir := filepath.Join(root, "backup")
	if err := os.Mkdir(backupDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := backup.Create(context.Background(), source, backupDir, true); err != nil {
		t.Fatal(err)
	}

	target := config.Config{
		DatabasePath: filepath.Join(root, "staged", "xdrive.db"),
		StoragePath:  filepath.Join(root, "staged", "objects"),
		SecretPath:   filepath.Join(root, "staged", "server.secret"),
	}
	if err := os.Mkdir(filepath.Dir(target.DatabasePath), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_DATABASE_PATH", target.DatabasePath)
	t.Setenv("XDRIVE_STORAGE_PATH", target.StoragePath)
	t.Setenv("XDRIVE_SECRET_PATH", target.SecretPath)
	t.Setenv("XDRIVE_DISK_SAFETY_BYTES", "0")
	t.Setenv("XDRIVE_MAINTENANCE_RESERVE_BYTES", "0")
	if err := run([]string{"restore-staged", backupDir}); err != nil {
		t.Fatalf("restore-staged CLI: %v", err)
	}
	settings, err := config.Load("")
	if err != nil {
		t.Fatal(err)
	}
	if err := runDoctor(settings, ""); err != nil {
		t.Fatalf("doctor after staged restore: %v", err)
	}
}

func createSchemaSixBackup(t *testing.T, root, backupDir string) string {
	t.Helper()
	source := config.Config{
		DatabasePath: filepath.Join(root, "schema6-source", "xdrive.db"),
		StoragePath:  filepath.Join(root, "schema6-source", "objects"),
		SecretPath:   filepath.Join(root, "schema6-source", "server.secret"),
	}
	if err := os.MkdirAll(source.StoragePath, 0700); err != nil {
		t.Fatal(err)
	}
	database, err := db.Open(context.Background(), source.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{"DROP INDEX objects_deleted_gc_idx", "DROP TABLE object_gc_state", "PRAGMA user_version=6", "PRAGMA wal_checkpoint(TRUNCATE)"} {
		if _, err := database.Exec(statement); err != nil {
			_ = database.Close()
			t.Fatalf("prepare schema-6 source: %v", err)
		}
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	generation := "0123456789abcdefghij"
	generationPath := filepath.Join(backupDir, "snapshots", generation)
	for _, directory := range []string{generationPath, filepath.Join(backupDir, "objects")} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(backupDir, ".backup.lock"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	snapshotBytes, err := os.ReadFile(source.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(generationPath, "db.sqlite.snapshot"), snapshotBytes, 0600); err != nil {
		t.Fatal(err)
	}
	manifest := backup.ObjectManifest{FormatVersion: 1, Objects: []backup.Object{}}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(generationPath, "OBJECTS.json"), manifestBytes, 0600); err != nil {
		t.Fatal(err)
	}
	snapshotDigest := sha256.Sum256(snapshotBytes)
	manifestDigest := sha256.Sum256(manifestBytes)
	header := struct {
		FormatVersion    int    `json:"formatVersion"`
		CreatedAt        int64  `json:"createdAt"`
		SchemaVersion    int    `json:"schemaVersion"`
		SnapshotSHA256   string `json:"snapshotSha256"`
		ManifestSHA256   string `json:"manifestSha256"`
		ObjectCount      int    `json:"objectCount"`
		TotalObjectBytes int64  `json:"totalObjectBytes"`
	}{1, 1, 6, hex.EncodeToString(snapshotDigest[:]), hex.EncodeToString(manifestDigest[:]), 0, 0}
	headerBytes, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(generationPath, "BACKUP.json"), headerBytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backupDir, "CURRENT"), []byte(generation+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return generation
}
