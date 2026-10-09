package backup

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"unsafe"

	"modernc.org/libc"
	sqlite3 "modernc.org/sqlite/lib"
)

// Experimental VFS: retain the descriptor pathname instead of resolving its
// symlink. This is not enabled for production Restore.
func descriptorFullPath(tls *libc.TLS, _ uintptr, input uintptr, capacity int32, output uintptr) int32 {
	name := libc.GoString(input)
	if len(name)+1 > int(capacity) {
		return sqlite3.SQLITE_CANTOPEN
	}
	bytes := libc.GoBytes(output, len(name)+1)
	copy(bytes, name)
	bytes[len(name)] = 0
	return sqlite3.SQLITE_OK
}

func TestRestoreDescriptorVFSReadsAndWritesOwnedSnapshot(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("descriptor pathname spike is only applicable to Linux procfs")
	}
	ctx := context.Background()
	settings, destination, _, _ := backupFixture(t)
	if err := Create(ctx, settings, destination, false); err != nil {
		t.Fatal(err)
	}
	generation, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(destination, "snapshots", generation, snapshotName)
	digest, err := hashFile(source)
	if err != nil {
		t.Fatal(err)
	}
	stage := t.TempDir()
	name := filepath.Join(stage, "snapshot.sqlite")
	if err := copyVerifiedSnapshot(ctx, source, name, digest); err != nil {
		t.Fatal(err)
	}
	owned, err := os.OpenFile(name, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer owned.Close()
	directory, err := os.Open(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	originalStage := stage + "-original"
	if err := os.Rename(stage, originalStage); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(originalStage)
	outside := t.TempDir()
	if err := os.Symlink(outside, stage); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(stage)
	descriptorPath := fmt.Sprintf("/dev/fd/%d", owned.Fd())
	if runtime.GOOS == "linux" {
		descriptorPath = fmt.Sprintf("/proc/self/fd/%d/snapshot.sqlite", directory.Fd())
	}

	tls := libc.NewTLS()
	defer tls.Close()
	original := sqlite3.Xsqlite3_vfs_find(tls, 0)
	if original == 0 {
		t.Fatal("missing SQLite VFS")
	}
	memory := libc.Xmalloc(tls, uint64(unsafe.Sizeof(sqlite3.Tsqlite3_vfs{})))
	if memory == 0 {
		t.Fatal("allocation failed")
	}
	defer libc.Xfree(tls, memory)
	size := int(unsafe.Sizeof(sqlite3.Tsqlite3_vfs{}))
	view := libc.GoBytes(memory, size)
	copy(view, libc.GoBytes(original, size))
	clone := (*sqlite3.Tsqlite3_vfs)(unsafe.Pointer(unsafe.SliceData(view)))
	cname, err := libc.CString("xdrive-descriptor-spike")
	if err != nil {
		t.Fatal(err)
	}
	defer libc.Xfree(tls, cname)
	clone.FzName = cname
	clone.FpNext = 0
	clone.FxFullPathname = *(*uintptr)(unsafe.Pointer(&struct {
		f func(*libc.TLS, uintptr, uintptr, int32, uintptr) int32
	}{descriptorFullPath}))
	if rc := sqlite3.Xsqlite3_vfs_register(tls, memory, 0); rc != sqlite3.SQLITE_OK {
		t.Fatalf("register: %d", rc)
	}
	defer sqlite3.Xsqlite3_vfs_unregister(tls, memory)
	dsn := (&url.URL{Scheme: "file", Path: descriptorPath}).String() + "?mode=rw&vfs=xdrive-descriptor-spike"
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	database.SetMaxOpenConns(1)
	for _, pragma := range []struct{ query, want string }{{"PRAGMA locking_mode=EXCLUSIVE", "exclusive"}, {"PRAGMA journal_mode=MEMORY", "memory"}} {
		var actual string
		if err := database.QueryRowContext(ctx, pragma.query).Scan(&actual); err != nil || actual != pragma.want {
			t.Fatalf("pragma %s = %q: %v", pragma.query, actual, err)
		}
	}
	for _, statement := range []string{"UPDATE server_state SET last_backup_at=123 WHERE id=1"} {
		if _, err := database.ExecContext(ctx, statement); err != nil {
			t.Fatalf("descriptor SQLite %s: %v", statement, err)
		}
	}
	var integrity string
	if err := database.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("integrity %q: %v", integrity, err)
	}
	var actual int64
	if err := database.QueryRowContext(ctx, "SELECT last_backup_at FROM server_state WHERE id=1").Scan(&actual); err != nil || actual != 123 {
		t.Fatalf("owned update %d: %v", actual, err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("external writes: %v %v", entries, err)
	}
	t.Log("SPIKE: descriptor-owned SQLite read/write succeeds; not production acceptance")
}
