package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func assertUploadPathFailureAccounting(t *testing.T, h *Handler, session string) {
	t.Helper()
	for _, table := range []string{"upload_object_claims", "upload_receive_fences", "objects"} {
		var count int
		if err := h.database.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Errorf("failed path leaves %s=%d: %v", table, count, err)
		}
	}
	var consumed, reserved int64
	if err := h.database.QueryRow("SELECT consumed_bytes,reserved_bytes FROM upload_sessions WHERE id=?", session).Scan(&consumed, &reserved); err != nil || consumed != 0 || reserved != 36 {
		t.Errorf("failed path accounting %d/%d: %v", consumed, reserved, err)
	}
}

func pathUploadRequest(t *testing.T, h *Handler, session, id string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	digest := sha256.Sum256(bytes.Repeat([]byte{0x73}, 36))
	req := httptest.NewRequest(http.MethodPut, "/api/v1/uploads/"+session+"/objects/"+id, body)
	req.ContentLength = 36
	req.Header.Set(clientProtocolHeader, "1")
	req.Header.Set("Origin", "http://example.com")
	req.Header.Set("X-CSRF-Token", "test-csrf-token")
	req.Header.Set("X-XDrive-Object-Size", "36")
	req.Header.Set("X-XDrive-Ciphertext-SHA256", hex.EncodeToString(digest[:]))
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	response := httptest.NewRecorder()
	h.ServeHTTP(response, req)
	return response
}

func TestUploadRejectsLinkedBucketsBeforeReadingBody(t *testing.T) {
	for _, kind := range []string{"external", "internal"} {
		t.Run(kind, func(t *testing.T) {
			h, root := concurrentUploadFixture(t)
			session := createTestUpload(t, h)
			if status := reserveTestUpload(t, h, session, 36); status != http.StatusOK {
				t.Fatal(status)
			}
			id := "abcdefghijklmnopqrstuvwx"
			target := t.TempDir()
			if kind == "internal" {
				target = filepath.Join(root, "zz")
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(target, filepath.Join(root, id[:2])); err != nil {
				t.Fatal(err)
			}
			body := &countedUploadReader{reader: bytes.NewReader(bytes.Repeat([]byte{0x73}, 36))}
			response := pathUploadRequest(t, h, session, id, body)
			if response.Code != http.StatusInsufficientStorage || body.read != 0 {
				t.Errorf("linked bucket status=%d read=%d", response.Code, body.read)
			}
			if entries, err := os.ReadDir(target); err != nil || len(entries) != 0 {
				t.Errorf("redirected bucket changed: %v %v", entries, err)
			}
			assertUploadPathFailureAccounting(t, h, session)
			// Repair the path, then reuse the exact object/session reservation.
			if err := os.Remove(filepath.Join(root, id[:2])); err != nil {
				t.Fatal(err)
			}
			data := bytes.Repeat([]byte{0x73}, 36)
			digest := sha256.Sum256(data)
			if status := putTestUploadObject(t, h, session, id, data, digest[:]); status != http.StatusCreated {
				t.Fatalf("path repair retry status=%d", status)
			}
		})
	}
}

type pathChangingReader struct {
	reader  *bytes.Reader
	change  func()
	changed bool
}

func (b *pathChangingReader) Read(p []byte) (int, error) {
	if !b.changed {
		b.changed = true
		b.change()
	}
	return b.reader.Read(p)
}

func TestUploadBucketReplacementDuringReceivePreservesRedirectedFiles(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	session := createTestUpload(t, h)
	if status := reserveTestUpload(t, h, session, 36); status != http.StatusOK {
		t.Fatal(status)
	}
	id := "abcdefghijklmnopqrstuvwx"
	bucket := filepath.Join(root, id[:2])
	moved := filepath.Join(root, "original-bucket")
	target := t.TempDir()
	var sentinel string
	content := bytes.Repeat([]byte{0x29}, 36)
	body := &pathChangingReader{reader: bytes.NewReader(bytes.Repeat([]byte{0x73}, 36)), change: func() {
		entries, err := os.ReadDir(bucket)
		if err != nil || len(entries) != 1 {
			t.Fatalf("receiving temporary file: %v %v", entries, err)
		}
		sentinel = filepath.Join(target, entries[0].Name())
		if err := os.WriteFile(sentinel, content, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(bucket, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, bucket); err != nil {
			t.Fatal(err)
		}
	}}
	response := pathUploadRequest(t, h, session, id, body)
	if response.Code != http.StatusInsufficientStorage {
		t.Errorf("replaced bucket returned %d", response.Code)
	}
	if got, err := os.ReadFile(sentinel); err != nil || !bytes.Equal(got, content) {
		t.Errorf("redirected temporary victim changed: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(target, id)); !os.IsNotExist(err) {
		t.Errorf("published redirected object: %v", err)
	}
	if entries, err := os.ReadDir(moved); err != nil || len(entries) != 0 {
		t.Errorf("original temporary remains: %v %v", entries, err)
	}
	assertUploadPathFailureAccounting(t, h, session)
}

func TestUploadCancelCleanupDoesNotFollowLinkedBucket(t *testing.T) {
	for _, kind := range []string{"object", "session"} {
		t.Run(kind, func(t *testing.T) {
			h, root := concurrentUploadFixture(t)
			session := createTestUpload(t, h)
			if status := reserveTestUpload(t, h, session, 36); status != http.StatusOK {
				t.Fatal(status)
			}
			id := "abcdefghijklmnopqrstuvwx"
			data := bytes.Repeat([]byte{0x73}, 36)
			digest := sha256.Sum256(data)
			if status := putTestUploadObject(t, h, session, id, data, digest[:]); status != http.StatusCreated {
				t.Fatal(status)
			}
			bucket := filepath.Join(root, id[:2])
			if err := os.Rename(bucket, filepath.Join(root, "original-bucket")); err != nil {
				t.Fatal(err)
			}
			target := t.TempDir()
			victim := filepath.Join(target, id)
			if err := os.WriteFile(victim, data, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, bucket); err != nil {
				t.Fatal(err)
			}
			var response *httptest.ResponseRecorder
			if kind == "object" {
				response = uploadRequest(t, h, http.MethodDelete, "/api/v1/uploads/"+session+"/objects/"+id, nil)
			} else {
				response = uploadRequest(t, h, http.MethodPost, "/api/v1/uploads/"+session+"/abandon", []byte(`{}`))
			}
			if response.Code != http.StatusNoContent {
				t.Fatal(response.Code, response.Body.String())
			}
			if got, err := os.ReadFile(victim); err != nil || !bytes.Equal(got, data) {
				t.Errorf("cancel unlinked redirected victim: %v", err)
			}
			var state string
			if err := h.database.QueryRow("SELECT state FROM objects WHERE id=?", id).Scan(&state); err != nil || state != "deleted" {
				t.Errorf("logical deletion %s %v", state, err)
			}
		})
	}
}
