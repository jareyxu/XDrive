package backup

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"xdrive/internal/db"
)

func TestRestorePrivateVFSRetainsSnapshotAcrossParentAndLeafReplacement(t *testing.T) {
	ctx := context.Background()
	settings, destination, _, _ := backupFixture(t)
	if err := Create(ctx, settings, destination, false); err != nil {
		t.Fatal(err)
	}
	generation, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(destination, "snapshots", generation, snapshotName)
	digest, err := hashFile(source)
	if err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(t.TempDir(), "parent")
	stage := filepath.Join(parent, "stage")
	if err := os.MkdirAll(stage, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := copyRestoredSnapshot(ctx, source, root, "snapshot.sqlite", digest); err != nil {
		t.Fatal(err)
	}
	database, cleanup, err := db.OpenPrivateStaged(ctx, root, "snapshot.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	original := parent + "-original"
	if err := os.Rename(parent, original); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, parent); err != nil {
		t.Fatal(err)
	}
	leaf := filepath.Join(original, "stage", "snapshot.sqlite")
	retained := filepath.Join(original, "stage", "retained.sqlite")
	if err := os.Rename(leaf, retained); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(outside, "victim.sqlite")
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(victim, before, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, leaf); err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, "UPDATE server_state SET last_backup_at=123 WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	var actual int64
	if err := database.QueryRowContext(ctx, "SELECT last_backup_at FROM server_state WHERE id=1").Scan(&actual); err != nil || actual != 123 {
		t.Fatalf("retained update %d: %v", actual, err)
	}
	var integrity string
	if err := database.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("integrity %s: %v", integrity, err)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(victim)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("external leaf victim changed")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 1 {
		t.Fatalf("external side files: %v %v", entries, err)
	}
	restored, err := db.OpenReadOnly(ctx, retained)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err := restored.QueryRowContext(ctx, "SELECT last_backup_at FROM server_state WHERE id=1").Scan(&actual); err != nil || actual != 123 {
		t.Fatalf("persisted update %d: %v", actual, err)
	}
	entries, err = os.ReadDir(filepath.Join(original, "stage"))
	if err != nil || len(entries) != 2 {
		t.Fatalf("private journal not cleaned: %v %v", entries, err)
	}
}

func TestRestoreDatabaseRejectsSameBytesDifferentInodeBeforeSQL(t *testing.T) {
	ctx := context.Background()
	settings, destination, _, _ := backupFixture(t)
	if err := Create(ctx, settings, destination, false); err != nil {
		t.Fatal(err)
	}
	generation, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(destination, "snapshots", generation, snapshotName)
	digest, err := hashFile(source)
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	identity, err := copyRestoredSnapshotWithIdentity(ctx, source, root, "snapshot.sqlite", digest)
	if err != nil {
		t.Fatal(err)
	}
	defer identity.guard.Close()
	if err := root.Rename("snapshot.sqlite", "retained.sqlite"); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(t.TempDir(), "victim.sqlite")
	if err := os.WriteFile(victim, before, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(victim, filepath.Join(root.Name(), "snapshot.sqlite")); err != nil {
		t.Fatal(err)
	}
	if err := verifyRestoredDatabaseIdentity(ctx, root, "snapshot.sqlite", identity.info); err == nil {
		t.Fatal("different prepared inode accepted")
	}
	if err := prepareRestoredDatabase(ctx, root, "snapshot.sqlite", identity.info, 123, settings, true); err == nil {
		t.Fatal("different inode accepted")
	}
	after, err := os.ReadFile(victim)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("same-byte external victim modified")
	}
	retained, err := root.ReadFile("retained.sqlite")
	if err != nil || !bytes.Equal(before, retained) {
		t.Fatal("retained snapshot modified")
	}
	file, err := root.Open(".")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	entries, err := file.ReadDir(-1)
	if err != nil || len(entries) != 2 {
		t.Fatalf("SQL journal created before refusal: %v %v", entries, err)
	}
}
