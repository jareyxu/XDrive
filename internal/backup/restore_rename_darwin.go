package backup

import "golang.org/x/sys/unix"

func renameRestoreExclusive(parent int, stage, target string) error {
	return unix.RenameatxNp(parent, stage, parent, target, unix.RENAME_EXCL)
}
