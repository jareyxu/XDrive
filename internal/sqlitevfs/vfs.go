// Package sqlitevfs contains ABI-sensitive helpers for cloning a SQLite VFS
// template without reading SQLite's mutable registry link.
package sqlitevfs

import (
	"errors"
	"unsafe"

	"modernc.org/libc"
	sqlite3 "modernc.org/sqlite/lib"
)

// CloneTemplate copies the stable fields of a registered VFS and leaves FpNext
// zero. SQLite owns FpNext and mutates it while registering or unregistering
// VFS objects, so callers must not copy it as part of the template. The
// modernc.org/sqlite v1.60.0 ABI exposes VFS versions 1 through 3.
func CloneTemplate(pointer uintptr) (sqlite3.Tsqlite3_vfs, error) {
	if pointer == 0 {
		return sqlite3.Tsqlite3_vfs{}, errors.New("SQLite VFS template is missing")
	}
	bytes := libc.GoBytes(pointer, int(unsafe.Sizeof(sqlite3.Tsqlite3_vfs{})))
	source := (*sqlite3.Tsqlite3_vfs)(unsafe.Pointer(unsafe.SliceData(bytes)))
	if source.FiVersion < 1 || source.FiVersion > 3 {
		return sqlite3.Tsqlite3_vfs{}, errors.New("unsupported SQLite VFS version")
	}
	return sqlite3.Tsqlite3_vfs{
		FiVersion:          source.FiVersion,
		FszOsFile:          source.FszOsFile,
		FmxPathname:        source.FmxPathname,
		FzName:             source.FzName,
		FpAppData:          source.FpAppData,
		FxOpen:             source.FxOpen,
		FxDelete:           source.FxDelete,
		FxAccess:           source.FxAccess,
		FxFullPathname:     source.FxFullPathname,
		FxDlOpen:           source.FxDlOpen,
		FxDlError:          source.FxDlError,
		FxDlSym:            source.FxDlSym,
		FxDlClose:          source.FxDlClose,
		FxRandomness:       source.FxRandomness,
		FxSleep:            source.FxSleep,
		FxCurrentTime:      source.FxCurrentTime,
		FxGetLastError:     source.FxGetLastError,
		FxCurrentTimeInt64: source.FxCurrentTimeInt64,
		FxSetSystemCall:    source.FxSetSystemCall,
		FxGetSystemCall:    source.FxGetSystemCall,
		FxNextSystemCall:   source.FxNextSystemCall,
	}, nil
}
