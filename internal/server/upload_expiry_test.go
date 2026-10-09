package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
	"xdrive/internal/config"
)

func TestConfiguredUploadExpiryPersistsDeadlineAndCleanupReleasesQuota(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", QuotaBytes: 4096, UploadExpiry: "1h"}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { h.Close() }()
	addAuthenticatedTestSession(t, h)
	create := func(wantSeconds int64) (string, int64) {
		t.Helper()
		response := uploadRequest(t, h, http.MethodPost, "/api/v1/uploads", []byte("{}"))
		var result struct {
			UploadID  string `json:"uploadId"`
			ExpiresAt int64  `json:"expiresAt"`
		}
		if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &result) != nil {
			t.Fatalf("create: %d %s", response.Code, response.Body.String())
		}
		var created, expires int64
		if err := h.database.QueryRow("SELECT created_at,expires_at FROM upload_sessions WHERE id=?", result.UploadID).Scan(&created, &expires); err != nil {
			t.Fatal(err)
		}
		if expires != result.ExpiresAt || expires-created != wantSeconds {
			t.Fatalf("deadline mismatch: %d %d %d", created, expires, result.ExpiresAt)
		}
		return result.UploadID, expires
	}
	oldID, oldExpiry := create(3600)
	if reserveTestUpload(t, h, oldID, 100) != http.StatusOK {
		t.Fatal("reserve")
	}
	body := bytes.Repeat([]byte{0x72}, 36)
	digest := sha256.Sum256(body)
	objectID := "abcdefghijklmnopqrstuvwx"
	if putTestUploadObject(t, h, oldID, objectID, body, digest[:]) != http.StatusCreated {
		t.Fatal("put")
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	cfg.UploadExpiry = "2h"
	h, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var preserved int64
	if err := h.database.QueryRow("SELECT expires_at FROM upload_sessions WHERE id=?", oldID).Scan(&preserved); err != nil || preserved != oldExpiry {
		t.Fatalf("restart rewrote deadline: %d %v", preserved, err)
	}
	newID, _ := create(7200)
	if err := CleanupOnce(context.Background(), h.database, cfg.StoragePath, time.Unix(oldExpiry-1, 0)); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := h.database.QueryRow("SELECT state FROM upload_sessions WHERE id=?", oldID).Scan(&state); err != nil || state != "active" {
		t.Fatalf("expired too early: %s %v", state, err)
	}
	if err := CleanupOnce(context.Background(), h.database, cfg.StoragePath, time.Unix(oldExpiry, 0)); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ id, want string }{{oldID, "expired"}, {newID, "active"}} {
		if err := h.database.QueryRow("SELECT state FROM upload_sessions WHERE id=?", item.id).Scan(&state); err != nil || state != item.want {
			t.Fatalf("session state: %s %v", state, err)
		}
	}
	if _, err := os.Stat(filepath.Join(cfg.StoragePath, "ab", objectID)); !os.IsNotExist(err) {
		t.Fatalf("expired object persists: %v", err)
	}
	response := uploadRequest(t, h, http.MethodGet, "/api/v1/storage/usage", nil)
	var usage struct {
		UsedBytes           int64 `json:"usedBytes"`
		PendingBytes        int64 `json:"pendingBytes"`
		UploadReservedBytes int64 `json:"uploadReservedBytes"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &usage) != nil || usage.UsedBytes+usage.PendingBytes+usage.UploadReservedBytes != 0 {
		t.Fatalf("quota not released: %d %s", response.Code, response.Body.String())
	}
	if reserveTestUpload(t, h, newID, 4096) != http.StatusOK {
		t.Fatal("expired reservation still blocks capacity")
	}
}
