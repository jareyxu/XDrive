package backup

import (
	"errors"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

func openOrCreateDirectoryAt(parent *os.File, name string, mode uint32) (*os.File, error) {
	if parent == nil || name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return nil, errors.New("invalid anchored backup directory")
	}
	parentFD := int(parent.Fd())
	if err := unix.Mkdirat(parentFD, name, mode); err != nil && !errors.Is(err, unix.EEXIST) {
		return nil, err
	} else if err == nil {
		if err := parent.Sync(); err != nil {
			return nil, err
		}
	}
	fd, err := unix.Openat(parentFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	directory := os.NewFile(uintptr(fd), name)
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil || info.Mode&unix.S_IFMT != unix.S_IFDIR {
		_ = directory.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("backup path component is not a directory")
	}
	return directory, nil
}

// securePrivateDirectory makes a directory used for backup state private to
// the service account. SQLite's default VFS accepts pathnames rather than an
// already-open directory descriptor, so private staging permissions are an
// important part of the snapshot path's safety boundary.
func securePrivateDirectory(directory *os.File) error {
	if directory == nil {
		return errors.New("missing backup directory")
	}
	fd := int(directory.Fd())
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil {
		return err
	}
	if info.Mode&unix.S_IFMT != unix.S_IFDIR {
		return errors.New("backup path is not a directory")
	}
	if info.Uid != uint32(os.Geteuid()) {
		return errors.New("backup directory must be owned by the service account")
	}
	if info.Mode&0o777 != 0o700 {
		if err := unix.Fchmod(fd, 0o700); err != nil {
			return err
		}
		if err := directory.Sync(); err != nil {
			return err
		}
		if err := unix.Fstat(fd, &info); err != nil {
			return err
		}
	}
	if info.Uid != uint32(os.Geteuid()) || info.Mode&unix.S_IFMT != unix.S_IFDIR || info.Mode&0o777 != 0o700 {
		return errors.New("backup directory is not private to the service account")
	}
	return nil
}
