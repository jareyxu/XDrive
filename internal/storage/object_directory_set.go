package storage

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
	"xdrive/internal/fssecure"
)

// ObjectDirectorySet belongs to one sequential batch. Views borrow one root
// and one descriptor per shard; Close must run after every candidate rollback.
// Neither the set nor its views may be used concurrently.
type ObjectDirectorySet struct {
	root        *os.File
	storagePath string
	buckets     map[string]*os.File
	closed      bool
}

func OpenObjectDirectorySet(storagePath string) (*ObjectDirectorySet, error) {
	root, err := fssecure.OpenDirectory(storagePath)
	if err != nil {
		return nil, err
	}
	return &ObjectDirectorySet{root: root, storagePath: storagePath, buckets: make(map[string]*os.File)}, nil
}

func (s *ObjectDirectorySet) Directory(objectID string) (*ObjectDirectory, error) {
	if s == nil || s.closed {
		return nil, os.ErrClosed
	}
	if !validObjectID(objectID) {
		return nil, errors.New("invalid object ID")
	}
	name := objectID[:2]
	bucket := s.buckets[name]
	if bucket == nil {
		fd := int(s.root.Fd())
		if err := unix.Mkdirat(fd, name, 0700); err == nil {
			if err := s.root.Sync(); err != nil {
				return nil, err
			}
		} else if !errors.Is(err, unix.EEXIST) {
			return nil, err
		}
		opened, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if err != nil {
			return nil, err
		}
		bucket = os.NewFile(uintptr(opened), filepath.Join(s.storagePath, name))
		s.buckets[name] = bucket
	}
	view := &ObjectDirectory{root: s.root, bucket: bucket, storagePath: s.storagePath, objectID: objectID, owner: s}
	if err := view.Validate(); err != nil {
		return nil, err
	}
	return view, nil
}

func (s *ObjectDirectorySet) Close() error {
	if s == nil || s.closed {
		return nil
	}
	s.closed = true
	var result error
	for _, bucket := range s.buckets {
		result = errors.Join(result, bucket.Close())
	}
	result = errors.Join(result, s.root.Close())
	s.buckets, s.root = nil, nil
	return result
}
