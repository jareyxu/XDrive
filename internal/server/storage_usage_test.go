package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
	"xdrive/internal/config"
)

func readUsage(t *testing.T, h *Handler) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/storage/usage", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	response := httptest.NewRecorder()
	h.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("usage status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("usage must not be cached")
	}
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestStorageUsageSubsetsClaimsAndBackupMilliseconds(t *testing.T) {
	h, path := concurrentUploadFixture(t)
	defer h.Close()
	unauthenticated := httptest.NewRecorder()
	h.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/v1/storage/usage", nil))
	if unauthenticated.Code != http.StatusUnauthorized || bytes.Contains(unauthenticated.Body.Bytes(), []byte("freeDiskBytes")) {
		t.Fatal("disk and logical usage must require authentication")
	}
	body := bytes.Repeat([]byte{7}, 36)
	digest := sha256.Sum256(body)
	ids := []string{"aaaaaaaaaaaaaaaaaaaaaaa1", "aaaaaaaaaaaaaaaaaaaaaaa2", "aaaaaaaaaaaaaaaaaaaaaaa3"}
	var sessions []string
	for _, id := range ids {
		session := createTestUpload(t, h)
		sessions = append(sessions, session)
		if reserveTestUpload(t, h, session, 100) != http.StatusOK || putTestUploadObject(t, h, session, id, body, digest[:]) != http.StatusCreated {
			t.Fatal("prepare upload")
		}
	}
	// First is pending, second active trash, third referenced only by purging trash.
	for _, id := range ids[1:] {
		if _, err := h.database.Exec("UPDATE objects SET state='live' WHERE id=?", id); err != nil {
			t.Fatal(err)
		}
	}
	for _, session := range sessions[1:] {
		if _, err := h.database.Exec("UPDATE upload_sessions SET state='committed' WHERE id=?", session); err != nil {
			t.Fatal(err)
		}
	}
	for _, stone := range []struct{ id, state string }{{"active-one", "active"}, {"active-two", "active"}, {"purging-one", "purging"}} {
		if _, err := h.database.Exec("INSERT INTO tombstones(id,deleted_at,state) VALUES(?,1,?)", stone.id, stone.state); err != nil {
			t.Fatal(err)
		}
	}
	for _, stone := range []string{"active-one", "active-two"} {
		if _, err := h.database.Exec("INSERT INTO tombstone_objects(tombstone_id,object_id) VALUES(?,?)", stone, ids[1]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.database.Exec("INSERT INTO tombstone_objects(tombstone_id,object_id) VALUES('purging-one',?)", ids[2]); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec("INSERT INTO upload_object_claims(session_id,object_id,expected_size_bytes,expected_sha256,created_at) VALUES(?, 'bbbbbbbbbbbbbbbbbbbbbbbb',36,?,unixepoch())", sessions[0], digest[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec("UPDATE server_state SET last_backup_at=1760000000 WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	usage := readUsage(t, h)
	for name, want := range map[string]float64{"usedBytes": 108, "pendingBytes": 36, "reservedBytes": 64, "trashBytes": 36, "lastBackupAt": 1760000000000} {
		if usage[name] != want {
			t.Fatalf("%s=%v want %v", name, usage[name], want)
		}
	}
	if usage["availableBytes"] != usage["quotaBytes"].(float64)-172 {
		t.Fatalf("double counted pending/claims: %v", usage)
	}
	if usage["freeDiskBytes"].(float64) < 0 {
		t.Fatal("invalid disk count")
	}
	// A reduced configured quota never wraps negative capacity to positive.
	response := httptest.NewRecorder()
	storageUsage(response, httptest.NewRequest("GET", "/", nil), h.database, 1, path, 30)
	var reduced map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &reduced); err != nil {
		t.Fatal(err)
	}
	if reduced["availableBytes"] != float64(0) {
		t.Fatal("reduced quota must floor at zero")
	}
	if _, err := h.database.Exec("UPDATE server_state SET last_backup_at=NULL WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	if readUsage(t, h)["lastBackupAt"] != nil {
		t.Fatal("never backed up must be null")
	}
	response = httptest.NewRecorder()
	storageUsage(response, httptest.NewRequest("GET", "/", nil), h.database, math.MaxInt64, path+"/missing", 30)
	if response.Code != http.StatusInternalServerError || !bytes.Contains(response.Body.Bytes(), []byte("disk_usage_unavailable")) {
		t.Fatal("disk probe failure should be explicit")
	}
}

func TestStorageUsageReadsOneConcurrentSnapshot(t *testing.T) {
	h, _ := concurrentUploadFixture(t)
	defer h.Close()
	session := createTestUpload(t, h)
	if reserveTestUpload(t, h, session, 100) != http.StatusOK {
		t.Fatal("reserve")
	}
	body := bytes.Repeat([]byte{9}, 36)
	digest := sha256.Sum256(body)
	id := "cccccccccccccccccccccccc"
	var group sync.WaitGroup
	group.Add(1)
	failures := make(chan error, 1)
	go func() {
		defer group.Done()
		for i := 0; i < 160; i++ {
			tx, err := h.database.Begin()
			if err != nil {
				failures <- err
				return
			}
			if i%2 == 0 {
				_, err = tx.Exec("INSERT INTO objects(id,size_bytes,sha256,state,upload_session_id,created_at) VALUES(?,36,?,'pending',?,?)", id, digest[:], session, time.Now().Unix())
				if err == nil {
					_, err = tx.Exec("UPDATE upload_sessions SET consumed_bytes=36 WHERE id=?", session)
				}
			} else {
				_, err = tx.Exec("DELETE FROM objects WHERE id=?", id)
				if err == nil {
					_, err = tx.Exec("UPDATE upload_sessions SET consumed_bytes=0 WHERE id=?", session)
				}
			}
			if err != nil {
				tx.Rollback()
				failures <- err
				return
			}
			if err = tx.Commit(); err != nil {
				failures <- err
				return
			}
		}
	}()
	for i := 0; i < 160; i++ {
		usage := readUsage(t, h)
		used, reserved := usage["usedBytes"].(float64), usage["reservedBytes"].(float64)
		if used+reserved != 100 || usage["pendingBytes"] != used {
			t.Errorf("torn usage snapshot: %v", usage)
			break
		}
	}
	group.Wait()
	select {
	case err := <-failures:
		t.Fatal(err)
	default:
	}
}

func TestUsageReportsConfiguredBackupWarningDays(t *testing.T) {
	root := t.TempDir()
	h, err := New(config.Config{ListenAddr: "127.0.0.1:0", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", BackupWarnAfterDays: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	addAuthenticatedTestSession(t, h)
	got := readUsage(t, h)
	if got["backupWarnAfterDays"] != float64(2) {
		t.Fatalf("configured policy: %+v", got)
	}
}
