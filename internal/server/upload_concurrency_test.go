package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"xdrive/internal/config"
)

// Hold a real handler inside body reception, after the first bytes reached its
// temporary file. Channel barriers avoid sleeping or test-only production hooks.
type stalledUploadBody struct {
	reader  *bytes.Reader
	started chan struct{}
	release chan struct{}
	first   bool
	once    sync.Once
}

func (b *stalledUploadBody) Read(p []byte) (int, error) {
	if !b.first {
		b.first = true
		return b.reader.Read(p[:min(len(p), 12)])
	}
	b.once.Do(func() { close(b.started) })
	<-b.release
	return b.reader.Read(p)
}

func concurrentUploadFixture(t *testing.T) (*Handler, string) {
	t.Helper()
	root := t.TempDir()
	h, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", QuotaBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	addAuthenticatedTestSession(t, h)
	return h, filepath.Join(root, "objects")
}

func startStalledPUT(t *testing.T, h *Handler, session, object string, data []byte) (<-chan *httptest.ResponseRecorder, func()) {
	t.Helper()
	body := &stalledUploadBody{reader: bytes.NewReader(data), started: make(chan struct{}), release: make(chan struct{})}
	var once sync.Once
	release := func() { once.Do(func() { close(body.release) }) }
	t.Cleanup(release)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- serveUploadBody(h, session, object, body, data) }()
	select {
	case <-body.started:
	case response := <-done:
		t.Fatalf("PUT returned before body barrier: %d %s", response.Code, response.Body.String())
	case <-time.After(5 * time.Second):
		t.Fatal("PUT did not begin receiving")
	}
	return done, release
}

func serveUploadBody(h *Handler, session, object string, reader io.Reader, data []byte) *httptest.ResponseRecorder {
	digest := sha256.Sum256(data)
	r := httptest.NewRequest(http.MethodPut, "/api/v1/uploads/"+session+"/objects/"+object, reader)
	r.ContentLength = int64(len(data))
	r.Header.Set(clientProtocolHeader, "1")
	r.Header.Set("Origin", "http://example.com")
	r.Header.Set("X-CSRF-Token", "test-csrf-token")
	r.Header.Set("X-XDrive-Object-Size", fmt.Sprint(len(data)))
	r.Header.Set("X-XDrive-Ciphertext-SHA256", hex.EncodeToString(digest[:]))
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func receiveResult(t *testing.T, done <-chan *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("receiving handler did not exit")
		return nil
	}
}

func TestClosedSessionRetainsObjectFenceUntilReceivingPUTExits(t *testing.T) {
	for _, transition := range []string{"abort", "cleanup-expiry", "reservation-expiry"} {
		t.Run(transition, func(t *testing.T) {
			h, storagePath := concurrentUploadFixture(t)
			first, second := createTestUpload(t, h), createTestUpload(t, h)
			for _, session := range []string{first, second} {
				if reserveTestUpload(t, h, session, 36) != http.StatusOK {
					t.Fatal("reserve failed")
				}
			}
			object := "abcdefghijklmnopqrstuvwx"
			data := bytes.Repeat([]byte{0x41}, 36)
			done, release := startStalledPUT(t, h, first, object, data)
			switch transition {
			case "abort":
				if w := uploadRequest(t, h, http.MethodPost, "/api/v1/uploads/"+first+"/abandon", []byte(`{}`)); w.Code != http.StatusNoContent {
					t.Fatalf("abort: %d", w.Code)
				}
			default:
				if _, err := h.database.Exec("UPDATE upload_sessions SET expires_at = ? WHERE id = ?", time.Now().Add(-48*time.Hour).Unix(), first); err != nil {
					t.Fatal(err)
				}
				if transition == "cleanup-expiry" {
					if err := CleanupOnce(context.Background(), h.database, storagePath, time.Now()); err != nil {
						t.Fatal(err)
					}
				} else if reserveTestUpload(t, h, second, 36) != http.StatusOK {
					t.Fatal("expiry reservation failed")
				}
			}
			var claims int
			if err := h.database.QueryRow("SELECT COUNT(*) FROM upload_receive_fences WHERE object_id = ?", object).Scan(&claims); err != nil || claims != 1 {
				t.Fatalf("fence removed early: %d %v", claims, err)
			}
			var activeClaims int
			if err := h.database.QueryRow("SELECT COUNT(*) FROM upload_object_claims WHERE object_id = ?", object).Scan(&activeClaims); err != nil || activeClaims != 0 {
				t.Fatalf("closed session retained quota claim: %d %v", activeClaims, err)
			}
			otherData := bytes.Repeat([]byte{0x42}, 36)
			body := &countedUploadReader{reader: bytes.NewReader(otherData)}
			if result := serveUploadBody(h, second, object, body, otherData); result.Code != http.StatusConflict || body.read != 0 {
				t.Fatalf("competing receiver consumed body: status=%d read=%d", result.Code, body.read)
			}
			release()
			if result := receiveResult(t, done); result.Code != http.StatusNotFound {
				t.Fatalf("closed PUT published: %d %s", result.Code, result.Body.String())
			}
			if err := h.database.QueryRow("SELECT COUNT(*) FROM upload_receive_fences WHERE object_id = ?", object).Scan(&claims); err != nil || claims != 0 {
				t.Fatalf("fence not released: %d %v", claims, err)
			}
			if result := serveUploadBody(h, second, object, bytes.NewReader(otherData), otherData); result.Code != http.StatusCreated {
				t.Fatalf("replacement PUT: %d %s", result.Code, result.Body.String())
			}
			stored, err := os.ReadFile(filepath.Join(storagePath, object[:2], object))
			if err != nil || !bytes.Equal(stored, otherData) {
				t.Fatalf("new receiver bytes changed: %v", err)
			}
		})
	}
}

