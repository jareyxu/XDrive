package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"xdrive/internal/config"
)

func TestErrorRequestCorrelationWithoutSensitiveLogs(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	root := t.TempDir()
	handler, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", QuotaBytes: 100})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	// An unauthenticated API error must not print headers, URL/query or body.
	request := httptest.NewRequest(http.MethodGet, "/api/v1/vault/config?filename=private-name&token=private-setup", strings.NewReader("private-body-password"))
	request.Header.Set("Cookie", "xdrive_session=private-cookie")
	request.Header.Set("Authorization", "Bearer private-auth-key")
	request.Header.Set("X-Request-ID", "private-spoofed-id")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertCorrelatedErrorLog(t, &logs, response, http.StatusUnauthorized, "invalid_session")
	for _, forbidden := range []string{"private-name", "private-setup", "private-body-password", "private-cookie", "private-auth-key", "private-spoofed-id", "/api/v1", "filename", "Cookie", "Authorization"} {
		if strings.Contains(logs.String(), forbidden) {
			t.Fatalf("sensitive request data reached log: %q", forbidden)
		}
	}
	logs.Reset()
	unknown := httptest.NewRequest(http.MethodGet, "/api/v1/does-not-exist?name=private-route", nil)
	unknownResponse := httptest.NewRecorder()
	handler.ServeHTTP(unknownResponse, unknown)
	assertCorrelatedErrorLog(t, &logs, unknownResponse, http.StatusNotFound, "not_found")
	if strings.Contains(logs.String(), "private-route") || strings.Contains(unknownResponse.Body.String(), "private-route") {
		t.Fatal("unknown API route leaked its query string")
	}
	logs.Reset()
	wrongMethod := httptest.NewRequest(http.MethodPost, "/api/v1/auth/session", nil)
	wrongMethod.Header.Set(clientProtocolHeader, "1")
	wrongMethodResponse := httptest.NewRecorder()
	handler.ServeHTTP(wrongMethodResponse, wrongMethod)
	assertCorrelatedErrorLog(t, &logs, wrongMethodResponse, http.StatusMethodNotAllowed, "method_not_allowed")
	if wrongMethodResponse.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("Allow=%q want GET, HEAD", wrongMethodResponse.Header().Get("Allow"))
	}
	logs.Reset()
	addAuthenticatedTestSession(t, handler)
	// Successful diagnostic records must remain correlatable without exposing
	// a URL/query, caller-controlled request ID or authentication headers.
	successRequest := httptest.NewRequest(http.MethodPost, "/api/v1/uploads?filename=private-success-name&token=private-success-token", strings.NewReader(`{}`))
	successRequest.Header.Set(clientProtocolHeader, "1")
	successRequest.Header.Set("Origin", "http://example.com")
	successRequest.Header.Set("Content-Type", "application/json")
	successRequest.Header.Set("X-CSRF-Token", "test-csrf-token")
	successRequest.Header.Set("Authorization", "Bearer private-success-auth")
	successRequest.Header.Set("X-Request-ID", "private-success-spoofed-id")
	successRequest.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	successResponse := httptest.NewRecorder()
	handler.ServeHTTP(successResponse, successRequest)
	assertCorrelatedSuccessLog(t, &logs, successResponse, http.StatusCreated)
	for _, forbidden := range []string{"private-success-name", "private-success-token", "private-success-auth", "private-success-spoofed-id", "/api/v1", "filename", "Authorization"} {
		if strings.Contains(logs.String(), forbidden) {
			t.Fatalf("successful request data reached log: %q", forbidden)
		}
	}
	logs.Reset()
	upload := createTestUpload(t, handler)
	logs.Reset()
	response = uploadRequest(t, handler, http.MethodPost, "/api/v1/uploads/"+upload+"/reserve", []byte(`{"reservedBytes":101}`))
	assertCorrelatedErrorLog(t, &logs, response, http.StatusInsufficientStorage, "quota_exceeded")
	if strings.Contains(logs.String(), "reservedBytes") || strings.Contains(logs.String(), upload) {
		t.Fatal("quota error log exposed request or response details")
	}
}

