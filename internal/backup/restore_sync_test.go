package backup

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreSyncRejectsOriginalTreeLinkAfterParentReplacement(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "parent")
	stage := filepath.Join(parent, "stage")
	if err := os.MkdirAll(stage, 0700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, "victim")
	if err := os.WriteFile(victim, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(stage, "unexpected")); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := os.Rename(parent, parent+"-original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(outside, "stage"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, parent); err != nil {
		t.Fatal(err)
	}
	if err := syncRestoreTree(context.Background(), root); err == nil {
		t.Fatal("synced replacement instead of rejecting original tree link")
	}
	bytes, err := os.ReadFile(victim)
	if err != nil || string(bytes) != "preserve" {
		t.Fatalf("outside victim changed: %q %v", bytes, err)
	}
}

func TestRestoreSyncHonorsCancellationBeforeReadingTree(t *testing.T) {
	stage := t.TempDir()
	if err := os.Symlink("missing", filepath.Join(stage, "unrelated")); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := syncRestoreTree(ctx, root); err != context.Canceled {
		t.Fatalf("cancelled sync: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(stage, "unrelated")); err != nil {
		t.Fatal(err)
	}
}

// Cancel the real context at a deterministic traversal checkpoint, after more
// than one 128-entry batch. No production fault hook is involved.
type cancelDuringRestoreSync struct {
	context.Context
	cancel context.CancelFunc
	checks int
}

func (c *cancelDuringRestoreSync) Err() error {
	c.checks++
	if c.checks == 170 {
		c.cancel()
	}
	return c.Context.Err()
}

func TestRestoreSyncCancelsAfterMultipleBatchesWithoutChangingFiles(t *testing.T) {
	stage := t.TempDir()
	for i := 0; i < 300; i++ {
		if err := os.WriteFile(filepath.Join(stage, fmt.Sprintf("file-%03d", i)), []byte(fmt.Sprintf("owned-%03d", i)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(stage, "nested", "child"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "nested", "child", "file"), []byte("nested-owned"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	probe := &cancelDuringRestoreSync{Context: ctx, cancel: cancel}
	if err := syncRestoreTree(probe, root); err != context.Canceled {
		t.Fatalf("mid-traversal sync: %v", err)
	}
	if probe.checks != 170 {
		t.Fatalf("did not stop at cancellation checkpoint: %d", probe.checks)
	}
	if err := syncRestoreTree(context.Background(), root); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 300; i++ {
		bytes, err := os.ReadFile(filepath.Join(stage, fmt.Sprintf("file-%03d", i)))
		if err != nil || string(bytes) != fmt.Sprintf("owned-%03d", i) {
			t.Fatalf("file %d changed: %q %v", i, bytes, err)
		}
	}
	bytes, err := os.ReadFile(filepath.Join(stage, "nested", "child", "file"))
	if err != nil || string(bytes) != "nested-owned" {
		t.Fatalf("nested bytes changed: %q %v", bytes, err)
	}
}
