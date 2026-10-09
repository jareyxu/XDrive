package server

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
	"xdrive/internal/config"
	"xdrive/internal/storage"
)

func TestConfiguredTrashRetentionStartupBoundaryAndBackupLease(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", TrashRetention: "48h"}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if h != nil {
			h.Close()
		}
	}()
	now := time.Now().Truncate(time.Second)
	add := func(number int, deleted time.Time) (string, string) {
		t.Helper()
		id := fmt.Sprintf("%032x", number)
		path := filepath.Join(cfg.StoragePath, id[:2], id)
		content := []byte("encrypted retention test object")
		digest := sha256.Sum256(content)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
		for _, item := range []struct {
			query string
			args  []any
		}{
			{"INSERT INTO objects (id,size_bytes,sha256,state,created_at) VALUES (?,?,?,'live',?)", []any{id, len(content), digest[:], now.Unix()}},
			{"INSERT INTO metadata_pointers (id,object_id,revision,updated_at) VALUES (?,?,1,?)", []any{id, id, now.Unix()}},
			{"INSERT INTO metadata_versions (metadata_id,revision,object_id,created_at) VALUES (?,1,?,?)", []any{id, id, now.Unix()}},
			{"INSERT INTO tombstones (id,deleted_at,state) VALUES (?,?,'active')", []any{id, deleted.Unix()}},
			{"INSERT INTO tombstone_objects (tombstone_id,object_id) VALUES (?,?)", []any{id, id}},
			{"INSERT INTO tombstone_metadata (tombstone_id,metadata_id) VALUES (?,?)", []any{id, id}},
		} {
			if _, err := h.database.Exec(item.query, item.args...); err != nil {
				t.Fatal(err)
			}
		}
		return id, path
	}
	count := func(table, id string) int {
		t.Helper()
		var n int
		if err := h.database.QueryRow("SELECT COUNT(*) FROM "+table+" WHERE id=?", id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	oldID, oldPath := add(1, now.Add(-25*time.Hour))
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if h.TrashRetention() != 48*time.Hour || count("tombstones", oldID) != 1 {
		t.Fatal("startup ignored longer retention")
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	cfg.TrashRetention = "24h"
	h, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if count("tombstones", oldID) != 0 || count("metadata_pointers", oldID) != 0 {
		t.Fatal("startup failed logical expiry")
	}
	if _, err := os.Stat(oldPath); err != nil {
		t.Fatal("startup unlinked object")
	}
	lease, err := storage.AcquireBackupLease(context.Background(), cfg.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if err := CleanupOnceWithRetention(context.Background(), h.database, cfg.StoragePath, now, h.TrashRetention()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldPath); err != nil {
		t.Fatal("cleanup bypassed backup lease")
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := CleanupOnceWithRetention(context.Background(), h.database, cfg.StoragePath, now, h.TrashRetention()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatal("released backup lease failed unlink")
	}
	boundaryID, boundaryPath := add(2, now.Add(-time.Hour))
	if err := CleanupOnceWithRetention(context.Background(), h.database, cfg.StoragePath, now.Add(-time.Second), time.Hour); err != nil {
		t.Fatal(err)
	}
	if count("tombstones", boundaryID) != 1 {
		t.Fatal("expired before boundary")
	}
	if err := CleanupOnceWithRetention(context.Background(), h.database, cfg.StoragePath, now, time.Hour); err != nil {
		t.Fatal(err)
	}
	if count("tombstones", boundaryID) != 0 {
		t.Fatal("exact boundary not expired")
	}
	if _, err := os.Stat(boundaryPath); !os.IsNotExist(err) {
		t.Fatal("boundary object persists")
	}
}