func assertCorrelatedErrorLog(t *testing.T, logs *bytes.Buffer, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status=%d want=%d", response.Code, status)
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	decoder := json.NewDecoder(bytes.NewReader(logs.Bytes()))
	if err := decoder.Decode(&event); err != nil {
		t.Fatalf("missing structured error log: %v", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		t.Fatalf("extra log record or malformed trailing log: %v", err)
	}
	id := response.Header().Get("X-Request-ID")
	if id == "" || body["requestId"] != id || event["request_id"] != id || event["status"] != float64(status) || event["code"] != code {
		t.Fatalf("log/response correlation failed: body=%v event=%v", body, event)
	}
	wantLevel := "WARN"
	if status >= http.StatusInternalServerError {
		wantLevel = "ERROR"
	}
	if event["level"] != wantLevel {
		t.Fatalf("log level=%v want=%s", event["level"], wantLevel)
	}
	for key := range event {
		if key != "time" && key != "level" && key != "msg" && key != "request_id" && key != "status" && key != "response_bytes" && key != "latency_ms" && key != "code" {
			t.Fatalf("unexpected log field %q", key)
		}
	}
}

func assertCorrelatedSuccessLog(t *testing.T, logs *bytes.Buffer, response *httptest.ResponseRecorder, status int) {
	t.Helper()
	var event map[string]any
	decoder := json.NewDecoder(bytes.NewReader(logs.Bytes()))
	if err := decoder.Decode(&event); err != nil {
		t.Fatalf("missing structured success log: %v", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		t.Fatalf("expected one request log record: %v", err)
	}
	if event["level"] != "DEBUG" || event["msg"] != "API request completed" || event["status"] != float64(status) || event["request_id"] == "" || event["request_id"] != response.Header().Get("X-Request-ID") {
		t.Fatalf("unexpected success event: %v", event)
	}
	if count, ok := event["response_bytes"].(float64); !ok || count != float64(response.Body.Len()) {
		t.Fatalf("missing response byte count: %v", event)
	}
	if _, ok := event["latency_ms"].(float64); !ok {
		t.Fatalf("missing response latency: %v", event)
	}
	if _, ok := event["code"]; ok {
		t.Fatalf("success event unexpectedly includes an error code: %v", event)
	}
	for key := range event {
		if key != "time" && key != "level" && key != "msg" && key != "request_id" && key != "status" && key != "response_bytes" && key != "latency_ms" {
			t.Fatalf("unexpected success log field %q", key)
		}
	}
}

func TestSuccessfulAPIRequestsDoNotFillDefaultInfoLog(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	root := t.TempDir()
	handler, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", QuotaBytes: 100})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	addAuthenticatedTestSession(t, handler)
	response := uploadRequest(t, handler, http.MethodPost, "/api/v1/uploads", []byte(`{}`))
	if response.Code != http.StatusCreated {
		t.Fatalf("upload session status=%d body=%s", response.Code, response.Body.String())
	}
	if logs.Len() != 0 {
		t.Fatalf("successful API request reached default INFO log: %s", logs.String())
	}
}

func TestRequestLogWriterPreservesResponseControllerAndCountsBytes(t *testing.T) {
	underlying := httptest.NewRecorder()
	tracked := &requestLogWriter{ResponseWriter: underlying}
	controller := http.NewResponseController(tracked)
	if err := controller.Flush(); err != nil {
		t.Fatalf("flush through request logger: %v", err)
	}
	if tracked.status != http.StatusOK {
		t.Fatalf("flush status=%d want=%d", tracked.status, http.StatusOK)
	}
	if _, err := tracked.Write([]byte("body")); err != nil {
		t.Fatal(err)
	}
	// Hide strings.Reader's WriterTo method so io.Copy exercises the logging
	// wrapper's ReaderFrom implementation and fallback path.
	copied, err := io.Copy(tracked, struct{ io.Reader }{strings.NewReader("copy")})
	if err != nil {
		t.Fatal(err)
	}
	if copied != 4 || tracked.bytes != 8 || underlying.Body.String() != "bodycopy" {
		t.Fatalf("bytes=%d body=%q", tracked.bytes, underlying.Body.String())
	}
}
