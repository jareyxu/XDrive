package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"xdrive/internal/config"
)

func TestChangePasswordCASAndSessionRevocation(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"),
		StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "server.secret"), Username: "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	addAuthenticatedTestSession(t, handler)
	oldKey := bytes.Repeat([]byte{3}, 32)
	newKey := bytes.Repeat([]byte{4}, 32)
	salt := bytes.Repeat([]byte{5}, 16)
	hash := sha256.Sum256(append(append([]byte{}, salt...), oldKey...))
	if _, err := handler.database.Exec("UPDATE users SET auth_salt = ?, auth_hash = ? WHERE id = 1", salt, hash[:]); err != nil {
		t.Fatal(err)
	}
	config := func(revision int) []byte {
		value := map[string]any{
			"formatVersion": map[bool]int{true: 1, false: 2}[revision == 1], "revision": revision,
			"slots": []any{map[string]any{
				"slotId": fmt.Sprintf("slot-%d", revision), "type": "password",
				"kdf":     map[string]any{"alg": "argon2id", "salt": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{byte(revision)}, 16)), "m": 65536, "t": 3, "p": 1},
				"wrapped": map[string]any{"nonce": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 12)), "ciphertext": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{8}, 48))},
			}},
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	if _, err := handler.database.Exec("INSERT INTO vault_config (id, format_version, revision, config_json) VALUES (1, 1, 1, ?)", config(1)); err != nil {
		t.Fatal(err)
	}
	otherToken := "other-session-token-0123456789abcdef"
	otherHash := sha256.Sum256([]byte(otherToken))
	now := time.Now().Unix()
	if _, err := handler.database.Exec("INSERT INTO sessions (id_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, 'other-csrf', ?, ?, ?)", otherHash[:], now, now, now+3600); err != nil {
		t.Fatal(err)
	}
	change := func(current []byte, expectedRevision int) *httpResponse {
		body := fmt.Sprintf(`{"currentAuthKey":%q,"newAuthKey":%q,"newVaultConfig":%s,"expectedConfigRevision":%d}`,
			base64.StdEncoding.EncodeToString(current), base64.StdEncoding.EncodeToString(newKey), config(2), expectedRevision)
		response := uploadRequest(t, handler, http.MethodPost, "/api/v1/auth/change-password", []byte(body))
		return &httpResponse{code: response.Code, body: response.Body.String()}
	}
	if response := change(bytes.Repeat([]byte{9}, 32), 1); response.code != http.StatusUnauthorized {
		t.Fatalf("wrong current auth key: %+v", response)
	}
	if response := change(oldKey, 2); response.code != http.StatusBadRequest {
		t.Fatalf("mismatched config revision: %+v", response)
	}
	if response := change(oldKey, 1); response.code != http.StatusOK {
		t.Fatalf("password change: %+v", response)
	}
	var revision int
	if err := handler.database.QueryRow("SELECT revision FROM vault_config WHERE id = 1").Scan(&revision); err != nil || revision != 2 {
		t.Fatalf("vault config revision = %d, error=%v", revision, err)
	}
	if verifyAuthKey(t.Context(), handler.database, oldKey) || !verifyAuthKey(t.Context(), handler.database, newKey) {
		t.Fatal("auth hash was not replaced atomically")
	}
	var remaining int
	if err := handler.database.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&remaining); err != nil || remaining != 1 {
		t.Fatalf("remaining sessions = %d, error=%v", remaining, err)
	}
	if response := change(oldKey, 1); response.code != http.StatusUnauthorized && response.code != http.StatusConflict {
		t.Fatalf("stale password change unexpectedly succeeded: %+v", response)
	}
	if response := change(newKey, 1); response.code != http.StatusConflict {
		t.Fatalf("stale config CAS status = %+v", response)
	}
	var otherCount int
	if err := handler.database.QueryRow("SELECT COUNT(*) FROM sessions WHERE id_hash = ?", otherHash[:]).Scan(&otherCount); err != nil || otherCount != 0 {
		t.Fatalf("other session survived: count=%d, error=%v", otherCount, err)
	}
}

func TestParseVaultConfigAcceptsV1AndV2AndRejectsUnknownVersions(t *testing.T) {
	for _, version := range []int{1, 2} {
		raw := []byte(fmt.Sprintf(`{"formatVersion":%d,"revision":1,"slots":[{"slotId":"slot-1","type":"password","kdf":{"alg":"argon2id","salt":%q,"m":65536,"t":3,"p":1},"wrapped":{"nonce":%q,"ciphertext":%q}}]}`, version,
			base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 16)),
			base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 12)),
			base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 48))))
		configuration, err := parseVaultConfig(raw)
		if err != nil || configuration.FormatVersion != uint32(version) {
			t.Fatalf("format version %d rejected: config=%+v err=%v", version, configuration, err)
		}
	}
	for _, version := range []int{0, 3, 99} {
		raw := []byte(fmt.Sprintf(`{"formatVersion":%d,"revision":1,"slots":[]}`, version))
		if _, err := parseVaultConfig(raw); err == nil {
			t.Fatalf("unsupported format version %d accepted", version)
		}
	}
}

type httpResponse struct {
	code int
	body string
}
