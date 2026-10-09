package server

import (
	"context"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
	"time"

	"xdrive/internal/config"
)

func TestCleanupOncePurgesExpiredTrashBeforeUnlinkingObjects(t *testing.T) {
	root := t.TempDir()
	storagePath := filepath.Join(root, "objects")
	handler, err := New(config.Config{ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: storagePath, SecretPath: filepath.Join(root, "secret"), Username: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()

	now := time.Now().UTC().Truncate(time.Second)
	tombstoneID := "abcdef0123456789abcdef0123456789"
	metadataID := "abcdefghijklmnopqrstuvwx12345678"
	objectID := "0123456789abcdefghijklmnopqrstuv"
	objectBytes := []byte("encrypted object fixture")
	digest := sha256.Sum256(objectBytes)
	objectPath := filepath.Join(storagePath, objectID[:2], objectID)
	if err := os.MkdirAll(filepath.Dir(objectPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(objectPath, objectBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO objects (id, size_bytes, sha256, state, created_at) VALUES (?, ?, ?, 'live', ?)`, objectID, len(objectBytes), digest[:], now.Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO metadata_pointers (id, object_id, revision, updated_at) VALUES (?, ?, 1, ?)`, metadataID, objectID, now.Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO metadata_versions (metadata_id, revision, object_id, created_at) VALUES (?, 1, ?, ?)`, metadataID, objectID, now.Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO tombstones (id, deleted_at, state) VALUES (?, ?, 'active')`, tombstoneID, now.Add(-trashRetention-time.Second).Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO tombstone_objects (tombstone_id, object_id) VALUES (?, ?)`, tombstoneID, objectID); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO tombstone_metadata (tombstone_id, metadata_id) VALUES (?, ?)`, tombstoneID, metadataID); err != nil {
		t.Fatal(err)
	}

	if err := CleanupOnce(context.Background(), handler.database, storagePath, now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(objectPath); !os.IsNotExist(err) {
		t.Fatalf("expired object file should be unlinked, stat error: %v", err)
	}
	var tombstoneCount, pointerCount, versionCount int
	if err := handler.database.QueryRow("SELECT COUNT(*) FROM tombstones WHERE id = ?", tombstoneID).Scan(&tombstoneCount); err != nil {
		t.Fatal(err)
	}
	if err := handler.database.QueryRow("SELECT COUNT(*) FROM metadata_pointers WHERE id = ?", metadataID).Scan(&pointerCount); err != nil {
		t.Fatal(err)
	}
	if err := handler.database.QueryRow("SELECT COUNT(*) FROM metadata_versions WHERE metadata_id = ?", metadataID).Scan(&versionCount); err != nil {
		t.Fatal(err)
	}
	var objectState string
	if err := handler.database.QueryRow("SELECT state FROM objects WHERE id = ?", objectID).Scan(&objectState); err != nil {
		t.Fatal(err)
	}
	if tombstoneCount != 0 || pointerCount != 0 || versionCount != 0 || objectState != "deleted" {
		t.Fatalf("expired trash remains visible: tombstone=%d pointer=%d versions=%d object=%q", tombstoneCount, pointerCount, versionCount, objectState)
	}
}

func TestServerStartupDefersPhysicalDeletionUntilPeriodicCleanup(t *testing.T) {
	root := t.TempDir()
	settings := config.Config{ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin"}
	initial, err := New(settings)
	if err != nil {
		t.Fatal(err)
	}
	objectID := "0123456789abcdefghijklmnopqrstuv"
	path := filepath.Join(settings.StoragePath, objectID[:2], objectID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	content := []byte("deleted encrypted object")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	if _, err := initial.database.Exec(`INSERT INTO objects (id, size_bytes, sha256, state, created_at) VALUES (?, ?, ?, 'deleted', ?)`, objectID, len(content), digest[:], time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if err := initial.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(settings)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("startup physically deleted an object before upgrade health checks: %v", err)
	}
	if err := CleanupOnce(context.Background(), restarted.database, settings.StoragePath, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("periodic cleanup did not remove deleted object: %v", err)
	}
}

func TestUpgradeRollbackHoldDefersPhysicalUnlinkAndFailsClosed(t *testing.T) {
	h, storagePath := concurrentUploadFixture(t)
	objectID := "0123456789abcdefghijklmnopqrstuv"
	objectPath := writeGCFile(t, storagePath, objectID)
	seedGCIdentities(t, h.database, []string{objectID})
	holdPath := filepath.Join(filepath.Dir(storagePath), UpgradeRollbackHoldFilename)
	if err := os.WriteFile(holdPath, nil, 0o640); err != nil {
		t.Fatal(err)
	}

	if err := CleanupOnceWithPolicyAndHold(context.Background(), h.database, storagePath, time.Now(), trashRetention, config.DefaultMetadataKeepVersions, holdPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(objectPath); err != nil {
		t.Fatalf("physical cleanup ignored upgrade hold: %v", err)
	}
	var state string
	if err := h.database.QueryRow("SELECT state FROM objects WHERE id = ?", objectID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "deleted" {
		t.Fatalf("logical cleanup did not remain committed while held: %q", state)
	}

	if err := os.Remove(holdPath); err != nil {
		t.Fatal(err)
	}
	if err := CleanupOnceWithPolicyAndHold(context.Background(), h.database, storagePath, time.Now(), trashRetention, config.DefaultMetadataKeepVersions, holdPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(objectPath); !os.IsNotExist(err) {
		t.Fatalf("physical cleanup did not resume after hold removal: %v", err)
	}

	target := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(target, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, holdPath); err != nil {
		t.Fatal(err)
	}
	if err := CleanupOnceWithPolicyAndHold(context.Background(), h.database, storagePath, time.Now(), trashRetention, config.DefaultMetadataKeepVersions, holdPath); err == nil {
		t.Fatal("symlinked rollback hold did not fail closed")
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "preserve" {
		t.Fatalf("unsafe hold inspection modified its target: %q %v", got, err)
	}
}

func TestUpgradeRollbackHoldPathPrefersConfigDirectory(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "etc", "xdrive", "config.toml")
	databasePath := filepath.Join(t.TempDir(), "var", "lib", "xdrive", "xdrive.db")
	want := filepath.Join(filepath.Dir(configPath), UpgradeRollbackHoldFilename)
	if got := UpgradeRollbackHoldPath(configPath, databasePath); got != want {
		t.Fatalf("explicit config hold path = %q, want %q", got, want)
	}
	want = filepath.Join(filepath.Dir(databasePath), UpgradeRollbackHoldFilename)
	if got := UpgradeRollbackHoldPath("", databasePath); got != want {
		t.Fatalf("development fallback hold path = %q, want %q", got, want)
	}
}
