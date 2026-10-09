package sqlitevfs

import (
	"testing"
	"unsafe"

	"modernc.org/libc"
	sqlite3 "modernc.org/sqlite/lib"
)

func TestCloneTemplateCopiesStableFieldsWithoutRegistryLink(t *testing.T) {
	source := sqlite3.Tsqlite3_vfs{
		FiVersion: 3, FszOsFile: 128, FmxPathname: 1024,
		FpNext: 0xdeadbeef, FzName: 0x101, FpAppData: 0x202,
		FxOpen: 0x303, FxDelete: 0x404, FxAccess: 0x505,
		FxFullPathname: 0x606, FxDlOpen: 0x707, FxDlError: 0x808,
		FxDlSym: 0x909, FxDlClose: 0xa0a, FxRandomness: 0xb0b,
		FxSleep: 0xc0c, FxCurrentTime: 0xd0d, FxGetLastError: 0xe0e,
		FxCurrentTimeInt64: 0xf0f, FxSetSystemCall: 0x111,
		FxGetSystemCall: 0x222, FxNextSystemCall: 0x333,
	}
	want := source
	want.FpNext = 0

	tls := libc.NewTLS()
	defer tls.Close()
	pointer := libc.Xmalloc(tls, uint64(unsafe.Sizeof(source)))
	if pointer == 0 {
		t.Fatal("allocate source VFS")
	}
	defer libc.Xfree(tls, pointer)
	copy(libc.GoBytes(pointer, int(unsafe.Sizeof(source))), unsafe.Slice((*byte)(unsafe.Pointer(&source)), int(unsafe.Sizeof(source))))
	got, err := CloneTemplate(pointer)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("cloned VFS = %#v, want %#v", got, want)
	}
}

func TestCloneTemplateRejectsUnknownABI(t *testing.T) {
	for _, version := range []int32{0, 4} {
		t.Run(string(rune('0'+version)), func(t *testing.T) {
			source := sqlite3.Tsqlite3_vfs{FiVersion: version}
			tls := libc.NewTLS()
			defer tls.Close()
			pointer := libc.Xmalloc(tls, uint64(unsafe.Sizeof(source)))
			if pointer == 0 {
				t.Fatal("allocate source VFS")
			}
			defer libc.Xfree(tls, pointer)
			copy(libc.GoBytes(pointer, int(unsafe.Sizeof(source))), unsafe.Slice((*byte)(unsafe.Pointer(&source)), int(unsafe.Sizeof(source))))
			if _, err := CloneTemplate(pointer); err == nil {
				t.Fatalf("accepted VFS version %d", version)
			}
		})
	}
}
