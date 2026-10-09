package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"xdrive/internal/config"
)

func TestUploadReservationClaimAndPersistence(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr:   "127.0.0.1:8787",
		DatabasePath: filepath.Join(root, "drive.db"),
		StoragePath:  filepath.Join(root, "objects"),
		SecretPath:   filepath.Join(root, "server.secret"),
		Username:     "admin",
		QuotaBytes:   100,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	addAuthenticatedTestSession(t, handler)

	first := createTestUpload(t, handler)
	second := createTestUpload(t, handler)
	if status := reserveTestUpload(t, handler, first, 80); status != http.StatusOK {
		t.Fatalf("first reservation status = %d", status)
	}
	if status := reserveTestUpload(t, handler, second, 21); status != http.StatusInsufficientStorage {
		t.Fatalf("over quota reservation status = %d, want 507", status)
	}

	body := bytes.Repeat([]byte{0xa5}, 36)
	digest := sha256.Sum256(body)
	objectID := "abcdefghijklmnopqrstuvwx"
	if status := putTestUploadObject(t, handler, first, objectID, body, digest[:]); status != http.StatusCreated {
		t.Fatalf("object upload status = %d", status)
	}
	if status := putTestUploadObject(t, handler, first, objectID, body, digest[:]); status != http.StatusNoContent {
		t.Fatalf("idempotent upload status = %d, want 204", status)
	}
	if status := reserveTestUpload(t, handler, second, 21); status != http.StatusInsufficientStorage {
		t.Fatalf("reservation ignored used and remaining bytes: status = %d", status)
	}
	if status := reserveTestUpload(t, handler, first, 36); status != http.StatusOK {
		t.Fatalf("release unused reservation status = %d", status)
	}
	if status := reserveTestUpload(t, handler, second, 64); status != http.StatusOK {
		t.Fatalf("reservation at remaining quota status = %d", status)
	}

	badDigest := bytes.Repeat([]byte{0}, sha256.Size)
	if status := putTestUploadObject(t, handler, second, "bcdefghijklmnopqrstuvwxy", body, badDigest); status != http.StatusUnprocessableEntity {
		t.Fatalf("digest mismatch status = %d, want 422", status)
	}
	otherDigest := sha256.Sum256(body)
	if status := putTestUploadObject(t, handler, second, "bcdefghijklmnopqrstuvwxy", body, otherDigest[:]); status != http.StatusCreated {
		t.Fatalf("claim was not released after digest mismatch: status = %d", status)
	}
	var used, reserved int64
	if err := handler.database.QueryRow(`SELECT COALESCE(SUM(size_bytes), 0) FROM objects WHERE state IN ('pending', 'live')`).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if err := handler.database.QueryRow(`SELECT COALESCE(SUM(reserved_bytes - consumed_bytes), 0) FROM upload_sessions WHERE state = 'active'`).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	if used != 72 || reserved != 28 || used+reserved != 100 {
		t.Fatalf("used=%d reserved=%d; want exact quota invariant (72 + 28 = 100)", used, reserved)
	}
	usageRequest := httptest.NewRequest(http.MethodGet, "/api/v1/storage/usage", nil)
	usageRequest.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	usageResponse := httptest.NewRecorder()
	handler.ServeHTTP(usageResponse, usageRequest)
	if usageResponse.Code != http.StatusOK || !strings.Contains(usageResponse.Body.String(), `"availableBytes":0`) || !strings.Contains(usageResponse.Body.String(), `"usedBytes":72`) {
		t.Fatalf("storage usage response = %d %s", usageResponse.Code, usageResponse.Body.String())
	}
}

