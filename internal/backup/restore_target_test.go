package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"xdrive/internal/config"
)

func TestRestoreRefusesLinkedTargetParentWithoutWritingOutside(t *testing.T) {
	settings, source, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, source, true); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	alias := filepath.Join(t.TempDir(), "linked-parent")
	if err := os.Symlink(outside, alias); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(alias, "restored")
	target := config.Config{DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "server.secret")}
	if err := Restore(context.Background(), target, source); err == nil {
		t.Error("restore accepted linked target parent")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("restore wrote outside configured parent: %v %v", entries, err)
	}
}

func TestCancelledRestoreCleansOwnedStageAfterParentReplacement(t *testing.T) {
	settings, source, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, source, true); err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(t.TempDir(), "parent")
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	ctx := &replaceRestoreParentOnStage{Context: context.Background(), parent: parent, outside: outside, t: t}
	root := filepath.Join(parent, "data")
	target := config.Config{DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "server.secret")}
	if err := Restore(ctx, target, source); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled restore result: %v", err)
	}
	if !ctx.acted {
		t.Fatal("stage replacement did not execute")
	}
	data, err := os.ReadFile(filepath.Join(outside, ctx.stage, "victim"))
	if err != nil || string(data) != "preserve" {
		t.Fatalf("external stage deleted: %q %v", data, err)
	}
	entries, err := os.ReadDir(parent + "-owned")
	if err != nil || len(entries) != 0 {
		t.Fatalf("original staging remains: %v %v", entries, err)
	}
}

type replaceRestoreParentOnStage struct {
	context.Context
	parent, outside, stage string
	acted                  bool
	continueAfter          bool
	t                      *testing.T
}

func (c *replaceRestoreParentOnStage) Err() error {
	if c.acted {
		if c.continueAfter {
			return nil
		}
		return context.Canceled
	}
	entries, err := os.ReadDir(c.parent)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".xdrive-restore-") {
			c.stage = entry.Name()
			break
		}
	}
	if c.stage == "" {
		return nil
	}
	c.acted = true
	if err := os.Rename(c.parent, c.parent+"-owned"); err != nil {
		c.t.Fatal(err)
	}
	if err := os.Symlink(c.outside, c.parent); err != nil {
		c.t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(c.outside, c.stage), 0700); err != nil {
		c.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(c.outside, c.stage, "victim"), []byte("preserve"), 0600); err != nil {
		c.t.Fatal(err)
	}
	if c.continueAfter {
		return nil
	}
	return context.Canceled
}

func TestRestoreRefusesParentReplacementBeforePreparedWrites(t *testing.T) {
	settings, source, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, source, true); err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(t.TempDir(), "parent")
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	ctx := &replaceRestoreParentOnStage{Context: context.Background(), parent: parent, outside: outside, t: t, continueAfter: true}
	root := filepath.Join(parent, "data")
	target := config.Config{DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "server.secret")}
	if err := Restore(ctx, target, source); err == nil {
		t.Error("restore activated replacement parent data")
	}
	if !ctx.acted {
		t.Fatal("real stage replacement did not execute")
	}
	data, err := os.ReadFile(filepath.Join(outside, ctx.stage, "victim"))
	if err != nil || string(data) != "preserve" {
		t.Fatalf("external victim modified or activated: %q %v", data, err)
	}
	entries, err := os.ReadDir(filepath.Join(outside, ctx.stage))
	if err != nil || len(entries) != 1 || entries[0].Name() != "victim" {
		t.Fatalf("external prepared writes: %v %v", entries, err)
	}
	if _, err := os.Stat(filepath.Join(outside, "data")); !os.IsNotExist(err) {
		t.Fatalf("external target activated: %v", err)
	}
	entries, err = os.ReadDir(parent + "-owned")
	if err != nil || len(entries) != 0 {
		t.Fatalf("owned staging remains: %v %v", entries, err)
	}
}

func TestRestoreEmptyCheckHasBoundedAllocationsForLargeNonemptyTarget(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 3000; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("existing-%06d", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	allocations := testing.AllocsPerRun(3, func() {
		if err := requireEmptyDataRoot(root); err == nil {
			t.Fatal("nonempty restore target accepted")
		}
	})
	t.Logf("empty-target check allocations for3000entries: %.0f", allocations)
	if allocations > 64 {
		t.Fatalf("empty-target check allocates directory-wide state: %.0f", allocations)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 3000 {
		t.Fatalf("existing target modified: %d %v", len(entries), err)
	}
}
