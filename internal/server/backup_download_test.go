package server

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"xdrive/internal/backup"
	"xdrive/internal/config"
)

const backupTestSession = "0123456789abcdefghijklmnopqrstuv"

func TestBackupDownloadRequiresCSRFAndOneTimeSessionTicket(t *testing.T) {
	h, _ := concurrentUploadFixture(t)
	h.SetBackupArchivePreparer(func(ctx context.Context, settings config.Config) (BackupArchive, error) {
		export, err := backup.PrepareArchive(ctx, settings)
		if errors.Is(err, backup.ErrBackupInProgress) {
			return nil, ErrBackupInProgress
		}
		return export, err
	})
	prepare := httptest.NewRequest(http.MethodPost, "http://example.com/api/v1/backups/download", strings.NewReader(`{}`))
	prepare.Header.Set(clientProtocolHeader, "1")
	prepare.Header.Set("Origin", "http://example.com")
	prepare.Header.Set("X-CSRF-Token", "test-csrf-token")
	prepare.AddCookie(&http.Cookie{Name: sessionCookieName, Value: backupTestSession})
	prepared := httptest.NewRecorder()
	h.ServeHTTP(prepared, prepare)
	if prepared.Code != http.StatusOK {
		t.Fatalf("prepare status=%d body=%s", prepared.Code, prepared.Body.String())
	}
	var result struct {
		Ready bool `json:"ready"`
	}
	if err := json.Unmarshal(prepared.Body.Bytes(), &result); err != nil || !result.Ready {
		t.Fatalf("invalid prepare response: %s (%v)", prepared.Body.String(), err)
	}
	var ticket *http.Cookie
	for _, cookie := range prepared.Result().Cookies() {
		if cookie.Name == backupDownloadCookieName {
			ticket = cookie
		}
	}
	if ticket == nil || !ticket.HttpOnly || ticket.Path != "/api/v1/backups/download" || ticket.SameSite != http.SameSiteStrictMode {
		t.Fatalf("download ticket cookie is not scoped safely: %#v", ticket)
	}

	download := httptest.NewRequest(http.MethodGet, "http://example.com/api/v1/backups/download", nil)
	download.Header.Set("Sec-Fetch-Site", "same-origin")
	download.AddCookie(&http.Cookie{Name: sessionCookieName, Value: backupTestSession})
	download.AddCookie(ticket)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, download)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Accel-Buffering") != "no" || !strings.HasSuffix(response.Header().Get("Content-Disposition"), ".tar\"") {
		t.Fatalf("download response status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	reader := tar.NewReader(bytes.NewReader(response.Body.Bytes()))
	foundSnapshot, foundCurrent := false, false
	for {
		header, err := reader.Next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatalf("invalid streaming tar: %v", err)
		}
		if strings.HasSuffix(header.Name, "/CURRENT") {
			foundCurrent = true
		}
		if strings.HasSuffix(header.Name, "/db.sqlite.snapshot") {
			foundSnapshot = true
		}
	}
	if !foundSnapshot || !foundCurrent {
		t.Fatalf("archive missing restore metadata: snapshot=%t current=%t", foundSnapshot, foundCurrent)
	}

	replay := httptest.NewRequest(http.MethodGet, "http://example.com/api/v1/backups/download", nil)
	replay.AddCookie(&http.Cookie{Name: sessionCookieName, Value: backupTestSession})
	replay.AddCookie(ticket)
	replayed := httptest.NewRecorder()
	h.ServeHTTP(replayed, replay)
	if replayed.Code != http.StatusUnauthorized {
		t.Fatalf("one-time download ticket replay status=%d body=%s", replayed.Code, replayed.Body.String())
	}
}

func TestBackupDownloadRejectsCrossOriginPreparation(t *testing.T) {
	h, _ := concurrentUploadFixture(t)
	request := httptest.NewRequest(http.MethodPost, "http://example.com/api/v1/backups/download", strings.NewReader(`{}`))
	request.Header.Set(clientProtocolHeader, "1")
	request.Header.Set("Origin", "http://attacker.example")
	request.Header.Set("X-CSRF-Token", "test-csrf-token")
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: backupTestSession})
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !bytes.Contains(response.Body.Bytes(), []byte("origin_rejected")) {
		t.Fatalf("cross-origin backup preparation was accepted: %d %s", response.Code, response.Body.String())
	}
}
