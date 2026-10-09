package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"xdrive/internal/config"
)

func TestSystemInfoUsesActualBuildAndRequiresSession(t *testing.T) {
	root := t.TempDir()
	h, err := NewWithBuild(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", TextPreviewLimit: 1024, VideoBlobFallbackLimit: 2048, ZipMemoryFallbackLimit: 4096}, "v1.3.1-test", "abc123")
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	addAuthenticatedTestSession(t, h)
	for _, authenticated := range []bool{false, true} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil)
		if authenticated {
			r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
		}
		response := httptest.NewRecorder()
		h.ServeHTTP(response, r)
		if !authenticated {
			if response.Code != 401 {
				t.Fatalf("unauth status %d", response.Code)
			}
			continue
		}
		if response.Code != 200 || !strings.Contains(response.Body.String(), `"version":"v1.3.1-test"`) || !strings.Contains(response.Body.String(), `"commit":"abc123"`) || !strings.Contains(response.Body.String(), `"clientProtocolVersion":1`) || !strings.Contains(response.Body.String(), `"encryptedFormatVersion":2`) || !strings.Contains(response.Body.String(), `"textPreviewLimit":1024`) || !strings.Contains(response.Body.String(), `"videoBlobFallbackLimit":2048`) || !strings.Contains(response.Body.String(), `"zipMemoryFallbackLimit":4096`) {
			t.Fatalf("info %d %s", response.Code, response.Body.String())
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("build response is cacheable")
		}
	}
}
