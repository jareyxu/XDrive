package backup

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
	"xdrive/internal/fssecure"
)

// Interrupted work is removed through retained no-follow directories.
func removeInterruptedWork(destination string) error {
	root, err := fssecure.OpenDirectory(destination)
	if err != nil {
		return err
	}
	defer root.Close()
	return removeInterruptedWorkAt(root, destination)
}

func removeInterruptedWorkAt(root *os.File, destination string) error {
	if root == nil {
		return errors.New("missing anchored backup directory")
	}
	fd := int(root.Fd())
	for {
		entries, e := root.ReadDir(128)
		if e != nil && !errors.Is(e, io.EOF) {
			return e
		}
		for _, entry := range entries {
			if !strings.HasPrefix(entry.Name(), ".current-") {
				continue
			}
			var stat unix.Stat_t
			if err := unix.Fstatat(fd, entry.Name(), &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				return err
			}
			if stat.Mode&unix.S_IFMT != unix.S_IFREG {
				continue
			}
			if err := unix.Unlinkat(fd, entry.Name(), 0); err != nil {
				return err
			}
		}
		if errors.Is(e, io.EOF) {
			break
		}
	}
	if err := root.Sync(); err != nil {
		return err
	}
	sfd, err := unix.Openat(fd, "snapshots", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err == nil {
		snapshots := os.NewFile(uintptr(sfd), "snapshots")
		defer snapshots.Close()
		for {
			entries, e := snapshots.ReadDir(128)
			if e != nil && !errors.Is(e, io.EOF) {
				return e
			}
			for _, entry := range entries {
				if !strings.HasPrefix(entry.Name(), ".staging-") || !safeID.MatchString(strings.TrimPrefix(entry.Name(), ".staging-")) {
					continue
				}
				if err := cleanInterruptedStage(sfd, entry.Name()); err != nil {
					return err
				}
			}
			if errors.Is(e, io.EOF) {
				break
			}
		}
		if err := snapshots.Sync(); err != nil {
			return err
		}
	} else if !errors.Is(err, unix.ENOENT) {
		return err
	}
	objectsFD, err := unix.Openat(fd, "objects", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	objectsRoot := os.NewFile(uintptr(objectsFD), filepath.Join(destination, "objects"))
	defer objectsRoot.Close()
	return removeInterruptedObjectCopiesAt(objectsRoot)
}

func cleanInterruptedStage(parent int, name string) error {
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) || errors.Is(err, unix.ELOOP) {
		return nil
	}
	if err != nil {
		return err
	}
	folder := os.NewFile(uintptr(fd), name)
	defer folder.Close()
	return cleanOpenedStage(parent, name, folder)
}

func cleanOpenedStage(parent int, name string, folder *os.File) error {
	fd := int(folder.Fd())
	var original unix.Stat_t
	if err := unix.Fstat(fd, &original); err != nil {
		return err
	}
	entries, err := folder.ReadDir(4)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if len(entries) > 3 {
		return nil
	}
	for _, entry := range entries {
		if entry.Name() != snapshotName && entry.Name() != objectsName && entry.Name() != backupName {
			return nil
		}
		var stat unix.Stat_t
		if err := unix.Fstatat(fd, entry.Name(), &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		if stat.Mode&unix.S_IFMT != unix.S_IFREG {
			return nil
		}
	}
	for _, entry := range entries {
		if err := unix.Unlinkat(fd, entry.Name(), 0); err != nil {
			return err
		}
	}
	if err := folder.Sync(); err != nil {
		return err
	}
	var current unix.Stat_t
	if err := unix.Fstatat(parent, name, &current, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if current.Dev != original.Dev || current.Ino != original.Ino {
		return errors.New("backup staging directory changed during cleanup")
	}
	return unix.Unlinkat(parent, name, unix.AT_REMOVEDIR)
}
