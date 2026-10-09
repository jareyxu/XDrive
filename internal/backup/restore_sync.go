package backup

import (
	"context"
	"errors"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"path/filepath"
)

func syncRestoreTree(ctx context.Context, root *os.Root) error {
	var visit func(string) error
	visit = func(name string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		directory, err := root.OpenFile(name, os.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
		if err != nil {
			return err
		}
		defer directory.Close()
		for {
			entries, readErr := directory.ReadDir(128)
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				return readErr
			}
			for _, entry := range entries {
				if err := ctx.Err(); err != nil {
					return err
				}
				path := filepath.Join(name, entry.Name())
				if entry.IsDir() {
					if err := visit(path); err != nil {
						return err
					}
					continue
				}
				if !entry.Type().IsRegular() {
					return errors.New("restore staging contains a non-regular file")
				}
				file, err := root.OpenFile(path, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
				if err != nil {
					return err
				}
				info, statErr := file.Stat()
				if statErr != nil || !info.Mode().IsRegular() {
					_ = file.Close()
					if statErr != nil {
						return statErr
					}
					return errors.New("restore sync file identity changed")
				}
				syncErr := file.Sync()
				closeErr := file.Close()
				if err := errors.Join(syncErr, closeErr); err != nil {
					return err
				}
			}
			if errors.Is(readErr, io.EOF) {
				break
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return directory.Sync()
	}
	return visit(".")
}
