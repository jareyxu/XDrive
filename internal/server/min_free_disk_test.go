package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"xdrive/internal/config"
)

func TestCanonicalMinimumFreeDiskAppliesToReservationAndPUT(t *testing.T) {
	t.Setenv("XDRIVE_MIN_FREE_DISK_BYTES", "9223372036854775807")
	t.Setenv("XDRIVE_DISK_SAFETY_BYTES", "")
	cfg, err := config.Load("")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	cfg.DatabasePath = filepath.Join(root, "drive.db")
	cfg.StoragePath = filepath.Join(root, "objects")
	cfg.SecretPath = filepath.Join(root, "secret")
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	addAuthenticatedTestSession(t, h)
	id := createTestUpload(t, h)
	if status := reserveTestUpload(t, h, id, 36); status != http.StatusInsufficientStorage {
		t.Fatalf("canonical disk margin ignored in reserve: %d", status)
	}
	// Simulate a reservation accepted earlier, before physical capacity changed.
	if _, err := h.database.Exec("UPDATE upload_sessions SET reserved_bytes=36 WHERE id=?", id); err != nil {
		t.Fatal(err)
	}
	data := bytes.Repeat([]byte{0x39}, 36)
	digest := sha256.Sum256(data)
	body := &countedUploadReader{reader: bytes.NewReader(data)}
	r := httptest.NewRequest(http.MethodPut, "/api/v1/uploads/"+id+"/objects/canonical-disk-object-aaaa", body)
	r.ContentLength = 36
	r.Header.Set(clientProtocolHeader, "1")
	r.Header.Set("Origin", "http://example.com")
	r.Header.Set("X-CSRF-Token", "test-csrf-token")
	r.Header.Set("X-XDrive-Object-Size", "36")
	r.Header.Set("X-XDrive-Ciphertext-SHA256", hex.EncodeToString(digest[:]))
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusInsufficientStorage || body.read != 0 {
		t.Fatalf("canonical disk margin ignored in PUT: %d read=%d", w.Code, body.read)
	}
	for _, table := range []string{"objects", "upload_object_claims", "upload_receive_fences"} {
		var n int
		if err := h.database.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("low disk leaked %s: %d %v", table, n, err)
		}
	}
	var reserved, consumed int64
	if err := h.database.QueryRow("SELECT reserved_bytes,consumed_bytes FROM upload_sessions WHERE id=?", id).Scan(&reserved, &consumed); err != nil || reserved != 36 || consumed != 0 {
		t.Fatalf("rejection changed reservation: %d/%d %v", reserved, consumed, err)
	}
}
