package db

// This VFS is restricted to a private, unpublished restore stage. It must not
// be used for a live or shared database: locks are local. A verified complete
// single-file WAL snapshot can bootstrap before normalization to DELETE;
// ordinary mutations cannot enable WAL or shared locking.
import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/unix"
	"modernc.org/libc"
	sqlite3 "modernc.org/sqlite/lib"
	"xdrive/internal/sqlitevfs"
)

type privateVFS struct {
	disposed               bool
	disposeError           error
	registered             bool
	bootstrapWAL           bool
	root                   *os.Root
	main                   *os.File
	id                     uintptr
	name                   string
	tls                    *libc.TLS
	memory, methods, cname uintptr
	mu                     sync.Mutex
	files                  map[string]*privateFile
	active                 int
}
type privateFile struct {
	owner               *privateVFS
	file                *os.File
	path, physical      string
	token               uintptr
	refs                int
	main, deleteOnClose bool
}
type privateSQLiteFile struct{ methods, token uintptr }

var privateRegistry = struct {
	sync.Mutex
	owners map[uintptr]*privateVFS
	files  map[uintptr]*privateFile
}{owners: map[uintptr]*privateVFS{}, files: map[uintptr]*privateFile{}}
var privateToken atomic.Uint64

func privateNextToken() uintptr    { return uintptr(privateToken.Add(1)) }
func privateFn[F any](f F) uintptr { return *(*uintptr)(unsafe.Pointer(&f)) }
func privateView[T any](pointer uintptr) *T {
	var value T
	return (*T)(unsafe.Pointer(unsafe.SliceData(libc.GoBytes(pointer, int(unsafe.Sizeof(value))))))
}
func privateOwner(pointer uintptr) *privateVFS {
	id := privateView[sqlite3.Tsqlite3_vfs](pointer).FpAppData
	privateRegistry.Lock()
	defer privateRegistry.Unlock()
	return privateRegistry.owners[id]
}
func privateEntry(pointer uintptr) *privateFile {
	id := privateView[privateSQLiteFile](pointer).token
	privateRegistry.Lock()
	defer privateRegistry.Unlock()
	return privateRegistry.files[id]
}

// OpenPrivateStaged opens only an existing regular file through its retained
// descriptor. Journals and temporary files are exclusively created via Root.
// The caller must exclusively own the unpublished root for the entire lifetime.
func OpenPrivateStaged(ctx context.Context, root *os.Root, name string) (*DB, func() error, error) {
	return OpenPrivateStagedVerified(ctx, root, name, nil)
}

