package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestMaintenancePurgeRejectsLinkedBucketAndRetriesAfterRepair(t *testing.T) {
	h, root, envelope := maintenanceFixture(t, 200)
	outside := t.TempDir()
	bucket := filepath.Join(root, "ne")
	if err := os.Symlink(outside, bucket); err != nil {
		t.Fatal(err)
	}
	response := maintenanceRequest(t, h, maintenanceBody(envelope), "maintenance-path-key-aaaa")
	if response.Code != 507 {
		t.Errorf("linked maintenance bucket returned %d: %s", response.Code, response.Body.String())
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Errorf("maintenance wrote redirected bucket: entries=%d error=%v", len(entries), err)
	}
	var revision, journal int
	if err := h.database.QueryRow("SELECT vault_mutation_revision FROM server_state").Scan(&revision); err != nil || revision != 0 {
		t.Errorf("rejected maintenance advanced revision: %d %v", revision, err)
	}
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_maintenance").Scan(&journal); err != nil || journal != 0 {
		t.Errorf("pre-publication journal remained: %d %v", journal, err)
	}
	if response.Code != 507 {
		return
	}
	if err := os.Remove(bucket); err != nil {
		t.Fatal(err)
	}
	retry := maintenanceRequest(t, h, maintenanceBody(envelope), "maintenance-path-key-aaaa")
	if retry.Code != 200 {
		t.Fatalf("repair retry: %d %s", retry.Code, retry.Body.String())
	}
	if got, err := os.ReadFile(filepath.Join(bucket, "new-trash-index-aaaaaaaa")); err != nil || !bytes.Equal(got, envelope) {
		t.Fatal("normal candidate bytes lost")
	}
	replay := maintenanceRequest(t, h, maintenanceBody(envelope), "maintenance-path-key-aaaa")
	if replay.Body.String() != retry.Body.String() || replay.Code != 200 {
		t.Fatal("same-key replay changed")
	}
}

type replaceMaintenanceBucketContext struct {
	context.Context
	mu                sync.Mutex
	root, id, outside string
	replaced          bool
	failure           error
	cancel            context.CancelFunc
}

