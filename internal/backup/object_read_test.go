package backup

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestBackupRejectsLinkedSourceShard(t *testing.T) {
	settings, destination, id, _ := backupFixture(t)
	shard := filepath.Dir(objectPath(settings.StoragePath, id))
	moved := shard + "-original"
	if err := os.Rename(shard, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moved, shard); err != nil {
		t.Fatal(err)
	}
	if err := Create(context.Background(), settings, destination, false); err == nil {
		t.Fatal("backup accepted linked source shard")
	}
	if current, err := readCurrent(destination); err != nil || current != "" {
		t.Fatalf("failed backup published CURRENT: %q %v", current, err)
	}
}

func TestBackupVerifyAndRestoreRejectLinkedObjectShard(t *testing.T) {
	settings, destination, id, content := backupFixture(t)
	if err := Create(context.Background(), settings, destination, false); err != nil {
		t.Fatal(err)
	}
	shard := filepath.Dir(objectPath(filepath.Join(destination, "objects"), id))
	moved := shard + "-original"
	if err := os.Rename(shard, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moved, shard); err != nil {
		t.Fatal(err)
	}
	if err := Verify(context.Background(), destination); err == nil {
		t.Error("verification accepted linked object shard")
	}
	target := settings
	root := filepath.Join(t.TempDir(), "restored")
	target.DatabasePath = filepath.Join(root, "drive.db")
	target.StoragePath = filepath.Join(root, "objects")
	target.SecretPath = filepath.Join(root, "server.secret")
	if err := Restore(context.Background(), target, destination); err == nil {
		t.Error("restore accepted linked object shard")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Errorf("restore activated target: %v", err)
	}
	actual, err := os.ReadFile(filepath.Join(moved, id))
	if err != nil || !bytes.Equal(actual, content) {
		t.Fatalf("source changed: %v", err)
	}
}
