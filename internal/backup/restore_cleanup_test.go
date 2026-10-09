package backup

import (
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreOwnedCleanupPopulatedTreeWindowsAndExternalLinks(t *testing.T) {
	parent := t.TempDir()
	name := ".xdrive-restore-owned"
	stage := filepath.Join(parent, name)
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 300; i++ {
		directory := filepath.Join(stage, fmt.Sprintf("entry-%04d", i), "nested")
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "data"), []byte("owned"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, "victim")
	if err := os.WriteFile(victim, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{"external-directory": outside, "external-file": victim} {
		if err := os.Symlink(target, filepath.Join(stage, name)); err != nil {
			t.Fatal(err)
		}
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	fd, err := unix.Open(parent, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	if err := os.Rename(parent, parent+"-owned"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(parent + "-owned") })
	if err := os.Symlink(outside, parent); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(outside, name), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, name, "victim"), []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := cleanupRestoreStage(root, fd, name); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(parent+"-owned", name)); !os.IsNotExist(err) {
		t.Fatalf("original populated tree remains: %v", err)
	}
	for path, want := range map[string]string{victim: "preserve", filepath.Join(outside, name, "victim"): "replacement"} {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != want {
			t.Fatalf("external bytes changed: %q %q %v", path, data, err)
		}
	}
}
