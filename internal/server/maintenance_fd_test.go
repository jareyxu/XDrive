package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"golang.org/x/sys/unix"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
	"xdrive/internal/config"
)

func countMaintenanceFDs() (int, error) {
	var limit unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_NOFILE, &limit); err != nil {
		return 0, err
	}
	if limit.Cur > 4096 {
		return 0, fmt.Errorf("controlled FD limit required, got%d", limit.Cur)
	}
	// Fstat does not allocate a descriptor, unlike enumerating /dev/fd.
	count := 0
	for fd := 0; fd < int(limit.Cur); fd++ {
		var info unix.Stat_t
		if unix.Fstat(fd, &info) == nil {
			count++
		}
	}
	return count, nil
}

type maintenanceFDContext struct {
	context.Context
	mu   sync.Mutex
	peak int
}

func (c *maintenanceFDContext) Err() error {
	if n, err := countMaintenanceFDs(); err == nil {
		c.mu.Lock()
		if n > c.peak {
			c.peak = n
		}
		c.mu.Unlock()
	}
	return c.Context.Err()
}
func (c *maintenanceFDContext) maximum() int { c.mu.Lock(); defer c.mu.Unlock(); return c.peak }

func TestMaintenanceMaximumBatchUnder768Descriptors(t *testing.T) {
	if os.Getenv("XDRIVE_TEST_MAINTENANCE_FD_CHILD") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestMaintenanceMaximumBatchUnder768Descriptors$", "-test.v")
		command.Env = append(os.Environ(), "XDRIVE_TEST_MAINTENANCE_FD_CHILD=1")
		output, err := command.CombinedOutput()
		t.Logf("isolated FD test output:\n%s", output)
		if err != nil {
			t.Fatalf("isolated FD child: %v", err)
		}
		return
	}
	var limit unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_NOFILE, &limit); err != nil {
		t.Fatal(err)
	}
	if limit.Max < 768 {
		t.Fatalf("required controlled fixture hard limit768 unavailable: %d", limit.Max)
	}
	limit.Cur = 768
	if err := unix.Setrlimit(unix.RLIMIT_NOFILE, &limit); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name     string
		distinct bool
		limit    uint64
		success  bool
	}{{"same-shard", false, 768, true}, {"500-shards", true, 768, true}, {"128-fd-exhaustion", true, 128, false}} {
		t.Run(scenario.name, func(t *testing.T) {
			distinct := scenario.distinct
			limit.Cur = scenario.limit
			if err := unix.Setrlimit(unix.RLIMIT_NOFILE, &limit); err != nil {
				t.Fatal(err)
			}
			h, root, request := maximumMaintenanceFixture(t)
			const total = 8 << 20
			tx, err := h.database.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			data := make([][]byte, 500)
			request.EncryptedObjects = nil
			alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
			for i := 0; i < 500; i++ {
				if i >= 2 {
					old := fmt.Sprintf("old-fd-index-%08d", i)
					metadata := fmt.Sprintf("fd-metadata-index-%08d", i)
					if _, err := tx.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,36,zeroblob(32),'live',1)", old); err != nil {
						t.Fatal(err)
					}
					if _, err := tx.Exec("INSERT INTO metadata_pointers VALUES(?,?,1,1)", metadata, old); err != nil {
						t.Fatal(err)
					}
					if _, err := tx.Exec("INSERT INTO metadata_versions VALUES(?,1,?,1)", metadata, old); err != nil {
						t.Fatal(err)
					}
					request.Updates = append(request.Updates, metadataPointerUpdate{MetadataID: metadata, ExpectedRevision: 1})
				}
				prefix := "zz"
				if distinct {
					prefix = string([]byte{alphabet[i/64], alphabet[i%64]})
				}
				request.Updates[i].ObjectID = fmt.Sprintf("%s-maintenance-fd-%08d", prefix, i)
				size := total / 500
				if i == 499 {
					size = total - size*499
				}
				data[i] = make([]byte, size)
				copy(data[i], []byte{'X', 'D', 'R', 'V', 1, 1, 0, 0})
				request.EncryptedObjects = append(request.EncryptedObjects, base64.StdEncoding.EncodeToString(data[i]))
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			before, err := countMaintenanceFDs()
			if err != nil {
				t.Fatal(err)
			}
			ctx := &maintenanceFDContext{Context: context.Background()}
			body, _ := json.Marshal(request)
			started := time.Now()
			r := httptest.NewRequest("POST", "/api/v1/metadata/maintenance-trash", bytes.NewReader(body)).WithContext(ctx)
			r.Header.Set("Origin", "http://example.com")
			r.Header.Set(clientProtocolHeader, "1")
			r.Header.Set("X-CSRF-Token", "test-csrf-token")
			r.Header.Set("Idempotency-Key", "maintenance-fd-max-key-aa")
			r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
			output := httptest.NewRecorder()
			h.ServeHTTP(output, r)
			response := output.Body.Bytes()
			var operationError error
			if output.Code != 200 {
				operationError = fmt.Errorf("HTTP%d %s", output.Code, response)
			}
			err = operationError
			after, countErr := countMaintenanceFDs()
			t.Logf("FD_PROBE distinct=%v candidates=500 bytes=%d limit=%d before=%d observedPeak=%d after=%d elapsedMs=%d error=%v", distinct, total, scenario.limit, before, ctx.maximum(), after, time.Since(started).Milliseconds(), err)
			if !scenario.success {
				if err == nil {
					t.Fatal("resource exhaustion unexpectedly committed")
				}
				if countErr != nil || after > before+2 {
					t.Fatalf("exhaustion leaked descriptors: %d %d %v", before, after, countErr)
				}
				for _, query := range []string{"SELECT vault_mutation_revision FROM server_state", "SELECT COUNT(*) FROM metadata_maintenance", "SELECT COUNT(*) FROM metadata_pointers WHERE revision<>1", "SELECT COUNT(*) FROM objects WHERE id LIKE '%maintenance-fd%'", "SELECT COUNT(*) FROM tombstones"} {
					var count int
					if err := h.database.QueryRow(query).Scan(&count); err != nil || count != 0 {
						t.Fatalf("exhaustion partial state: %s -> %d %v", query, count, err)
					}
				}
				for _, update := range request.Updates {
					if _, err := os.Stat(filepath.Join(root, update.ObjectID[:2], update.ObjectID)); !os.IsNotExist(err) {
						t.Fatalf("exhaustion left candidate: %v", err)
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("maximum allowed500-candidate batch failed: %v", err)
			}
			if countErr != nil || after > before+2 {
				t.Fatalf("descriptor leak: before=%d after=%d error=%v", before, after, countErr)
			}
			var result metadataTransactionResponse
			if err := json.Unmarshal(response, &result); err != nil || result.ActivatedObjects != 500 || result.UpdatedPointers != 500 || result.VaultMutationRevision != 1 {
				t.Fatalf("partial max batch response: %+v %v", result, err)
			}
			for i, update := range request.Updates {
				got, err := os.ReadFile(filepath.Join(root, update.ObjectID[:2], update.ObjectID))
				if err != nil || sha256.Sum256(got) != sha256.Sum256(data[i]) {
					t.Fatalf("candidate%d bytes differ: %v", i, err)
				}
			}
			var journal int
			if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_maintenance").Scan(&journal); err != nil || journal != 0 {
				t.Fatalf("journal: %d %v", journal, err)
			}
		})
	}
}

