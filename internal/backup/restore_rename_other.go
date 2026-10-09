//go:build !linux && !darwin

package backup

import "errors"

func renameRestoreExclusive(parent int, stage, target string) error {
	return errors.New("exclusive restore activation unsupported on this platform")
}