func TestMetadataCommitRejectsStillReceivingObjectWithoutPartialActivation(t *testing.T) {
	h, _ := concurrentUploadFixture(t)
	session := createTestUpload(t, h)
	if reserveTestUpload(t, h, session, 72) != http.StatusOK {
		t.Fatal("reserve failed")
	}
	indexObject, receivingObject, index := "abcdefghijklmnopqrstuvwx", "bcdefghijklmnopqrstuvwxy", "cdefghijklmnopqrstuvwxyz"
	data := bytes.Repeat([]byte{0x56}, 36)
	digest := sha256.Sum256(data)
	if putTestUploadObject(t, h, session, indexObject, data, digest[:]) != http.StatusCreated {
		t.Fatal("index upload failed")
	}
	done, release := startStalledPUT(t, h, session, receivingObject, data)
	body := fmt.Sprintf(`{"uploadId":%q,"expectedGlobalRevision":0,"activateObjectIds":[%q],"updates":[{"metadataId":%q,"expectedRevision":0,"objectId":%q}]}`, session, indexObject, index, indexObject)
	result := metadataTransactionRequestForTest(t, h, body, "receivecommitbarrier")
	if result.Code != http.StatusConflict || !strings.Contains(result.Body.String(), "object_receive_in_progress") {
		t.Fatalf("commit did not wait: %d %s", result.Code, result.Body.String())
	}
	var pointers int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_pointers").Scan(&pointers); err != nil || pointers != 0 {
		t.Fatalf("partial pointer: %d %v", pointers, err)
	}
	release()
	if result := receiveResult(t, done); result.Code != http.StatusCreated {
		t.Fatalf("receive finish: %d", result.Code)
	}
	result = metadataTransactionRequestForTest(t, h, body, "receivecommitbarrier")
	if result.Code != http.StatusOK {
		t.Fatalf("commit after receive: %d %s", result.Code, result.Body.String())
	}
}