func (c *replaceMaintenanceBucketContext) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.replaced || c.failure != nil {
		return context.Canceled
	}
	bucket := filepath.Join(c.root, c.id[:2])
	if _, err := os.Stat(filepath.Join(bucket, c.id)); err == nil {
		if err := os.Rename(bucket, filepath.Join(c.root, "original-"+c.id[:2])); err != nil {
			c.failure = err
			c.cancel()
			return context.Canceled
		}
		if err := os.Symlink(c.outside, bucket); err != nil {
			c.failure = err
			c.cancel()
			return context.Canceled
		}
		c.replaced = true
		c.cancel()
		return context.Canceled
	}
	return c.Context.Err()
}
func (c *replaceMaintenanceBucketContext) result() (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.replaced, c.failure
}
func TestMaintenanceCancelledRollbackPreservesRedirectedVictim(t *testing.T) {
	for _, kind := range []string{"purge", "trash"} {
		t.Run(kind, func(t *testing.T) {
			var h *Handler
			var root, id string
			var run func(context.Context) error
			if kind == "purge" {
				var envelope []byte
				h, root, envelope = maintenanceFixture(t, 200)
				var req maintenancePurgeRequest
				if err := json.Unmarshal(maintenanceBody(envelope), &req); err != nil {
					t.Fatal(err)
				}
				id = req.Updates[0].ObjectID
				hash := sha256.Sum256([]byte("purge synthetic cancel"))
				run = func(ctx context.Context) error {
					_, err := runMaintenancePurge(ctx, h.database, root, 4096, 0, req, envelope, "maintenance-cancel-key-aa", hash[:])
					return err
				}
			} else {
				var req maintenanceTrashRequest
				h, root, req = fullQuotaTrashFixture(t, 512)
				id = req.Updates[0].ObjectID
				data := make([][]byte, len(req.EncryptedObjects))
				for i, v := range req.EncryptedObjects {
					var err error
					data[i], err = base64.StdEncoding.DecodeString(v)
					if err != nil {
						t.Fatal(err)
					}
				}
				hash := sha256.Sum256([]byte("trash synthetic cancel"))
				run = func(ctx context.Context) error {
					_, err := runMaintenanceTrash(ctx, httptest.NewRequest("POST", "/api/v1/metadata/maintenance-trash", nil).WithContext(ctx), h.database, root, 4096, 0, req, data, "maintenance-cancel-key-aa", hash[:])
					return err
				}
			}
			outside := t.TempDir()
			victim := filepath.Join(outside, id)
			original := bytes.Repeat([]byte{0x7a}, 36)
			if err := os.WriteFile(victim, original, 0600); err != nil {
				t.Fatal(err)
			}
			parent, cancel := context.WithCancel(context.Background())
			defer cancel()
			ctx := &replaceMaintenanceBucketContext{Context: parent, cancel: cancel, root: root, id: id, outside: outside}
			err := run(ctx)
			replaced, failure := ctx.result()
			if failure != nil {
				t.Fatal(failure)
			}
			// Existing revision/build checks can map cancellation into a conflict.
			// The safety contract is actual cancellation + failed operation and
			// unchanged bytes/ledger below, not an incidental error precedence.
			if err == nil || !replaced || !errors.Is(parent.Err(), context.Canceled) {
				t.Fatalf("publication/cancel barrier did not execute: %v replaced=%v", err, replaced)
			}
			requireCleanupVictimUnchanged(t, victim, original)
			if _, err := os.Stat(filepath.Join(root, "original-"+id[:2], id)); !os.IsNotExist(err) {
				t.Errorf("rollback left original owned candidate: %v", err)
			}
			var revision, journal int
			if err := h.database.QueryRow("SELECT vault_mutation_revision FROM server_state").Scan(&revision); err != nil || revision != 0 {
				t.Errorf("cancelled revision: %d %v", revision, err)
			}
			if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_maintenance").Scan(&journal); err != nil || journal != 0 {
				t.Errorf("safe rollback journal: %d %v", journal, err)
			}
		})
	}
}
func TestMaintenancePublicationRejectsLinkedRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	linked := filepath.Join(root, "objects")
	if err := os.Symlink(outside, linked); err != nil {
		t.Fatal(err)
	}
	published := false
	err := publishMaintenanceObject(linked, "abcdefghijklmnopqrstuvwx", bytes.Repeat([]byte{0x2a}, 36), &published)
	if err == nil || published {
		t.Errorf("linked root publication accepted: published=%v error=%v", published, err)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Errorf("linked root wrote outside: entries=%d error=%v", len(entries), err)
	}
}

func TestMaintenanceTrashLinkedLaterBucketRollsBackEarlierCandidate(t *testing.T) {
	h, root, request := fullQuotaTrashFixture(t, 512)
	request.Updates[1].ObjectID = "zz-trash-index-aaaaaaaa"
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "zz")); err != nil {
		t.Fatal(err)
	}
	before := readUsage(t, h)
	response := requestMaintenanceTrash(t, h, request, "maintenance-later-path-key")
	if response.Code != 507 {
		t.Fatalf("later unsafe bucket: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "ne", request.Updates[0].ObjectID)); !os.IsNotExist(err) {
		t.Fatalf("earlier candidate not rolled back: %v", err)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("later bucket wrote outside: %d %v", len(entries), err)
	}
	for _, query := range []string{"SELECT vault_mutation_revision FROM server_state", "SELECT COUNT(*) FROM metadata_maintenance", "SELECT COUNT(*) FROM tombstones"} {
		var count int
		if err := h.database.QueryRow(query).Scan(&count); err != nil || count != 0 {
			t.Fatalf("partial operation: %s -> %d %v", query, count, err)
		}
	}
	after := readUsage(t, h)
	for _, key := range []string{"usedBytes", "reservedBytes", "maintenanceReservedBytes"} {
		if before[key] != after[key] {
			t.Fatalf("partial quota change: %s", key)
		}
	}
	if err := os.Remove(filepath.Join(root, "zz")); err != nil {
		t.Fatal(err)
	}
	retry := requestMaintenanceTrash(t, h, request, "maintenance-later-path-key")
	if retry.Code != 200 {
		t.Fatalf("normal repaired batch: %d %s", retry.Code, retry.Body.String())
	}
}