func TestOversizedReservationReportsQuotaWithoutOverflowOrMutation(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", QuotaBytes: 100})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	addAuthenticatedTestSession(t, handler)
	first, second := createTestUpload(t, handler), createTestUpload(t, handler)
	if status := reserveTestUpload(t, handler, first, 25); status != http.StatusOK {
		t.Fatalf("reserve = %d", status)
	}
	for _, requested := range []int64{101, math.MaxInt64} {
		response := uploadRequest(t, handler, http.MethodPost, "/api/v1/uploads/"+second+"/reserve", []byte(fmt.Sprintf(`{"reservedBytes":%d}`, requested)))
		var result struct {
			Error          string `json:"error"`
			RequestID      string `json:"requestId"`
			ShortfallBytes int64  `json:"shortfallBytes"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusInsufficientStorage || result.Error != "quota_exceeded" || result.ShortfallBytes != requested-75 {
			t.Fatalf("requested=%d status=%d result=%+v", requested, response.Code, result)
		}
		if result.RequestID == "" || result.RequestID != response.Header().Get("X-Request-ID") {
			t.Fatalf("quota error lost its request identifier: %+v", result)
		}
	}
	if status := reserveTestUpload(t, handler, second, -1); status != http.StatusBadRequest {
		t.Fatalf("negative request = %d", status)
	}
	// A configuration reduced below existing reservations still rejects huge
	// requests; its diagnostic saturates instead of becoming a negative integer.
	request := httptest.NewRequest(http.MethodPost, "/reserve", strings.NewReader(fmt.Sprintf(`{"reservedBytes":%d}`, int64(math.MaxInt64))))
	request.Header.Set("Content-Type", "application/json")
	request.SetPathValue("id", second)
	response := httptest.NewRecorder()
	reserveUpload(response, request, handler.database, 1, filepath.Join(root, "objects"), 0)
	var reduced struct {
		ShortfallBytes int64 `json:"shortfallBytes"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &reduced); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusInsufficientStorage || reduced.ShortfallBytes != math.MaxInt64 {
		t.Fatalf("reduced quota status=%d shortfall=%d", response.Code, reduced.ShortfallBytes)
	}
	var reservation, consumed, claims, objects int64
	if err := handler.database.QueryRow(`SELECT reserved_bytes, consumed_bytes FROM upload_sessions WHERE id = ?`, second).Scan(&reservation, &consumed); err != nil {
		t.Fatal(err)
	}
	if err := handler.database.QueryRow(`SELECT COUNT(*) FROM upload_object_claims WHERE session_id = ?`, second).Scan(&claims); err != nil {
		t.Fatal(err)
	}
	if err := handler.database.QueryRow(`SELECT COUNT(*) FROM objects`).Scan(&objects); err != nil {
		t.Fatal(err)
	}
	if reservation != 0 || consumed != 0 || claims != 0 || objects != 0 {
		t.Fatalf("reservation=%d consumed=%d claims=%d objects=%d", reservation, consumed, claims, objects)
	}
}

func TestUploadStatusReconcilesPendingObjectsWithoutExposingCiphertext(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"),
		StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "server.secret"),
		Username: "admin", QuotaBytes: 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	addAuthenticatedTestSession(t, handler)
	uploadID := createTestUpload(t, handler)
	if status := reserveTestUpload(t, handler, uploadID, 100); status != http.StatusOK {
		t.Fatalf("reserve status = %d", status)
	}
	objectID := "abcdefghijklmnopqrstuvwx"
	body := bytes.Repeat([]byte{0xc7}, 36)
	digest := sha256.Sum256(body)
	if status := putTestUploadObject(t, handler, uploadID, objectID, body, digest[:]); status != http.StatusCreated {
		t.Fatalf("PUT status = %d", status)
	}
	response := uploadRequest(t, handler, http.MethodGet, "/api/v1/uploads/"+uploadID, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("GET upload status = %d, body=%s", response.Code, response.Body.String())
	}
	var status struct {
		State         string `json:"state"`
		ReservedBytes int64  `json:"reservedBytes"`
		ConsumedBytes int64  `json:"consumedBytes"`
		Objects       []struct {
			ObjectID  string `json:"objectId"`
			SizeBytes int64  `json:"sizeBytes"`
			SHA256    string `json:"sha256"`
		} `json:"objects"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.State != "active" || status.ReservedBytes != 100 || status.ConsumedBytes != 36 || len(status.Objects) != 1 || status.Objects[0].ObjectID != objectID || status.Objects[0].SizeBytes != 36 || status.Objects[0].SHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("unexpected upload reconciliation state: %+v", status)
	}
	if response.Body.Len() > 1024 || strings.Contains(response.Body.String(), hex.EncodeToString(body)) {
		t.Fatalf("status response unexpectedly includes object bytes: %s", response.Body.String())
	}
	unauthenticated := httptest.NewRequest(http.MethodGet, "/api/v1/uploads/"+uploadID, nil)
	unauthenticatedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticatedResponse, unauthenticated)
	if unauthenticatedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d", unauthenticatedResponse.Code)
	}
	if result := uploadRequest(t, handler, http.MethodPost, "/api/v1/uploads/"+uploadID+"/abandon", []byte(`{}`)); result.Code != http.StatusNoContent {
		t.Fatalf("abandon status = %d, body=%s", result.Code, result.Body.String())
	}
	response = uploadRequest(t, handler, http.MethodGet, "/api/v1/uploads/"+uploadID, nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"state":"aborted"`) || !strings.Contains(response.Body.String(), `"objects":[]`) {
		t.Fatalf("aborted status = %d, body=%s", response.Code, response.Body.String())
	}
}

