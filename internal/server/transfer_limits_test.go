package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestTransferAdmissionIsBoundedAndReusable(t *testing.T) {
	slots := make(chan struct{}, 2)
	var admitted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			response := httptest.NewRecorder()
			if admitTransfer(response, slots) {
				admitted.Add(1)
			} else if response.Code != http.StatusServiceUnavailable || response.Header().Get("Retry-After") != "1" {
				t.Error("missing bounded backoff response")
			}
		}()
	}
	wg.Wait()
	if admitted.Load() != 2 {
		t.Fatalf("admitted %d, want 2", admitted.Load())
	}
	<-slots
	if !admitTransfer(httptest.NewRecorder(), slots) {
		t.Fatal("slot not reusable")
	}
}

func TestTransferCapabilitiesRequireAuthentication(t *testing.T) {
	h, _ := concurrentUploadFixture(t)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/transfers/capabilities", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatal("capabilities accepted anonymous request")
	}
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"uploadConcurrency":4`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("invalid capabilities: %d %s", w.Code, w.Body.String())
	}
}

func TestTransferBusyDoesNotReadBodyOrClaimQuota(t *testing.T) {
	h, _ := concurrentUploadFixture(t)
	data := bytes.Repeat([]byte{0x41}, 36)
	var results []<-chan *httptest.ResponseRecorder
	var releases []func()
	for _, prefix := range []string{"a", "b", "c", "d"} {
		session := createTestUpload(t, h)
		if reserveTestUpload(t, h, session, 36) != http.StatusOK {
			t.Fatal("reserve failed")
		}
		result, release := startStalledPUT(t, h, session, strings.Repeat(prefix, 24), data)
		results = append(results, result)
		releases = append(releases, release)
	}
	session := createTestUpload(t, h)
	if reserveTestUpload(t, h, session, 36) != http.StatusOK {
		t.Fatal("reserve failed")
	}
	body := &countedUploadReader{reader: bytes.NewReader(data)}
	response := serveUploadBody(h, session, strings.Repeat("e", 24), body, data)
	if response.Code != http.StatusServiceUnavailable || body.read != 0 {
		t.Fatalf("busy request consumed body: %d %d", response.Code, body.read)
	}
	var claims int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM upload_object_claims WHERE session_id = ?", session).Scan(&claims); err != nil || claims != 0 {
		t.Fatalf("busy claim: %d %v", claims, err)
	}
	for _, release := range releases {
		release()
	}
	for _, result := range results {
		if response := receiveResult(t, result); response.Code != http.StatusCreated {
			t.Fatalf("existing transfer failed: %d %s", response.Code, response.Body.String())
		}
	}
	response = serveUploadBody(h, session, strings.Repeat("e", 24), bytes.NewReader(data), data)
	if response.Code != http.StatusCreated {
		t.Fatalf("retry failed: %d %s", response.Code, response.Body.String())
	}
}
