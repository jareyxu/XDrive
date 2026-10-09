package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
)

func TestCreateSetupTokenStoresOnlyHashAndRotatesPendingToken(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		ListenAddr:   "127.0.0.1:8787",
		DatabasePath: filepath.Join(root, "drive.db"),
		StoragePath:  filepath.Join(root, "objects"),
		SecretPath:   filepath.Join(root, "server.secret"),
		Username:     "owner",
	}
	initialized, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := initialized.Close(); err != nil {
		t.Fatal(err)
	}
	firstToken, err := CreateSetupToken(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	secondToken, err := CreateSetupToken(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if firstToken == secondToken {
		t.Fatal("rotated token did not change")
	}

	database, err := db.Open(context.Background(), cfg.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	state, err := database.SetupState(context.Background())
	if err != nil || state != "pending_setup" {
		t.Fatalf("state = %q, error = %v", state, err)
	}
	var storedHash []byte
	var expiresAt int64
	if err := database.QueryRow("SELECT token_hash, expires_at FROM setup_tokens WHERE id = 1").Scan(&storedHash, &expiresAt); err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(secondToken)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(decoded)
	if len(storedHash) != 32 || string(storedHash) != string(hash[:]) {
		t.Fatal("database does not contain the current token hash")
	}
	if expiresAt <= time.Now().Unix() || expiresAt > time.Now().Add(25*time.Hour).Unix() {
		t.Fatalf("unexpected token expiry %d", expiresAt)
	}
}

func TestConfiguredSetupTokenTTLRotationExpiryAndAccountClosure(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", SetupTokenTTL: "1h"}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if h != nil {
			h.Close()
		}
	}()
	first, err := CreateSetupToken(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	var created, expiry int64
	if err := h.database.QueryRow("SELECT created_at,expires_at FROM setup_tokens WHERE id=1").Scan(&created, &expiry); err != nil || expiry-created != 3600 {
		t.Fatalf("custom deadline: %v", err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	cfg.SetupTokenTTL = "2h"
	h, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var preserved int64
	if err := h.database.QueryRow("SELECT expires_at FROM setup_tokens WHERE id=1").Scan(&preserved); err != nil || preserved != expiry {
		t.Fatal("restart changed existing deadline")
	}
	second, err := CreateSetupToken(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if second == first {
		t.Fatal("rotation reused token")
	}
	if err := h.database.QueryRow("SELECT created_at,expires_at FROM setup_tokens WHERE id=1").Scan(&created, &expiry); err != nil || expiry-created != 7200 {
		t.Fatal("rotation ignored new TTL")
	}
	submit := func(token string) int {
		t.Helper()
		payload := map[string]any{
			"token": token, "authKey": base64.StdEncoding.EncodeToString(make([]byte, 32)),
			"vaultConfig": map[string]any{"formatVersion": 1, "revision": 1, "slots": []any{map[string]any{"slotId": "slot-1", "type": "password", "kdf": map[string]any{"alg": "argon2id", "salt": base64.StdEncoding.EncodeToString(make([]byte, 16)), "m": 65536, "t": 3, "p": 1}, "wrapped": map[string]any{"nonce": base64.StdEncoding.EncodeToString(make([]byte, 12)), "ciphertext": base64.StdEncoding.EncodeToString(make([]byte, 48))}}}},
			"rootIndex":   map[string]any{"metadataId": "abcdefghijklmnopqrstuvwx12", "objectId": "0123456789abcdefghijklmnopqrstuv", "revision": 1, "encryptedObject": base64.StdEncoding.EncodeToString(makeTestEnvelope(0x21))},
			"trashIndex":  map[string]any{"metadataId": "bcdefghijklmnopqrstuvwxy123", "objectId": "123456789abcdefghijklmnopqrstuv0", "revision": 1, "encryptedObject": base64.StdEncoding.EncodeToString(makeTestEnvelope(0x61))},
		}
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "/api/v1/setup", bytes.NewReader(body))
		r.Header.Set("Origin", "http://example.com")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set(clientProtocolHeader, "1")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if status := submit(first); status != http.StatusNotFound {
		t.Fatalf("rotated token accepted: %d", status)
	}
	if _, err := h.database.Exec("UPDATE setup_tokens SET expires_at=? WHERE id=1", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if status := submit(second); status != http.StatusNotFound {
		t.Fatalf("expired token accepted: %d", status)
	}
	var objects int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM objects").Scan(&objects); err != nil || objects != 0 {
		t.Fatal("rejected setup published objects")
	}
	if state, err := h.database.SetupState(context.Background()); err != nil || state != "pending_setup" {
		t.Fatal("rejected setup changed account")
	}
	bad := cfg
	bad.SetupTokenTTL = "-1h"
	if _, err := CreateSetupToken(context.Background(), bad); err == nil {
		t.Fatal("invalid TTL accepted")
	}
	third, err := CreateSetupToken(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if status := submit(third); status != http.StatusCreated {
		t.Fatalf("replacement setup failed: %d", status)
	}
	if _, err := CreateSetupToken(context.Background(), cfg); err == nil {
		t.Fatal("active account allowed setup token")
	}
	if status := submit(third); status != http.StatusNotFound {
		t.Fatalf("consumed token accepted: %d", status)
	}
}
