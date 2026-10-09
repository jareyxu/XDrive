package server

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"xdrive/internal/config"
)

func TestHealthAndReadiness(t *testing.T) {
	handler, err := New(config.Config{
		ListenAddr:   "127.0.0.1:8787",
		DatabasePath: t.TempDir() + "/drive.db",
		StoragePath:  t.TempDir() + "/objects",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()

	for _, test := range []struct {
		path       string
		wantStatus int
		wantBody   string
	}{
		{path: "/healthz", wantStatus: http.StatusOK, wantBody: `"status":"ok"`},
		{path: "/readyz", wantStatus: http.StatusOK, wantBody: `"status":"ready"`},
		{path: "/api/v1/status", wantStatus: http.StatusOK, wantBody: `"setupRequired":true`},
	} {
		t.Run(test.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, test.wantStatus)
			}
			if !strings.Contains(response.Body.String(), test.wantBody) {
				t.Fatalf("body %q does not contain %q", response.Body.String(), test.wantBody)
			}
			if response.Header().Get("Content-Security-Policy") == "" {
				t.Fatal("security headers were not set")
			}
		})
	}
}

func TestEmbeddedWebShellAndUnknownAPIRoute(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr:   "127.0.0.1:8787",
		DatabasePath: root + "/drive.db",
		StoragePath:  root + "/objects",
		SecretPath:   root + "/server.secret",
		Username:     "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()

	_, assetErr := embeddedWeb.ReadFile("static/index.html")
	wantStatus := http.StatusOK
	if assetErr != nil {
		wantStatus = http.StatusServiceUnavailable
	}
	pageRequest := httptest.NewRequest(http.MethodGet, "/setup", nil)
	pageResponse := httptest.NewRecorder()
	handler.ServeHTTP(pageResponse, pageRequest)
	if pageResponse.Code != wantStatus {
		t.Fatalf("embedded shell status = %d, want %d", pageResponse.Code, wantStatus)
	}
	if wantStatus == http.StatusOK && (pageResponse.Header().Get("Content-Type") != "text/html; charset=utf-8" || !strings.Contains(pageResponse.Body.String(), "XDrive")) {
		t.Fatalf("invalid embedded shell response: type=%q body=%q", pageResponse.Header().Get("Content-Type"), pageResponse.Body.String())
	}
	for _, route := range []string{"/api/v1/unknown", "/__xdrive_media/missing", "/__xdrive_download/missing"} {
		apiRequest := httptest.NewRequest(http.MethodGet, route, nil)
		apiResponse := httptest.NewRecorder()
		handler.ServeHTTP(apiResponse, apiRequest)
		if apiResponse.Code != http.StatusNotFound {
			t.Fatalf("reserved route %s returned frontend shell: status=%d", route, apiResponse.Code)
		}
	}
}

func TestPreloginUsesStableFakeSaltForUnknownUser(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr:   "127.0.0.1:8787",
		DatabasePath: root + "/drive.db",
		StoragePath:  root + "/objects",
		SecretPath:   root + "/server.secret",
		Username:     "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()

	request := func() map[string]any {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/prelogin", strings.NewReader(`{"username":"missing"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(clientProtocolHeader, "1")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	first, second := request(), request()
	if first["kdf"].(map[string]any)["salt"] != second["kdf"].(map[string]any)["salt"] {
		t.Fatal("fake salt must be deterministic for the same username")
	}
}

func TestPreloginNamesShareOneBoundedLoginRateLimitBucket(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr:   "127.0.0.1:8787",
		DatabasePath: root + "/drive.db",
		StoragePath:  root + "/objects",
		SecretPath:   root + "/server.secret",
		Username:     "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()

	for attempt := 1; attempt <= 30; attempt++ {
		username := strings.Repeat("u", attempt)
		payload, err := json.Marshal(map[string]string{"username": username})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/prelogin", bytes.NewReader(payload))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(clientProtocolHeader, "1")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		wantStatus := http.StatusOK
		if attempt == 30 {
			wantStatus = http.StatusTooManyRequests
		}
		if response.Code != wantStatus {
			t.Fatalf("attempt %d for a distinct username returned %d, want %d: %s", attempt, response.Code, wantStatus, response.Body.String())
		}
	}
	var rows int
	if err := handler.Database().QueryRow("SELECT COUNT(*) FROM login_attempts").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("distinct usernames created %d rate-limit rows, want one per source/operation", rows)
	}
}

