package backup

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
	"xdrive/internal/fssecure"
)

// copyDirectory owns descriptors through publication and temporary cleanup.
// It is local to one sequential object copy, never shared across requests.
type copyDirectory struct {
	root, bucket *os.File
	path, id     string
}

func openCopyDirectory(path, id string) (*copyDirectory, error) {
	if !safeID.MatchString(id) {
		return nil, errors.New("invalid backup object ID")
	}
	parent, err := fssecure.OpenDirectory(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	root, err := openOrCreateDirectoryAt(parent, filepath.Base(path), 0700)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return openCopyDirectoryAt(root, path, id)
}

func openCopyDirectoryAt(root *os.File, path, id string) (*copyDirectory, error) {
	if root == nil || !safeID.MatchString(id) {
		return nil, errors.New("invalid backup object directory")
	}
	fd, err := unix.Dup(int(root.Fd()))
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(fd)
	ownedRoot := os.NewFile(uintptr(fd), path)
	rootFD := int(ownedRoot.Fd())
	d := &copyDirectory{root: ownedRoot, path: path, id: id}
	if err := unix.Mkdirat(rootFD, id[:2], 0700); err == nil {
		if err := d.root.Sync(); err != nil {
			d.close()
			return nil, err
		}
	} else if !errors.Is(err, unix.EEXIST) {
		d.close()
		return nil, err
	}
	bucket, err := unix.Openat(rootFD, id[:2], unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		d.close()
		return nil, err
	}
	d.bucket = os.NewFile(uintptr(bucket), filepath.Join(path, id[:2]))
	if err := d.validate(); err != nil {
		d.close()
		return nil, err
	}
	return d, nil
}
func (d *copyDirectory) close() {
	if d.bucket != nil {
		_ = d.bucket.Close()
	}
	if d.root != nil {
		_ = d.root.Close()
	}
}
func (d *copyDirectory) validate() error {
	root, err := fssecure.OpenDirectory(d.path)
	if err != nil {
		return err
	}
	defer root.Close()
	a, err := root.Stat()
	b, e := d.root.Stat()
	if err != nil || e != nil || !os.SameFile(a, b) {
		return errors.New("backup object root changed")
	}
	fd, err := unix.Openat(int(root.Fd()), d.id[:2], unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	bucket := os.NewFile(uintptr(fd), d.id[:2])
	defer bucket.Close()
	a, err = bucket.Stat()
	b, e = d.bucket.Stat()
	if err != nil || e != nil || !os.SameFile(a, b) {
		return errors.New("backup object shard changed")
	}
	return nil
}
func (d *copyDirectory) temporary() (*os.File, string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, "", err
	}
	name := ".copy-" + hex.EncodeToString(random[:])
	fd, err := unix.Openat(int(d.bucket.Fd()), name, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, "", err
	}
	return os.NewFile(uintptr(fd), filepath.Join(d.bucket.Name(), name)), name, nil
}
func (d *copyDirectory) cleanup(name string) {
	_ = unix.Unlinkat(int(d.bucket.Fd()), name, 0)
	_ = d.bucket.Sync()
}
func (d *copyDirectory) publish(name string) error {
	if err := d.validate(); err != nil {
		return err
	}
	// Replacement is required to repair a corrupted shared backup copy. Refuse
	// links and special files; rename remains anchored to the original shard.
	var info unix.Stat_t
	err := unix.Fstatat(int(d.bucket.Fd()), d.id, &info, unix.AT_SYMLINK_NOFOLLOW)
	if err == nil && info.Mode&unix.S_IFMT != unix.S_IFREG {
		return errors.New("backup target object is not regular")
	}
	if err != nil && !errors.Is(err, unix.ENOENT) {
		return err
	}
	return unix.Renameat(int(d.bucket.Fd()), name, int(d.bucket.Fd()), d.id)
}

// Interrupted copies are enumerated in bounded windows under retained handles.
// Legacy .copy-* regular names remain recognized; links/special files survive.
func removeInterruptedObjectCopies(path string) error {
	root, err := fssecure.OpenDirectory(path)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	defer root.Close()
	return removeInterruptedObjectCopiesAt(root)
}

func removeInterruptedObjectCopiesAt(root *os.File) error {
	if root == nil {
		return errors.New("missing anchored backup objects directory")
	}
	fd := int(root.Fd())
	for {
		shards, readErr := root.ReadDir(128)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return readErr
		}
		for _, shard := range shards {
			if !safeShard.MatchString(shard.Name()) {
				continue
			}
			var stat unix.Stat_t
			if err := unix.Fstatat(fd, shard.Name(), &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				return err
			}
			if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
				continue
			}
			if err := cleanCopyShard(fd, shard.Name()); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
	}
}
func cleanCopyShard(rootFD int, name string) error {
	fd, err := unix.Openat(rootFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	bucket := os.NewFile(uintptr(fd), name)
	defer bucket.Close()
	removed := false
	for {
		entries, readErr := bucket.ReadDir(128)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return readErr
		}
		for _, entry := range entries {
			if !strings.HasPrefix(entry.Name(), ".copy-") {
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
			removed = true
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
	}
	if removed {
		return bucket.Sync()
	}
	return nil
}
