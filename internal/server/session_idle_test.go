package server

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
	"xdrive/internal/config"
)

func TestSessionIdleAtomicSlidingBoundaryAndOrderedRenewal(t *testing.T) {
	root := t.TempDir()
	h, err := New(config.Config{ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), Username: "admin", SessionIdleTimeout: "1m"})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	addAuthenticatedTestSession(t, h)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil)
	r = r.WithContext(context.WithValue(r.Context(), sessionIdleContextKey{}, time.Minute))
	issued := httptest.NewRecorder()
	if _, err := issueSession(issued, r, h.database); err != nil {
		t.Fatal(err)
	}
	cookie := issued.Result().Cookies()[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("cookie protection changed")
	}
	r.AddCookie(cookie)
	hash := sha256.Sum256([]byte(cookie.Value))
	var created, last, expires int64
	if err := h.database.QueryRow("SELECT created_at,last_seen_at,expires_at FROM sessions WHERE id_hash=?", hash[:]).Scan(&created, &last, &expires); err != nil {
		t.Fatal(err)
	}
	if expires-created != 60 {
		t.Fatal("issued session ignored policy")
	}
	base := time.Unix(created, 0)
	if !validSessionAt(r, h.database, base.Add(2*time.Second)) || !validSessionAt(r, h.database, base.Add(time.Second)) {
		t.Fatal("active renewal rejected")
	}
	if err := h.database.QueryRow("SELECT last_seen_at,expires_at FROM sessions WHERE id_hash=?", hash[:]).Scan(&last, &expires); err != nil {
		t.Fatal(err)
	}
	if last != created+2 || expires != created+62 {
		t.Fatal("out-of-order renewal moved deadline backward")
	}
	if !validSessionAt(r, h.database, base.Add(61*time.Second)) {
		t.Fatal("pre-boundary session rejected")
	}
	if validSessionAt(r, h.database, base.Add(121*time.Second)) {
		t.Fatal("exact idle boundary renewed")
	}
	r = r.WithContext(context.WithValue(r.Context(), sessionIdleContextKey{}, 24*time.Hour))
	if validSessionAt(r, h.database, base.Add(121*time.Second)) {
		t.Fatal("longer policy revived expired deadline")
	}
	if _, err := h.database.Exec("DELETE FROM sessions WHERE id_hash=?", hash[:]); err != nil {
		t.Fatal(err)
	}
	if validSessionAt(r, h.database, base) {
		t.Fatal("deleted cookie revived")
	}
}

func TestSessionPolicyShorteningAtRestartCannotReviveOldCookie(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", SessionIdleTimeout: "12h"}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if h != nil {
			h.Close()
		}
	}()
	addAuthenticatedTestSession(t, h)
	token := "0123456789abcdefghijklmnopqrstuv"
	hash := sha256.Sum256([]byte(token))
	now := time.Now().Unix()
	if _, err := h.database.Exec("UPDATE sessions SET last_seen_at=?,expires_at=? WHERE id_hash=?", now-61, now+3600, hash[:]); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	cfg.SessionIdleTimeout = "1m"
	h, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	check := func() {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil)
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("old cookie accepted: %d", w.Code)
		}
	}
	check()
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	cfg.SessionIdleTimeout = "24h"
	h, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	check()
}