type countedUploadReader struct {
	reader io.Reader
	read   int
}

type uploadWriterFunc func([]byte) (int, error)

func (f uploadWriterFunc) Write(p []byte) (int, error) { return f(p) }

func TestReceiveUploadBodySeparatesStorageWriteErrorsFromRequestCopyErrors(t *testing.T) {
	writeFailure := errors.New("injected temporary object write failure")
	failedDestination := uploadWriterFunc(func([]byte) (int, error) { return 0, writeFailure })
	written, copyErr, storageErr := receiveUploadBody(failedDestination, io.Discard, strings.NewReader("body"), 4)
	if written != 0 || !errors.Is(copyErr, writeFailure) || !errors.Is(storageErr, writeFailure) {
		t.Fatalf("destination failure = written %d, copy %v, storage %v", written, copyErr, storageErr)
	}

	shortDestination := uploadWriterFunc(func([]byte) (int, error) { return 1, nil })
	written, copyErr, storageErr = receiveUploadBody(shortDestination, io.Discard, strings.NewReader("body"), 4)
	if written != 1 || !errors.Is(copyErr, io.ErrShortWrite) || !errors.Is(storageErr, io.ErrShortWrite) {
		t.Fatalf("short destination write = written %d, copy %v, storage %v", written, copyErr, storageErr)
	}

	written, copyErr, storageErr = receiveUploadBody(io.Discard, io.Discard, strings.NewReader("short"), 8)
	if written != 5 || copyErr != nil || storageErr != nil {
		t.Fatalf("short request body = written %d, copy %v, storage %v", written, copyErr, storageErr)
	}
}

func (c *countedUploadReader) Read(p []byte) (int, error) {
	n, err := c.reader.Read(p)
	c.read += n
	return n, err
}

func TestUploadDeclaredLengthIsCheckedBeforeBodyAndUnknownTransportLengthIsBounded(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"),
		StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "server.secret"),
		Username: "admin", QuotaBytes: 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	addAuthenticatedTestSession(t, handler)
	uploadID := createTestUpload(t, handler)
	if status := reserveTestUpload(t, handler, uploadID, 100); status != http.StatusOK {
		t.Fatalf("reserve status = %d", status)
	}
	body := bytes.Repeat([]byte{0xb2}, 36)
	digest := sha256.Sum256(body)
	makeRequest := func(objectID string, reader io.Reader, transportLength int64) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPut, "/api/v1/uploads/"+uploadID+"/objects/"+objectID, reader)
		request.ContentLength = transportLength
		request.Header.Set(clientProtocolHeader, "1")
		request.Header.Set("Origin", "http://example.com")
		request.Header.Set("X-CSRF-Token", "test-csrf-token")
		request.Header.Set("X-XDrive-Object-Size", "36")
		request.Header.Set("X-XDrive-Ciphertext-SHA256", hex.EncodeToString(digest[:]))
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	objectID := "abcdefghijklmnopqrstuvwx"
	counted := &countedUploadReader{reader: bytes.NewReader(append(bytes.Clone(body), 0xff))}
	mismatch := makeRequest(objectID, counted, 37)
	if mismatch.Code != http.StatusBadRequest || !strings.Contains(mismatch.Body.String(), `"object_length_header_mismatch"`) || counted.read != 0 {
		t.Fatalf("header mismatch read body: status=%d read=%d body=%s", mismatch.Code, counted.read, mismatch.Body.String())
	}
	tooLong := makeRequest(objectID, bytes.NewReader(append(bytes.Clone(body), 0xff)), -1)
	if tooLong.Code != http.StatusRequestEntityTooLarge || !strings.Contains(tooLong.Body.String(), `"object_size_exceeded"`) {
		t.Fatalf("unknown-length overrun status=%d body=%s", tooLong.Code, tooLong.Body.String())
	}
	tooShort := makeRequest(objectID, bytes.NewReader(body[:35]), -1)
	if tooShort.Code != http.StatusBadRequest || !strings.Contains(tooShort.Body.String(), `"object_size_mismatch"`) {
		t.Fatalf("unknown-length short read status=%d body=%s", tooShort.Code, tooShort.Body.String())
	}
	retry := makeRequest(objectID, bytes.NewReader(body), -1)
	if retry.Code != http.StatusCreated {
		t.Fatalf("valid unknown-length retry status=%d body=%s", retry.Code, retry.Body.String())
	}
}