func TestDuplicateClaimNeverReceivesASecondBodyAndRetriesIdempotently(t *testing.T) {
	h, _ := concurrentUploadFixture(t)
	session, other := createTestUpload(t, h), createTestUpload(t, h)
	for _, id := range []string{session, other} {
		if reserveTestUpload(t, h, id, 36) != http.StatusOK {
			t.Fatal("reserve failed")
		}
	}
	object := "abcdefghijklmnopqrstuvwx"
	data := bytes.Repeat([]byte{0x72}, 36)
	digest := sha256.Sum256(data)
	done, release := startStalledPUT(t, h, session, object, data)
	foreignBody := &countedUploadReader{reader: bytes.NewReader(data)}
	if result := serveUploadBody(h, other, object, foreignBody, data); result.Code != http.StatusConflict || foreignBody.read != 0 {
		t.Fatalf("different session consumed a body for the in-flight object: %d %s read=%d", result.Code, result.Body.String(), foreignBody.read)
	}
	r := httptest.NewRequest(http.MethodPut, "/", nil)
	duplicateBody := &countedUploadReader{reader: bytes.NewReader(data)}
	if result := serveUploadBody(h, session, object, duplicateBody, data); result.Code != http.StatusConflict || !strings.Contains(result.Body.String(), "object_receive_in_progress") || duplicateBody.read != 0 {
		t.Fatalf("duplicate inflight PUT read body: %d %s read=%d", result.Code, result.Body.String(), duplicateBody.read)
	}
	if _, err := acquireUploadClaimOnce(r, h.database, session, object, 36, digest[:]); !errors.Is(err, errUploadInProgress) {
		t.Fatalf("same claim did not wait: %v", err)
	}
	if _, err := acquireUploadClaimOnce(r, h.database, other, object, 36, digest[:]); !errors.Is(err, errUploadConflict) {
		t.Fatalf("different owner acquired claim: %v", err)
	}
	wrong := sha256.Sum256([]byte("different digest"))
	if _, err := acquireUploadClaimOnce(r, h.database, session, object, 36, wrong[:]); !errors.Is(err, errUploadConflict) {
		t.Fatalf("different digest acquired claim: %v", err)
	}
	release()
	if w := receiveResult(t, done); w.Code != http.StatusCreated {
		t.Fatalf("original PUT: %d", w.Code)
	}
	body := &countedUploadReader{reader: bytes.NewReader(data)}
	if w := serveUploadBody(h, session, object, body, data); w.Code != http.StatusNoContent || body.read != 0 {
		t.Fatalf("idempotent retry read body: %d %d", w.Code, body.read)
	}
	var consumed, reserved, claims int64
	if err := h.database.QueryRow(`SELECT consumed_bytes, reserved_bytes,
		(SELECT COALESCE(SUM(expected_size_bytes), 0) FROM upload_object_claims WHERE session_id = ?)
		FROM upload_sessions WHERE id = ?`, session, session).Scan(&consumed, &reserved, &claims); err != nil {
		t.Fatal(err)
	}
	if consumed != 36 || reserved != 36 || claims != 0 {
		t.Fatalf("duplicate accounting: consumed=%d reserved=%d claims=%d", consumed, reserved, claims)
	}
	var foreignConsumed, foreignReserved int64
	if err := h.database.QueryRow("SELECT consumed_bytes, reserved_bytes FROM upload_sessions WHERE id = ?", other).Scan(&foreignConsumed, &foreignReserved); err != nil {
		t.Fatal(err)
	}
	if foreignConsumed != 0 || foreignReserved != 36 {
		t.Fatalf("conflicting session accounting changed: consumed=%d reserved=%d", foreignConsumed, foreignReserved)
	}
}

func TestConcurrentUploadReservationsNeverExceedQuota(t *testing.T) {
	h, _ := concurrentUploadFixture(t)
	const reservation int64 = 2048
	const uploadCount = 4
	uploads := make([]string, uploadCount)
	for i := range uploads {
		uploads[i] = createTestUpload(t, h)
	}

	type reservationResult struct {
		status int
		body   string
	}
	start := make(chan struct{})
	results := make(chan reservationResult, uploadCount)
	var workers sync.WaitGroup
	workers.Add(uploadCount)
	for _, uploadID := range uploads {
		go func(id string) {
			defer workers.Done()
			request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/"+id+"/reserve", strings.NewReader(fmt.Sprintf(`{"reservedBytes":%d}`, reservation)))
			request.Header.Set(clientProtocolHeader, "1")
			request.Header.Set("Origin", "http://example.com")
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-CSRF-Token", "test-csrf-token")
			request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
			response := httptest.NewRecorder()
			<-start
			h.ServeHTTP(response, request)
			results <- reservationResult{status: response.Code, body: response.Body.String()}
		}(uploadID)
	}
	close(start)
	workers.Wait()
	close(results)

	var accepted, rejected int
	for result := range results {
		switch result.status {
		case http.StatusOK:
			accepted++
		case http.StatusInsufficientStorage:
			if !strings.Contains(result.body, `"error":"quota_exceeded"`) {
				t.Fatalf("quota rejection had the wrong error: %s", result.body)
			}
			rejected++
		default:
			t.Fatalf("concurrent reservation returned unexpected status %d: %s", result.status, result.body)
		}
	}
	if accepted != 2 || rejected != 2 {
		t.Fatalf("concurrent reservations accepted=%d rejected=%d; want 2/2 at exact quota", accepted, rejected)
	}

	var used, reserved, claims, objects int64
	if err := h.database.QueryRow(`SELECT
		(SELECT COALESCE(SUM(size_bytes),0) FROM objects WHERE state IN ('live','pending')),
		(SELECT COALESCE(SUM(reserved_bytes-consumed_bytes),0) FROM upload_sessions WHERE state='active'),
		(SELECT COUNT(*) FROM upload_object_claims),
		(SELECT COUNT(*) FROM objects)`).Scan(&used, &reserved, &claims, &objects); err != nil {
		t.Fatal(err)
	}
	if used+reserved > 4096 || used != 0 || reserved != 4096 || claims != 0 || objects != 0 {
		t.Fatalf("concurrent reservation accounting: used=%d reserved=%d claims=%d objects=%d", used, reserved, claims, objects)
	}
	usage := readUsage(t, h)
	if usage["usedBytes"] != float64(0) || usage["reservedBytes"] != float64(4096) || usage["availableBytes"] != float64(0) {
		t.Fatalf("usage snapshot disagrees with reservation ledger: %v", usage)
	}
}

