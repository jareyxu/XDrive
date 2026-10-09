package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFailedBackupCleansOnlyOwnedStageAfterParentReplacement(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	outside := t.TempDir()
	snapshots := filepath.Join(destination, "snapshots")
	moved := snapshots + "-owned"
	var stageName string
	err := create(context.Background(), settings, destination, false, func() error {
		entries, e := os.ReadDir(snapshots)
		if e != nil {
			t.Fatal(e)
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".staging-") {
				stageName = entry.Name()
			}
		}
		if stageName == "" {
			t.Fatal("missing actual stage")
		}
		if e := os.Rename(snapshots, moved); e != nil {
			t.Fatal(e)
		}
		if e := os.Symlink(outside, snapshots); e != nil {
			t.Fatal(e)
		}
		if e := os.Mkdir(filepath.Join(outside, stageName), 0700); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(filepath.Join(outside, stageName, snapshotName), []byte("preserve"), 0600); e != nil {
			t.Fatal(e)
		}
		return errors.New("injected backup failure after snapshot")
	})
	if err == nil {
		t.Fatal("failed backup succeeded")
	}
	data, e := os.ReadFile(filepath.Join(outside, stageName, snapshotName))
	if e != nil || string(data) != "preserve" {
		t.Fatalf("redirected victim deleted: %v", e)
	}
	if _, e := os.Stat(filepath.Join(moved, stageName)); !os.IsNotExist(e) {
		t.Fatalf("owned stage remains: %v", e)
	}
	if _, e := os.Stat(filepath.Join(destination, "CURRENT")); !os.IsNotExist(e) {
		t.Fatalf("failed backup published CURRENT: %v", e)
	}
}

func TestBackupStageReplacementDoesNotWriteExternalManifest(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	outside := t.TempDir()
	snapshots := filepath.Join(destination, "snapshots")
	moved := snapshots + "-owned"
	var stageName string
	err := create(context.Background(), settings, destination, false, func() error {
		entries, e := os.ReadDir(snapshots)
		if e != nil {
			t.Fatal(e)
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".staging-") {
				stageName = entry.Name()
			}
		}
		if stageName == "" {
			t.Fatal("missing actual stage")
		}
		if e := os.Rename(snapshots, moved); e != nil {
			t.Fatal(e)
		}
		if e := os.Symlink(outside, snapshots); e != nil {
			t.Fatal(e)
		}
		if e := os.Mkdir(filepath.Join(outside, stageName), 0700); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(filepath.Join(outside, stageName, snapshotName), []byte("preserve"), 0600); e != nil {
			t.Fatal(e)
		}
		return nil
	})
	if err == nil {
		t.Fatal("replaced stage accepted")
	}
	data, e := os.ReadFile(filepath.Join(outside, stageName, snapshotName))
	if e != nil || string(data) != "preserve" {
		t.Fatalf("redirected victim deleted: %v", e)
	}
	entries, e := os.ReadDir(filepath.Join(outside, stageName))
	if e != nil || len(entries) != 1 || entries[0].Name() != snapshotName {
		t.Fatalf("external stage received backup writes: %v %v", entries, e)
	}

	if _, e := os.Stat(filepath.Join(moved, stageName)); !os.IsNotExist(e) {
		t.Fatalf("owned stage remains: %v", e)
	}
	if _, e := os.Stat(filepath.Join(destination, "CURRENT")); !os.IsNotExist(e) {
		t.Fatalf("failed backup published CURRENT: %v", e)
	}
}

func TestBackupGenerationReplacementDoesNotPublishCurrent(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	snapshots := filepath.Join(destination, "snapshots")
	moved := snapshots + "-owned"
	outside := t.TempDir()
	changed := false
	err := createWithHooks(context.Background(), settings, destination, false, createHooks{afterStep: func(step string) {
		if step != "generation-renamed" {
			return
		}
		changed = true
		if e := os.Rename(snapshots, moved); e != nil {
			t.Fatal(e)
		}
		if e := os.Symlink(outside, snapshots); e != nil {
			t.Fatal(e)
		}
	}})
	if !changed || err == nil {
		t.Fatalf("inaccessible generation accepted: changed=%v err=%v", changed, err)
	}
	if _, e := os.Stat(filepath.Join(destination, "CURRENT")); !os.IsNotExist(e) {
		t.Fatalf("unreadable generation published: %v", e)
	}
	entries, e := os.ReadDir(outside)
	if e != nil || len(entries) != 0 {
		t.Fatalf("replacement destination changed: %v %v", entries, e)
	}
	entries, e = os.ReadDir(moved)
	if e != nil || len(entries) != 1 {
		t.Fatalf("original complete generation removed: %v %v", entries, e)
	}
	for _, name := range []string{snapshotName, objectsName, backupName} {
		if _, e := os.Stat(filepath.Join(moved, entries[0].Name(), name)); e != nil {
			t.Fatalf("completed generation file lost: %s %v", name, e)
		}
	}
}
