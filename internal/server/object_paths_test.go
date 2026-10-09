package server

import (
	"bytes"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"xdrive/internal/config"
)

func TestObjectReadRejectsSymbolicLeafAndBucketWithoutLeakingBytes(t *testing.T) {
	for _, kind := range []string{"leaf", "external-bucket", "internal-bucket"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			objects := filepath.Join(root, "objects")
			handler, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "db.sqlite"), StoragePath: objects, SecretPath: filepath.Join(root, "secret"), Username: "admin"})
			if err != nil {
				t.Fatal(err)
			}
			defer handler.Close()
			addAuthenticatedTestSession(t, handler)
			id := "abcdefghijklmnopqrstuvwx"
			content := []byte("external-file-must-never-be-an-object")
			digest := sha256.Sum256(content)
			if _, err := handler.database.Exec(`INSERT INTO objects (id,size_bytes,sha256,state,created_at) VALUES (?,?,?,'live',?)`, id, len(content), digest[:], time.Now().Unix()); err != nil {
				t.Fatal(err)
			}
			bucket := filepath.Join(objects, id[:2])
			targetDir := filepath.Join(root, "outside")
			if kind == "internal-bucket" {
				targetDir = filepath.Join(objects, "different-bucket")
			}
			if err := os.MkdirAll(targetDir, 0700); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(targetDir, id)
			if err := os.WriteFile(target, content, 0600); err != nil {
				t.Fatal(err)
			}
			if kind == "leaf" {
				if err := os.Mkdir(bucket, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, filepath.Join(bucket, id)); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Symlink(targetDir, bucket); err != nil {
				t.Fatal(err)
			}
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				req := httptest.NewRequest(method, "/api/v1/objects/"+id, nil)
				req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, req)
				if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), string(content)) {
					t.Fatalf("redirected %s returns %d %q", method, response.Code, response.Body.String())
				}
			}
			got, err := os.ReadFile(target)
			if err != nil || !bytes.Equal(got, content) {
				t.Fatalf("target changed: %v", err)
			}
			var state string
			if err := handler.database.QueryRow("SELECT state FROM objects WHERE id=?", id).Scan(&state); err != nil || state != "live" {
				t.Fatalf("read changed object state: %s %v", state, err)
			}
		})
	}
}

func TestObjectReadRegularRangeHeadAndSizeMismatch(t *testing.T) {
	root := t.TempDir()
	objects := filepath.Join(root, "objects")
	handler, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "db.sqlite"), StoragePath: objects, SecretPath: filepath.Join(root, "secret"), Username: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	addAuthenticatedTestSession(t, handler)
	id := "abcdefghijklmnopqrstuvwx"
	body := []byte("authenticated-ciphertext")
	digest := sha256.Sum256(body)
	if _, err := handler.database.Exec(`INSERT INTO objects (id,size_bytes,sha256,state,created_at) VALUES (?,?,?,'live',?)`, id, len(body), digest[:], time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(objects, id[:2])
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, id)
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		request := httptest.NewRequest(method, "/api/v1/objects/"+id, nil)
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
		request.Header.Set("Range", "bytes=2-5")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if method == http.MethodGet {
			if response.Code != http.StatusPartialContent || !bytes.Equal(response.Body.Bytes(), body[2:6]) {
				t.Fatalf("range %d %q", response.Code, response.Body.String())
			}
		}
		if method == http.MethodHead && (response.Code != http.StatusPartialContent || response.Body.Len() != 0 || response.Header().Get("Content-Length") != "4") {
			t.Fatalf("HEAD %d %q", response.Code, response.Body.String())
		}
	}
	if err := os.WriteFile(path, body[:3], 0600); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/objects/"+id, nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("wrong size accepted: %d", response.Code)
	}
}