func TestUploadDoesNotReplaceUnexpectedExistingFinalPath(t *testing.T) {
	h, storagePath := concurrentUploadFixture(t)
	session := createTestUpload(t, h)
	if reserveTestUpload(t, h, session, 36) != http.StatusOK {
		t.Fatal("reserve failed")
	}
	object := "abcdefghijklmnopqrstuvwx"
	data := bytes.Repeat([]byte{0x42}, 36)
	preexisting := bytes.Repeat([]byte{0xa5}, 36)
	objectDir := filepath.Join(storagePath, object[:2])
	if err := os.MkdirAll(objectDir, 0o700); err != nil {
		t.Fatal(err)
	}
	finalPath := filepath.Join(objectDir, object)
	if err := os.WriteFile(finalPath, preexisting, 0o600); err != nil {
		t.Fatal(err)
	}

	result := serveUploadBody(h, session, object, bytes.NewReader(data), data)
	if result.Code != http.StatusConflict || !strings.Contains(result.Body.String(), `"error":"object_conflict"`) {
		t.Fatalf("upload did not reject an occupied final path: %d %s", result.Code, result.Body.String())
	}
	if stored, err := os.ReadFile(finalPath); err != nil || !bytes.Equal(stored, preexisting) {
		t.Fatalf("upload changed the pre-existing object path: equal=%v error=%v", bytes.Equal(stored, preexisting), err)
	}
	var objects, claims, fences int
	var reserved, consumed int64
	if err := h.database.QueryRow(`SELECT
		(SELECT COUNT(*) FROM objects WHERE id = ?),
		(SELECT COUNT(*) FROM upload_object_claims WHERE object_id = ?),
		(SELECT COUNT(*) FROM upload_receive_fences WHERE object_id = ?),
		(SELECT reserved_bytes FROM upload_sessions WHERE id = ?),
		(SELECT consumed_bytes FROM upload_sessions WHERE id = ?)`, object, object, object, session, session).Scan(&objects, &claims, &fences, &reserved, &consumed); err != nil {
		t.Fatal(err)
	}
	if objects != 0 || claims != 0 || fences != 0 || reserved != 36 || consumed != 0 {
		t.Fatalf("conflict left inconsistent state: objects=%d claims=%d fences=%d reserved=%d consumed=%d", objects, claims, fences, reserved, consumed)
	}

	if err := os.Remove(finalPath); err != nil {
		t.Fatal(err)
	}
	result = serveUploadBody(h, session, object, bytes.NewReader(data), data)
	if result.Code != http.StatusCreated {
		t.Fatalf("same upload could not retry after conflict removal: %d %s", result.Code, result.Body.String())
	}
	if stored, err := os.ReadFile(finalPath); err != nil || !bytes.Equal(stored, data) {
		t.Fatalf("retry did not publish the requested bytes: equal=%v error=%v", bytes.Equal(stored, data), err)
	}
}

