package storage

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
	"xdrive/internal/fssecure"
)

var ErrObjectDirectoryChanged = errors.New("object directory identity changed")

// ObjectDirectory owns root and bucket descriptors for one opaque object ID.
// Relative creation, publication and unlink never resolve through a new path.
// It is request-owned, not shared between goroutines.
type ObjectDirectory struct {
	root, bucket          *os.File
	storagePath, objectID string
	owner                 *ObjectDirectorySet
}

func validObjectID(id string) bool {
	if len(id) < 2 || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func OpenObjectDirectory(storagePath, objectID string, create bool) (*ObjectDirectory, error) {
	if !validObjectID(objectID) {
		return nil, errors.New("invalid object ID")
	}
	root, err := fssecure.OpenDirectory(storagePath)
	if err != nil {
		return nil, err
	}
	fd := int(root.Fd())
	directory := &ObjectDirectory{root: root, storagePath: storagePath, objectID: objectID}
	if create {
		err = unix.Mkdirat(fd, objectID[:2], 0700)
		if err == nil {
			err = directory.root.Sync()
		} else if errors.Is(err, unix.EEXIST) {
			err = nil
		}
		if err != nil {
			_ = directory.Close()
			return nil, err
		}
	}
	bucket, err := unix.Openat(fd, objectID[:2], unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		_ = directory.Close()
		return nil, err
	}
	directory.bucket = os.NewFile(uintptr(bucket), filepath.Join(storagePath, objectID[:2]))
	return directory, nil
}

func (d *ObjectDirectory) Close() error {
	if d == nil {
		return nil
	}
	if d.owner != nil {
		d.root, d.bucket = nil, nil
		return nil
	}
	var err error
	if d.bucket != nil {
		err = d.bucket.Close()
		d.bucket = nil
	}
	if d.root != nil {
		err = errors.Join(err, d.root.Close())
		d.root = nil
	}
	return err
}

// Validate detects replacement of the configured root or the named bucket.
// Anchored operations remain confined even if a privileged writer races this
// check; full protection against privileged filesystem mutation is not claimed.
func (d *ObjectDirectory) Validate() error {
	if d.closed() {
		return os.ErrClosed
	}
	currentRoot, err := fssecure.OpenDirectory(d.storagePath)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrObjectDirectoryChanged, err)
	}
	defer currentRoot.Close()
	expected, err := d.root.Stat()
	actual, statErr := currentRoot.Stat()
	if err != nil || statErr != nil || !os.SameFile(expected, actual) {
		return ErrObjectDirectoryChanged
	}
	fd, err := unix.Openat(int(d.root.Fd()), d.objectID[:2], unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrObjectDirectoryChanged, err)
	}
	currentBucket := os.NewFile(uintptr(fd), d.objectID[:2])
	defer currentBucket.Close()
	expected, err = d.bucket.Stat()
	actual, statErr = currentBucket.Stat()
	if err != nil || statErr != nil || !os.SameFile(expected, actual) {
		return ErrObjectDirectoryChanged
	}
	return nil
}

func (d *ObjectDirectory) CreateTemporary() (*os.File, string, error) {
	if d.closed() {
		return nil, "", os.ErrClosed
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, "", err
	}
	name := ".upload-" + hex.EncodeToString(random[:])
	fd, err := unix.Openat(int(d.bucket.Fd()), name, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, "", err
	}
	return os.NewFile(uintptr(fd), filepath.Join(d.bucket.Name(), name)), name, nil
}

func validTemporaryName(name string) bool {
	if !strings.HasPrefix(name, ".upload-") || len(name) != 40 {
		return false
	}
	_, err := hex.DecodeString(name[len(".upload-"):])
	return err == nil
}

func (d *ObjectDirectory) RemoveTemporary(name string) error {
	if d.closed() {
		return os.ErrClosed
	}
	if !validTemporaryName(name) {
		return errors.New("invalid upload temporary name")
	}
	return unix.Unlinkat(int(d.bucket.Fd()), name, 0)
}

func (d *ObjectDirectory) PublishTemporary(name string) error {
	var published bool
	return d.PublishTemporaryTracked(name, &published)
}

// PublishTemporaryTracked records ownership even if post-link validation fails.
// The caller must retain this handle for rollback and directory sync.
func (d *ObjectDirectory) PublishTemporaryTracked(name string, published *bool) error {
	if published == nil {
		return errors.New("missing publication state")
	}
	*published = false
	if !validTemporaryName(name) {
		return errors.New("invalid upload temporary name")
	}
	if err := d.Validate(); err != nil {
		return err
	}
	fd := int(d.bucket.Fd())
	if err := unix.Linkat(fd, name, fd, d.objectID, 0); err != nil {
		return err
	}
	*published = true
	if err := d.Validate(); err != nil {
		_ = d.RemoveObject()
		return err
	}
	return nil
}

