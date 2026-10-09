package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
)

// Exercise the data semantics required by ADR-173's restore-based rollback:
// restore the verified pre-write snapshot into an empty root, without mixing
// in objects or sessions created after that snapshot.
func TestRestoreRollbackRestoresCompletedSnapshotAndDiscardsPostSnapshotWrites(t *testing.T) {
	settings, destination, oldObjectID, oldContent := backupFixture(t)
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatalf("create rollback point: %v", err)
	}
	if err := Verify(context.Background(), destination); err != nil {
		t.Fatalf("verify rollback point: %v", err)
	}

	newObjectID := "zyxwvutsrqponmlkjihgfedc"
	newContent := bytes.Repeat([]byte{0x77}, 77)
	newObjectPath := objectPath(settings.StoragePath, newObjectID)
	if err := os.MkdirAll(filepath.Dir(newObjectPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newObjectPath, newContent, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(newContent)
	live, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	if _, err := live.Exec(`INSERT INTO objects (id, size_bytes, sha256, state, created_at) VALUES (?, ?, ?, 'live', ?)`, newObjectID, len(newContent), digest[:], now); err != nil {
		_ = live.Close()
		t.Fatal(err)
	}
	if _, err := live.Exec(`INSERT INTO sessions (id_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, 'new-candidate-session', ?, ?, ?)`, bytes.Repeat([]byte{0x4d}, 32), now, now, now+3600); err != nil {
		_ = live.Close()
		t.Fatal(err)
	}
	if err := live.Close(); err != nil {
		t.Fatal(err)
	}

	rollbackRoot := filepath.Join(t.TempDir(), "rollback-data")
	if err := os.Mkdir(rollbackRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	restored := config.Config{
		DatabasePath: filepath.Join(rollbackRoot, "drive.db"),
		StoragePath:  filepath.Join(rollbackRoot, "objects"),
		SecretPath:   filepath.Join(rollbackRoot, "server.secret"),
	}
	if err := Restore(context.Background(), restored, destination); err != nil {
		t.Fatalf("restore verified rollback point: %v", err)
	}
	if got, err := os.ReadFile(objectPath(restored.StoragePath, oldObjectID)); err != nil || !bytes.Equal(got, oldContent) {
		t.Fatalf("pre-change snapshot object was not restored: bytes=%d error=%v", len(got), err)
	}
	if _, err := os.Stat(objectPath(restored.StoragePath, newObjectID)); !os.IsNotExist(err) {
		t.Fatalf("post-snapshot object survived rollback: %v", err)
	}

	recovered, err := db.Open(context.Background(), restored.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	var objects, sessions int
	if err := recovered.QueryRow("SELECT COUNT(*) FROM objects").Scan(&objects); err != nil {
		t.Fatal(err)
	}
	if err := recovered.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if objects != 1 || sessions != 0 {
		t.Fatalf("rollback mixed snapshot state: objects=%d sessions=%d", objects, sessions)
	}
	if err := recovered.QueryRow("SELECT COUNT(*) FROM objects WHERE id = ?", newObjectID).Scan(&sessions); err != nil || sessions != 0 {
		t.Fatalf("post-snapshot object record survived rollback: count=%d error=%v", sessions, err)
	}
}
