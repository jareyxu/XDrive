package backup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/unix"
	"modernc.org/libc"
	sqlite3 "modernc.org/sqlite/lib"
	"xdrive/internal/db"
	"xdrive/internal/sqlitevfs"
)

var (
	pathVFSIDs atomic.Uint64
	pathVFSMu  sync.Mutex
	pathVFSes  = map[uintptr]*pathVFSState{}
)

type pathVFSState struct {
	mu          sync.Mutex
	target      string
	afterPath   func(string) error
	hookInvoked bool
}

type pathVFS struct {
	tls  *libc.TLS
	ptr  uintptr
	name uintptr
}

// snapshotSQLiteDatabase copies a consistent SQLite image into a path rooted
// at an already-open staging directory. Linux uses a cloned Unix VFS whose
// xFullPathname preserves /proc/self/fd paths for kernel resolution at open
// time. macOS development falls back to VACUUM INTO because /dev/fd does not
// support appending a child path to a directory descriptor.
func snapshotSQLiteDatabase(ctx context.Context, databasePath string, stage *os.File, visibleStage, name string, afterPath func(string) error) (resultErr error) {
	if databasePath == "" || stage == nil {
		return errors.New("SQLite database path and staging directory are required")
	}
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return errors.New("invalid SQLite snapshot filename")
	}
	var existing unix.Stat_t
	if err := unix.Fstatat(int(stage.Fd()), name, &existing, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		return errors.New("SQLite snapshot target already exists")
	} else if !errors.Is(err, unix.ENOENT) {
		return fmt.Errorf("check SQLite snapshot target: %w", err)
	}
	if runtime.GOOS == "darwin" {
		source, err := db.OpenCurrent(ctx, databasePath)
		if err != nil {
			return err
		}
		defer func() { resultErr = errors.Join(resultErr, source.Close()) }()
		if _, err := source.ExecContext(ctx, "VACUUM INTO ?", filepath.Join(visibleStage, name)); err != nil {
			return fmt.Errorf("create macOS development snapshot: %w", err)
		}
		return nil
	}

	stagePath, err := descriptorPath(stage)
	if err != nil {
		return err
	}
	target := filepath.Join(stagePath, name)
	pathVFS, err := newPathPreservingVFS(target, afterPath)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, pathVFS.Close()) }()

	sourcePath, err := filepath.Abs(databasePath)
	if err != nil {
		return err
	}
	sourceURI := (&url.URL{Scheme: "file", Path: sourcePath}).String()
	sourceURI += "?mode=ro&vfs=" + pathVFS.nameString() + "&_pragma=busy_timeout(5000)"
	source, err := sql.Open("sqlite", sourceURI)
	if err != nil {
		return fmt.Errorf("open SQLite source with anchored VFS: %w", err)
	}
	source.SetMaxOpenConns(1)
	source.SetMaxIdleConns(1)
	defer func() { resultErr = errors.Join(resultErr, source.Close()) }()
	if err := source.PingContext(ctx); err != nil {
		return fmt.Errorf("open SQLite source with anchored VFS: %w", err)
	}
	if _, err := source.ExecContext(ctx, "VACUUM INTO ?", target); err != nil {
		return fmt.Errorf("create descriptor-anchored SQLite snapshot: %w", err)
	}
	return nil
}

