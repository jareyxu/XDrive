package storage

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestBackupLeasePreventsDeletionUntilReleased(t *testing.T) {
	storagePath := t.TempDir()
	backup, err := AcquireBackupLease(context.Background(), storagePath)
	if err != nil {
		t.Fatal(err)
	}
	deletion, err := TryDeletionLease(storagePath)
	if err != nil || deletion != nil {
		t.Fatalf("deletion lock acquired during backup: lease=%v error=%v", deletion, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if waiting, err := AcquireDeletionLease(ctx, storagePath); err != context.DeadlineExceeded || waiting != nil {
		t.Fatalf("blocking deletion lease did not respect context: lease=%v error=%v", waiting, err)
	}
	if waiting, err := AcquireInspectionLease(ctx, storagePath); err != context.DeadlineExceeded || waiting != nil {
		t.Fatalf("blocking inspection lease did not respect context: lease=%v error=%v", waiting, err)
	}
	if err := backup.Close(); err != nil {
		t.Fatal(err)
	}
	deletion, err = TryDeletionLease(storagePath)
	if err != nil || deletion == nil {
		t.Fatalf("deletion lock remained unavailable after backup: lease=%v error=%v", deletion, err)
	}
	if err := deletion.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestBackupLeaseSurvivesServerProcessRestartAndReleasesOnExit(t *testing.T) {
	storagePath := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestBackupLeaseHelperProcess$")
	command.Env = append(os.Environ(), "XDRIVE_LOCK_HELPER_PATH="+storagePath)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = command.Process.Kill(); _ = command.Wait() }()
	ready, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || ready != "READY\n" {
		t.Fatalf("backup helper did not acquire lock: %q %v", ready, err)
	}
	deletion, err := TryDeletionLease(storagePath)
	if err != nil || deletion != nil {
		t.Fatalf("new process bypassed active backup lease: lease=%v error=%v", deletion, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if waiting, err := AcquireDeletionLease(ctx, storagePath); err != context.DeadlineExceeded || waiting != nil {
		t.Fatalf("restarted server would not respect active lock: lease=%v error=%v", waiting, err)
	}
	_ = stdin.Close()
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	deletion, err = TryDeletionLease(storagePath)
	if err != nil || deletion == nil {
		t.Fatalf("lock remained held after backup process exit: lease=%v error=%v", deletion, err)
	}
	_ = deletion.Close()
}

func TestBackupLeaseHelperProcess(t *testing.T) {
	path := os.Getenv("XDRIVE_LOCK_HELPER_PATH")
	if path == "" {
		return
	}
	lease, err := AcquireBackupLease(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	_, _ = fmt.Fprintln(os.Stdout, "READY")
	_, _ = os.Stdin.Read(make([]byte, 1))
}

func TestBackupCoordinationRejectsSymlinkForEveryLeaseKind(t *testing.T) {
	for _, kind := range []string{"backup", "deletion", "inspection", "try-deletion"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			target := root + "/target"
			content := []byte("unrelated-private-file")
			if err := os.WriteFile(target, content, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, root+"/.backup.lock"); err != nil {
				t.Fatal(err)
			}
			var lease *BackupLease
			var err error
			switch kind {
			case "backup":
				lease, err = AcquireBackupLease(context.Background(), root)
			case "deletion":
				lease, err = AcquireDeletionLease(context.Background(), root)
			case "inspection":
				lease, err = AcquireInspectionLease(context.Background(), root)
			default:
				lease, err = TryDeletionLease(root)
			}
			if lease != nil {
				_ = lease.Close()
			}
			if err == nil || lease != nil {
				t.Fatal("followed symbolic backup coordination lock")
			}
			got, readErr := os.ReadFile(target)
			if readErr != nil || string(got) != string(content) {
				t.Fatalf("unrelated target changed: %v", readErr)
			}
		})
	}
}

func TestInspectionLeaseDoesNotCreateLockAndSupportsReadOnlyDirectory(t *testing.T) {
	root := t.TempDir()
	lockPath := filepath.Join(root, ".backup.lock")
	if lease, err := AcquireInspectionLease(context.Background(), root); err == nil || lease != nil {
		if lease != nil {
			_ = lease.Close()
		}
		t.Fatalf("inspection unexpectedly succeeded without a pre-existing lock: %v", err)
	}
	if _, err := os.Lstat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("failed inspection created a lock file: %v", err)
	}

	writer, err := AcquireBackupLease(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0500); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(root, 0700) }()
	inspection, err := AcquireInspectionLease(context.Background(), root)
	if err != nil {
		t.Fatalf("inspection could not use an existing lock in a read-only directory: %v", err)
	}
	if err := inspection.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestStorageRootAncestorsRejectSymbolicLinks(t *testing.T) {
	parent := t.TempDir()
	objects := filepath.Join(parent, "real", "objects")
	if err := os.MkdirAll(objects, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(parent, "root-link")
	if err := os.Symlink(filepath.Join(parent, "real"), alias); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(alias, "objects")
	if lease, err := AcquireBackupLease(context.Background(), root); err == nil || !(errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR)) || lease != nil {
		if lease != nil {
			_ = lease.Close()
		}
		t.Fatalf("backup lock followed a configured-root ancestor link: %v", err)
	}
	if directory, err := OpenObjectDirectory(root, "abcdefghijklmnopqrstuvwx", true); err == nil || !(errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR)) || directory != nil {
		if directory != nil {
			_ = directory.Close()
		}
		t.Fatalf("object storage followed a configured-root ancestor link: %v", err)
	}
	if _, err := os.Stat(filepath.Join(objects, "ab")); !os.IsNotExist(err) {
		t.Fatalf("rejected object open mutated the link target: %v", err)
	}
}

func TestBackupLeaseRetainsTheLockedDirectoryAfterPathRename(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "backup")
	moved := filepath.Join(parent, "backup-original")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	lease, err := AcquireBackupLease(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	marker, err := unix.Openat(int(lease.Directory().Fd()), "anchored-marker", unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Close(marker); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(moved, "anchored-marker")); err != nil {
		t.Fatalf("lease root no longer addresses the locked directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "anchored-marker")); !os.IsNotExist(err) {
		t.Fatalf("lease operation followed the replaced pathname: %v", err)
	}
}