func TestAbandonPendingObjectReleasesSessionBytesWithoutTouchingAnotherSession(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"),
		StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "server.secret"),
		Username: "admin", QuotaBytes: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	addAuthenticatedTestSession(t, handler)
	first, second := createTestUpload(t, handler), createTestUpload(t, handler)
	if status := reserveTestUpload(t, handler, first, 100); status != http.StatusOK {
		t.Fatalf("reserve status = %d", status)
	}
	body := bytes.Repeat([]byte{0x44}, 36)
	digest := sha256.Sum256(body)
	objectID := "abcdefghijklmnopqrstuvwx"
	if status := putTestUploadObject(t, handler, first, objectID, body, digest[:]); status != http.StatusCreated {
		t.Fatalf("PUT status = %d", status)
	}
	wrongSession := uploadRequest(t, handler, http.MethodDelete, "/api/v1/uploads/"+second+"/objects/"+objectID, nil)
	if wrongSession.Code != http.StatusConflict {
		t.Fatalf("other session delete status = %d", wrongSession.Code)
	}
	deleted := uploadRequest(t, handler, http.MethodDelete, "/api/v1/uploads/"+first+"/objects/"+objectID, nil)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("pending object delete status = %d, body=%s", deleted.Code, deleted.Body.String())
	}
	var consumed int64
	if err := handler.database.QueryRow("SELECT consumed_bytes FROM upload_sessions WHERE id = ?", first).Scan(&consumed); err != nil || consumed != 0 {
		t.Fatalf("consumed bytes after delete = %d, error=%v", consumed, err)
	}
	if response := uploadRequest(t, handler, http.MethodGet, "/api/v1/uploads/"+first, nil); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"objects":[]`) {
		t.Fatalf("reconciled state after delete = %d %s", response.Code, response.Body.String())
	}
	newObjectID := "bcdefghijklmnopqrstuvwxy"
	if status := putTestUploadObject(t, handler, first, newObjectID, body, digest[:]); status != http.StatusCreated {
		t.Fatalf("replacement object PUT status = %d", status)
	}
}

func TestStartupRecoversOrphanClaimAndFinalPathBeforeAcceptingRetry(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"),
		StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "server.secret"),
		Username: "admin", QuotaBytes: 100,
	}
	handler, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	addAuthenticatedTestSession(t, handler)
	uploadID := createTestUpload(t, handler)
	if status := reserveTestUpload(t, handler, uploadID, 100); status != http.StatusOK {
		t.Fatalf("reserve status = %d", status)
	}
	body := bytes.Repeat([]byte{0x49}, 36)
	digest := sha256.Sum256(body)
	objectID := "abcdefghijklmnopqrstuvwx"
	if _, err := handler.database.Exec(`INSERT INTO upload_object_claims
		(session_id, object_id, expected_size_bytes, expected_sha256, created_at) VALUES (?, ?, ?, ?, ?)`, uploadID, objectID, 36, digest[:], time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	objectDir := filepath.Join(cfg.StoragePath, objectID[:2])
	if err := os.MkdirAll(objectDir, 0o700); err != nil {
		t.Fatal(err)
	}
	finalPath := filepath.Join(objectDir, objectID)
	if err := os.WriteFile(finalPath, body, 0o600); err != nil {
		t.Fatal(err)
	}
	temporaryPath := filepath.Join(objectDir, ".upload-interrupted")
	if err := os.WriteFile(temporaryPath, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := handler.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if _, err := os.Stat(finalPath); !os.IsNotExist(err) {
		t.Fatalf("orphan final path survived startup recovery: %v", err)
	}
	if _, err := os.Stat(temporaryPath); !os.IsNotExist(err) {
		t.Fatalf("orphan temporary path survived startup recovery: %v", err)
	}
	var claims int
	if err := restarted.database.QueryRow("SELECT COUNT(*) FROM upload_object_claims WHERE object_id = ?", objectID).Scan(&claims); err != nil || claims != 0 {
		t.Fatalf("orphan claim survived startup recovery: count=%d error=%v", claims, err)
	}
	if status := putTestUploadObject(t, restarted, uploadID, objectID, body, digest[:]); status != http.StatusCreated {
		t.Fatalf("resumed PUT after restart status = %d", status)
	}
}

func TestUploadReservationPreservesConfiguredDiskSafetyReserve(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr:      "127.0.0.1:8787",
		DatabasePath:    filepath.Join(root, "drive.db"),
		StoragePath:     filepath.Join(root, "objects"),
		SecretPath:      filepath.Join(root, "server.secret"),
		Username:        "admin",
		QuotaBytes:      100,
		DiskSafetyBytes: math.MaxInt64,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	addAuthenticatedTestSession(t, handler)
	uploadID := createTestUpload(t, handler)
	response := uploadRequest(t, handler, http.MethodPost, "/api/v1/uploads/"+uploadID+"/reserve", []byte(`{"reservedBytes":36}`))
	if response.Code != http.StatusInsufficientStorage || !strings.Contains(response.Body.String(), `"error":"disk_space_low"`) {
		t.Fatalf("disk safety response = %d %s", response.Code, response.Body.String())
	}
	var reserved int64
	if err := handler.database.QueryRow("SELECT reserved_bytes FROM upload_sessions WHERE id = ?", uploadID).Scan(&reserved); err != nil || reserved != 0 {
		t.Fatalf("low-disk reservation changed session state: reserved=%d error=%v", reserved, err)
	}
}

func addAuthenticatedTestSession(t *testing.T, handler *Handler) {
	t.Helper()
	token := "0123456789abcdefghijklmnopqrstuv"
	csrf := "test-csrf-token"
	hash := sha256.Sum256([]byte(token))
	now := time.Now().Unix()
	if _, err := handler.database.Exec(`INSERT INTO users (id, username, auth_salt, auth_hash, state, created_at) VALUES (1, 'admin', ?, ?, 'active', ?)`, bytes.Repeat([]byte{1}, 16), bytes.Repeat([]byte{2}, 32), now); err != nil {
		t.Fatal(err)
	}
	if _, err := handler.database.Exec(`INSERT INTO sessions (id_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)`, hash[:], csrf, now, now, now+3600); err != nil {
		t.Fatal(err)
	}
}

func createTestUpload(t *testing.T, handler *Handler) string {
	t.Helper()
	response := uploadRequest(t, handler, http.MethodPost, "/api/v1/uploads", []byte(`{}`))
	if response.Code != http.StatusCreated {
		t.Fatalf("create upload status = %d, body=%s", response.Code, response.Body.String())
	}
	var result struct {
		ID string `json:"uploadId"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || !opaqueIDPattern.MatchString(result.ID) {
		t.Fatalf("invalid upload response: %s, error=%v", response.Body.String(), err)
	}
	return result.ID
}

