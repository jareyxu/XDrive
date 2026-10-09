package backup

import (
	"errors"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
	"xdrive/internal/fssecure"
)

const maximumDescriptorRead = 256 << 20

// Known generation files are resolved relative to the backup root, protecting
// both snapshots/ and the generation directory. Other private staging files
// use their immediate directory. Every component of either root is opened with
// O_NOFOLLOW so a linked ancestor cannot redirect backup reads.
func openBackupRegular(path string) (*os.File, error) {
	parent := filepath.Dir(path)
	root := parent
	parts := []string{filepath.Base(path)}
	switch filepath.Base(path) {
	case backupName, objectsName, snapshotName:
		if filepath.Base(filepath.Dir(parent)) == "snapshots" {
			root = filepath.Dir(filepath.Dir(parent))
			parts = []string{"snapshots", filepath.Base(parent), filepath.Base(path)}
		}
	}
	directory, err := fssecure.OpenDirectory(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = directory.Close() }()
	for _, part := range parts[:len(parts)-1] {
		next, err := unix.Openat(int(directory.Fd()), part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if err != nil {
			return nil, err
		}
		_ = directory.Close()
		directory = os.NewFile(uintptr(next), part)
	}
	fd, err := unix.Openat(int(directory.Fd()), parts[len(parts)-1], unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errors.New("backup input must be a regular file")
	}
	return file, nil
}

func readRegularBounded(path string, maximum int64) ([]byte, error) {
	if maximum < 0 || maximum > maximumDescriptorRead {
		return nil, errors.New("invalid backup read bound")
	}
	file, err := openBackupRegular(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() > maximum {
		return nil, errors.New("backup file exceeds safety limit")
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum || int64(len(data)) != info.Size() {
		return nil, errors.New("backup file changed or exceeds safety limit")
	}
	return data, nil
}
