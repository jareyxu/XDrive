package backup

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
	"xdrive/internal/fssecure"
)

func validateOwnedStage(parentPath, name string, parent, stage *os.File) error {
	currentParent, err := fssecure.OpenDirectory(parentPath)
	if err != nil {
		return err
	}
	defer currentParent.Close()
	fd := int(currentParent.Fd())
	var held, current, owned, named unix.Stat_t
	if err := unix.Fstat(int(parent.Fd()), &held); err != nil {
		return err
	}
	if err := unix.Fstat(fd, &current); err != nil {
		return err
	}
	if current.Dev != held.Dev || current.Ino != held.Ino {
		return errors.New("backup snapshots directory changed")
	}
	if err := unix.Fstat(int(stage.Fd()), &owned); err != nil {
		return err
	}
	if err := unix.Fstatat(fd, name, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if named.Dev != owned.Dev || named.Ino != owned.Ino || named.Mode&unix.S_IFMT != unix.S_IFDIR {
		return errors.New("backup stage changed")
	}
	return nil
}

func writeStageSynced(stage *os.File, name string, data []byte) error {
	fd, err := unix.Openat(int(stage.Fd()), name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), name)
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
