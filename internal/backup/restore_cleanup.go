package backup

import (
	"errors"
	"golang.org/x/sys/unix"
	"io"
	"os"
)

func validatePreparedRestore(parentPath, name string, parent int, root *os.Root) error {
	fd, err := openRestoreParent(parentPath, false)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var held, current unix.Stat_t
	if err := unix.Fstat(parent, &held); err != nil {
		return err
	}
	if err := unix.Fstat(fd, &current); err != nil {
		return err
	}
	if held.Dev != current.Dev || held.Ino != current.Ino {
		return errors.New("restore parent identity changed")
	}
	return verifyRestoreStageIdentity(root, parent, name)
}

func verifyRestoreStageIdentity(root *os.Root, parent int, name string) error {
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	var original, current unix.Stat_t
	if err := unix.Fstat(int(directory.Fd()), &original); err != nil {
		return err
	}
	if err := unix.Fstatat(parent, name, &current, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if current.Dev != original.Dev || current.Ino != original.Ino || current.Mode&unix.S_IFMT != unix.S_IFDIR {
		return errors.New("restore stage identity changed")
	}
	return nil
}

// os.Root operations retain the original tree on supported Unix platforms.
// RemoveAll never follows a leaf symlink into another tree.
func cleanupRestoreStage(root *os.Root, parent int, name string) error {
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	for {
		entries, e := directory.ReadDir(128)
		if e != nil && !errors.Is(e, io.EOF) {
			return e
		}
		for _, entry := range entries {
			if err := root.RemoveAll(entry.Name()); err != nil {
				return err
			}
		}
		if errors.Is(e, io.EOF) {
			break
		}
	}
	if err := directory.Sync(); err != nil {
		return err
	}
	if err := verifyRestoreStageIdentity(root, parent, name); err != nil {
		return err
	}
	return unix.Unlinkat(parent, name, unix.AT_REMOVEDIR)
}