func TestClosedReceiveFenceSurvivesUntilStartupRecovery(t *testing.T) {
	h, storagePath := concurrentUploadFixture(t)
	session := createTestUpload(t, h)
	object := "startup-fence-object-0123456789"
	data := bytes.Repeat([]byte{0x57}, 36)
	digest := sha256.Sum256(data)
	if _, err := h.database.Exec("UPDATE upload_sessions SET state='aborted' WHERE id=?", session); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec("INSERT INTO upload_receive_fences VALUES (?,?,36,?,1)", object, session, digest[:]); err != nil {
		t.Fatal(err)
	}
	shard := filepath.Join(storagePath, object[:2])
	if err := os.MkdirAll(shard, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{object, ".upload-interrupted"} {
		if err := os.WriteFile(filepath.Join(shard, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := RecoverUploadClaimsAtStartup(context.Background(), h.database, storagePath); err != nil {
		t.Fatal(err)
	}
	var fences int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM upload_receive_fences").Scan(&fences); err != nil || fences != 0 {
		t.Fatalf("startup fences: %d %v", fences, err)
	}
	for _, name := range []string{object, ".upload-interrupted"} {
		if _, err := os.Stat(filepath.Join(shard, name)); !os.IsNotExist(err) {
			t.Fatalf("startup orphan remains: %s %v", name, err)
		}
	}
	next := createTestUpload(t, h)
	if reserveTestUpload(t, h, next, 36) != http.StatusOK {
		t.Fatal("reserve")
	}
	if result := serveUploadBody(h, next, object, bytes.NewReader(data), data); result.Code != http.StatusCreated {
		t.Fatalf("recovered ID: %d %s", result.Code, result.Body.String())
	}
}

func TestStalledTCPUploadDeadlineReleasesFenceAndAllowsRetry(t *testing.T) {
	h, storagePath := concurrentUploadFixture(t)
	const receiveTimeout = 500 * time.Millisecond
	h.uploadReceiveTimeout = receiveTimeout
	session := createTestUpload(t, h)
	if reserveTestUpload(t, h, session, 36) != http.StatusOK {
		t.Fatal("reserve failed")
	}
	object := "abcdefghijklmnopqrstuvwx"
	data := bytes.Repeat([]byte{0x61}, 36)
	digest := sha256.Sum256(data)
	server := httptest.NewServer(h)
	defer server.Close()
	address := strings.TrimPrefix(server.URL, "http://")
	connection, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		t.Fatal("connect to test upload server", err)
	}
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	defer connection.Close()
	_, err = fmt.Fprintf(connection, "PUT /api/v1/uploads/%s/objects/%s HTTP/1.1\r\nHost: %s\r\nOrigin: http://%s\r\nX-CSRF-Token: test-csrf-token\r\nX-XDrive-Client-Protocol: 1\r\nX-XDrive-Object-Size: %d\r\nX-XDrive-Ciphertext-SHA256: %s\r\nCookie: %s=0123456789abcdefghijklmnopqrstuv\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", session, object, address, address, len(data), hex.EncodeToString(digest[:]), sessionCookieName, len(data))
	if err != nil {
		t.Fatal("write stalled upload headers", err)
	}
	started := time.Now()
	if _, err := connection.Write(data[:12]); err != nil {
		t.Fatal("write first body window", err)
	}
	shard := filepath.Join(storagePath, object[:2])
	if err := waitForUploadTemporary(shard, 12); err != nil {
		t.Fatal("server did not persist first body window", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPut})
	if err != nil {
		t.Fatal("read stalled upload response", err)
	}
	responseBody, bodyErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if elapsed := time.Since(started); elapsed < receiveTimeout*3/5 {
		t.Fatalf("server returned before the configured body read deadline: elapsed=%s", elapsed)
	}
	_ = connection.Close()
	if response.StatusCode != http.StatusRequestTimeout || bodyErr != nil || closeErr != nil || !strings.Contains(string(responseBody), "upload_receive_timeout") {
		t.Fatalf("stalled PUT response: status=%d body=%s read=%v close=%v", response.StatusCode, responseBody, bodyErr, closeErr)
	}
	if temporary, err := filepath.Glob(filepath.Join(shard, ".upload-*")); err != nil || len(temporary) != 0 {
		t.Fatalf("deadline left temporary files: %q %v", temporary, err)
	}
	var objects, claims, fences int
	var reserved, consumed int64
	if err := h.database.QueryRow(`SELECT
		(SELECT COUNT(*) FROM objects WHERE id = ?),
		(SELECT COUNT(*) FROM upload_object_claims WHERE object_id = ?),
		(SELECT COUNT(*) FROM upload_receive_fences WHERE object_id = ?),
		(SELECT reserved_bytes FROM upload_sessions WHERE id = ?),
		(SELECT consumed_bytes FROM upload_sessions WHERE id = ?)`, object, object, object, session, session).Scan(&objects, &claims, &fences, &reserved, &consumed); err != nil {
		t.Fatal(err)
	}
	if objects != 0 || claims != 0 || fences != 0 || reserved != 36 || consumed != 0 {
		t.Fatalf("deadline left inconsistent state: objects=%d claims=%d fences=%d reserved=%d consumed=%d", objects, claims, fences, reserved, consumed)
	}
	if status := networkPUTStatus(t, address, session, object, data, digest[:]); status != http.StatusCreated {
		t.Fatalf("retry after receive deadline returned %d", status)
	}
	if stored, err := os.ReadFile(filepath.Join(shard, object)); err != nil || !bytes.Equal(stored, data) {
		t.Fatalf("retry after receive deadline stored different bytes: equal=%v error=%v", bytes.Equal(stored, data), err)
	}
}
