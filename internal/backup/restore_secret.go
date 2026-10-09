package backup

import (
	"os"
	"path/filepath"
)

func writeRestoredSecret(root *os.Root, name string, secret []byte) error {
	if err := root.MkdirAll(filepath.Dir(name), 0700); err != nil {
		return err
	}
	file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err := file.Write(secret); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