func reserveTestUpload(t *testing.T, handler *Handler, uploadID string, reserved int64) int {
	t.Helper()
	body := []byte(fmt.Sprintf(`{"reservedBytes":%d}`, reserved))
	request := uploadRequest(t, handler, http.MethodPost, "/api/v1/uploads/"+uploadID+"/reserve", body)
	return request.Code
}

func putTestUploadObject(t *testing.T, handler *Handler, uploadID, objectID string, body, digest []byte) int {
	t.Helper()
	request := httptest.NewRequest(http.MethodPut, "/api/v1/uploads/"+uploadID+"/objects/"+objectID, bytes.NewReader(body))
	request.Header.Set(clientProtocolHeader, "1")
	request.Header.Set("Origin", "http://example.com")
	request.Header.Set("X-CSRF-Token", "test-csrf-token")
	request.Header.Set("X-XDrive-Object-Size", fmt.Sprintf("%d", len(body)))
	request.Header.Set("X-XDrive-Ciphertext-SHA256", hex.EncodeToString(digest))
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response.Code
}

func uploadRequest(t *testing.T, handler *Handler, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set(clientProtocolHeader, "1")
	request.Header.Set("Origin", "http://example.com")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", "test-csrf-token")
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestPUTRechecksPhysicalDiskAfterClaimWithoutReadingBody(t *testing.T) {
	h, storagePath := concurrentUploadFixture(t)
	session := createTestUpload(t, h)
	if _, err := h.database.Exec("UPDATE upload_sessions SET reserved_bytes=36 WHERE id=?", session); err != nil {
		t.Fatal(err)
	}
	data := bytes.Repeat([]byte{0x28}, 36)
	body := &countedUploadReader{reader: bytes.NewReader(data)}
	digest := sha256.Sum256(data)
	// Run the actual PUT with a safety requirement larger than any available disk.
	request := httptest.NewRequest(http.MethodPut, "/", body)
	request.SetPathValue("id", session)
	request.SetPathValue("objectId", "disk-check-object-0123456789")
	request.ContentLength = 36
	request.Header.Set("X-XDrive-Object-Size", "36")
	request.Header.Set("X-XDrive-Ciphertext-SHA256", hex.EncodeToString(digest[:]))
	response := httptest.NewRecorder()
	putUploadObject(response, request, h.database, storagePath, math.MaxInt64, config.DefaultObjectPutMaxBytes, nil, 0)
	if response.Code != http.StatusInsufficientStorage || body.read != 0 {
		t.Fatalf("low disk body: %d read=%d", response.Code, body.read)
	}
	for _, table := range []string{"upload_object_claims", "upload_receive_fences", "objects"} {
		var count int
		if err := h.database.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("low disk leaked %s: %d %v", table, count, err)
		}
	}
}

