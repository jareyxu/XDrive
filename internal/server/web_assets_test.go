package server

import (
	"bytes"
	"io/fs"
	"os"
	"testing"
)

// Compare the actual build directory with the compiled binary's filesystem.
// In particular, generated _virtual lazy modules must not silently disappear.
func TestEveryBuildAssetIsEmbedded(t *testing.T) {
	disk := os.DirFS(".")
	count := 0
	err := fs.WalkDir(disk, "static", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		actual, err := fs.ReadFile(disk, name)
		if err != nil {
			return err
		}
		embedded, err := embeddedWeb.ReadFile(name)
		if err != nil {
			t.Errorf("build asset missing from binary: %s: %v", name, err)
		} else if !bytes.Equal(actual, embedded) {
			t.Errorf("build asset differs from binary: %s", name)
		}
		count++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatal("no static files available to verify")
	}
}
