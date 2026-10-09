package backup

import (
	"context"
	"errors"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"strings"
	"time"
)

const snapshotLeaseName = ".lease"

func lockSnapshotFolder(folder string) (*os.File, error) {
	fd, err := unix.Open(folder+"/"+snapshotLeaseName, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), snapshotLeaseName)
	if err := unix.Flock(fd, unix.LOCK_EX); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}
func reapSnapshotCopies(ctx context.Context, rootPath string, now time.Time) error {
	fd, err := unix.Open(rootPath, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	root := os.NewFile(uintptr(fd), rootPath)
	defer root.Close()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		entries, readErr := root.ReadDir(128)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return readErr
		}
		for _, entry := range entries {
			suffix := strings.TrimPrefix(entry.Name(), ".xdrive-snapshot-read-")
			if suffix == entry.Name() || len(suffix) == 0 || len(suffix) > 20 {
				continue
			}
			valid := true
			for _, c := range suffix {
				if c < '0' || c > '9' {
					valid = false
				}
			}
			if !valid {
				continue
			}
			if err := reapSnapshotFolder(fd, entry.Name(), now); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
	}
}
func reapSnapshotFolder(rootFD int, name string, now time.Time) error {
	// Shared temporary roots may contain another account's private directories.
	// Inspect the entry without opening it before deciding it is ours to reap.
	var candidate unix.Stat_t
	if err := unix.Fstatat(rootFD, name, &candidate, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.EACCES) {
			return nil
		}
		return err
	}
	if candidate.Uid != uint32(os.Geteuid()) || candidate.Mode&unix.S_IFMT != unix.S_IFDIR || candidate.Mode&0777 != 0700 {
		return nil
	}
	fd, err := unix.Openat(rootFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) || errors.Is(err, unix.ELOOP) || errors.Is(err, unix.EACCES) {
		return nil
	}
	if err != nil {
		return err
	}
	folder := os.NewFile(uintptr(fd), name)
	defer folder.Close()
	var original unix.Stat_t
	if err := unix.Fstat(fd, &original); err != nil {
		return err
	}
	if original.Uid != uint32(os.Geteuid()) || original.Mode&0777 != 0700 {
		return nil
	}
	leaseFD, err := unix.Openat(fd, snapshotLeaseName, unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if errors.Is(err, unix.ENOENT) {
		info, e := folder.Stat()
		if e != nil {
			return e
		}
		if now.Sub(info.ModTime()) < time.Hour {
			return nil
		}
	} else if err != nil {
		return nil
	} else {
		lease := os.NewFile(uintptr(leaseFD), snapshotLeaseName)
		defer lease.Close()
		var stat unix.Stat_t
		if unix.Fstat(leaseFD, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != original.Uid {
			return nil
		}
		if err := unix.Flock(leaseFD, unix.LOCK_EX|unix.LOCK_NB); errors.Is(err, unix.EWOULDBLOCK) {
			return nil
		} else if err != nil {
			return err
		}
	}
	entries, err := folder.ReadDir(3)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if len(entries) > 2 {
		return nil
	}
	for _, entry := range entries {
		if entry.Name() != snapshotName && entry.Name() != snapshotLeaseName {
			return nil
		}
		var stat unix.Stat_t
		if unix.Fstatat(fd, entry.Name(), &stat, unix.AT_SYMLINK_NOFOLLOW) != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != original.Uid {
			return nil
		}
	}
	var current unix.Stat_t
	if unix.Fstatat(rootFD, name, &current, unix.AT_SYMLINK_NOFOLLOW) != nil || current.Dev != original.Dev || current.Ino != original.Ino {
		return nil
	}
	for _, entry := range entries {
		if err := unix.Unlinkat(fd, entry.Name(), 0); err != nil {
			return err
		}
	}
	if err := folder.Sync(); err != nil {
		return err
	}
	if unix.Fstatat(rootFD, name, &current, unix.AT_SYMLINK_NOFOLLOW) != nil || current.Dev != original.Dev || current.Ino != original.Ino {
		return nil
	}
	return unix.Unlinkat(rootFD, name, unix.AT_REMOVEDIR)
}
