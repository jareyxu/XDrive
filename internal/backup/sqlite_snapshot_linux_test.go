//go:build linux

package backup

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
	"xdrive/internal/fssecure"
)

func TestSQLiteSnapshotStaysAnchoredWhenVisibleStagePathIsReplaced(t *testing.T) {
	ctx := context.Background()
	settings, _, _, _ := backupFixture(t)
	parentPath := t.TempDir()
	stagePath := filepath.Join(parentPath, ".staging-path-swap")
	if err := os.Mkdir(stagePath, 0o700); err != nil {
		t.Fatal(err)
	}
	parent, err := fssecure.OpenDirectory(parentPath)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	stage, err := fssecure.OpenDirectory(stagePath)
	if err != nil {
		t.Fatal(err)
	}
	defer stage.Close()

	outside := t.TempDir()
	victim := filepath.Join(outside, snapshotName)
	victimContents := []byte("external backup target must remain untouched")
	if err := os.WriteFile(victim, victimContents, 0o600); err != nil {
		t.Fatal(err)
	}
	movedStage := filepath.Join(parentPath, ".staging-original")
	anchoredPath, err := descriptorPath(stage)
	if err != nil {
		t.Fatal(err)
	}
	expectedPath := filepath.Join(anchoredPath, snapshotName)
	swapped := false
	pathSwap := func(path string) error {
		if path != expectedPath || swapped {
			return nil
		}
		if err := os.Rename(stagePath, movedStage); err != nil {
			return err
		}
		if err := os.Symlink(outside, stagePath); err != nil {
			return err
		}
		swapped = true
		return nil
	}

	if err := snapshotSQLiteDatabase(ctx, settings.DatabasePath, stage, stagePath, snapshotName, pathSwap); err != nil {
		t.Fatal(err)
	}
	if !swapped {
		t.Fatal("test did not replace the stage pathname after SQLite resolved it")
	}
	gotVictim, err := os.ReadFile(victim)
	if err != nil || !bytes.Equal(gotVictim, victimContents) {
		t.Fatalf("SQLite modified redirected target: %q, %v", gotVictim, err)
	}
	var snapshotInfo unix.Stat_t
	if err := unix.Fstatat(int(stage.Fd()), snapshotName, &snapshotInfo, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		t.Fatalf("snapshot was not created in the held stage directory: %v", err)
	}
	if snapshotInfo.Mode&unix.S_IFMT != unix.S_IFREG {
		t.Fatalf("anchored snapshot is not regular: mode=%#o", snapshotInfo.Mode)
	}
	if _, _, err := readSnapshotObjects(ctx, filepath.Join(movedStage, snapshotName)); err != nil {
		t.Fatalf("descriptor-anchored snapshot is not a valid database: %v", err)
	}
}

func TestCreateDoesNotPublishAfterStagePathChangesDuringSQLiteOpen(t *testing.T) {
	ctx := context.Background()
	settings, destination, _, _ := backupFixture(t)
	outside := t.TempDir()
	victim := filepath.Join(outside, snapshotName)
	victimContents := []byte("must not receive a SQLite snapshot")
	if err := os.WriteFile(victim, victimContents, 0o600); err != nil {
		t.Fatal(err)
	}
	snapshots := filepath.Join(destination, "snapshots")
	var stagePath, movedStage string
	replaced := false
	err := createWithHooks(ctx, settings, destination, false, createHooks{
		afterPathname: func(_ string) error {
			if replaced {
				return nil
			}
			entries, err := os.ReadDir(snapshots)
			if err != nil {
				return err
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".staging-") {
					stagePath = filepath.Join(snapshots, entry.Name())
					break
				}
			}
			if stagePath == "" {
				return errors.New("staging directory not found during SQLite path resolution")
			}
			movedStage = stagePath + ".original"
			if err := os.Rename(stagePath, movedStage); err != nil {
				return err
			}
			if err := os.Symlink(outside, stagePath); err != nil {
				return err
			}
			replaced = true
			return nil
		},
	})
	defer func() {
		if stagePath != "" {
			_ = os.Remove(stagePath)
		}
		if movedStage != "" {
			_ = os.RemoveAll(movedStage)
		}
	}()
	if err == nil || !replaced {
		t.Fatalf("stage replacement did not abort backup publication: replaced=%v err=%v", replaced, err)
	}
	current, err := readCurrent(destination)
	if err != nil || current != "" {
		t.Fatalf("failed backup published CURRENT=%q: %v", current, err)
	}
	gotVictim, err := os.ReadFile(victim)
	if err != nil || !bytes.Equal(gotVictim, victimContents) {
		t.Fatalf("SQLite modified redirected target: %q, %v", gotVictim, err)
	}
}
