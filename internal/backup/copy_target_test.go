package backup

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"xdrive/internal/fssecure"
	"xdrive/internal/storage"
)

func TestProbeCopyDestinationLinkedShard(t *testing.T) {
	settings, destination, id, content := backupFixture(t)
	objects := filepath.Join(destination, "objects")
	if err := os.MkdirAll(objects, 0700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(objects, id[:2])); err != nil {
		t.Fatal(err)
	}
	err := Create(context.Background(), settings, destination, false)
	observed, readErr := os.ReadFile(filepath.Join(outside, id))
	if err == nil && readErr == nil && bytes.Equal(observed, content) {
		t.Fatal("copy destination linked shard accepted; outside file written; CURRENT published")
	}
	if err == nil {
		t.Fatal("copy destination linked shard accepted")
	}
	entries, e := os.ReadDir(outside)
	if e != nil || len(entries) != 0 {
		t.Fatalf("outside directory modified: %v %v", entries, e)
	}
	current, e := readCurrent(destination)
	if e != nil || current != "" {
		t.Fatalf("failed backup published CURRENT: %q %v", current, e)
	}
}

func TestCopyReplacementCleansOnlyOriginalDirectory(t *testing.T) {
	for _, point := range []string{"partial", "temp-synced", "renamed"} {
		t.Run(point, func(t *testing.T) {
			settings, destination, id, _ := backupFixture(t)
			content := bytes.Repeat([]byte{0x5b}, 256*1024)
			source := objectPath(settings.StoragePath, id)
			if err := os.WriteFile(source, content, 0600); err != nil {
				t.Fatal(err)
			}
			target := objectPath(filepath.Join(destination, "objects"), id)
			shard := filepath.Dir(target)
			moved := shard + "-original"
			outside := t.TempDir()
			victim := []byte("preserve redirected victim")
			replaced := false
			name := ""
			err := copyVerifiedObjectWithHook(source, target, Object{ID: id, SizeBytes: int64(len(content)), SHA256: hexDigest(content)}, func(step string) {
				if replaced || step != point {
					return
				}
				entries, e := os.ReadDir(shard)
				if e != nil {
					t.Fatal(e)
				}
				for _, entry := range entries {
					if strings.HasPrefix(entry.Name(), ".copy-") {
						name = entry.Name()
					}
				}
				if step == "renamed" {
					name = id
				}
				if name == "" {
					t.Fatal("no owned copy file found")
				}
				if e := os.Rename(shard, moved); e != nil {
					t.Fatal(e)
				}
				if e := os.Symlink(outside, shard); e != nil {
					t.Fatal(e)
				}
				if e := os.WriteFile(filepath.Join(outside, name), victim, 0600); e != nil {
					t.Fatal(e)
				}
				replaced = true
			})
			if !replaced || err == nil {
				t.Fatalf("path replacement accepted: replaced=%v error=%v", replaced, err)
			}
			actual, e := os.ReadFile(filepath.Join(outside, name))
			if e != nil || !bytes.Equal(actual, victim) {
				t.Fatalf("redirected victim changed: %v", e)
			}
			entries, e := os.ReadDir(moved)
			if e != nil {
				t.Fatal(e)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".copy-") {
					t.Errorf("owned temporary remains: %s", entry.Name())
				}
			}
			if point != "renamed" {
				if _, e := os.Stat(filepath.Join(moved, id)); !os.IsNotExist(e) {
					t.Errorf("failed copy published object: %v", e)
				}
			}
		})
	}
}

