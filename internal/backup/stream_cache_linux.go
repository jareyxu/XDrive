//go:build linux

package backup

import (
	"os"

	"golang.org/x/sys/unix"
)

func prepareBackupStream(file *os.File) {
	_ = unix.Fadvise(int(file.Fd()), 0, 0, unix.FADV_SEQUENTIAL)
}

func flushBackupStreamWindow(file *os.File, offset, size int64) error {
	if size == 0 {
		return nil
	}
	if err := unix.SyncFileRange(int(file.Fd()), offset, size, unix.SYNC_FILE_RANGE_WRITE_AND_WAIT); err != nil {
		// Some virtual, network, or overlay filesystems do not implement
		// sync_file_range. Keep the bounded-write guarantee with the portable
		// file sync fallback rather than making backup support filesystem-specific.
		return file.Sync()
	}
	return nil
}

func discardBackupStreamWindow(file *os.File, offset, size int64) {
	if size > 0 {
		_ = unix.Fadvise(int(file.Fd()), offset, size, unix.FADV_DONTNEED)
	}
}
