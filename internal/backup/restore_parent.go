package backup

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// openRestoreParent opens the final configured parent without following it.
// Existing system ancestors (for example macOS /var -> /private/var) may be
// aliases; the returned descriptor is then used for all stage operations.
func openRestoreParent(path string, create bool) (int, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return -1, err
	}
	fd, err := unix.Open(absolute, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err == nil {
		return fd, nil
	}
	if !create || !errors.Is(err, unix.ENOENT) {
		return -1, err
	}

	missing := make([]string, 0, 8)
	candidate := absolute
	for {
		parent := filepath.Dir(candidate)
		if parent == candidate {
			return -1, errors.New("no existing restore parent ancestor")
		}
		missing = append(missing, filepath.Base(candidate))
		candidate = parent
		fd, openErr := unix.Open(candidate, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if openErr == nil {
			return createRestoreParentComponents(fd, missing)
		}
		if !errors.Is(openErr, unix.ENOENT) {
			// Resolve an existing alias ancestor once, then continue from its real path.
			resolved, resolveErr := filepath.EvalSymlinks(candidate)
			if resolveErr != nil {
				return -1, openErr
			}
			fd, openErr = unix.Open(resolved, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
			if openErr != nil {
				return -1, openErr
			}
			return createRestoreParentComponents(fd, missing)
		}
	}
}

func createRestoreParentComponents(fd int, missing []string) (int, error) {
	for i := len(missing) - 1; i >= 0; i-- {
		name := missing[i]
		if err := unix.Mkdirat(fd, name, 0700); err != nil && !errors.Is(err, unix.EEXIST) {
			unix.Close(fd)
			return -1, err
		}
		if err := unix.Fsync(fd); err != nil {
			unix.Close(fd)
			return -1, err
		}
		next, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if err != nil {
			unix.Close(fd)
			return -1, fmt.Errorf("open restore path component %q: %w", name, err)
		}
		if err := unix.Close(fd); err != nil {
			unix.Close(next)
			return -1, err
		}
		fd = next
	}
	return fd, nil
}

func createRestoreStage(parentFD int) (string, *os.Root, error) {
	for attempt := 0; attempt < 16; attempt++ {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", nil, err
		}
		name := ".xdrive-restore-" + hex.EncodeToString(random[:])
		if err := unix.Mkdirat(parentFD, name, 0700); errors.Is(err, unix.EEXIST) {
			continue
		} else if err != nil {
			return "", nil, err
		}
		if err := unix.Fsync(parentFD); err != nil {
			return "", nil, errors.Join(err, unix.Unlinkat(parentFD, name, unix.AT_REMOVEDIR), unix.Fsync(parentFD))
		}
		fd, err := unix.Openat(parentFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if err != nil {
			return "", nil, errors.Join(err, unix.Unlinkat(parentFD, name, unix.AT_REMOVEDIR), unix.Fsync(parentFD))
		}
		handle := os.NewFile(uintptr(fd), name)
		root, openErr := os.OpenRoot(fmt.Sprintf("/dev/fd/%d", fd))
		if openErr == nil {
			actual, statErr := root.Stat(".")
			held, heldErr := handle.Stat()
			if statErr != nil || heldErr != nil || !os.SameFile(actual, held) {
				openErr = errors.Join(errors.New("restore stage descriptor identity mismatch"), statErr, heldErr)
			}
		}
		closeErr := handle.Close()
		if openErr != nil || closeErr != nil {
			var cleanupErr error
			if root != nil {
				cleanupErr = root.Close()
			}
			cleanupErr = errors.Join(cleanupErr, unix.Unlinkat(parentFD, name, unix.AT_REMOVEDIR), unix.Fsync(parentFD))
			return "", nil, errors.Join(openErr, closeErr, cleanupErr)
		}
		return name, root, nil
	}
	return "", nil, errors.New("unable to allocate a unique restore stage directory")
}
