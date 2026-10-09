package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"xdrive/internal/config"
)

func TestMetadataTransactionCASActivationAndIdempotency(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr:   "127.0.0.1:8787",
		DatabasePath: filepath.Join(root, "drive.db"),
		StoragePath:  filepath.Join(root, "objects"),
		SecretPath:   filepath.Join(root, "server.secret"),
		Username:     "admin",
		QuotaBytes:   1 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	addAuthenticatedTestSession(t, handler)
	indexID := "abcdefghijklmnopqrstuvwx12"
	oldObjectID := "0123456789abcdefghijklmnopqrstuv"
	oldBody := bytes.Repeat([]byte{1}, 36)
	oldDigest := sha256.Sum256(oldBody)
	now := time.Now().Unix()
	if _, err := handler.database.Exec("UPDATE server_state SET vault_mutation_revision = 1 WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO objects (id, size_bytes, sha256, state, created_at) VALUES (?, ?, ?, 'live', ?)`, oldObjectID, len(oldBody), oldDigest[:], now); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO metadata_pointers (id, object_id, revision, updated_at) VALUES (?, ?, 1, ?)`, indexID, oldObjectID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO metadata_versions (metadata_id, revision, object_id, created_at) VALUES (?, 1, ?, ?)`, indexID, oldObjectID, now); err != nil {
		t.Fatal(err)
	}
	uploadID := createTestUpload(t, handler)
	body := bytes.Repeat([]byte{2}, 36)
	digest := sha256.Sum256(body)
	newObjectID := "123456789abcdefghijklmnopqrstuv0"
	orphanObjectID := "23456789abcdefghijklmnopqrstuv01"
	if status := reserveTestUpload(t, handler, uploadID, int64(2*len(body))); status != http.StatusOK {
		t.Fatalf("reserve status = %d", status)
	}
	if status := putTestUploadObject(t, handler, uploadID, newObjectID, body, digest[:]); status != http.StatusCreated {
		t.Fatalf("pending object upload status = %d", status)
	}
	if status := putTestUploadObject(t, handler, uploadID, orphanObjectID, body, digest[:]); status != http.StatusCreated {
		t.Fatalf("unselected pending object upload status = %d", status)
	}
	requestBody := fmt.Sprintf(`{"uploadId":%q,"expectedGlobalRevision":1,"activateObjectIds":[%q],"updates":[{"metadataId":%q,"expectedRevision":1,"objectId":%q}]}`, uploadID, newObjectID, indexID, newObjectID)
	staleBody := fmt.Sprintf(`{"uploadId":%q,"expectedGlobalRevision":0,"activateObjectIds":[%q],"updates":[{"metadataId":%q,"expectedRevision":1,"objectId":%q}]}`, uploadID, newObjectID, indexID, newObjectID)
	stale := metadataTransactionRequestForTest(t, handler, staleBody, "staleglobalrevision")
	var conflict struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(stale.Body.Bytes(), &conflict); err != nil || stale.Code != http.StatusConflict || conflict.Error != "vault_mutation_conflict" {
		t.Fatalf("global conflict contract: status=%d body=%s error=%v", stale.Code, stale.Body.String(), err)
	}
	key := "abcdefghijklmnop"
	first := metadataTransactionRequestForTest(t, handler, requestBody, key)
	if first.Code != http.StatusOK {
		t.Fatalf("transaction status = %d, body=%s", first.Code, first.Body.String())
	}
	var result metadataTransactionResponse
	if err := json.Unmarshal(first.Body.Bytes(), &result); err != nil || result.VaultMutationRevision != 2 || result.ActivatedObjects != 1 || result.UpdatedPointers != 1 {
		t.Fatalf("unexpected transaction response: %s, error=%v", first.Body.String(), err)
	}
	var state string
	var revision int64
	if err := handler.database.QueryRow("SELECT state FROM objects WHERE id = ?", newObjectID).Scan(&state); err != nil || state != "live" {
		t.Fatalf("activated object state = %q, error=%v", state, err)
	}
	if err := handler.database.QueryRow("SELECT state FROM objects WHERE id = ?", orphanObjectID).Scan(&state); err != nil || state != "deleted" {
		t.Fatalf("unselected object state = %q, error=%v", state, err)
	}
	if _, err := os.Stat(filepath.Join(root, "objects", orphanObjectID[:2], orphanObjectID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unselected object was not unlinked, stat error=%v", err)
	}
	if err := handler.database.QueryRow("SELECT revision FROM metadata_pointers WHERE id = ?", indexID).Scan(&revision); err != nil || revision != 2 {
		t.Fatalf("metadata revision = %d, error=%v", revision, err)
	}
	if replay := metadataTransactionRequestForTest(t, handler, requestBody, key); replay.Code != http.StatusOK || replay.Body.String() != first.Body.String() {
		t.Fatalf("idempotent replay status=%d body=%s", replay.Code, replay.Body.String())
	}
	changedBody := fmt.Sprintf(`{"uploadId":%q,"expectedGlobalRevision":2,"activateObjectIds":[%q],"updates":[{"metadataId":%q,"expectedRevision":2,"objectId":%q}]}`, uploadID, newObjectID, indexID, newObjectID)
	if replay := metadataTransactionRequestForTest(t, handler, changedBody, key); replay.Code != http.StatusConflict {
		t.Fatalf("idempotency key reuse status=%d, want 409", replay.Code)
	}
}

func metadataTransactionRequestForTest(t *testing.T, handler *Handler, body, key string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/metadata/transactions", bytes.NewBufferString(body))
	request.Header.Set(clientProtocolHeader, "1")
	request.Header.Set("Origin", "http://example.com")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", "test-csrf-token")
	request.Header.Set("Idempotency-Key", key)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestMetadataEncryptedIndexSizeBoundaryIsAtomic(t *testing.T) {
	for _, size := range []int{4 << 20, (4 << 20) + 1} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			root := t.TempDir()
			h, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", QuotaBytes: 16 << 20})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			addAuthenticatedTestSession(t, h)
			session := createTestUpload(t, h)
			if reserveTestUpload(t, h, session, int64(size+36)) != http.StatusOK {
				t.Fatal("reserve")
			}
			largeID := "large-index-object-012345678901"
			smallID := "small-index-object-012345678901"
			body := bytes.Repeat([]byte{0x67}, size)
			digest := sha256.Sum256(body)
			if putTestUploadObject(t, h, session, largeID, body, digest[:]) != http.StatusCreated {
				t.Fatal("large PUT")
			}
			small := bytes.Repeat([]byte{0x38}, 36)
			smallDigest := sha256.Sum256(small)
			if putTestUploadObject(t, h, session, smallID, small, smallDigest[:]) != http.StatusCreated {
				t.Fatal("small PUT")
			}
			request := fmt.Sprintf(`{"uploadId":%q,"expectedGlobalRevision":0,"activateObjectIds":[%q,%q],"updates":[{"metadataId":"small-metadata-id-0123456789","expectedRevision":0,"objectId":%q},{"metadataId":"large-metadata-id-0123456789","expectedRevision":0,"objectId":%q}]}`, session, smallID, largeID, smallID, largeID)
			response := metadataTransactionRequestForTest(t, h, request, "size-boundary-0123456789")
			var pointers, live, revision int
			if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_pointers").Scan(&pointers); err != nil {
				t.Fatal(err)
			}
			if err := h.database.QueryRow("SELECT COUNT(*) FROM objects WHERE state='live'").Scan(&live); err != nil {
				t.Fatal(err)
			}
			if err := h.database.QueryRow("SELECT vault_mutation_revision FROM server_state WHERE id=1").Scan(&revision); err != nil {
				t.Fatal(err)
			}
			if size == 4<<20 {
				if response.Code != http.StatusOK || pointers != 2 || live != 2 || revision != 1 {
					t.Fatalf("exact limit rejected: %d pointers=%d live=%d revision=%d %s", response.Code, pointers, live, revision, response.Body.String())
				}
			} else {
				if response.Code != http.StatusRequestEntityTooLarge || !bytes.Contains(response.Body.Bytes(), []byte("metadata_object_too_large")) || pointers != 0 || live != 0 || revision != 0 {
					t.Fatalf("oversize partially activated: %d pointers=%d live=%d revision=%d %s", response.Code, pointers, live, revision, response.Body.String())
				}
			}
		})
	}
}
