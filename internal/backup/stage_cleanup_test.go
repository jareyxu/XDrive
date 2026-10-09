package backup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInterruptedStageCleanupWindowsAndUnknownContent(t *testing.T) {
	root := t.TempDir()
	snapshots := filepath.Join(root, "snapshots")
	if err := os.Mkdir(snapshots, 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 300; i++ {
		stage := filepath.Join(snapshots, fmt.Sprintf(".staging-%032d", i))
		if err := os.Mkdir(stage, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(stage, snapshotName), []byte("partial"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	unknown := filepath.Join(snapshots, ".staging-"+strings.Repeat("u", 32))
	if err := os.Mkdir(unknown, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unknown, "preserve"), []byte("unknown"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := removeInterruptedWork(root); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(snapshots)
	if err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(unknown) {
		t.Fatalf("unexpected cleanup: %v %v", entries, err)
	}
	data, err := os.ReadFile(filepath.Join(unknown, "preserve"))
	if err != nil || string(data) != "unknown" {
		t.Fatalf("unknown data changed: %v", err)
	}
}

func TestInterruptedCleanupRejectsLinkedSnapshotRoot(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	stage := filepath.Join(outside, ".staging-"+strings.Repeat("a", 32))
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(stage, snapshotName)
	if err := os.WriteFile(victim, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "snapshots")); err != nil {
		t.Fatal(err)
	}
	if err := removeInterruptedWork(root); err == nil {
		t.Error("linked snapshots root accepted")
	}
	data, err := os.ReadFile(victim)
	if err != nil || string(data) != "preserve" {
		t.Fatalf("outside staging deleted: %v", err)
	}
}
