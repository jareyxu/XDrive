package db

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestSnapshotCapturesCommittedStateWithoutReplacingExistingFile(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "live.db")
	snapshotPath := filepath.Join(root, "before-upgrade.db")
	live, err := Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	if _, err := live.Exec("UPDATE server_state SET last_backup_at = 123 WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	if err := Snapshot(context.Background(), databasePath, snapshotPath); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(snapshotPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("snapshot must contain sensitive database metadata with mode 0600: %v %v", info, err)
	}
	if _, err := live.Exec("UPDATE server_state SET last_backup_at = 456 WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	copied, err := Open(context.Background(), snapshotPath)
	if err != nil {
		t.Fatal(err)
	}
	var value int
	if err := copied.QueryRow("SELECT last_backup_at FROM server_state WHERE id = 1").Scan(&value); err != nil {
		t.Fatal(err)
	}
	if err := copied.Close(); err != nil {
		t.Fatal(err)
	}
	if value != 123 {
		t.Fatalf("snapshot saw value %d, want 123", value)
	}
	before, err := os.ReadFile(snapshotPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := Snapshot(context.Background(), databasePath, snapshotPath); err == nil {
		t.Fatal("snapshot replaced an existing rollback file")
	}
	after, err := os.ReadFile(snapshotPath)
	if err != nil || !bytes.Equal(after, before) {
		t.Fatalf("existing snapshot changed after rejected replacement: %v", err)
	}
}

func TestSnapshotDoesNotRunCandidateMigrations(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "old-schema.db")
	snapshotPath := filepath.Join(root, "rollback.db")
	live, err := Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := live.Exec("PRAGMA user_version = 1"); err != nil {
		t.Fatal(err)
	}
	if err := live.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Snapshot(context.Background(), databasePath, snapshotPath); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{databasePath, snapshotPath} {
		raw, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		var version int
		if err := raw.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
			t.Fatal(err)
		}
		_ = raw.Close()
		if version != 1 {
			t.Fatalf("snapshot migrated %s from schema 1 to %d", path, version)
		}
	}
}
