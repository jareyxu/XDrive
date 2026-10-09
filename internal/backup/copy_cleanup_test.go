package backup

import (
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"
)

func TestInterruptedCopyCleanupCrossesBothWindowsAndPreservesSpecialFiles(t *testing.T) {
	// Keep Unix socket paths below the macOS/Linux sockaddr_un limit.
	root, err := os.MkdirTemp("/tmp", "xdc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	alphabet := "abcdefghijklmnopqrstuvwxyz0123456789_-"
	for i := 0; i < 300; i++ {
		name := string([]byte{alphabet[i/38], alphabet[i%38]})
		path := filepath.Join(root, name)
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, ".copy-interrupted"), []byte("remove"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	bucket := filepath.Join(root, "aa")
	for i := 0; i < 300; i++ {
		if err := os.WriteFile(filepath.Join(bucket, fmt.Sprintf(".copy-%03d", i)), []byte("remove"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, ".copy-victim")
	if err := os.WriteFile(victim, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(bucket, ".copy-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "zz")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(bucket, ".copy-fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(bucket, ".copy-directory"), 0700); err != nil {
		t.Fatal(err)
	}
	socket, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	unix.CloseOnExec(socket)
	defer unix.Close(socket)
	socketBound := false
	if err := unix.Bind(socket, &unix.SockaddrUnix{Name: filepath.Join(bucket, ".copy-socket")}); err != nil {
		if !errors.Is(err, unix.EPERM) && !errors.Is(err, unix.EACCES) {
			t.Fatal(err)
		}
		t.Log("Unix-domain socket preservation subcase skipped: sandbox denies bind")
	} else {
		socketBound = true
	}
	if err := removeInterruptedObjectCopies(root); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 300; i++ {
		name := string([]byte{alphabet[i/38], alphabet[i%38]})
		entries, err := os.ReadDir(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		expected := 0
		if name == "aa" {
			expected = 3
			if socketBound {
				expected++
			}
		}
		if len(entries) != expected {
			t.Fatalf("%s remaining=%d want=%d", name, len(entries), expected)
		}
	}
	specialFiles := map[string]os.FileMode{".copy-link": os.ModeSymlink, ".copy-fifo": os.ModeNamedPipe, ".copy-directory": os.ModeDir}
	if socketBound {
		specialFiles[".copy-socket"] = os.ModeSocket
	}
	for name, kind := range specialFiles {
		info, err := os.Lstat(filepath.Join(bucket, name))
		if err != nil || info.Mode()&os.ModeType != kind {
			t.Fatalf("special file %s changed: %v %v", name, info, err)
		}
	}
	info, err := os.Lstat(filepath.Join(root, "zz"))
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("linked shard changed: %v", err)
	}
	actual, err := os.ReadFile(victim)
	if err != nil || string(actual) != "keep" {
		t.Fatalf("outside changed: %v", err)
	}
}