func TestConfiguredObjectPutLimitBoundsBodyBeforeClaims(t *testing.T) {
	for _, limit := range []int64{config.MinObjectPutMaxBytes, config.DefaultObjectPutMaxBytes, 17 << 20} {
		t.Run(fmt.Sprint(limit), func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("XDRIVE_OBJECT_PUT_MAX_BYTES", fmt.Sprint(limit))
			cfg, err := config.Load("")
			if err != nil {
				t.Fatal(err)
			}
			cfg.DatabasePath = filepath.Join(root, "drive.db")
			cfg.StoragePath = filepath.Join(root, "objects")
			cfg.SecretPath = filepath.Join(root, "secret")
			cfg.DiskSafetyBytes = 0
			h, err := New(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			addAuthenticatedTestSession(t, h)
			id := createTestUpload(t, h)
			if status := reserveTestUpload(t, h, id, limit+1); status != http.StatusOK {
				t.Fatalf("reserve %d", status)
			}
			oversized := &countedUploadReader{reader: strings.NewReader("must not read")}
			request := httptest.NewRequest(http.MethodPut, "/api/v1/uploads/"+id+"/objects/abcdefghijklmnopqrstuvwx", oversized)
			request.ContentLength = limit + 1
			request.Header.Set(clientProtocolHeader, "1")
			request.Header.Set("Origin", "http://example.com")
			request.Header.Set("X-CSRF-Token", "test-csrf-token")
			request.Header.Set("X-XDrive-Object-Size", fmt.Sprint(limit+1))
			request.Header.Set("X-XDrive-Ciphertext-SHA256", strings.Repeat("0", 64))
			request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest || oversized.read != 0 {
				t.Fatalf("oversize: %d reads=%d %s", response.Code, oversized.read, response.Body.String())
			}
			var claims, fences, objects, consumed int64
			for _, item := range []struct {
				query  string
				target *int64
			}{
				{"SELECT COUNT(*) FROM upload_object_claims", &claims},
				{"SELECT COUNT(*) FROM upload_receive_fences", &fences},
				{"SELECT COUNT(*) FROM objects", &objects},
				{"SELECT consumed_bytes FROM upload_sessions WHERE id = '" + id + "'", &consumed},
			} {
				if err := h.database.QueryRow(item.query).Scan(item.target); err != nil {
					t.Fatal(err)
				}
			}
			if claims+fences+objects+consumed != 0 {
				t.Fatalf("rejected body changed accounting: %d/%d/%d/%d", claims, fences, objects, consumed)
			}
			body := bytes.Repeat([]byte{0x71}, int(limit))
			digest := sha256.Sum256(body)
			if status := putTestUploadObject(t, h, id, "abcdefghijklmnopqrstuvwx", body, digest[:]); status != http.StatusCreated {
				t.Fatalf("exact limit %d", status)
			}
			stored, err := os.ReadFile(filepath.Join(cfg.StoragePath, "ab", "abcdefghijklmnopqrstuvwx"))
			if err != nil || !bytes.Equal(stored, body) {
				t.Fatalf("persisted boundary differs: %v", err)
			}
		})
	}
}
