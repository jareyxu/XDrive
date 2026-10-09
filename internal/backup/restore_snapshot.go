package backup

import (
	"context"
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
)

func copyRestoredSnapshot(ctx context.Context, source string, root *os.Root, name, digest string) error {
	identity, err := copyRestoredSnapshotWithIdentity(ctx, source, root, name, digest)
	if identity != nil {
		err = errors.Join(err, identity.guard.Close())
	}
	return err
}

type copiedSnapshotIdentity struct {
	info  os.FileInfo
	guard *os.File
}

func copyRestoredSnapshotWithIdentity(ctx context.Context, source string, root *os.Root, name, digest string) (*copiedSnapshotIdentity, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := root.MkdirAll(filepath.Dir(name), 0700); err != nil {
		return nil, err
	}
	var identity *copiedSnapshotIdentity
	err := copySnapshotWithOutput(ctx, source, digest, func() (*os.File, error) {
		file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		info, err := file.Stat()
		if err != nil {
			return nil, errors.Join(err, file.Close())
		}
		duplicate, err := unix.FcntlInt(file.Fd(), unix.F_DUPFD_CLOEXEC, 0)
		if err != nil {
			return nil, errors.Join(err, file.Close())
		}
		identity = &copiedSnapshotIdentity{info: info, guard: os.NewFile(uintptr(duplicate), name)}
		return file, nil
	})
	if err != nil {
		if identity != nil {
			err = errors.Join(err, identity.guard.Close())
		}
		return nil, err
	}
	return identity, nil
}
