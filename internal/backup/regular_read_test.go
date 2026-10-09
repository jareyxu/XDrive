package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestBackupDescriptorReadsRejectLinkedGenerationAndSnapshots(t *testing.T) {
	for _, kind := range []string{"generation", "snapshots"} {
		t.Run(kind, func(t *testing.T) {
			settings, destination, _, _ := backupFixture(t)
			if err := Create(context.Background(), settings, destination, false); err != nil {
				t.Fatal(err)
			}
			generation, err := readCurrent(destination)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(destination, "snapshots")
			if kind == "generation" {
				path = filepath.Join(path, generation)
			}
			moved := path + "-original"
			if err := os.Rename(path, moved); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(moved, path); err != nil {
				t.Fatal(err)
			}
			if err := Verify(context.Background(), destination); err == nil {
				t.Error("verification accepted linked descriptor hierarchy")
			}
			target := settings
			root := filepath.Join(t.TempDir(), "restored")
			target.DatabasePath = filepath.Join(root, "drive.db")
			target.StoragePath = filepath.Join(root, "objects")
			target.SecretPath = filepath.Join(root, "secret")
			if err := Restore(context.Background(), target, destination); err == nil {
				t.Error("restore accepted linked descriptor hierarchy")
			}
			if _, err := os.Stat(root); !os.IsNotExist(err) {
				t.Errorf("restore activated target: %v", err)
			}
		})
	}
}

func TestRegularBoundedReadRejectsSymlinkInConfiguredRootAncestor(t *testing.T) {
	parent := t.TempDir()
	target := filepath.Join(parent, "real", "backup")
	if err := os.MkdirAll(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "data"), []byte("safe"), 0600); err != nil {
		t.Fatal(err)
	}
	ancestor := filepath.Join(parent, "root-link")
	if err := os.Symlink(filepath.Join(parent, "real"), ancestor); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(ancestor, "backup", "data")
	if _, err := readRegularBounded(path, 4); err == nil || !(errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR)) {
		t.Fatalf("configured-root ancestor symlink was not rejected: %v", err)
	}
}
func TestRegularBoundedReadLimitsAndRejectsLinks(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "data")
	if err := os.WriteFile(path, []byte("1234"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, maximum := range []int64{-1, 0, 3, 1 << 62} {
		if _, err := readRegularBounded(path, maximum); err == nil {
			t.Errorf("unsafe bound accepted: %d", maximum)
		}
	}
	if b, err := readRegularBounded(path, 4); err != nil || string(b) != "1234" {
		t.Fatalf("exact read: %q %v", b, err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readRegularBounded(link, 4); err == nil {
		t.Error("leaf link accepted")
	}
	parent := root + "-link"
	if err := os.Symlink(root, parent); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(parent) })
	if _, err := readRegularBounded(filepath.Join(parent, "data"), 4); err == nil {
		t.Error("parent link accepted")
	}
}
