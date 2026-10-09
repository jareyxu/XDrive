package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func redirectedCleanupBucket(t *testing.T, root, id string) (string, []byte) {
	t.Helper()
	bucket := filepath.Join(root, id[:2])
	if err := os.MkdirAll(bucket, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(bucket, filepath.Join(root, "original-"+id[:2])); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	victim := filepath.Join(target, id)
	data := bytes.Repeat([]byte{0x58}, 36)
	if err := os.WriteFile(victim, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, bucket); err != nil {
		t.Fatal(err)
	}
	return victim, data
}

func requireCleanupVictimUnchanged(t *testing.T, victim string, data []byte) {
	t.Helper()
	got, err := os.ReadFile(victim)
	if err != nil || !bytes.Equal(got, data) {
		t.Errorf("cleanup modified redirected target: %v", err)
	}
}

func TestDeferredGCDoesNotFollowBucketAfterUploadCancellation(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	session := createTestUpload(t, h)
	if status := reserveTestUpload(t, h, session, 36); status != http.StatusOK {
		t.Fatal(status)
	}
	id := "abcdefghijklmnopqrstuvwx"
	data := bytes.Repeat([]byte{0x28}, 36)
	digest := sha256.Sum256(data)
	if status := putTestUploadObject(t, h, session, id, data, digest[:]); status != http.StatusCreated {
		t.Fatal(status)
	}
	victim, original := redirectedCleanupBucket(t, root, id)
	if r := uploadRequest(t, h, http.MethodPost, "/api/v1/uploads/"+session+"/abandon", []byte(`{}`)); r.Code != http.StatusNoContent {
		t.Fatal(r.Code)
	}
	requireCleanupVictimUnchanged(t, victim, original)
	for i := 0; i < 2; i++ {
		if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
			t.Fatal(err)
		}
		requireCleanupVictimUnchanged(t, victim, original)
	}
	var state string
	if err := h.database.QueryRow("SELECT state FROM objects WHERE id=?", id).Scan(&state); err != nil || state != "deleted" {
		t.Fatalf("deleted state lost: %s %v", state, err)
	}
}

func TestStartupOrphanRecoveryRejectsLinkedBucketAndRetainsFences(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	session := createTestUpload(t, h)
	if status := reserveTestUpload(t, h, session, 36); status != http.StatusOK {
		t.Fatal(status)
	}
	id := "abcdefghijklmnopqrstuvwx"
	digest := sha256.Sum256(bytes.Repeat([]byte{0x58}, 36))
	now := time.Now().Unix()
	for _, table := range []string{"upload_object_claims", "upload_receive_fences"} {
		if _, err := h.database.Exec("INSERT INTO "+table+" (session_id,object_id,expected_size_bytes,expected_sha256,created_at) VALUES (?,?,?,?,?)", session, id, 36, digest[:], now); err != nil {
			t.Fatal(err)
		}
	}
	victim, original := redirectedCleanupBucket(t, root, id)
	if err := RecoverUploadClaimsAtStartup(context.Background(), h.database, root); err == nil {
		t.Error("startup followed linked orphan bucket")
	}
	requireCleanupVictimUnchanged(t, victim, original)
	for _, table := range []string{"upload_object_claims", "upload_receive_fences"} {
		var count int
		if err := h.database.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 1 {
			t.Errorf("failed startup discarded %s: %d %v", table, count, err)
		}
	}
	// Repair the directory and retry actual orphan and legacy temporary cleanup.
	bucket := filepath.Join(root, id[:2])
	if err := os.Remove(bucket); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(bucket, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{id, ".upload-legacy-123"} {
		if err := os.WriteFile(filepath.Join(bucket, name), original, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := RecoverUploadClaimsAtStartup(context.Background(), h.database, root); err != nil {
		t.Fatal(err)
	}
	if entries, err := os.ReadDir(bucket); err != nil || len(entries) != 0 {
		t.Errorf("repaired startup left objects: %v %v", entries, err)
	}
	for _, table := range []string{"upload_object_claims", "upload_receive_fences"} {
		var count int
		if err := h.database.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Errorf("repaired startup kept %s: %d %v", table, count, err)
		}
	}
	requireCleanupVictimUnchanged(t, victim, original)
}

func TestMetadataCommitAndDeferredGCDoNotUnlinkRedirectedUnactivatedObject(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	session := createTestUpload(t, h)
	if status := reserveTestUpload(t, h, session, 72); status != http.StatusOK {
		t.Fatal(status)
	}
	active := "bcdefghijklmnopqrstuvwxy"
	orphan := "abcdefghijklmnopqrstuvwx"
	data := bytes.Repeat([]byte{0x36}, 36)
	digest := sha256.Sum256(data)
	for _, id := range []string{active, orphan} {
		if status := putTestUploadObject(t, h, session, id, data, digest[:]); status != http.StatusCreated {
			t.Fatal(status)
		}
	}
	victim, original := redirectedCleanupBucket(t, root, orphan)
	request := fmt.Sprintf(`{"uploadId":%q,"expectedGlobalRevision":0,"activateObjectIds":[%q],"updates":[{"metadataId":"metadata-path-proof-123456","expectedRevision":0,"objectId":%q}]}`, session, active, active)
	response := metadataTransactionRequestForTest(t, h, request, "metadata-path-proof-key")
	if response.Code != http.StatusOK {
		t.Fatal(response.Code, response.Body.String())
	}
	requireCleanupVictimUnchanged(t, victim, original)
	var state string
	if err := h.database.QueryRow("SELECT state FROM objects WHERE id=?", orphan).Scan(&state); err != nil || state != "deleted" {
		t.Fatalf("orphan state: %s %v", state, err)
	}
	if err := h.database.QueryRow("SELECT state FROM objects WHERE id=?", active).Scan(&state); err != nil || state != "live" {
		t.Fatalf("active state: %s %v", state, err)
	}
	if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
		t.Fatal(err)
	}
	requireCleanupVictimUnchanged(t, victim, original)
	replay := metadataTransactionRequestForTest(t, h, request, "metadata-path-proof-key")
	if replay.Code != http.StatusOK || !bytes.Equal(replay.Body.Bytes(), response.Body.Bytes()) {
		t.Fatalf("committed result replay changed: %d %s", replay.Code, replay.Body.String())
	}
}
