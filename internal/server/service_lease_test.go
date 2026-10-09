package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
	"xdrive/internal/storage"

	"xdrive/internal/config"
)

func TestSecondServiceCannotRunRecoveryAgainstLiveOwner(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), QuotaBytes: 4096}
	owner, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if _, err := owner.database.Exec("INSERT INTO metadata_maintenance VALUES(1,'active-candidate-aaaaaaaa',36,1)"); err != nil {
		t.Fatal(err)
	}
	second, err := New(cfg)
	var candidates int
	if scanErr := owner.database.QueryRow("SELECT COUNT(*) FROM metadata_maintenance").Scan(&candidates); scanErr != nil {
		t.Fatal(scanErr)
	}
	if second != nil {
		_ = second.Close()
	}
	if !errors.Is(err, storage.ErrServiceInUse) || second != nil || candidates != 1 {
		t.Fatalf("second service reached recovery: handler=%t err=%v candidate count=%d (want refused, 1)", second != nil, err, candidates)
	}
}

func TestOwnershipProtectsSharedDatabaseAndSharedObjectsBeforeMigration(t *testing.T) {
	for _, kind := range []string{"same-database", "same-objects", "symlink-alias"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			cfg := config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), QuotaBytes: 4096}
			owner, err := New(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer owner.Close()
			// A second new binary must be refused before even examining this version.
			if _, err := owner.database.Exec("PRAGMA user_version=999"); err != nil {
				t.Fatal(err)
			}
			next := cfg
			switch kind {
			case "same-database":
				next.StoragePath = filepath.Join(root, "other-objects")
			case "same-objects":
				next.DatabasePath = filepath.Join(root, "other.db")
			case "symlink-alias":
				alias := filepath.Join(t.TempDir(), "alias")
				if err := os.Symlink(root, alias); err != nil {
					t.Fatal(err)
				}
				next.DatabasePath = filepath.Join(alias, "drive.db")
				next.StoragePath = filepath.Join(alias, "objects")
			}
			second, err := New(next)
			if second != nil {
				second.Close()
			}
			if !errors.Is(err, storage.ErrServiceInUse) {
				t.Fatalf("did not guard before DB open: %v", err)
			}
			if kind == "same-objects" {
				if _, err := os.Stat(next.DatabasePath); !os.IsNotExist(err) {
					t.Fatal("created another database before acquiring both locks")
				}
			}
		})
	}
}

func TestFailedStartupReleasesOwnership(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: root, QuotaBytes: 4096}
	if handler, err := New(cfg); err == nil {
		handler.Close()
		t.Fatal("expected invalid secret path failure")
	}
	cfg.SecretPath = filepath.Join(root, "server.secret")
	handler, err := New(cfg)
	if err != nil {
		t.Fatal("failed startup stranded ownership", err)
	}
	if err := handler.Close(); err != nil {
		t.Fatal(err)
	}
	if err := handler.Close(); err != nil {
		t.Fatal("repeat close", err)
	}
	restarted, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
}

func TestCloseWaitsForActiveHTTPBeforeReleasingOwnership(t *testing.T) {
	h, path := concurrentUploadFixture(t)
	session := createTestUpload(t, h)
	if reserveTestUpload(t, h, session, 36) != 200 {
		t.Fatal("prepare")
	}
	completed, release := startStalledPUT(t, h, session, "receiving-object-aaaaaaaa", make([]byte, 36))
	closed := make(chan error, 1)
	go func() { closed <- h.Close() }()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		h.lifecycleMutex.Lock()
		closing := h.closing
		h.lifecycleMutex.Unlock()
		if closing {
			break
		}
		time.Sleep(time.Millisecond)
	}
	response := httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != 503 {
		t.Fatal("close admitted another request")
	}
	lease, err := storage.AcquireServiceLease(path+"/another.db", path)
	if lease != nil {
		lease.Close()
	}
	if !errors.Is(err, storage.ErrServiceInUse) {
		t.Fatal("released storage ownership before receiver finished", err)
	}
	select {
	case err := <-closed:
		t.Fatal("closed before receive finished", err)
	default:
	}
	release()
	<-completed
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("close did not finish")
	}
	lease, err = storage.AcquireServiceLease(path+"/another.db", path)
	if err != nil {
		t.Fatal("did not release storage ownership", err)
	}
	lease.Close()
}
