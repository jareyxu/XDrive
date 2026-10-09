package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
	"xdrive/internal/fssecure"
)

// BackupLease coordinates the backup CLI with every process that may unlink
// an object file. It retains the opened directory whose lock it owns.
type BackupLease struct {
	file *os.File
	root *os.File
}

func AcquireBackupLease(ctx context.Context, storagePath string) (*BackupLease, error) {
	return acquire(ctx, storagePath, unix.LOCK_EX, true)
}

func AcquireDeletionLease(ctx context.Context, storagePath string) (*BackupLease, error) {
	return acquire(ctx, storagePath, unix.LOCK_SH, true)
}

// AcquireInspectionLease takes a shared lock on an existing coordinator file
// without creating or modifying anything in the inspected directory.
func AcquireInspectionLease(ctx context.Context, storagePath string) (*BackupLease, error) {
	return acquireWithOptions(ctx, storagePath, unix.LOCK_SH, true, false)
}

// TryDeletionLease returns nil when an active backup owns the exclusive lock.
// The caller must leave database-deleted object files for a later GC pass.
func TryDeletionLease(storagePath string) (*BackupLease, error) {
	return acquire(context.Background(), storagePath, unix.LOCK_SH, false)
}

func acquire(ctx context.Context, storagePath string, mode int, wait bool) (*BackupLease, error) {
	return acquireWithOptions(ctx, storagePath, mode, wait, true)
}

func acquireWithOptions(ctx context.Context, storagePath string, mode int, wait, createLock bool) (*BackupLease, error) {
	root, err := fssecure.OpenDirectory(storagePath)
	if err != nil {
		return nil, fmt.Errorf("open backup coordination directory: %w", err)
	}
	flags := unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
	if createLock {
		flags |= unix.O_CREAT | unix.O_RDWR
	} else {
		flags |= unix.O_RDONLY
	}
	fd, err := unix.Openat(int(root.Fd()), ".backup.lock", flags, 0o600)
	if err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("open backup coordination lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), filepath.Join(storagePath, ".backup.lock"))
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		_ = root.Close()
		return nil, errors.New("backup coordination lock must be a regular file")
	}
	for {
		err = unix.Flock(int(file.Fd()), mode|unix.LOCK_NB)
		if err == nil {
			return &BackupLease{file: file, root: root}, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			_ = file.Close()
			_ = root.Close()
			return nil, fmt.Errorf("acquire backup coordination lock: %w", err)
		}
		if !wait {
			_ = file.Close()
			_ = root.Close()
			return nil, nil
		}
		select {
		case <-ctx.Done():
			_ = file.Close()
			_ = root.Close()
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// Directory returns the borrowed root descriptor protected by this lease. It
// remains valid until Close and must not be closed by the caller.
func (lease *BackupLease) Directory() *os.File {
	if lease == nil {
		return nil
	}
	return lease.root
}

func (lease *BackupLease) Close() error {
	if lease == nil || lease.file == nil {
		return nil
	}
	err := unix.Flock(int(lease.file.Fd()), unix.LOCK_UN)
	closeErr := lease.file.Close()
	lease.file = nil
	rootErr := lease.root.Close()
	lease.root = nil
	return errors.Join(err, closeErr, rootErr)
}
