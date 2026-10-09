package backup

import (
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/sys/unix"
	"xdrive/internal/fssecure"
)

// Published generations are immutable single-file SQLite snapshots plus their
// header and object manifest. Reject WAL/SHM sidecars and unknown entries from
// a descriptor-anchored directory before inspecting or restoring the database.
func validateGenerationContents(source, generation string) error {
	root, err := fssecure.OpenDirectory(source)
	if err != nil {
		return fmt.Errorf("open backup root: %w", err)
	}
	defer root.Close()
	snapshotsFD, err := unix.Openat(int(root.Fd()), "snapshots", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open snapshots directory: %w", err)
	}
	defer unix.Close(snapshotsFD)
	generationFD, err := unix.Openat(snapshotsFD, generation, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open backup generation: %w", err)
	}
	directory := os.NewFile(uintptr(generationFD), "backup-generation")
	defer directory.Close()
	entries, readErr := directory.ReadDir(4)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return fmt.Errorf("read backup generation entries: %w", readErr)
	}
	if len(entries) != 3 {
		return errors.New("backup generation must contain exactly its snapshot, object manifest and header")
	}
	expected := map[string]bool{snapshotName: false, objectsName: false, backupName: false}
	for _, entry := range entries {
		if _, ok := expected[entry.Name()]; !ok {
			return fmt.Errorf("unexpected file in backup generation: %q", entry.Name())
		}
		expected[entry.Name()] = true
	}
	for name, present := range expected {
		if !present {
			return fmt.Errorf("backup generation is missing %s", name)
		}
	}
	return nil
}
