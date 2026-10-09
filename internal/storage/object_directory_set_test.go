package storage

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDirectorySetBorrowedViewsShareOnlyOwnedDescriptors(t *testing.T) {
	root := t.TempDir()
	set, err := OpenObjectDirectorySet(root)
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	a, err := set.Directory("aa-first-candidate")
	if err != nil {
		t.Fatal(err)
	}
	b, err := set.Directory("aa-second-candidate")
	if err != nil {
		t.Fatal(err)
	}
	c, err := set.Directory("bb-third-candidate")
	if err != nil {
		t.Fatal(err)
	}
	if a.root != b.root || a.root != c.root || a.bucket != b.bucket || a.bucket == c.bucket || len(set.buckets) != 2 {
		t.Fatal("batch does not share one root and one FD per bucket")
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	if err := a.Validate(); !errors.Is(err, os.ErrClosed) {
		t.Fatal("closed view remains usable")
	}
	file, name, err := b.CreateTemporary()
	if err != nil {
		t.Fatalf("closing one view closed sibling: %v", err)
	}
	file.Write([]byte("owned bytes"))
	file.Close()
	published := false
	if err := b.PublishTemporaryTracked(name, &published); err != nil || !published {
		t.Fatal(err)
	}
	b.RemoveTemporary(name)
	if err := b.Sync(); err != nil {
		t.Fatal(err)
	}
	if err := set.Close(); err != nil {
		t.Fatal(err)
	}
	if err := set.Close(); err != nil {
		t.Fatal(err)
	}
	if err := b.Validate(); !errors.Is(err, os.ErrClosed) {
		t.Fatal("closed set did not invalidate view")
	}
	if _, _, err := c.CreateTemporary(); !errors.Is(err, os.ErrClosed) {
		t.Fatal("closed set accepted create")
	}
	if _, err := set.Directory("cc-after-close-object"); !errors.Is(err, os.ErrClosed) {
		t.Fatal("closed set accepted another view")
	}
	if got, err := os.ReadFile(filepath.Join(root, "aa", "aa-second-candidate")); err != nil || string(got) != "owned bytes" {
		t.Fatal("closing set modified committed bytes")
	}
}
func TestDirectorySetCachedBucketReplacementKeepsOriginalCleanup(t *testing.T) {
	root := t.TempDir()
	set, err := OpenObjectDirectorySet(root)
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	id := "aa-original-candidate"
	a, err := set.Directory(id)
	if err != nil {
		t.Fatal(err)
	}
	file, name, err := a.CreateTemporary()
	if err != nil {
		t.Fatal(err)
	}
	file.Write([]byte("original bytes"))
	file.Close()
	published := false
	if err := a.PublishTemporaryTracked(name, &published); err != nil {
		t.Fatal(err)
	}
	a.RemoveTemporary(name)
	original := filepath.Join(root, "original-aa")
	if err := os.Rename(filepath.Join(root, "aa"), original); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, id)
	os.WriteFile(victim, []byte("unrelated bytes"), 0600)
	if err := os.Symlink(outside, filepath.Join(root, "aa")); err != nil {
		t.Fatal(err)
	}
	if _, err := set.Directory("aa-later-candidate"); !errors.Is(err, ErrObjectDirectoryChanged) {
		t.Fatalf("cached bucket replacement admitted: %v", err)
	}
	if err := a.RemoveObject(); err != nil {
		t.Fatal(err)
	}
	if err := a.Sync(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(original, id)); !os.IsNotExist(err) {
		t.Fatal("original rollback failed")
	}
	if got, err := os.ReadFile(victim); err != nil || string(got) != "unrelated bytes" {
		t.Fatal("rollback followed redirected bucket")
	}
}
func TestDirectorySetRejectsLinkedRootsBucketsAndInvalidIDs(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "root-link")
	os.Symlink(outside, link)
	if set, err := OpenObjectDirectorySet(link); err == nil {
		set.Close()
		t.Fatal("linked root admitted")
	}
	set, err := OpenObjectDirectorySet(root)
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	os.Symlink(outside, filepath.Join(root, "zz"))
	if _, err := set.Directory("zz-linked-candidate"); err == nil {
		t.Fatal("linked bucket admitted")
	}
	for _, id := range []string{"", "x", "../escape", "aa/slash"} {
		if _, err := set.Directory(id); err == nil {
			t.Fatal("invalid object ID admitted")
		}
	}
	if len(set.buckets) != 0 {
		t.Fatal("failed bucket became cached")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("set modified outside directory")
	}
}
