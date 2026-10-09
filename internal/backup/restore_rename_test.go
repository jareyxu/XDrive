package backup

import (
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreActivationExclusiveRenamePreservesExistingEmptyTarget(t *testing.T) {
	parent := t.TempDir()
	for _, name := range []string{"stage", "target"} {
		if err := os.Mkdir(filepath.Join(parent, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(parent, "stage", "prepared"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(filepath.Join(parent, "target"))
	if err != nil {
		t.Fatal(err)
	}
	fd, err := unix.Open(parent, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	if err := renameRestoreExclusive(fd, "stage", "target"); err == nil {
		t.Fatal("activation replaced an existing empty target")
	}
	after, err := os.Stat(filepath.Join(parent, "target"))
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("existing target identity changed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(parent, "stage", "prepared"))
	if err != nil || string(data) != "data" {
		t.Fatalf("source stage lost: %v", err)
	}
	if err := os.Remove(filepath.Join(parent, "target")); err != nil {
		t.Fatal(err)
	}
	if err := renameRestoreExclusive(fd, "stage", "target"); err != nil {
		t.Fatalf("absent target activation failed: %v", err)
	}
	data, err = os.ReadFile(filepath.Join(parent, "target", "prepared"))
	if err != nil || string(data) != "data" {
		t.Fatalf("activated bytes lost: %v", err)
	}
}
