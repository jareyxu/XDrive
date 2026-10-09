package db

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"modernc.org/libc"
	sqlite3 "modernc.org/sqlite/lib"
)

func privateFixture(t *testing.T) *os.Root {
	t.Helper()
	stage := t.TempDir()
	database, err := Open(context.Background(), filepath.Join(stage, "live.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if err := Snapshot(context.Background(), filepath.Join(stage, "live.sqlite"), filepath.Join(stage, "snapshot.sqlite")); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	return root
}

func TestPrivateVFSCleanupRetainsOpenRowsAndCanRetry(t *testing.T) {
	root := privateFixture(t)
	database, cleanup, err := OpenPrivateStaged(context.Background(), root, "snapshot.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	rows, err := database.Query("SELECT 123")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if err := cleanup(); !errors.Is(err, ErrPrivateVFSInUse) {
		t.Fatalf("live rows cleanup: %v", err)
	}
	if !rows.Next() {
		t.Fatalf("rows invalidated: %v", rows.Err())
	}
	var actual int
	if err := rows.Scan(&actual); err != nil || actual != 123 {
		t.Fatalf("retained row %d: %v", actual, err)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(); err != nil {
		t.Fatalf("repeat cleanup: %v", err)
	}
}

func TestPrivateVFSUnregisterFailureKeepsRegisteredMemoryForRetry(t *testing.T) {
	root := privateFixture(t)
	main, err := root.OpenFile("snapshot.sqlite", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	v := &privateVFS{id: privateNextToken(), name: "xdrive-private-unregister-test", root: root, main: main, tls: libc.NewTLS(), files: map[string]*privateFile{}}
	if err := v.register(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := v.dispose(); err != nil {
			t.Errorf("cleanup VFS: %v", err)
		}
	})

	registeredMemory, registeredName := v.memory, v.cname
	if err := v.disposeWithUnregister(func(*libc.TLS, uintptr) int32 { return sqlite3.SQLITE_ERROR }); err == nil {
		t.Fatal("unregister failure was ignored")
	}
	if v.disposed || !v.registered || v.memory != registeredMemory || v.cname != registeredName {
		t.Fatalf("failed unregister destroyed VFS state: disposed=%v registered=%v memory=%#x name=%#x", v.disposed, v.registered, v.memory, v.cname)
	}
	name := libc.GoString(v.cname)
	observer := libc.NewTLS()
	defer observer.Close()
	namePointer, err := libc.CString(name)
	if err != nil {
		t.Fatal(err)
	}
	defer libc.Xfree(observer, namePointer)
	if found := sqlite3.Xsqlite3_vfs_find(observer, namePointer); found != registeredMemory {
		t.Fatalf("registered VFS disappeared after failed unregister: got=%#x want=%#x", found, registeredMemory)
	}

	if err := v.dispose(); err != nil {
		t.Fatalf("retry unregister: %v", err)
	}
	if !v.disposed || v.registered {
		t.Fatalf("successful cleanup state: disposed=%v registered=%v", v.disposed, v.registered)
	}
	if found := sqlite3.Xsqlite3_vfs_find(observer, namePointer); found != 0 {
		t.Fatalf("VFS remains registered after successful cleanup: %#x", found)
	}
}

func TestPrivateVFSUsesRootedDiskJournalAndRejectsWAL(t *testing.T) {
	root := privateFixture(t)
	database, cleanup, err := OpenPrivateStaged(context.Background(), root, "snapshot.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	tx, err := database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("UPDATE server_state SET last_backup_at=321 WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	entries, err := readPrivateEntries(t, root)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".sqlite-private-") {
			info, err := root.Stat(entry.Name())
			if err != nil || info.Size() == 0 || info.Mode().Perm() != 0600 {
				t.Fatalf("journal: %v %v", info, err)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("no private disk journal")
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var actual int64
	if err := database.QueryRow("SELECT COALESCE(last_backup_at,0) FROM server_state WHERE id=1").Scan(&actual); err != nil || actual == 321 {
		t.Fatalf("rollback: %d %v", actual, err)
	}
	var mode string
	if err := database.QueryRow("PRAGMA journal_mode=WAL").Scan(&mode); err == nil && mode == "wal" {
		t.Fatal("private VFS enabled WAL")
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	entries, err = readPrivateEntries(t, root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".sqlite-private-") {
			t.Fatal("journal leaked")
		}
	}
}

func TestPrivateVFSRejectsCancelledAndLinkedInitialOpen(t *testing.T) {
	root := privateFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := OpenPrivateStaged(ctx, root, "cancel.sqlite"); !errors.Is(err, context.Canceled) {
		t.Fatalf("initial cancel: %v", err)
	}
	if _, err := root.Stat("cancel.sqlite"); !os.IsNotExist(err) {
		t.Fatal("cancel created file")
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, "victim")
	if err := os.WriteFile(victim, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := root.Symlink(victim, "linked.sqlite"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := OpenPrivateStaged(context.Background(), root, "linked.sqlite"); err == nil {
		t.Fatal("linked main accepted")
	}
	actual, err := os.ReadFile(victim)
	if err != nil || string(actual) != "preserve" {
		t.Fatal("victim changed")
	}
}

func readPrivateEntries(t *testing.T, root *os.Root) ([]os.DirEntry, error) {
	t.Helper()
	file, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return file.ReadDir(-1)
}

func TestPrivateVFSRejectsLiveWALWithoutRegistryLeak(t *testing.T) {
	stage := t.TempDir()
	path := filepath.Join(stage, "live.sqlite")
	database, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	privateRegistry.Lock()
	owners, files := len(privateRegistry.owners), len(privateRegistry.files)
	privateRegistry.Unlock()
	if _, _, err := OpenPrivateStaged(context.Background(), root, "live.sqlite"); err == nil {
		t.Fatal("live WAL database accepted")
	}
	privateRegistry.Lock()
	same := owners == len(privateRegistry.owners) && files == len(privateRegistry.files)
	privateRegistry.Unlock()
	if !same {
		t.Fatal("failed open leaked VFS registry")
	}
	after, err := os.ReadFile(path)
	if err != nil || string(before) != string(after) {
		t.Fatal("live WAL bytes changed")
	}
}

func TestPrivateVFSIndependentConcurrentConnections(t *testing.T) {
	roots := []*os.Root{privateFixture(t), privateFixture(t), privateFixture(t), privateFixture(t)}
	results := make(chan error, len(roots))
	for i, root := range roots {
		go func(value int, root *os.Root) {
			database, cleanup, err := OpenPrivateStaged(context.Background(), root, "snapshot.sqlite")
			if err != nil {
				results <- err
				return
			}
			_, err = database.Exec("UPDATE server_state SET last_backup_at=? WHERE id=1", value)
			var actual int
			if err == nil {
				err = database.QueryRow("SELECT last_backup_at FROM server_state WHERE id=1").Scan(&actual)
			}
			if err == nil && actual != value {
				err = errors.New("concurrent VFS crossed database handles")
			}
			results <- errors.Join(err, cleanup())
		}(i+1, root)
	}
	for range roots {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
}

func TestPrivateVFSVerifiedCleanWALSnapshotConvertsToDelete(t *testing.T) {
	stage := t.TempDir()
	path := filepath.Join(stage, "snapshot.sqlite")
	database, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("UPDATE server_state SET last_backup_at=789 WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	// Close/checkpoint produced a complete single-file image with WAL header,
	// as SQLite's backup API can. No live service or sidecar is being imported.
	if _, err := os.Stat(path + "-wal"); !os.IsNotExist(err) {
		t.Fatalf("snapshot has WAL sidecar: %v", err)
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	identity, err := root.Stat("snapshot.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	restored, cleanup, err := OpenPrivateStagedVerified(context.Background(), root, "snapshot.sqlite", identity)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	var actual int64
	if err := restored.QueryRow("SELECT last_backup_at FROM server_state WHERE id=1").Scan(&actual); err != nil || actual != 789 {
		t.Fatalf("WAL snapshot content %d: %v", actual, err)
	}
	var mode string
	if err := restored.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "delete" {
		t.Fatalf("converted mode %q: %v", mode, err)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	entries, err := readPrivateEntries(t, root)
	if err != nil || len(entries) != 1 {
		t.Fatalf("bootstrap sidecars: %v %v", entries, err)
	}
}