// OpenPrivateStagedVerified also requires the descriptor identity captured when
// the verified copy was exclusively created, before SQL can write any bytes.
func OpenPrivateStagedVerified(ctx context.Context, root *os.Root, name string, expected os.FileInfo) (*DB, func() error, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if root == nil || name == "" {
		return nil, nil, errors.New("private SQLite root and name are required")
	}
	main, err := root.OpenFile(name, os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	info, err := main.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, nil, errors.Join(errors.New("private SQLite must be an existing regular file"), err, main.Close())
	}
	if expected != nil && !os.SameFile(expected, info) {
		return nil, nil, errors.Join(errors.New("restored SQLite snapshot identity changed"), main.Close())
	}
	v := &privateVFS{bootstrapWAL: expected != nil, root: root, main: main, id: privateNextToken(), tls: libc.NewTLS(), files: map[string]*privateFile{}}
	v.name = fmt.Sprintf("xdrive-private-%d", v.id)
	if err := v.register(); err != nil {
		return nil, nil, errors.Join(err, v.dispose())
	}
	raw, err := sql.Open("sqlite", "file:/private.db?mode=rw&vfs="+v.name)
	if err != nil {
		return nil, nil, errors.Join(err, v.dispose())
	}
	raw.SetMaxOpenConns(1)
	raw.SetMaxIdleConns(1)
	database := &DB{DB: raw}
	cleanup := func() error { return errors.Join(raw.Close(), v.dispose()) }
	for _, pragma := range []struct{ query, want string }{{"PRAGMA locking_mode=EXCLUSIVE", "exclusive"}, {"PRAGMA journal_mode=DELETE", "delete"}} {
		var actual string
		if err := raw.QueryRowContext(ctx, pragma.query).Scan(&actual); err != nil || actual != pragma.want {
			return nil, nil, errors.Join(fmt.Errorf("private SQLite %s returned %q", pragma.query, actual), err, cleanup())
		}
	}
	v.mu.Lock()
	v.bootstrapWAL = false
	v.mu.Unlock()
	if _, err := raw.ExecContext(ctx, "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-2048"); err != nil {
		return nil, nil, errors.Join(err, cleanup())
	}
	return database, cleanup, nil
}
func (v *privateVFS) register() error {
	base := sqlite3.Xsqlite3_vfs_find(v.tls, 0)
	if base == 0 {
		return errors.New("SQLite default VFS missing")
	}
	v.memory = libc.Xmalloc(v.tls, uint64(unsafe.Sizeof(sqlite3.Tsqlite3_vfs{})))
	v.methods = libc.Xmalloc(v.tls, uint64(unsafe.Sizeof(sqlite3.Tsqlite3_io_methods{})))
	if v.memory == 0 || v.methods == 0 {
		return errors.New("allocate private VFS")
	}
	v.cname, _ = libc.CString(v.name)
	if v.cname == 0 {
		return errors.New("allocate private VFS name")
	}
	template, err := sqlitevfs.CloneTemplate(base)
	if err != nil {
		return fmt.Errorf("copy private SQLite VFS template: %w", err)
	}
	clone := privateView[sqlite3.Tsqlite3_vfs](v.memory)
	*clone = template
	clone.FzName = v.cname
	clone.FpAppData = v.id
	clone.FszOsFile = int32(unsafe.Sizeof(privateSQLiteFile{}))
	clone.FxOpen = privateFn(privateOpen)
	clone.FxDelete = privateFn(privateDelete)
	clone.FxAccess = privateFn(privateAccess)
	clone.FxFullPathname = privateFn(privateFullPath)
	methods := privateView[sqlite3.Tsqlite3_io_methods](v.methods)
	*methods = sqlite3.Tsqlite3_io_methods{FiVersion: 1, FxClose: privateFn(privateClose), FxRead: privateFn(privateRead), FxWrite: privateFn(privateWrite), FxTruncate: privateFn(privateTruncate), FxSync: privateFn(privateSync), FxFileSize: privateFn(privateSize), FxLock: privateFn(privateLock), FxUnlock: privateFn(privateLock), FxCheckReservedLock: privateFn(privateReserved), FxFileControl: privateFn(privateControl), FxSectorSize: privateFn(privateSector), FxDeviceCharacteristics: privateFn(privateCharacteristics)}
	privateRegistry.Lock()
	privateRegistry.owners[v.id] = v
	privateRegistry.Unlock()
	if rc := sqlite3.Xsqlite3_vfs_register(v.tls, v.memory, 0); rc != sqlite3.SQLITE_OK {
		return fmt.Errorf("register private VFS: %d", rc)
	}
	v.registered = true
	return nil
}

// ErrPrivateVFSInUse means SQLite still owns a file (for example open Rows).
// Cleanup can be retried after closing the remaining SQL resource.
var ErrPrivateVFSInUse = errors.New("private SQLite VFS is still in use")

func (v *privateVFS) dispose() error {
	return v.disposeWithUnregister(sqlite3.Xsqlite3_vfs_unregister)
}

