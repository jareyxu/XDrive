package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"xdrive/internal/config"
	"xdrive/internal/update"
)

func TestSystemUpdateCheckAndQueueRequireSessionAndCSRF(t *testing.T) {
	root := t.TempDir()
	h, err := NewWithBuild(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin"}, "v1.3.1", "abc123")
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	addAuthenticatedTestSession(t, h)
	h.updateRequestPath = filepath.Join(root, "runtime", "request.json")
	h.updateStatusPath = filepath.Join(root, "runtime", "status.json")
	if err := os.Mkdir(filepath.Dir(h.updateRequestPath), 0700); err != nil {
		t.Fatal(err)
	}
	h.updateCheck = func(context.Context) (update.Release, error) {
		return update.Release{Version: "v1.4.0", Name: "XDrive 1.4.0", URL: "https://github.com/jareyxu/XDrive/releases/tag/v1.4.0", PublishedAt: "2026-10-09T00:00:00Z", Notes: "release notes"}, nil
	}
	h.updateManagerCheck = func(context.Context) bool { return true }

	unauthenticated := httptest.NewRecorder()
	h.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/v1/system/update", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("update check without a session = %d", unauthenticated.Code)
	}

	check := httptest.NewRequest(http.MethodGet, "/api/v1/system/update", nil)
	check.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	checkResponse := httptest.NewRecorder()
	h.ServeHTTP(checkResponse, check)
	var info map[string]any
	if err := json.Unmarshal(checkResponse.Body.Bytes(), &info); err != nil || checkResponse.Code != http.StatusOK || info["updateAvailable"] != true || info["canInstall"] != true || info["latestVersion"] != "v1.4.0" {
		t.Fatalf("invalid update check: status=%d response=%s err=%v", checkResponse.Code, checkResponse.Body.String(), err)
	}

	badOrigin := updateStartRequest("v1.4.0")
	badOrigin.Header.Set("Origin", "https://attacker.example")
	badResponse := httptest.NewRecorder()
	h.ServeHTTP(badResponse, badOrigin)
	if badResponse.Code != http.StatusForbidden {
		t.Fatalf("bad origin accepted: %d", badResponse.Code)
	}

	start := updateStartRequest("v1.4.0")
	startResponse := httptest.NewRecorder()
	h.ServeHTTP(startResponse, start)
	var queued update.Status
	if err := json.Unmarshal(startResponse.Body.Bytes(), &queued); err != nil || startResponse.Code != http.StatusAccepted || queued.State != "queued" || queued.Version != "v1.4.0" || len(queued.ID) != 22 {
		t.Fatalf("invalid update request response: status=%d body=%s err=%v", startResponse.Code, startResponse.Body.String(), err)
	}
	stored, err := update.ReadRequest(h.updateRequestPath)
	if err != nil || stored.ID != queued.ID || stored.Version != queued.Version {
		t.Fatalf("queued file mismatch: %+v err=%v", stored, err)
	}

	statusRequest := httptest.NewRequest(http.MethodGet, "/api/v1/system/update/status?id="+queued.ID, nil)
	statusRequest.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	statusResponse := httptest.NewRecorder()
	h.ServeHTTP(statusResponse, statusRequest)
	if statusResponse.Code != http.StatusOK || !strings.Contains(statusResponse.Body.String(), `"state":"queued"`) {
		t.Fatalf("queued status lookup failed: %d %s", statusResponse.Code, statusResponse.Body.String())
	}

	duplicate := updateStartRequest("v1.4.0")
	duplicateResponse := httptest.NewRecorder()
	h.ServeHTTP(duplicateResponse, duplicate)
	if duplicateResponse.Code != http.StatusConflict || !strings.Contains(duplicateResponse.Body.String(), `"error":"update_already_queued"`) {
		t.Fatalf("duplicate update request = %d %s", duplicateResponse.Code, duplicateResponse.Body.String())
	}
}

func TestSystemUpdateRejectsChangedOrOlderRelease(t *testing.T) {
	root := t.TempDir()
	h, err := NewWithBuild(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin"}, "v1.3.1", "abc123")
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	addAuthenticatedTestSession(t, h)
	h.updateRequestPath = filepath.Join(root, "runtime", "request.json")
	if err := os.Mkdir(filepath.Dir(h.updateRequestPath), 0700); err != nil {
		t.Fatal(err)
	}
	h.updateManagerCheck = func(context.Context) bool { return true }
	h.updateCheck = func(context.Context) (update.Release, error) {
		return update.Release{Version: "v1.4.0", URL: "https://github.com/jareyxu/XDrive/releases/tag/v1.4.0"}, nil
	}
	request := updateStartRequest("v1.3.1")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"error":"release_changed"`) {
		t.Fatalf("stale version was not rejected: %d %s", response.Code, response.Body.String())
	}
}

func updateStartRequest(version string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/system/update", strings.NewReader(fmt.Sprintf(`{"version":%q}`, version)))
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	request.Header.Set("Origin", "http://example.com")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", "test-csrf-token")
	request.Header.Set(clientProtocolHeader, "1")
	return request
}
