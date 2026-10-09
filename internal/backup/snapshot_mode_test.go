package backup

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestCreatePublishesPrivateSnapshotWithPermissiveCallerUmask(t *testing.T) {
	// Backup tests are serial. Exercise the CLI's usual caller umask without
	// allowing it to determine the permissions of the published database.
	previous := unix.Umask(0022)
	defer unix.Umask(previous)
	settings, destination, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, true); err != nil {
		t.Fatal(err)
	}
	generation, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(destination, "snapshots", generation, snapshotName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("published snapshot permissions: got %04o, want 0600", info.Mode().Perm())
	}
	if err := Verify(context.Background(), destination); err != nil {
		t.Fatal(err)
	}
}

func TestPrivateSnapshotSyncRejectsLinksAndSpecialFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "fifo", "directory"} {
		t.Run(kind, func(t *testing.T) {
			stage := t.TempDir()
			outside := filepath.Join(t.TempDir(), "preserve")
			if err := os.WriteFile(outside, []byte("outside-snapshot"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(outside, 0644); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(stage, snapshotName)
			var err error
			switch kind {
			case "symlink":
				err = os.Symlink(outside, path)
			case "hardlink":
				err = os.Link(outside, path)
			case "fifo":
				err = unix.Mkfifo(path, 0600)
			case "directory":
				err = os.Mkdir(path, 0700)
			}
			if err != nil {
				t.Fatal(err)
			}
			fd, err := unix.Open(stage, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer unix.Close(fd)
			if err := syncPrivateSnapshot(fd); err == nil {
				t.Fatal("unsafe snapshot accepted")
			}
			info, err := os.Stat(outside)
			if err != nil || info.Mode().Perm() != 0644 {
				t.Fatalf("outside permissions changed: %v %v", info, err)
			}
			data, err := os.ReadFile(outside)
			if err != nil || string(data) != "outside-snapshot" {
				t.Fatalf("outside bytes changed: %q %v", data, err)
			}
		})
	}
}

func TestPrivateSnapshotSyncUsesHeldStageAfterPathReplacement(t *testing.T) {
	root := t.TempDir()
	stage, moved, outside := filepath.Join(root, "stage"), filepath.Join(root, "moved"), filepath.Join(root, "outside")
	for _, path := range []string{stage, outside} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, snapshotName), []byte("preserve-snapshot"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Join(path, snapshotName), 0644); err != nil {
			t.Fatal(err)
		}
	}
	fd, err := unix.Open(stage, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	if err := os.Rename(stage, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, stage); err != nil {
		t.Fatal(err)
	}
	if err := syncPrivateSnapshot(fd); err != nil {
		t.Fatal(err)
	}
	for path, mode := range map[string]os.FileMode{moved: 0600, outside: 0644} {
		info, err := os.Stat(filepath.Join(path, snapshotName))
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("snapshot mode in %s: %v %v", path, info, err)
		}
		data, err := os.ReadFile(filepath.Join(path, snapshotName))
		if err != nil || string(data) != "preserve-snapshot" {
			t.Fatalf("snapshot bytes in %s: %q %v", path, data, err)
		}
	}
}
