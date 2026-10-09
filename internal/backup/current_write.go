package backup

import (
	"errors"
	"os"
	"strings"

	"golang.org/x/sys/unix"
	"xdrive/internal/fssecure"
)

func writeAtomicWithHook(directory, name string, data []byte, afterStep func(string)) error {
	root, err := fssecure.OpenDirectory(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	return writeAtomicAtWithHook(root, directory, name, data, afterStep)
}

func writeAtomicAtWithHook(root *os.File, directory, name string, data []byte, afterStep func(string)) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return errors.New("invalid atomic backup filename")
	}
	if root == nil {
		return errors.New("missing anchored backup directory")
	}
	fd := int(root.Fd())
	var original unix.Stat_t
	if err := unix.Fstat(fd, &original); err != nil {
		return err
	}
	validate := func() error {
		next, err := fssecure.OpenDirectory(directory)
		if err != nil {
			return err
		}
		defer next.Close()
		var stat unix.Stat_t
		if err := unix.Fstat(int(next.Fd()), &stat); err != nil {
			return err
		}
		if stat.Dev != original.Dev || stat.Ino != original.Ino {
			return errors.New("backup publication directory changed")
		}
		return nil
	}
	id, err := randomID()
	if err != nil {
		return err
	}
	temporary := ".current-" + id
	tfd, err := unix.Openat(fd, temporary, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(tfd), temporary)
	defer func() { _ = unix.Unlinkat(fd, temporary, 0); _ = root.Sync() }()
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if afterStep != nil {
		afterStep("temp-synced")
	}
	if err := validate(); err != nil {
		return err
	}
	var target unix.Stat_t
	if err := unix.Fstatat(fd, name, &target, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		if target.Mode&unix.S_IFMT != unix.S_IFREG {
			return errors.New("backup completion marker is not regular")
		}
	} else if !errors.Is(err, unix.ENOENT) {
		return err
	}
	if err := unix.Renameat(fd, temporary, fd, name); err != nil {
		return err
	}
	if afterStep != nil {
		afterStep("renamed")
	}
	if err := root.Sync(); err != nil {
		return err
	}
	if err := validate(); err != nil {
		return err
	}
	if afterStep != nil {
		afterStep("directory-synced")
	}
	return nil
}
