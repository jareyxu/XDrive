package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"xdrive/internal/config"
)

func TestStagedBuildRejectsStaleGlobalRevisionWithProtocolCode(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	if _, err := handler.database.Exec("UPDATE server_state SET vault_mutation_revision = 2 WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/tombstone-builds", bytes.NewBufferString(`{"expectedGlobalRevision":1}`))
	request.Header.Set("Content-Type", "application/json")
	createTombstoneBuild(response, request, handler.database)
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusConflict || body.Error != "vault_mutation_conflict" {
		t.Fatalf("staged build conflict contract: status=%d body=%s error=%v", response.Code, response.Body.String(), err)
	}
	var builds int
	if err := handler.database.QueryRow("SELECT COUNT(*) FROM tombstone_builds").Scan(&builds); err != nil || builds != 0 {
		t.Fatalf("stale request created %d builds, error=%v", builds, err)
	}
}

func TestFinalizeTombstoneBuildIncludesMetadataHistoryAndRejectsOverlap(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	metadataID := "abcdefghijklmnopqrstuvwx12345678"
	currentObjectID := "0123456789abcdefghijklmnopqrstuv"
	historyObjectID := "123456789abcdefghijklmnopqrstuv0"
	dataObjectID := "23456789abcdefghijklmnopqrstuv01"
	createdAt := time.Now().Unix()
	for _, item := range []struct {
		id   string
		size int
	}{{currentObjectID, 40}, {historyObjectID, 41}, {dataObjectID, 42}} {
		digest := sha256.Sum256(make([]byte, item.size))
		if _, err := handler.database.Exec(`INSERT INTO objects (id, size_bytes, sha256, state, created_at) VALUES (?, ?, ?, 'live', ?)`, item.id, item.size, digest[:], createdAt); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handler.database.Exec(`INSERT INTO metadata_pointers (id, object_id, revision, updated_at) VALUES (?, ?, 2, ?)`, metadataID, currentObjectID, createdAt); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO metadata_versions (metadata_id, revision, object_id, created_at) VALUES (?, 1, ?, ?), (?, 2, ?, ?)`, metadataID, historyObjectID, createdAt-5, metadataID, currentObjectID, createdAt); err != nil {
		t.Fatal(err)
	}
	buildID, secondBuildID := "abcdef0123456789abcdef0123456789", "bcdef0123456789abcdef0123456789a"
	for _, id := range []string{buildID, secondBuildID} {
		if _, err := handler.database.Exec(`INSERT INTO tombstone_builds (id, state, created_at, expires_at, expected_global_revision) VALUES (?, 'active', ?, ?, 7)`, id, createdAt, createdAt+3600); err != nil {
			t.Fatal(err)
		}
		for _, member := range []struct{ kind, id string }{{"metadata", metadataID}, {"object", dataObjectID}} {
			if _, err := handler.database.Exec(`INSERT INTO tombstone_build_members (build_id, member_type, opaque_id) VALUES (?, ?, ?)`, id, member.kind, member.id); err != nil {
				t.Fatal(err)
			}
		}
	}
	request := httptest.NewRequest("POST", "/", nil)
	tx, err := handler.database.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := finalizeTombstoneBuild(tx, request, buildID, "cdef0123456789abcdef0123456789ab", 7, createdAt); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var memberObjects, memberMetadata int
	if err := handler.database.QueryRow("SELECT COUNT(*) FROM tombstone_objects WHERE tombstone_id = ?", "cdef0123456789abcdef0123456789ab").Scan(&memberObjects); err != nil {
		t.Fatal(err)
	}
	if err := handler.database.QueryRow("SELECT COUNT(*) FROM tombstone_metadata WHERE tombstone_id = ?", "cdef0123456789abcdef0123456789ab").Scan(&memberMetadata); err != nil {
		t.Fatal(err)
	}
	if memberObjects != 3 || memberMetadata != 1 {
		t.Fatalf("tombstone members: objects=%d metadata=%d", memberObjects, memberMetadata)
	}
	tx, err = handler.database.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := finalizeTombstoneBuild(tx, request, secondBuildID, "def0123456789abcdef0123456789abc", 7, createdAt); err == nil {
		_ = tx.Rollback()
		t.Fatal("overlapping active tombstone membership was accepted")
	}
	_ = tx.Rollback()
}

func TestMetadataWritesRemainBlockedUntilTombstoneRestore(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	metadataID := "abcdefghijklmnopqrstuvwx12345678"
	if _, err := handler.database.Exec(`INSERT INTO tombstones (id, deleted_at, state) VALUES (?, ?, 'active')`, "abcdef0123456789abcdef0123456789", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO tombstone_metadata (tombstone_id, metadata_id) VALUES (?, ?)`, "abcdef0123456789abcdef0123456789", metadataID); err != nil {
		t.Fatal(err)
	}
	blocked, err := metadataWriteBlocked(context.Background(), handler.database, metadataID)
	if err != nil || !blocked {
		t.Fatalf("active tombstone should block metadata writes: blocked=%t err=%v", blocked, err)
	}
	if _, err := handler.database.Exec("DELETE FROM tombstones WHERE id = ?", "abcdef0123456789abcdef0123456789"); err != nil {
		t.Fatal(err)
	}
	blocked, err = metadataWriteBlocked(context.Background(), handler.database, metadataID)
	if err != nil || blocked {
		t.Fatalf("restored metadata should become writable: blocked=%t err=%v", blocked, err)
	}
}