func maximumMaintenanceFixture(t *testing.T) (*Handler, string, maintenanceTrashRequest) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "objects")
	h, err := New(config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(base, "drive.db"), StoragePath: root, SecretPath: filepath.Join(base, "secret"), Username: "admin", QuotaBytes: 32 << 20, MaintenanceReserveBytes: 8 << 20})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	addAuthenticatedTestSession(t, h)
	for _, id := range []string{"old-parent-index-aaaaaaaa", "old-trash-index-aaaaaaaaa", "original-file-aaaaaaaaaaa"} {
		if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,36,zeroblob(32),'live',1)", id); err != nil {
			t.Fatal(err)
		}
	}
	for _, pair := range []struct{ metadata, object string }{{"parent-index-aaaaaaaaaaaa", "old-parent-index-aaaaaaaa"}, {"trash-index-aaaaaaaaaaaaa", "old-trash-index-aaaaaaaaa"}} {
		if _, err := h.database.Exec("INSERT INTO metadata_pointers VALUES(?,?,1,1)", pair.metadata, pair.object); err != nil {
			t.Fatal(err)
		}
		if _, err := h.database.Exec("INSERT INTO metadata_versions VALUES(?,1,?,1)", pair.metadata, pair.object); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().Unix()
	build := "trash-build-aaaaaaaaaaaaa"
	if _, err := h.database.Exec("INSERT INTO tombstone_builds VALUES(?,'active',?,?,0)", build, now, now+3600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec("INSERT INTO tombstone_build_members VALUES(?,'object','original-file-aaaaaaaaaaa')", build); err != nil {
		t.Fatal(err)
	}
	return h, root, maintenanceTrashRequest{ExpectedGlobalRevision: 0, FinalizeTombstoneBuildID: build, CreateTombstoneID: "trash-root-aaaaaaaaaaaaaa", Updates: []metadataPointerUpdate{{MetadataID: "parent-index-aaaaaaaaaaaa", ExpectedRevision: 1}, {MetadataID: "trash-index-aaaaaaaaaaaaa", ExpectedRevision: 1}}}
}