func (d *ObjectDirectory) RemoveObject() error {
	if d.closed() {
		return os.ErrClosed
	}
	return unix.Unlinkat(int(d.bucket.Fd()), d.objectID, 0)
}

func (d *ObjectDirectory) Sync() error {
	if d.closed() {
		return os.ErrClosed
	}
	return d.bucket.Sync()
}

func (d *ObjectDirectory) closed() bool {
	return d == nil || d.root == nil || d.bucket == nil || d.owner != nil && d.owner.closed
}

func RemoveObjectFile(storagePath, objectID string) error {
	directory, err := OpenObjectDirectory(storagePath, objectID, false)
	if err != nil {
		return err
	}
	defer directory.Close()
	if err := directory.RemoveObject(); err != nil && !errors.Is(err, unix.ENOENT) {
		return err
	}
	return directory.Sync()
}

// OpenObjectRead never follows an object/bucket symlink, including internal links.
func OpenObjectRead(storagePath, objectID string) (*os.File, error) {
	directory, err := OpenObjectDirectory(storagePath, objectID, false)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	fd, err := unix.Openat(int(directory.bucket.Fd()), objectID, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), objectID)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errors.New("object must be a regular file")
	}
	return file, nil
}

// OpenObjectReadAt reads an opaque object relative to an already-held storage
// root. It is used by backup operations so source reads remain protected by
// the same directory descriptor that contains the active backup lease.
func OpenObjectReadAt(root *os.File, objectID string) (*os.File, error) {
	if root == nil || !validObjectID(objectID) {
		return nil, errors.New("invalid anchored object read")
	}
	rootInfo, err := root.Stat()
	if err != nil {
		return nil, err
	}
	if !rootInfo.IsDir() {
		return nil, errors.New("anchored object root is not a directory")
	}
	bucketFD, err := unix.Openat(int(root.Fd()), objectID[:2], unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	bucket := os.NewFile(uintptr(bucketFD), objectID[:2])
	defer bucket.Close()
	fd, err := unix.Openat(bucketFD, objectID, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), objectID)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errors.New("object must be a regular file")
	}
	return file, nil
}

// ListObjectShards lists at most4096 valid two-character directory names.
// Both enumeration and type lookup use the same root descriptor, never paths.
func ListObjectShards(storagePath string) ([]string, error) {
	root, err := fssecure.OpenDirectory(storagePath)
	if err != nil {
		return nil, err
	}
	fd := int(root.Fd())
	defer root.Close()
	var names []string
	seen := make(map[string]bool)
	for {
		entries, err := root.ReadDir(128)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		for _, entry := range entries {
			name := entry.Name()
			if len(name) != 2 || !validObjectID(name) {
				continue
			}
			var info unix.Stat_t
			if statErr := unix.Fstatat(fd, name, &info, unix.AT_SYMLINK_NOFOLLOW); statErr != nil {
				if errors.Is(statErr, unix.ENOENT) {
					continue
				}
				return nil, statErr
			}
			if info.Mode&unix.S_IFMT == unix.S_IFDIR && !seen[name] {
				seen[name] = true
				names = append(names, name)
			}
		}
		if errors.Is(err, io.EOF) {
			return names, nil
		}
	}
}

func validStaleUploadName(name string) bool {
	if !strings.HasPrefix(name, ".upload-") || len(name) <= 8 || len(name) > 255 {
		return false
	}
	for _, c := range name[8:] {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// RemoveStaleUploadTemporaries is only for exclusive startup recovery, never
// an active receive. Preserve legacy decimal and maintenance temporary names.
func (d *ObjectDirectory) RemoveStaleUploadTemporaries() (result error) {
	if err := d.Validate(); err != nil {
		return err
	}
	removed := false
	defer func() {
		if removed {
			result = errors.Join(result, d.Sync())
		}
	}()
	fd := int(d.bucket.Fd())
	for {
		entries, err := d.bucket.ReadDir(128)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if !validStaleUploadName(name) {
				continue
			}
			var info unix.Stat_t
			if statErr := unix.Fstatat(fd, name, &info, unix.AT_SYMLINK_NOFOLLOW); statErr != nil {
				if errors.Is(statErr, unix.ENOENT) {
					continue
				}
				return statErr
			}
			if info.Mode&unix.S_IFMT != unix.S_IFREG {
				continue
			}
			if err := d.Validate(); err != nil {
				return err
			}
			if err := unix.Unlinkat(fd, name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
				return err
			}
			removed = true
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
	}
}
