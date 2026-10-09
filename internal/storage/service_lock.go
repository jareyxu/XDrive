package storage

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/sys/unix"
)

var ErrServiceInUse = errors.New("XDrive data is already owned by a running service or offline maintenance command")

// ServiceLease excludes migration/startup recovery, not online SQL operations.
// Both database and object-directory aliases must resolve to the same lock inode.
// Never unlink a lock file: doing so would let two owners lock different inodes.
type ServiceLease struct {
	files []*os.File
	once  sync.Once
	err   error
}

func AcquireServiceLease(databasePath, storagePath string) (*ServiceLease, error) {
	if databasePath == "" || storagePath == "" {
		return nil, errors.New("database and object storage paths are required")
	}
	if err := os.MkdirAll(filepath.Dir(databasePath), 0700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(storagePath, 0700); err != nil {
		return nil, err
	}
	lease := &ServiceLease{}
	for _, path := range []string{databasePath + ".xdrive.lock", filepath.Join(storagePath, ".service.lock")} {
		fd, err := unix.Open(path, unix.O_RDWR|unix.O_CREAT|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
		if err != nil {
			_ = lease.Close()
			return nil, fmt.Errorf("open service coordination lock: %w", err)
		}
		file := os.NewFile(uintptr(fd), path)
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			_ = file.Close()
			_ = lease.Close()
			return nil, errors.New("service coordination lock must be a regular file")
		}
		if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
			_ = file.Close()
			_ = lease.Close()
			if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
				return nil, ErrServiceInUse
			}
			return nil, fmt.Errorf("acquire service coordination lock: %w", err)
		}
		lease.files = append(lease.files, file)
		if err := file.Chmod(0600); err != nil {
			_ = lease.Close()
			return nil, err
		}
	}
	return lease, nil
}

func (lease *ServiceLease) Close() error {
	if lease == nil {
		return nil
	}
	lease.once.Do(func() {
		for index := len(lease.files) - 1; index >= 0; index-- {
			file := lease.files[index]
			lease.err = errors.Join(lease.err, unix.Flock(int(file.Fd()), unix.LOCK_UN), file.Close())
		}
	})
	return lease.err
}
