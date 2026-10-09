package storage

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestServiceLeaseReleasesAfterAbruptProcessExit(t *testing.T) {
	root := t.TempDir()
	database := filepath.Join(root, "drive.db")
	objects := filepath.Join(root, "objects")
	child := exec.Command(os.Args[0], "-test.run=^TestServiceLeaseHelperProcess$")
	child.Env = append(os.Environ(), "XDRIVE_SERVICE_LOCK_HELPER="+root)
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "READY\n" {
		t.Fatal("child did not own locks", line, err)
	}
	if lease, err := AcquireServiceLease(database, objects); !errors.Is(err, ErrServiceInUse) {
		if lease != nil {
			lease.Close()
		}
		t.Fatal("second process entered", err)
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	lease, err := AcquireServiceLease(database, objects)
	if err != nil {
		t.Fatal("dead process stranded lock", err)
	}
	defer lease.Close()
	// Lock file existence never means an owner remains alive.
	for _, path := range []string{database + ".xdrive.lock", filepath.Join(objects, ".service.lock")} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("lock inode or permissions", err)
		}
	}
	backup, err := AcquireBackupLease(t.Context(), objects)
	if err != nil {
		t.Fatal("service ownership must permit online backup", err)
	}
	backup.Close()
}

func TestServiceLeaseHelperProcess(t *testing.T) {
	root := os.Getenv("XDRIVE_SERVICE_LOCK_HELPER")
	if root == "" {
		return
	}
	lease, err := AcquireServiceLease(filepath.Join(root, "drive.db"), filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	_, _ = fmt.Fprintln(os.Stdout, "READY")
	_, _ = os.Stdin.Read(make([]byte, 1))
}

func TestServiceLeaseRejectsSymlinkAndReleasesPartialAcquisition(t *testing.T) {
	root := t.TempDir()
	database := filepath.Join(root, "drive.db")
	objects := filepath.Join(root, "objects")
	if err := os.MkdirAll(objects, 0700); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(root, "victim")
	if err := os.WriteFile(victim, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(objects, ".service.lock")
	if err := os.Symlink(victim, lock); err != nil {
		t.Fatal(err)
	}
	if lease, err := AcquireServiceLease(database, objects); err == nil {
		lease.Close()
		t.Fatal("followed lock symlink")
	}
	if content, err := os.ReadFile(victim); err != nil || string(content) != "original" {
		t.Fatal("changed target", err)
	}
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}
	lease, err := AcquireServiceLease(database, objects)
	if err != nil {
		t.Fatal("partial database lock was not released", err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
}
