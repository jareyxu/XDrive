// Package fssecure contains descriptor-based filesystem path helpers shared by
// storage and offline backup operations.
package fssecure

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// OpenDirectory opens each component from the filesystem root with O_NOFOLLOW.
// macOS exposes its temporary directories through the conventional /var and
// /tmp aliases; normalize only those two OS aliases before walking. This keeps
// temporary paths usable without following arbitrary links in configured roots.
func OpenDirectory(path string) (*os.File, error) {
	if path == "" {
		return nil, errors.New("directory path is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	absolute = filepath.Clean(absolute)
	if strings.HasPrefix(absolute, "/var/") || absolute == "/var" {
		if aliasTarget("/var") == "/private/var" {
			absolute = filepath.Join("/private", strings.TrimPrefix(absolute, "/"))
		}
	}
	if strings.HasPrefix(absolute, "/tmp/") || absolute == "/tmp" {
		if aliasTarget("/tmp") == "/private/tmp" {
			absolute = filepath.Join("/private", strings.TrimPrefix(absolute, "/"))
		}
	}

	rootFD, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	directory := os.NewFile(uintptr(rootFD), "/")
	for _, component := range strings.Split(strings.TrimPrefix(absolute, "/"), "/") {
		if component == "" || component == "." {
			continue
		}
		nextFD, openErr := unix.Openat(int(directory.Fd()), component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if openErr != nil {
			_ = directory.Close()
			return nil, fmt.Errorf("open directory component %q of %q: %w", component, absolute, openErr)
		}
		_ = directory.Close()
		directory = os.NewFile(uintptr(nextFD), component)
	}
	return directory, nil
}

func aliasTarget(path string) string {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return ""
	}
	target, err := os.Readlink(path)
	if err != nil {
		return ""
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(path), target)
	}
	return filepath.Clean(target)
}
