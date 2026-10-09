package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestSnapshotKilledOwnerCopyIsReaped(t *testing.T) {
	if root := os.Getenv("XDRIVE_SNAPSHOT_KILL_ROOT"); root != "" {
		source := filepath.Join(root, "source.db")
		if err := os.WriteFile(source, make([]byte, 512*1024), 0600); err != nil {
			t.Fatal(err)
		}
		var ctx context.Context = context.Background()
		if os.Getenv("XDRIVE_SNAPSHOT_KILL_PHASE") == "partial" {
			ctx = &pauseSnapshotCopy{Context: ctx, root: root}
		}
		path, cleanup, err := prepareSnapshotRead(ctx, source, "")
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		data, _ := json.Marshal(path)
		if err := os.WriteFile(filepath.Join(root, "ready.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
		time.Sleep(30 * time.Second)
		t.Fatal("owner was not killed")
		return
	}
	for _, phase := range []string{"complete", "partial"} {
		t.Run(phase, func(t *testing.T) {
			root := t.TempDir()
			staging := filepath.Join(root, "staging")
			if err := os.Mkdir(staging, 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("TMPDIR", staging)
			command := exec.Command(os.Args[0], "-test.run=^TestSnapshotKilledOwnerCopyIsReaped$", "-test.count=1")
			command.Env = append(os.Environ(), "XDRIVE_SNAPSHOT_KILL_ROOT="+root, "XDRIVE_SNAPSHOT_KILL_PHASE="+phase)
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			waited := false
			defer func() {
				if !waited {
					_ = command.Process.Kill()
					_ = command.Wait()
				}
			}()
			var old string
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				if data, err := os.ReadFile(filepath.Join(root, "ready.json")); err == nil && json.Unmarshal(data, &old) == nil {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if old == "" {
				t.Fatal("owned child did not prepare a snapshot")
			}
			probe, releaseProbe, err := prepareSnapshotRead(context.Background(), filepath.Join(root, "source.db"), "")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(old); err != nil {
				releaseProbe()
				t.Fatalf("live other-process copy reaped: %v", err)
			}
			if _, err := os.Stat(probe); err != nil {
				releaseProbe()
				t.Fatal(err)
			}
			releaseProbe()
			if err := command.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err := command.Wait(); err == nil {
				t.Fatal("killed child returned success")
			}
			waited = true
			if info, err := os.Stat(old); err == nil && phase == "partial" && (info.Size() <= 0 || info.Size() > 128*1024) {
				t.Fatalf("not a partial interrupted copy: %d", info.Size())
			}
			if _, err := os.Stat(old); err != nil {
				t.Fatalf("no interrupted copy to recover: %v", err)
			}
			path, cleanup, err := prepareSnapshotRead(context.Background(), filepath.Join(root, "source.db"), "")
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup()
			if _, err := os.Stat(old); !os.IsNotExist(err) {
				t.Fatalf("killed owner copy remains: %v", err)
			}
			if _, err := os.Stat(path); err != nil {
				t.Fatal(err)
			}
		})
	}

}

func TestSnapshotReaperPreservesLiveCopies(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	source := filepath.Join(root, "source.db")
	if err := os.WriteFile(source, make([]byte, 512*1024), 0600); err != nil {
		t.Fatal(err)
	}
	first, closeFirst, err := prepareSnapshotRead(context.Background(), source, "")
	if err != nil {
		t.Fatal(err)
	}
	defer closeFirst()
	second, closeSecond, err := prepareSnapshotRead(context.Background(), source, "")
	if err != nil {
		t.Fatal(err)
	}
	defer closeSecond()
	if first == second {
		t.Fatal("copies share path")
	}
	if _, err := os.Stat(first); err != nil {
		t.Fatalf("active copy reaped: %v", err)
	}
}
func TestSnapshotReaperWindowsAndUnsafeCandidates(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	now := time.Now()
	for i := 0; i < 300; i++ {
		folder := filepath.Join(root, fmt.Sprintf(".xdrive-snapshot-read-%d", i))
		if err := os.Mkdir(folder, 0700); err != nil {
			t.Fatal(err)
		}
		lease, err := lockSnapshotFolder(folder)
		if err != nil {
			t.Fatal(err)
		}
		if err := lease.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(folder, snapshotName), []byte("orphan"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	fresh := filepath.Join(root, ".xdrive-snapshot-read-9001")
	old := filepath.Join(root, ".xdrive-snapshot-read-9002")
	for _, folder := range []string{fresh, old} {
		if err := os.Mkdir(folder, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(folder, snapshotName), []byte("legacy"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chtimes(old, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, snapshotName)
	if err := os.WriteFile(victim, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(root, ".xdrive-snapshot-read-9003")
	if err := os.Symlink(outside, linked); err != nil {
		t.Fatal(err)
	}
	unsafe := filepath.Join(root, ".xdrive-snapshot-read-9004")
	if err := os.Mkdir(unsafe, 0700); err != nil {
		t.Fatal(err)
	}
	lease, err := lockSnapshotFolder(unsafe)
	if err != nil {
		t.Fatal(err)
	}
	_ = lease.Close()
	if err := os.Symlink(victim, filepath.Join(unsafe, snapshotName)); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(root, ".xdrive-snapshot-read-9005")
	if err := os.Mkdir(unknown, 0700); err != nil {
		t.Fatal(err)
	}
	lease, err = lockSnapshotFolder(unknown)
	if err != nil {
		t.Fatal(err)
	}
	_ = lease.Close()
	if err := os.WriteFile(filepath.Join(unknown, "keep"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := reapSnapshotCopies(ctx, root, now); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 300; i++ {
		if _, err := os.Stat(filepath.Join(root, fmt.Sprintf(".xdrive-snapshot-read-%d", i))); !os.IsNotExist(err) {
			t.Fatalf("orphan %d remains: %v", i, err)
		}
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("stale legacy remains: %v", err)
	}
	for _, path := range []string{fresh, linked, unsafe, unknown} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("guarded candidate removed: %v", err)
		}
	}
	data, err := os.ReadFile(victim)
	if err != nil || string(data) != "keep" {
		t.Fatalf("outside victim changed: %v", err)
	}
}

func TestSnapshotReaperPreservesInaccessibleCandidate(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission boundary requires an unprivileged process")
	}
	root := t.TempDir()
	candidate := filepath.Join(root, ".xdrive-snapshot-read-9999")
	if err := os.Mkdir(candidate, 0700); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(candidate, snapshotName)
	if err := os.WriteFile(victim, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(candidate, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(candidate, 0700) })
	if err := reapSnapshotCopies(context.Background(), root, time.Now()); err != nil {
		t.Fatalf("unrelated inaccessible candidate blocks snapshot operations: %v", err)
	}
	if err := os.Chmod(candidate, 0700); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(victim)
	if err != nil || string(data) != "preserve" {
		t.Fatalf("candidate modified: %v", err)
	}
}

func TestSnapshotTrustedTemporaryRootAlias(t *testing.T) {
	root := t.TempDir()
	alias := root + "-alias"
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(alias) })
	t.Setenv("TMPDIR", alias)
	source := filepath.Join(root, "source.db")
	if err := os.WriteFile(source, []byte("snapshot"), 0600); err != nil {
		t.Fatal(err)
	}
	path, cleanup, err := prepareSnapshotRead(context.Background(), source, "")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	expected, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(filepath.Dir(path)) != expected {
		t.Fatalf("copy not in resolved temporary root: %s", path)
	}
}

type pauseSnapshotCopy struct {
	context.Context
	root   string
	paused bool
}

func (c *pauseSnapshotCopy) Err() error {
	if c.paused {
		return nil
	}
	entries, _ := os.ReadDir(filepath.Join(c.root, "staging"))
	for _, entry := range entries {
		path := filepath.Join(c.root, "staging", entry.Name(), snapshotName)
		info, err := os.Stat(path)
		if err == nil && info.Size() > 0 && info.Size() <= 128*1024 {
			c.paused = true
			data, _ := json.Marshal(path)
			if err := os.WriteFile(filepath.Join(c.root, "ready.json"), data, 0600); err != nil {
				return err
			}
			time.Sleep(30 * time.Second)
			return context.Canceled
		}
	}
	return nil
}
