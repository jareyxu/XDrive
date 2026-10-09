package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"xdrive/internal/db"
	"xdrive/internal/storage"
)

func TestGCDeletedPrefixDoesNotStarveLaterObject(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	data := bytes.Repeat([]byte{0x41}, 36)
	digest := sha256.Sum256(data)
	tx, err := h.database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for i := 0; i <= cleanupBatchSize; i++ {
		id := fmt.Sprintf("gc-progress-proof-%08d", i)
		if _, err := tx.Exec("INSERT INTO objects (id,size_bytes,sha256,state,created_at) VALUES (?,?,?,'deleted',?)", id, 36, digest[:], i); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "gc")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	last := filepath.Join(dir, fmt.Sprintf("gc-progress-proof-%08d", cleanupBatchSize))
	if err := os.WriteFile(last, data, 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(last); !os.IsNotExist(err) {
		t.Fatalf("three GC passes with1000 already-missing prefix records still leave later deleted file: %v", err)
	}
}

// TestGCProcessCrashHelper runs in a subprocess so the parent can kill the
// collector after its bounded unlink batch but before the progress CAS.
func TestGCProcessCrashHelper(t *testing.T) {
	if os.Getenv("XDRIVE_GC_PROCESS_HELPER") != "1" {
		t.Skip("subprocess helper")
	}
	database, err := db.OpenCurrent(context.Background(), os.Getenv("XDRIVE_GC_DATABASE"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	ctx := context.Background()
	if barrierDir := os.Getenv("XDRIVE_GC_BARRIER_DIR"); barrierDir != "" {
		ctx = withGCBeforeProgressCASHook(ctx, func() {
			if err := os.WriteFile(filepath.Join(barrierDir, "unlinked"), []byte("unlinked"), 0600); err != nil {
				panic(err)
			}
			for {
				if _, err := os.Stat(filepath.Join(barrierDir, "release")); err == nil {
					return
				}
				time.Sleep(time.Millisecond)
			}
		})
	}
	if err := CleanupOnce(ctx, database, os.Getenv("XDRIVE_GC_OBJECTS"), time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestGCCrashAfterUnlinkBeforeProgressCASRepeatsSafely(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	databasePath := filepath.Join(filepath.Dir(root), "drive.db")
	ids := gcIDs(cleanupBatchSize + 1)
	seedGCIdentities(t, h.database, ids)
	for _, id := range ids {
		writeGCFile(t, root, id)
	}
	barrierDir := filepath.Join(filepath.Dir(root), "gc-crash-barrier")
	if err := os.Mkdir(barrierDir, 0700); err != nil {
		t.Fatal(err)
	}

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestGCProcessCrashHelper$")
	command.Env = append(os.Environ(),
		"XDRIVE_GC_PROCESS_HELPER=1",
		"XDRIVE_GC_DATABASE="+databasePath,
		"XDRIVE_GC_OBJECTS="+root,
		"XDRIVE_GC_BARRIER_DIR="+barrierDir,
	)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	waited := false
	defer func() {
		if !waited {
			_ = command.Process.Kill()
			<-finished
		}
	}()

	assertChildRunning := func() {
		t.Helper()
		select {
		case err := <-finished:
			waited = true
			t.Fatalf("collector exited before crash window: %v; stdout=%s stderr=%s", err, stdout.String(), stderr.String())
		default:
		}
	}
	waitForPauseMarker := func() {
		t.Helper()
		deadline := time.Now().Add(60 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(barrierDir, "unlinked")); err == nil {
				return
			}
			assertChildRunning()
			time.Sleep(2 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for GC crash-window barrier; stdout=%s stderr=%s", stdout.String(), stderr.String())
	}

	// The child pauses inside the real collector after the unlink batch and
	// immediately before its durable progress CAS. This avoids racing the
	// filesystem scan against a second SQLite writer on fast Linux hosts.
	waitForPauseMarker()
	entries, err := os.ReadDir(filepath.Join(root, ids[0][:2]))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != ids[cleanupBatchSize] {
		t.Fatalf("crash-window pause has unexpected remaining files: %v", entries)
	}
	assertChildRunning()
	if cursor, generation := gcState(t, h.database); cursor != "" || generation != 0 {
		t.Fatalf("cursor advanced before the progress CAS: %q %d", cursor, generation)
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err == nil {
		t.Fatal("collector exited cleanly instead of being killed inside the crash window")
	}
	waited = true
	if cursor, generation := gcState(t, h.database); cursor != "" || generation != 0 {
		t.Fatalf("crash window changed durable progress: %q %d", cursor, generation)
	}

	// Restart repeats the now-missing prefix idempotently, advances progress,
	// and then reaches the still-present tail without losing identity rows.
	for pass := 0; pass < 2; pass++ {
		if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	assertGCFileGone(t, filepath.Join(root, ids[cleanupBatchSize][:2], ids[cleanupBatchSize]))
	if cursor, generation := gcState(t, h.database); cursor != "" || generation != 2 {
		t.Fatalf("restart did not complete repeat and tail passes: %q %d", cursor, generation)
	}
	var identities int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM objects WHERE state='deleted'").Scan(&identities); err != nil || identities != len(ids) {
		t.Fatalf("crash recovery changed deleted identity ledger: %d %v", identities, err)
	}
}

func TestGCCancelMidBatchDoesNotAdvanceProgress(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	ids := gcIDs(cleanupBatchSize + 1)
	seedGCIdentities(t, h.database, ids)
	for _, id := range ids {
		writeGCFile(t, root, id)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- CleanupOnce(ctx, h.database, root, time.Now()) }()
	defer cancel()

	deadline := time.Now().Add(60 * time.Second)
	for {
		entries, err := os.ReadDir(filepath.Join(root, ids[0][:2]))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) < len(ids) {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("cleanup exited before physical batch began: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the cleanup batch to begin")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled cleanup returned %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(root, ids[0][:2]))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("fixture must retain the object beyond the 1000-item batch")
	}
	if cursor, generation := gcState(t, h.database); cursor != "" || generation != 0 {
		t.Fatalf("incomplete cancelled batch advanced durable progress: %q %d", cursor, generation)
	}

	// The incomplete attempt is retried from its prior cursor. Already-missing
	// files are harmless, and the tail remains reachable on the following pass.
	for pass := 0; pass < 2; pass++ {
		if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	assertGCFileGone(t, filepath.Join(root, ids[cleanupBatchSize][:2], ids[cleanupBatchSize]))
	if cursor, generation := gcState(t, h.database); cursor != "" || generation != 2 {
		t.Fatalf("retry after cancellation did not reach the tail: %q %d", cursor, generation)
	}
}

func seedGCIdentities(t *testing.T, database *db.DB, ids []string) {
	t.Helper()
	tx, err := database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	digest := sha256.Sum256(bytes.Repeat([]byte{0x41}, 36))
	for i, id := range ids {
		if _, err := tx.Exec("INSERT INTO objects (id,size_bytes,sha256,state,created_at) VALUES (?,?,?,'deleted',?)", id, 36, digest[:], i); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
func gcIDs(count int) []string {
	ids := make([]string, count)
	for i := range ids {
		ids[i] = fmt.Sprintf("zz-gc-progress-%08d", i)
	}
	return ids
}
func writeGCFile(t *testing.T, root, id string) string {
	t.Helper()
	path := filepath.Join(root, id[:2], id)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte{0x41}, 36), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func gcState(t *testing.T, database *db.DB) (string, int64) {
	t.Helper()
	var cursor string
	var generation int64
	if err := database.QueryRow("SELECT cursor,generation FROM object_gc_state WHERE id=1").Scan(&cursor, &generation); err != nil {
		t.Fatal(err)
	}
	return cursor, generation
}
func assertGCFileGone(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("deleted file remains %s: %v", path, err)
	}
}
func TestGCBoundedProgressSurvivesDatabaseRestartAndRetainsIdentities(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	ids := gcIDs(cleanupBatchSize + 1)
	seedGCIdentities(t, h.database, ids)
	for _, id := range ids {
		writeGCFile(t, root, id)
	}
	if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "zz"))
	if err != nil || len(entries) != 1 || entries[0].Name() != ids[cleanupBatchSize] {
		t.Fatalf("first pass must remove exactly1000 files: entries=%d error=%v", len(entries), err)
	}
	cursor, generation := gcState(t, h.database)
	if cursor != ids[cleanupBatchSize-1] || generation != 1 {
		t.Fatalf("first durable state: %q %d", cursor, generation)
	}
	if err := h.database.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := db.OpenCurrent(context.Background(), filepath.Join(filepath.Dir(root), "drive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if got, g := gcState(t, restarted); got != cursor || g != generation {
		t.Fatalf("restart lost progress: %q %d", got, g)
	}
	if err := CleanupOnce(context.Background(), restarted, root, time.Now()); err != nil {
		t.Fatal(err)
	}
	assertGCFileGone(t, filepath.Join(root, "zz", ids[cleanupBatchSize]))
	if got, g := gcState(t, restarted); got != "" || g != 2 {
		t.Fatalf("tail failed to wrap: %q %d", got, g)
	}
	var rows, revision int
	if err := restarted.QueryRow("SELECT COUNT(*) FROM objects WHERE state='deleted'").Scan(&rows); err != nil || rows != len(ids) {
		t.Fatalf("deleted identity ledger changed: %d %v", rows, err)
	}
	if err := restarted.QueryRow("SELECT vault_mutation_revision FROM server_state WHERE id=1").Scan(&revision); err != nil || revision != 0 {
		t.Fatalf("GC changed vault revision: %d %v", revision, err)
	}
	if _, err := restarted.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,36,zeroblob(32),'pending',0)", ids[0]); err == nil {
		t.Fatal("GC allowed deleted objectID reuse")
	}
}
func TestGCWrapRetriesUnsafeBucketAndNewEarlierDeletion(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	first := "aa-gc-repaired-object"
	ids := append([]string{first}, gcIDs(cleanupBatchSize)...)
	seedGCIdentities(t, h.database, ids)
	outside := t.TempDir()
	victim := writeGCFile(t, outside, first)
	if err := os.Symlink(filepath.Dir(victim), filepath.Join(root, "aa")); err != nil {
		t.Fatal(err)
	}
	tail := writeGCFile(t, root, ids[len(ids)-1])
	if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(victim); err != nil || len(got) != 36 {
		t.Fatalf("unsafe batch modified target: %v", err)
	}
	if _, err := os.Stat(tail); err != nil {
		t.Fatal("first batch exceeded1000")
	}
	if err := os.Remove(filepath.Join(root, "aa")); err != nil {
		t.Fatal(err)
	}
	repaired := writeGCFile(t, root, first)
	early := "00-new-earlier-deletion"
	seedGCIdentities(t, h.database, []string{early})
	earlyPath := writeGCFile(t, root, early)
	for i := 0; i < 2; i++ {
		if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{tail, repaired, earlyPath} {
		assertGCFileGone(t, path)
	}
	if got, err := os.ReadFile(victim); err != nil || len(got) != 36 {
		t.Fatalf("wrap modified outside target: %v", err)
	}
}
func TestGCBackupAndStartupDeferralPreserveProgress(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	id := "zz-backup-deferred-object"
	seedGCIdentities(t, h.database, []string{id})
	path := writeGCFile(t, root, id)
	lease, err := storage.AcquireBackupLease(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	for _, clean := range []func(context.Context, *db.DB, string, time.Time) error{CleanupOnce, StartupCleanup} {
		if err := clean(context.Background(), h.database, root, time.Now()); err != nil {
			t.Fatal(err)
		}
		if cursor, g := gcState(t, h.database); cursor != "" || g != 0 {
			t.Fatalf("deferred scan advanced: %q %d", cursor, g)
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("backup/startup deferral unlinked object: %v", err)
		}
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := CleanupOnce(cancelled, h.database, root, time.Now()); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled GC: %v", err)
	}
	if cursor, g := gcState(t, h.database); cursor != "" || g != 0 {
		t.Fatalf("cancelled scan advanced: %q %d", cursor, g)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
		t.Fatal(err)
	}
	assertGCFileGone(t, path)
}
func TestGCConcurrentPassesEventuallyCleanLaterID(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	ids := gcIDs(2*cleanupBatchSize + 1)
	seedGCIdentities(t, h.database, ids)
	last := writeGCFile(t, root, ids[len(ids)-1])
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func() {
			for j := 0; j < 4; j++ {
				if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
					errs <- err
					return
				}
			}
			errs <- nil
		}()
	}
	for i := 0; i < 8; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	assertGCFileGone(t, last)
	var count int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM objects").Scan(&count); err != nil || count != len(ids) {
		t.Fatalf("concurrent identity loss: %d %v", count, err)
	}
}
func TestGCQueryUsesIndexedBoundedRange(t *testing.T) {
	h, _ := concurrentUploadFixture(t)
	seedGCIdentities(t, h.database, gcIDs(2*cleanupBatchSize+1))
	batch, err := deletedObjectBatch(context.Background(), h.database, "")
	if err != nil || len(batch) != cleanupBatchSize {
		t.Fatalf("bounded query: %d %v", len(batch), err)
	}
	rows, err := h.database.Query("EXPLAIN QUERY PLAN "+deletedObjectBatchQuery, batch[len(batch)-1], cleanupBatchSize)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var details string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		details += detail + "\n"
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(details, "objects_deleted_gc_idx") || !strings.Contains(details, "id>?") || strings.Contains(details, "TEMP B-TREE") {
		t.Fatalf("GC lacks bounded indexed seek: %s", details)
	}
}

func TestGCStalePassCannotRewindAfterCursorWrap(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	id := "zz-gc-one-round-object"
	seedGCIdentities(t, h.database, []string{id})
	path := writeGCFile(t, root, id)
	// Capture an old worker's token on a genuinely separate connection.
	old, err := db.OpenCurrent(context.Background(), filepath.Join(filepath.Dir(root), "drive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	oldCursor, oldGeneration := gcState(t, old)
	if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
		t.Fatal(err)
	}
	assertGCFileGone(t, path)
	newCursor, newGeneration := gcState(t, h.database)
	if newCursor != oldCursor || newGeneration <= oldGeneration {
		t.Fatal("fixture must exercise same-cursor/new-generation ABA")
	}
	if err := advanceObjectGC(context.Background(), old, oldGeneration, "zz-stale-pass-would-skip-new-deletions"); err != nil {
		t.Fatal(err)
	}
	if got, g := gcState(t, h.database); got != newCursor || g != newGeneration {
		t.Fatalf("stale pass rewound newer progress: %q %d", got, g)
	}
}
func TestGCEmptyTailWrapsToNewEarlierDeletionInSamePass(t *testing.T) {
	h, root := concurrentUploadFixture(t)
	ids := gcIDs(cleanupBatchSize)
	seedGCIdentities(t, h.database, ids)
	if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
		t.Fatal(err)
	}
	early := "00-just-deleted-earlier"
	seedGCIdentities(t, h.database, []string{early})
	path := writeGCFile(t, root, early)
	if err := CleanupOnce(context.Background(), h.database, root, time.Now()); err != nil {
		t.Fatal(err)
	}
	assertGCFileGone(t, path)
}
