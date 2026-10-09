package backup

import (
	"os"
	"testing"

	"golang.org/x/sys/unix"
)

func TestRestoreStageRootSupportsWritableFiles(t *testing.T) {
	parent, err := unix.Open(t.TempDir(), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(parent)
	name, root, err := createRestoreStage(parent)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := cleanupRestoreStage(root, parent, name); err != nil {
			t.Errorf("cleanup restore stage: %v", err)
		}
		if err := root.Close(); err != nil {
			t.Errorf("close restore stage: %v", err)
		}
	}()
	f, err := root.OpenFile("probe", os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("write")); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}