func newPathPreservingVFS(target string, afterPath func(string) error) (*pathVFS, error) {
	tls := libc.NewTLS()
	defaultVFS := sqlite3.Xsqlite3_vfs_find(tls, 0)
	if defaultVFS == 0 {
		tls.Close()
		return nil, errors.New("SQLite default VFS is unavailable")
	}
	id := pathVFSIDs.Add(1)
	nameValue := fmt.Sprintf("xdrive_fd_%x_%x", os.Getpid(), id)
	name, err := libc.CString(nameValue)
	if err != nil {
		tls.Close()
		return nil, err
	}
	ptr := libc.Xmalloc(tls, libc.Tsize_t(unsafe.Sizeof(sqlite3.Tsqlite3_vfs{})))
	if ptr == 0 {
		libc.Xfree(tls, name)
		tls.Close()
		return nil, errors.New("allocate anchored SQLite VFS")
	}
	template, err := sqlitevfs.CloneTemplate(defaultVFS)
	if err != nil {
		libc.Xfree(tls, ptr)
		libc.Xfree(tls, name)
		tls.Close()
		return nil, fmt.Errorf("copy SQLite VFS template: %w", err)
	}
	clone := pathVFSView[sqlite3.Tsqlite3_vfs](ptr)
	*clone = template
	clone.FzName = name
	clone.FxFullPathname = anchoredFullPathnamePointer()
	state := &pathVFSState{target: target, afterPath: afterPath}
	token := ptr
	pathVFSMu.Lock()
	pathVFSes[token] = state
	pathVFSMu.Unlock()
	if rc := sqlite3.Xsqlite3_vfs_register(tls, ptr, 0); rc != sqlite3.SQLITE_OK {
		pathVFSMu.Lock()
		delete(pathVFSes, token)
		pathVFSMu.Unlock()
		libc.Xfree(tls, ptr)
		libc.Xfree(tls, name)
		tls.Close()
		return nil, fmt.Errorf("register anchored SQLite VFS: %d", rc)
	}
	return &pathVFS{tls: tls, ptr: ptr, name: name}, nil
}

func anchoredFullPathnamePointer() uintptr {
	return *(*uintptr)(unsafe.Pointer(&struct {
		f func(*libc.TLS, uintptr, uintptr, int32, uintptr) int32
	}{anchoredFullPathname}))
}

func pathVFSView[T any](pointer uintptr) *T {
	var value T
	return (*T)(unsafe.Pointer(unsafe.SliceData(libc.GoBytes(pointer, int(unsafe.Sizeof(value))))))
}

func anchoredFullPathname(tls *libc.TLS, vfs uintptr, path uintptr, capacity int32, output uintptr) int32 {
	if path == 0 || output == 0 || capacity < 2 {
		return sqlite3.SQLITE_CANTOPEN
	}
	value := libc.GoString(path)
	if !strings.HasPrefix(value, "/") || len(value)+1 > int(capacity) {
		return sqlite3.SQLITE_CANTOPEN
	}
	state := lookupPathVFSState(vfs)
	if state == nil {
		return sqlite3.SQLITE_CANTOPEN
	}
	state.mu.Lock()
	hook := state.afterPath
	if hook != nil && !state.hookInvoked && value == state.target {
		state.hookInvoked = true
		state.mu.Unlock()
		if err := hook(value); err != nil {
			return sqlite3.SQLITE_CANTOPEN
		}
	} else {
		state.mu.Unlock()
	}
	libc.Xstrncpy(tls, output, path, uint64(capacity))
	return sqlite3.SQLITE_OK
}

func lookupPathVFSState(token uintptr) *pathVFSState {
	pathVFSMu.Lock()
	state := pathVFSes[token]
	pathVFSMu.Unlock()
	return state
}

func (vfs *pathVFS) nameString() string {
	return libc.GoString(vfs.name)
}

func (vfs *pathVFS) Close() error {
	if vfs == nil || vfs.ptr == 0 {
		return nil
	}
	if rc := sqlite3.Xsqlite3_vfs_unregister(vfs.tls, vfs.ptr); rc != sqlite3.SQLITE_OK {
		return fmt.Errorf("unregister anchored SQLite VFS: %d", rc)
	}
	pathVFSMu.Lock()
	delete(pathVFSes, vfs.ptr)
	pathVFSMu.Unlock()
	libc.Xfree(vfs.tls, vfs.ptr)
	libc.Xfree(vfs.tls, vfs.name)
	vfs.tls.Close()
	vfs.ptr, vfs.name, vfs.tls = 0, 0, nil
	return nil
}

func descriptorPath(file *os.File) (string, error) {
	if file == nil {
		return "", errors.New("missing SQLite snapshot directory descriptor")
	}
	switch runtime.GOOS {
	case "linux":
		return fmt.Sprintf("/proc/self/fd/%d", file.Fd()), nil
	case "darwin":
		return fmt.Sprintf("/dev/fd/%d", file.Fd()), nil
	default:
		return "", fmt.Errorf("descriptor-rooted SQLite snapshots are unsupported on %s", runtime.GOOS)
	}
}