func TestRootAnchoredCopyDoesNotFollowReplacedObjectsPath(t *testing.T) {
	settings, destination, id, _ := backupFixture(t)
	content := bytes.Repeat([]byte{0x5b}, 256*1024)
	source := objectPath(settings.StoragePath, id)
	if err := os.WriteFile(source, content, 0600); err != nil {
		t.Fatal(err)
	}
	objectsRoot := filepath.Join(destination, "objects")
	if err := os.Mkdir(objectsRoot, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := fssecure.OpenDirectory(objectsRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	moved := objectsRoot + "-owned"
	outside := t.TempDir()
	victim := []byte("keep redirected directory unchanged")
	if err := os.WriteFile(filepath.Join(outside, "victim"), victim, 0600); err != nil {
		t.Fatal(err)
	}
	replaced := false
	err = copyVerifiedObjectWithRoot(source, objectPath(objectsRoot, id), root, Object{ID: id, SizeBytes: int64(len(content)), SHA256: hexDigest(content)}, func(step string) {
		if replaced || step != "partial" {
			return
		}
		if err := os.Rename(objectsRoot, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, objectsRoot); err != nil {
			t.Fatal(err)
		}
		replaced = true
	})
	if !replaced || err == nil {
		t.Fatalf("path replacement was not rejected: replaced=%v err=%v", replaced, err)
	}
	got, err := os.ReadFile(filepath.Join(outside, "victim"))
	if err != nil || !bytes.Equal(got, victim) {
		t.Fatalf("redirected victim changed: %v", err)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 1 || entries[0].Name() != "victim" {
		t.Fatalf("copy escaped into replaced destination: %v %v", entries, err)
	}
	shardEntries, err := os.ReadDir(filepath.Join(moved, id[:2]))
	if err != nil || len(shardEntries) != 0 {
		t.Fatalf("failed anchored copy left a temp or object behind: %v %v", shardEntries, err)
	}
}

func TestBackupCopyReadsSourceFromTheLockedRootDescriptor(t *testing.T) {
	settings, destination, id, _ := backupFixture(t)
	original := bytes.Repeat([]byte{0x27}, 256*1024)
	replacement := bytes.Repeat([]byte{0x72}, len(original))
	sourcePath := objectPath(settings.StoragePath, id)
	if err := os.WriteFile(sourcePath, original, 0600); err != nil {
		t.Fatal(err)
	}
	lease, err := storage.AcquireBackupLease(context.Background(), settings.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	movedSource := settings.StoragePath + "-original"
	if err := os.Rename(settings.StoragePath, movedSource); err != nil {
		t.Fatal(err)
	}
	newBucket := filepath.Join(settings.StoragePath, id[:2])
	if err := os.MkdirAll(newBucket, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(newBucket, id), replacement, 0600); err != nil {
		t.Fatal(err)
	}
	objectsRoot := filepath.Join(destination, "objects")
	if err := os.Mkdir(objectsRoot, 0700); err != nil {
		t.Fatal(err)
	}
	targetRoot, err := fssecure.OpenDirectory(objectsRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer targetRoot.Close()
	targetPath := objectPath(objectsRoot, id)
	item := Object{ID: id, SizeBytes: int64(len(original)), SHA256: hexDigest(original)}
	if err := copyVerifiedObjectWithRoots(sourcePath, targetPath, lease.Directory(), targetRoot, item, nil); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(targetPath)
	if err != nil || !bytes.Equal(got, original) {
		t.Fatalf("copy did not use the locked source root: bytes=%d error=%v", len(got), err)
	}
}

func TestCopyRefusesLinkedFinalObject(t *testing.T) {
	settings, destination, id, content := backupFixture(t)
	target := objectPath(filepath.Join(destination, "objects"), id)
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(victim, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, target); err != nil {
		t.Fatal(err)
	}
	if err := copyVerifiedObject(objectPath(settings.StoragePath, id), target, Object{ID: id, SizeBytes: int64(len(content)), SHA256: hexDigest(content)}); err == nil {
		t.Fatal("linked final object replaced")
	}
	info, err := os.Lstat(target)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("final link changed: %v", err)
	}
	actual, err := os.ReadFile(victim)
	if err != nil || string(actual) != "unchanged" {
		t.Fatalf("victim changed: %v", err)
	}
}

func TestBackupLinkedObjectsRootPreservesInterruptedVictim(t *testing.T) {
	settings, destination, id, _ := backupFixture(t)
	outside := t.TempDir()
	shard := filepath.Join(outside, id[:2])
	if err := os.Mkdir(shard, 0700); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(shard, ".copy-interrupted")
	if err := os.WriteFile(victim, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(destination, "objects")); err != nil {
		t.Fatal(err)
	}
	if err := Create(context.Background(), settings, destination, false); err == nil {
		t.Fatal("linked object root accepted")
	}
	actual, err := os.ReadFile(victim)
	if err != nil || string(actual) != "keep" {
		t.Fatalf("interrupted cleanup changed outside victim: %v", err)
	}
}