func TestStaleClientProtocolCannotReachMutationRoutes(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr: "127.0.0.1:8787", DatabasePath: root + "/drive.db",
		StoragePath: root + "/objects", SecretPath: root + "/server.secret", Username: "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()

	for _, protocol := range []string{"", "0", "2", "01"} {
		body := &countedUploadReader{reader: strings.NewReader(`not-json`)}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/prelogin", body)
		if protocol != "" {
			request.Header.Set(clientProtocolHeader, protocol)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUpgradeRequired || !strings.Contains(response.Body.String(), `"error":"client_update_required"`) || response.Header().Get("X-XDrive-Required-Client-Protocol") != "1" {
			t.Fatalf("stale protocol %q status=%d headers=%v body=%s", protocol, response.Code, response.Header(), response.Body.String())
		}
		if body.read != 0 {
			t.Fatalf("stale protocol %q reached the route body reader: %d bytes", protocol, body.read)
		}
	}

	current := httptest.NewRequest(http.MethodPost, "/api/v1/auth/prelogin", strings.NewReader(`{"username":"missing"}`))
	current.Header.Set(clientProtocolHeader, "1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, current)
	if response.Code != http.StatusOK {
		t.Fatalf("current protocol request was rejected: %d %s", response.Code, response.Body.String())
	}

	read := httptest.NewRequest(http.MethodGet, "/api/v1/status", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, read)
	if response.Code != http.StatusOK {
		t.Fatalf("protocol gate blocked a read request: %d %s", response.Code, response.Body.String())
	}
}

func TestSessionExpirySlidesWithActivity(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr:   "127.0.0.1:8787",
		DatabasePath: root + "/drive.db",
		StoragePath:  root + "/objects",
		SecretPath:   root + "/server.secret",
		Username:     "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	token := "0123456789abcdefghijklmnopqrstuv"
	hash := sha256.Sum256([]byte(token))
	now := time.Now().Unix()
	if _, err := handler.database.Exec(`INSERT INTO users (id, username, auth_salt, auth_hash, state, created_at) VALUES (1, 'admin', ?, ?, 'active', ?)`, bytes.Repeat([]byte{1}, 16), bytes.Repeat([]byte{2}, 32), now); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO sessions (id_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, 'csrf', ?, ?, ?)`, hash[:], now-11*60*60, now-11*60*60, now+60); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
	if !validSession(request, handler.database) {
		t.Fatal("recently active session should remain valid")
	}
	var expiresAt int64
	if err := handler.database.QueryRow("SELECT expires_at FROM sessions WHERE id_hash = ?", hash[:]).Scan(&expiresAt); err != nil {
		t.Fatal(err)
	}
	if expiresAt < time.Now().Add(11*time.Hour).Unix() {
		t.Fatalf("session expiry was not extended: %d", expiresAt)
	}
}

func TestSetupLoginSessionAndLogout(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr:   "127.0.0.1:8787",
		DatabasePath: root + "/drive.db",
		StoragePath:  root + "/objects",
		SecretPath:   root + "/server.secret",
		Username:     "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()

	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		t.Fatal(err)
	}
	tokenHash := sha256.Sum256(token)
	if _, err := handler.database.Exec(`INSERT INTO users (id, username, state, created_at) VALUES (1, 'admin', 'pending_setup', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO setup_tokens (id, token_hash, expires_at, created_at) VALUES (1, ?, ?, ?)`, tokenHash[:], time.Now().Add(time.Hour).Unix(), time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	var persistedHash []byte
	var persistedExpiry int64
	if err := handler.database.QueryRow("SELECT token_hash, expires_at FROM setup_tokens WHERE id = 1").Scan(&persistedHash, &persistedExpiry); err != nil || len(persistedHash) != 32 || persistedExpiry <= time.Now().Unix() || sha256.Sum256(token) != tokenHash {
		t.Fatalf("setup token fixture invalid: hashLen=%d expiry=%d err=%v", len(persistedHash), persistedExpiry, err)
	}

	rootIndex := makeTestEnvelope(0x21)
	trashIndex := makeTestEnvelope(0x61)
	vaultConfig := map[string]any{
		"formatVersion": 1,
		"revision":      1,
		"slots": []any{map[string]any{
			"slotId": "slot-1", "type": "password",
			"kdf":     map[string]any{"alg": "argon2id", "salt": base64.StdEncoding.EncodeToString(make([]byte, 16)), "m": 65536, "t": 3, "p": 1},
			"wrapped": map[string]any{"nonce": base64.StdEncoding.EncodeToString(make([]byte, 12)), "ciphertext": base64.StdEncoding.EncodeToString(make([]byte, 48))},
		}},
	}
	requestBody := map[string]any{
		"token":       base64.RawURLEncoding.EncodeToString(token),
		"authKey":     base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"vaultConfig": vaultConfig,
		"rootIndex":   map[string]any{"metadataId": "abcdefghijklmnopqrstuvwx12", "objectId": "0123456789abcdefghijklmnopqrstuv", "revision": 1, "encryptedObject": base64.StdEncoding.EncodeToString(rootIndex)},
		"trashIndex":  map[string]any{"metadataId": "bcdefghijklmnopqrstuvwxy123", "objectId": "123456789abcdefghijklmnopqrstuv0", "revision": 1, "encryptedObject": base64.StdEncoding.EncodeToString(trashIndex)},
	}
	encodedToken := requestBody["token"].(string)
	decodedToken, decodeTokenErr := base64.RawURLEncoding.Strict().DecodeString(encodedToken)
	if decodeTokenErr != nil || len(decodedToken) != 32 || sha256.Sum256(decodedToken) != tokenHash {
		t.Fatalf("setup token encoding invalid: bytes=%d error=%v", len(decodedToken), decodeTokenErr)
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		t.Fatal(err)
	}
	// A blocked object shard must be reported as a storage failure rather
	// than a setup-state conflict, and the setup token must remain reusable.
	blockedShard := root + "/objects/01"
	if err := os.WriteFile(blockedShard, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	failedSetupRequest := httptest.NewRequest(http.MethodPost, "/api/v1/setup", strings.NewReader(string(body)))
	failedSetupRequest.Header.Set("Origin", "http://example.com")
	failedSetupRequest.Header.Set("Content-Type", "application/json")
	failedSetupRequest.Header.Set(clientProtocolHeader, "1")
	failedSetupResponse := httptest.NewRecorder()
	handler.ServeHTTP(failedSetupResponse, failedSetupRequest)
	var failedSetupError map[string]any
	if err := json.Unmarshal(failedSetupResponse.Body.Bytes(), &failedSetupError); err != nil || failedSetupResponse.Code != http.StatusInsufficientStorage || failedSetupError["error"] != "storage_unavailable" {
		t.Fatalf("blocked storage setup response = %d %s, error=%v", failedSetupResponse.Code, failedSetupResponse.Body.String(), err)
	}
	state, err := handler.database.SetupState(failedSetupRequest.Context())
	if err != nil || state != "pending_setup" {
		t.Fatalf("failed setup changed account state to %q: %v", state, err)
	}
	if err := os.Remove(blockedShard); err != nil {
		t.Fatal(err)
	}
	setupRequest := httptest.NewRequest(http.MethodPost, "/api/v1/setup", strings.NewReader(string(body)))
	setupRequest.Header.Set("Origin", "http://example.com")
	setupRequest.Header.Set("Content-Type", "application/json")
	setupRequest.Header.Set(clientProtocolHeader, "1")
	setupResponse := httptest.NewRecorder()
	handler.ServeHTTP(setupResponse, setupRequest)
	if setupResponse.Code != http.StatusCreated {
		t.Fatalf("setup status = %d, body = %s", setupResponse.Code, setupResponse.Body.String())
	}
	state, err = handler.database.SetupState(setupRequest.Context())
	if err != nil || state != "active" {
		t.Fatalf("setup state = %q, error = %v", state, err)
	}

	loginBody := `{"username":"admin","authKey":"` + base64.StdEncoding.EncodeToString(make([]byte, 32)) + `"}`
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(loginBody))
	loginRequest.Header.Set("Origin", "http://example.com")
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set(clientProtocolHeader, "1")
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, loginRequest)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", loginResponse.Code, loginResponse.Body.String())
	}
	var cookie *http.Cookie
	for _, candidate := range loginResponse.Result().Cookies() {
		if candidate.Name == sessionCookieName {
			cookie = candidate
		}
	}
	if cookie == nil || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("session cookie flags are unsafe: %#v", cookie)
	}

	sessionRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	sessionRequest.AddCookie(cookie)
	sessionResponse := httptest.NewRecorder()
	handler.ServeHTTP(sessionResponse, sessionRequest)
	if sessionResponse.Code != http.StatusOK || !strings.Contains(sessionResponse.Body.String(), `"authenticated":true`) || sessionResponse.Header().Get("X-CSRF-Token") == "" {
		t.Fatalf("session response = %d %s", sessionResponse.Code, sessionResponse.Body.String())
	}

	metadataRequest := httptest.NewRequest(http.MethodGet, "/api/v1/metadata/abcdefghijklmnopqrstuvwx12", nil)
	metadataRequest.AddCookie(cookie)
	metadataResponse := httptest.NewRecorder()
	handler.ServeHTTP(metadataResponse, metadataRequest)
	if metadataResponse.Code != http.StatusOK || !strings.Contains(metadataResponse.Body.String(), `"revision":1`) {
		t.Fatalf("metadata response = %d %s", metadataResponse.Code, metadataResponse.Body.String())
	}
	objectRequest := httptest.NewRequest(http.MethodGet, "/api/v1/objects/0123456789abcdefghijklmnopqrstuv", nil)
	objectRequest.AddCookie(cookie)
	objectResponse := httptest.NewRecorder()
	handler.ServeHTTP(objectResponse, objectRequest)
	if objectResponse.Code != http.StatusOK || !bytes.Equal(objectResponse.Body.Bytes(), rootIndex) {
		t.Fatalf("object response = %d %x", objectResponse.Code, objectResponse.Body.Bytes())
	}

	logoutRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	logoutRequest.AddCookie(cookie)
	logoutRequest.Header.Set("Origin", "http://example.com")
	logoutRequest.Header.Set("X-CSRF-Token", sessionResponse.Header().Get("X-CSRF-Token"))
	logoutRequest.Header.Set(clientProtocolHeader, "1")
	logoutResponse := httptest.NewRecorder()
	handler.ServeHTTP(logoutResponse, logoutRequest)
	if logoutResponse.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d", logoutResponse.Code)
	}
	if validSession(sessionRequest, handler.database) {
		t.Fatal("session remained valid after logout")
	}
}

func makeTestEnvelope(value byte) []byte {
	data := make([]byte, 36)
	copy(data, []byte{'X', 'D', 'R', 'V', 1, 1, 0, 0})
	for i := 8; i < len(data); i++ {
		data[i] = value
	}
	return data
}
