package backup

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestBackupRestrictsSnapshotAndObjectDirectoriesBeforeReuse(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, false); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{destination, filepath.Join(destination, "snapshots"), filepath.Join(destination, "objects")} {
		if err := os.Chmod(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := Create(context.Background(), settings, destination, false); err != nil {
		t.Fatal(err)
	}

	for name, path := range map[string]string{
		"destination": destination,
		"snapshots":   filepath.Join(destination, "snapshots"),
		"objects":     filepath.Join(destination, "objects"),
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != 0o700 {
			t.Errorf("%s directory mode = %#o, want 0700", name, got)
		}
	}
	generation, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	stageInfo, err := os.Stat(filepath.Join(destination, "snapshots", generation))
	if err != nil {
		t.Fatal(err)
	}
	if got := stageInfo.Mode().Perm(); got != 0o700 {
		t.Fatalf("published generation directory mode = %#o, want 0700", got)
	}
}
