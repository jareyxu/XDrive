//go:build !linux && !darwin

package backup

import "os"

func prepareBackupStream(_ *os.File) {}

func flushBackupStreamWindow(file *os.File, _, _ int64) error { return file.Sync() }

func discardBackupStreamWindow(_ *os.File, _, _ int64) {}