func (v *privateVFS) disposeWithUnregister(unregister func(*libc.TLS, uintptr) int32) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.disposed {
		return v.disposeError
	}
	for _, file := range v.files {
		if file.refs != 0 {
			return ErrPrivateVFSInUse
		}
	}
	if v.registered {
		if rc := unregister(v.tls, v.memory); rc != sqlite3.SQLITE_OK {
			return fmt.Errorf("unregister private VFS: %d", rc)
		}
		v.registered = false
	}
	v.disposed = true
	var err error
	for _, f := range v.files {
		if !f.main {
			err = errors.Join(err, f.file.Close(), v.root.Remove(f.physical))
		}
		privateRegistry.Lock()
		delete(privateRegistry.files, f.token)
		privateRegistry.Unlock()
	}
	err = errors.Join(err, v.main.Close())
	privateRegistry.Lock()
	delete(privateRegistry.owners, v.id)
	privateRegistry.Unlock()
	libc.Xfree(v.tls, v.memory)
	libc.Xfree(v.tls, v.methods)
	libc.Xfree(v.tls, v.cname)
	v.tls.Close()
	v.disposeError = err
	return err
}
func privateOpen(_ *libc.TLS, pointer, path, output uintptr, flags int32, outFlags uintptr) int32 {
	v := privateOwner(pointer)
	if v == nil {
		return sqlite3.SQLITE_CANTOPEN
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	name := libc.GoString(path)
	if flags&sqlite3.SQLITE_OPEN_WAL != 0 && !v.bootstrapWAL {
		return sqlite3.SQLITE_CANTOPEN
	}
	f := v.files[name]
	isMain := flags&sqlite3.SQLITE_OPEN_MAIN_DB != 0
	if isMain {
		if name != "/private.db" || v.active != 0 {
			return sqlite3.SQLITE_CANTOPEN
		}
		if f == nil {
			f = &privateFile{owner: v, file: v.main, path: name, main: true, token: privateNextToken()}
			v.files[name] = f
		}
	} else if f == nil {
		if flags&sqlite3.SQLITE_OPEN_CREATE == 0 {
			return sqlite3.SQLITE_CANTOPEN
		}
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return sqlite3.SQLITE_CANTOPEN
		}
		physical := ".sqlite-private-" + hex.EncodeToString(random[:])
		file, err := v.root.OpenFile(physical, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			return sqlite3.SQLITE_CANTOPEN
		}
		if name == "" {
			name = physical
		}
		f = &privateFile{owner: v, file: file, path: name, physical: physical, token: privateNextToken(), deleteOnClose: flags&sqlite3.SQLITE_OPEN_DELETEONCLOSE != 0}
		v.files[name] = f
	}
	f.refs++
	if isMain {
		v.active++
	}
	privateRegistry.Lock()
	privateRegistry.files[f.token] = f
	privateRegistry.Unlock()
	*privateView[privateSQLiteFile](output) = privateSQLiteFile{methods: v.methods, token: f.token}
	if outFlags != 0 {
		*privateView[int32](outFlags) = flags
	}
	return sqlite3.SQLITE_OK
}
func privateClose(_ *libc.TLS, pointer uintptr) int32 {
	f := privateEntry(pointer)
	if f == nil {
		return sqlite3.SQLITE_IOERR_CLOSE
	}
	v := f.owner
	v.mu.Lock()
	defer v.mu.Unlock()
	f.refs--
	if f.main {
		v.active--
	}
	privateView[privateSQLiteFile](pointer).methods = 0
	if f.deleteOnClose && f.refs == 0 {
		if err := v.remove(f); err != nil {
			return sqlite3.SQLITE_IOERR_CLOSE
		}
	}
	return sqlite3.SQLITE_OK
}
func (v *privateVFS) remove(f *privateFile) error {
	if f.main || f.refs != 0 {
		return errors.New("private SQLite file still open")
	}
	err := errors.Join(f.file.Close(), v.root.Remove(f.physical))
	delete(v.files, f.path)
	privateRegistry.Lock()
	delete(privateRegistry.files, f.token)
	privateRegistry.Unlock()
	return err
}
func privateDelete(_ *libc.TLS, pointer, path uintptr, syncDir int32) int32 {
	v := privateOwner(pointer)
	if v == nil {
		return sqlite3.SQLITE_IOERR_DELETE
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	f := v.files[libc.GoString(path)]
	if f != nil {
		if err := v.remove(f); err != nil {
			return sqlite3.SQLITE_IOERR_DELETE
		}
	}
	if syncDir != 0 {
		directory, err := v.root.Open(".")
		if err != nil {
			return sqlite3.SQLITE_IOERR_DIR_FSYNC
		}
		err = errors.Join(directory.Sync(), directory.Close())
		if err != nil {
			return sqlite3.SQLITE_IOERR_DIR_FSYNC
		}
	}
	return sqlite3.SQLITE_OK
}
func privateAccess(_ *libc.TLS, pointer, path uintptr, _ int32, result uintptr) int32 {
	v := privateOwner(pointer)
	if v == nil {
		return sqlite3.SQLITE_IOERR_ACCESS
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	exists := libc.GoString(path) == "/private.db" || v.files[libc.GoString(path)] != nil
	*privateView[int32](result) = 0
	if exists {
		*privateView[int32](result) = 1
	}
	return sqlite3.SQLITE_OK
}
func privateFullPath(_ *libc.TLS, _ uintptr, input uintptr, capacity int32, output uintptr) int32 {
	name := libc.GoString(input)
	if len(name)+1 > int(capacity) {
		return sqlite3.SQLITE_CANTOPEN
	}
	b := libc.GoBytes(output, len(name)+1)
	copy(b, name)
	b[len(name)] = 0
	return sqlite3.SQLITE_OK
}
func privateRead(_ *libc.TLS, pointer, buffer uintptr, count int32, offset int64) int32 {
	f := privateEntry(pointer)
	if f == nil || count < 0 || offset < 0 {
		return sqlite3.SQLITE_IOERR_READ
	}
	b := libc.GoBytes(buffer, int(count))
	n, err := f.file.ReadAt(b, offset)
	if errors.Is(err, io.EOF) {
		clear(b[n:])
		return sqlite3.SQLITE_IOERR_SHORT_READ
	}
	if err != nil {
		return sqlite3.SQLITE_IOERR_READ
	}
	return sqlite3.SQLITE_OK
}
func privateWrite(_ *libc.TLS, pointer, buffer uintptr, count int32, offset int64) int32 {
	f := privateEntry(pointer)
	if f == nil || count < 0 || offset < 0 {
		return sqlite3.SQLITE_IOERR_WRITE
	}
	n, err := f.file.WriteAt(libc.GoBytes(buffer, int(count)), offset)
	if err != nil || n != int(count) {
		return sqlite3.SQLITE_IOERR_WRITE
	}
	return sqlite3.SQLITE_OK
}
func privateTruncate(_ *libc.TLS, pointer uintptr, size int64) int32 {
	f := privateEntry(pointer)
	if f == nil || f.file.Truncate(size) != nil {
		return sqlite3.SQLITE_IOERR_TRUNCATE
	}
	return sqlite3.SQLITE_OK
}
func privateSync(_ *libc.TLS, pointer uintptr, _ int32) int32 {
	f := privateEntry(pointer)
	if f == nil || f.file.Sync() != nil {
		return sqlite3.SQLITE_IOERR_FSYNC
	}
	return sqlite3.SQLITE_OK
}
func privateSize(_ *libc.TLS, pointer, output uintptr) int32 {
	f := privateEntry(pointer)
	if f == nil {
		return sqlite3.SQLITE_IOERR_FSTAT
	}
	info, err := f.file.Stat()
	if err != nil {
		return sqlite3.SQLITE_IOERR_FSTAT
	}
	*privateView[int64](output) = info.Size()
	return sqlite3.SQLITE_OK
}
func privateLock(_ *libc.TLS, _ uintptr, _ int32) int32 { return sqlite3.SQLITE_OK }
func privateReserved(_ *libc.TLS, _ uintptr, result uintptr) int32 {
	*privateView[int32](result) = 0
	return sqlite3.SQLITE_OK
}
func privateControl(tls *libc.TLS, _ uintptr, operation int32, argument uintptr) int32 {
	if operation != sqlite3.SQLITE_FCNTL_PRAGMA {
		return sqlite3.SQLITE_NOTFOUND
	}
	args := privateView[[3]uintptr](argument)
	name, value := libc.GoString(args[1]), libc.GoString(args[2])
	if args[2] == 0 {
		return sqlite3.SQLITE_NOTFOUND
	}
	invalid := strings.EqualFold(name, "journal_mode") && !strings.EqualFold(value, "delete") || strings.EqualFold(name, "locking_mode") && !strings.EqualFold(value, "exclusive")
	if !invalid {
		return sqlite3.SQLITE_NOTFOUND
	}
	message := "private restore databases require DELETE journals and exclusive ownership"
	result := sqlite3.Xsqlite3_malloc64(tls, uint64(len(message)+1))
	if result == 0 {
		return sqlite3.SQLITE_NOMEM
	}
	b := libc.GoBytes(result, len(message)+1)
	copy(b, message)
	b[len(message)] = 0
	args[0] = result
	return sqlite3.SQLITE_ERROR
}
func privateSector(_ *libc.TLS, _ uintptr) int32          { return 4096 }
func privateCharacteristics(_ *libc.TLS, _ uintptr) int32 { return 0 }
