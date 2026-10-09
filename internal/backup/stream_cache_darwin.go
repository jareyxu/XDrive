//go:build darwin

package backup

import (
	"os"

	"golang.org/x/sys/unix"
)

func prepareBackupStream(file *os.File) {
	// Large encrypted objects are copied or hashed once per backup operation;
	// bypassing the unified buffer cache avoids retaining a second large copy.
	_, _ = unix.FcntlInt(file.Fd(), unix.F_NOCACHE, 1)
}

func flushBackupStreamWindow(_ *os.File, _, _ int64) error { return nil }

func discardBackupStreamWindow(_ *os.File, _, _ int64) {}
