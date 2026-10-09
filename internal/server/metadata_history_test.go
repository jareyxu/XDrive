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

func TestMetadataHistoryPruneProtectsReferencesAndBackup(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), Username: "admin", MetadataKeepVersions: 2}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	now := time.Now().Truncate(time.Second)
	add := func(metadata string, revision int) string {
		t.Helper()
		id := fmt.Sprintf("%s%016d", metadata, revision)
		content := makeTestEnvelope(byte(revision))
		digest := sha256.Sum256(content)
		path := filepath.Join(cfg.StoragePath, id[:2], id)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,?,?,'live',?)", id, len(content), digest[:], now.Unix()); err != nil {
			t.Fatal(err)
		}
		if _, err := h.database.Exec("INSERT INTO metadata_versions VALUES(?,?,?,?)", metadata, revision, id, now.Unix()); err != nil {
			t.Fatal(err)
		}
		return id
	}
	ids := make([]string, 7)
	for i := range ids {
		ids[i] = add("history-aaaaaaaa", i+1)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := h.database.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO metadata_pointers VALUES(?,?,7,?)", "history-aaaaaaaa", ids[6], now.Unix())
	exec("INSERT INTO metadata_pointers VALUES(?,?,1,?)", "shared-index-aaaa", ids[0], now.Unix())
	exec("INSERT INTO tombstones VALUES(?,?,'active')", "trash-root-aaaaa", now.Unix())
	exec("INSERT INTO tombstone_objects VALUES(?,?)", "trash-root-aaaaa", ids[1])
	exec("INSERT INTO tombstone_builds(id,state,created_at,expires_at) VALUES(?,'active',?,?)", "build-object-aaa", now.Unix(), now.Add(time.Hour).Unix())
	exec("INSERT INTO tombstone_build_members VALUES(?, 'object', ?)", "build-object-aaa", ids[2])
	for i := 1; i <= 4; i++ {
		add("staged-aaaaaaaaa", i)
	}
	exec("INSERT INTO tombstone_builds(id,state,created_at,expires_at) VALUES(?,'active',?,?)", "build-index-aaaa", now.Unix(), now.Add(time.Hour).Unix())
	exec("INSERT INTO tombstone_build_members VALUES(?, 'metadata', ?)", "build-index-aaaa", "staged-aaaaaaaaa")
	lease, err := storage.AcquireBackupLease(context.Background(), cfg.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	clean := func() {
		t.Helper()
		if err := CleanupOnceWithPolicy(context.Background(), h.database, cfg.StoragePath, now, 30*24*time.Hour, h.MetadataKeepVersions()); err != nil {
			t.Fatal(err)
		}
	}
	clean()
	state := func(id string) string {
		t.Helper()
		var s string
		if err := h.database.QueryRow("SELECT state FROM objects WHERE id=?", id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	for i, id := range ids {
		want := "live"
		if i == 3 || i == 4 {
			want = "deleted"
		}
		if state(id) != want {
			t.Fatalf("object %d not protected/pruned", i+1)
		}
		if _, err := os.Stat(filepath.Join(cfg.StoragePath, id[:2], id)); err != nil {
			t.Fatal("backup lock bypassed")
		}
	}
	var versions int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_versions WHERE metadata_id=?", "staged-aaaaaaaaa").Scan(&versions); err != nil || versions != 4 {
		t.Fatal("metadata build history pruned")
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	clean()
	if _, err := os.Stat(filepath.Join(cfg.StoragePath, ids[3][:2], ids[3])); !os.IsNotExist(err) {
		t.Fatal("deleted history not unlinked")
	}
	exec("DELETE FROM tombstone_builds WHERE id IN (?,?)", "build-object-aaa", "build-index-aaaa")
	exec("DELETE FROM metadata_pointers WHERE id=?", "shared-index-aaaa")
	clean()
	if state(ids[0]) != "deleted" || state(ids[2]) != "deleted" || state(ids[1]) != "live" {
		t.Fatal("released protections leaked history or removed trash member")
	}
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_versions WHERE metadata_id=?", "staged-aaaaaaaaa").Scan(&versions); err != nil || versions != 2 {
		t.Fatal("released build history not pruned")
	}
}

func TestMetadataHistoryStartupAndBatchBudget(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), Username: "admin", MetadataKeepVersions: 3}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if h != nil {
			h.Close()
		}
	}()
	now := time.Now()
	tx, err := h.database.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for i := 1; i <= 1005; i++ {
		id := fmt.Sprintf("%032x", 10000+i)
		if _, err := tx.Exec("INSERT INTO objects VALUES(?,36,?,'live',NULL,?)", id, make([]byte, 32), now.Unix()); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec("INSERT INTO metadata_versions VALUES('large-index-aaaa',?,?,?)", i, id, now.Unix()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec("INSERT INTO metadata_pointers VALUES('large-index-aaaa',?,1005,?)", fmt.Sprintf("%032x", 11005), now.Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("INSERT INTO objects VALUES('ordinary-file-aaa',36,?,'live',NULL,?)", make([]byte, 32), now.Unix()); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_versions").Scan(&count); err != nil || count != 5 {
		t.Fatalf("startup exceeded 1000-row budget: %d %v", count, err)
	}
	if err := CleanupOnceWithPolicy(context.Background(), h.database, cfg.StoragePath, now, 30*24*time.Hour, 3); err != nil {
		t.Fatal(err)
	}
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_versions").Scan(&count); err != nil || count != 3 {
		t.Fatalf("second pass did not converge: %d %v", count, err)
	}
	var state string
	if err := h.database.QueryRow("SELECT state FROM objects WHERE id='ordinary-file-aaa'").Scan(&state); err != nil || state != "live" {
		t.Fatal("history cleanup swept ordinary file data")
	}
}
