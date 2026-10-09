package backup

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestInspectGenerationRejectsSQLiteSidecarsAndUnknownEntries(t *testing.T) {
	for _, extra := range []string{snapshotName + "-wal", snapshotName + "-shm", "UNEXPECTED"} {
		t.Run(extra, func(t *testing.T) {
			settings, destination, _, _ := backupFixture(t)
			if err := Create(context.Background(), settings, destination, false); err != nil {
				t.Fatal(err)
			}
			generation, err := readCurrent(destination)
			if err != nil {
				t.Fatal(err)
			}
			stage := filepath.Join(destination, "snapshots", generation)
			if err := os.WriteFile(filepath.Join(stage, extra), []byte("untrusted sidecar"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := Verify(context.Background(), destination); err == nil {
				t.Fatal("generation with an extra entry was accepted")
			}
			if _, _, _, err := inspectGeneration(context.Background(), destination, generation, false); err == nil {
				t.Fatal("generation inspection accepted sidecar")
			}
		})
	}
}

func TestInspectGenerationAcceptsExactPublishedFileSet(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, false); err != nil {
		t.Fatal(err)
	}
	generation, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := inspectGeneration(context.Background(), destination, generation, true); err != nil {
		t.Fatal(err)
	}
}
