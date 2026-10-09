package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"golang.org/x/sys/unix"
)

func TestObjectOpenRegularAndInvalidIDs(t *testing.T) {
	root := t.TempDir()
	id := "abcdefghijklmnopqrstuvwx"
	bucket := filepath.Join(root, id[:2])
	if err := os.Mkdir(bucket, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(bucket, id)
	if err := os.WriteFile(path, []byte("ciphertext"), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := OpenObjectRead(root, id)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil || string(got) != "ciphertext" {
		t.Fatalf("read: %q %v", got, err)
	}
	for _, id := range []string{"", "a", "../escape", "ab/file", "ab\\file", "ab\x00file", "éabc"} {
		if file, err := OpenObjectRead(root, id); err == nil || file != nil {
			if file != nil {
				_ = file.Close()
			}
			t.Fatalf("accepted unsafe ID %q", id)
		}
	}
}

func TestObjectOpenRejectsSpecialFilesAndSymbolicRoot(t *testing.T) {
	for _, kind := range []string{"fifo", "directory", "dangling", "root-link"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			id := "abcdefghijklmnopqrstuvwx"
			bucket := filepath.Join(root, id[:2])
			if err := os.Mkdir(bucket, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(bucket, id)
			switch kind {
			case "fifo":
				if err := unix.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "dangling":
				if err := os.Symlink(filepath.Join(root, "missing"), path); err != nil {
					t.Fatal(err)
				}
			case "root-link":
				if err := os.WriteFile(path, []byte("ciphertext"), 0600); err != nil {
					t.Fatal(err)
				}
				alias := filepath.Join(t.TempDir(), "alias")
				if err := os.Symlink(root, alias); err != nil {
					t.Fatal(err)
				}
				root = alias
			}
			file, err := OpenObjectRead(root, id)
			if file != nil {
				_ = file.Close()
			}
			if err == nil || file != nil {
				t.Fatalf("accepted %s object", kind)
			}
		})
	}
}

func TestOpenObjectReadAtUsesRetainedRootAfterPathReplacement(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "objects")
	moved := filepath.Join(parent, "objects-original")
	id := "abcdefghijklmnopqrstuvwx"
	bucket := filepath.Join(root, id[:2])
	if err := os.MkdirAll(bucket, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bucket, id), []byte("original ciphertext"), 0600); err != nil {
		t.Fatal(err)
	}
	anchored, err := OpenObjectDirectory(root, id, false)
	if err != nil {
		t.Fatal(err)
	}
	defer anchored.Close()
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	newBucket := filepath.Join(root, id[:2])
	if err := os.MkdirAll(newBucket, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(newBucket, id), []byte("replacement ciphertext"), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := OpenObjectReadAt(anchored.root, id)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	got, err := io.ReadAll(file)
	if err != nil || string(got) != "original ciphertext" {
		t.Fatalf("anchored read followed the replacement pathname: %q %v", got, err)
	}
}

func TestBackupCoordinationRejectsNonregularLock(t *testing.T) {
	for _, kind := range []string{"fifo", "directory", "dangling"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, ".backup.lock")
			switch kind {
			case "fifo":
				if err := unix.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "dangling":
				if err := os.Symlink(filepath.Join(root, "missing"), path); err != nil {
					t.Fatal(err)
				}
			}
			lease, err := AcquireBackupLease(context.Background(), root)
			if lease != nil {
				_ = lease.Close()
			}
			if err == nil || lease != nil {
				t.Fatalf("accepted %s lock", kind)
			}
		})
	}
}

func TestObjectDirectoryImmutablePublicationAndConfinedTemporaryNames(t *testing.T) {
	root := t.TempDir()
	id := "abcdefghijklmnopqrstuvwx"
	directory, err := OpenObjectDirectory(root, id, true)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	first, name, err := directory.CreateTemporary()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Write([]byte("original-ciphertext")); err != nil {
		t.Fatal(err)
	}
	if err := first.Sync(); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := directory.PublishTemporary(name); err != nil {
		t.Fatal(err)
	}
	if err := directory.Sync(); err != nil {
		t.Fatal(err)
	}
	if err := directory.RemoveTemporary(name); err != nil {
		t.Fatal(err)
	}
	second, name, err := directory.CreateTemporary()
	if err != nil {
		t.Fatal(err)
	}
	defer directory.RemoveTemporary(name)
	if _, err := second.Write([]byte("replacement")); err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if err := directory.PublishTemporary(name); !errors.Is(err, unix.EEXIST) {
		t.Fatalf("immutable publish %v", err)
	}
	file, err := OpenObjectRead(root, id)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil || string(got) != "original-ciphertext" {
		t.Fatalf("replaced published object: %q %v", got, err)
	}
	for _, name := range []string{"../victim", ".upload-../victim", "", id, ".upload-not-generated"} {
		if err := directory.RemoveTemporary(name); err == nil {
			t.Fatalf("accepted unlink name %q", name)
		}
		if err := directory.PublishTemporary(name); err == nil {
			t.Fatalf("accepted publication name %q", name)
		}
	}
	if err := RemoveObjectFile(root, id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, id[:2], id)); !os.IsNotExist(err) {
		t.Fatalf("original not removed: %v", err)
	}
}

func TestObjectDirectoryReplacementUsesOriginalDescriptorForCleanup(t *testing.T) {
	for _, kind := range []string{"root", "bucket", "regular-bucket"} {
		t.Run(kind, func(t *testing.T) {
			parent := t.TempDir()
			root := filepath.Join(parent, "objects")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			id := "abcdefghijklmnopqrstuvwx"
			directory, err := OpenObjectDirectory(root, id, true)
			if err != nil {
				t.Fatal(err)
			}
			defer directory.Close()
			temp, name, err := directory.CreateTemporary()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := temp.Write([]byte("ciphertext")); err != nil {
				t.Fatal(err)
			}
			_ = temp.Close()
			outside := t.TempDir()
			bucket := filepath.Join(root, id[:2])
			original := filepath.Join(parent, "original")
			target := outside
			if kind == "root" {
				if err := os.Rename(root, original); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, root); err != nil {
					t.Fatal(err)
				}
				target = filepath.Join(outside, id[:2])
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
				original = filepath.Join(original, id[:2])
			} else {
				if err := os.Rename(bucket, original); err != nil {
					t.Fatal(err)
				}
				if kind == "bucket" {
					if err := os.Symlink(outside, bucket); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := os.Mkdir(bucket, 0700); err != nil {
						t.Fatal(err)
					}
					target = bucket
				}
			}
			victim := filepath.Join(target, name)
			if err := os.WriteFile(victim, []byte("unrelated"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := directory.PublishTemporary(name); !errors.Is(err, ErrObjectDirectoryChanged) {
				t.Fatalf("accepted %s replacement: %v", kind, err)
			}
			if err := directory.RemoveTemporary(name); err != nil {
				t.Fatal(err)
			}
			if got, err := os.ReadFile(victim); err != nil || string(got) != "unrelated" {
				t.Fatalf("changed redirect target: %q %v", got, err)
			}
			if entries, err := os.ReadDir(original); err != nil || len(entries) != 0 {
				t.Fatalf("original temporary remains: %v %v", entries, err)
			}
			if err := directory.Close(); err != nil {
				t.Fatal(err)
			}
			if err := directory.Validate(); !errors.Is(err, os.ErrClosed) {
				t.Fatalf("closed directory usable: %v", err)
			}
		})
	}
}

func TestObjectShardListingRejectsLinksAndNonDirectories(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"ab", "BC", "Z_", "too-long", "a!"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "zz"), []byte("ordinary-file"), 0600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "xy")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(root, "pq"), 0600); err != nil {
		t.Fatal(err)
	}
	names, err := ListObjectShards(root)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"BC", "Z_", "ab"}) {
		t.Fatalf("unsafe shard list: %v", names)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := ListObjectShards(alias); err == nil {
		t.Fatal("followed symbolic root when enumerating shards")
	}
}

func TestStartupTemporaryCleanupUsesBatchesAndPreservesNonregularEntries(t *testing.T) {
	root := t.TempDir()
	id := "abcdefghijklmnopqrstuvwx"
	directory, err := OpenObjectDirectory(root, id, true)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	bucket := filepath.Join(root, id[:2])
	for i := 0; i < 300; i++ {
		if err := os.WriteFile(filepath.Join(bucket, fmt.Sprintf(".upload-legacy-%d", i)), []byte("stale"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(bucket, ".upload-maintenance-123456"), []byte("stale"), 0600); err != nil {
		t.Fatal(err)
	}
	temporary, _, err := directory.CreateTemporary()
	if err != nil {
		t.Fatal(err)
	}
	if err := temporary.Close(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{id, ".upload-keep.dot", ".copy-other"} {
		if err := os.WriteFile(filepath.Join(bucket, name), []byte("retain"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	victim := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(victim, []byte("unrelated"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(bucket, ".upload-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(bucket, ".upload-dir"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(bucket, ".upload-fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := directory.RemoveStaleUploadTemporaries(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(bucket)
	if err != nil || len(entries) != 6 {
		t.Fatalf("temporary cleanup entries: %v %v", entries, err)
	}
	for _, name := range []string{id, ".upload-keep.dot", ".copy-other", ".upload-link", ".upload-dir", ".upload-fifo"} {
		if _, err := os.Lstat(filepath.Join(bucket, name)); err != nil {
			t.Errorf("removed retained %s: %v", name, err)
		}
	}
	if got, err := os.ReadFile(victim); err != nil || string(got) != "unrelated" {
		t.Fatalf("changed symbolic target: %q %v", got, err)
	}
}

func TestTrackedPublicationOwnsOnlyNewFinalPath(t *testing.T) {
	root := t.TempDir()
	directory, err := OpenObjectDirectory(root, "tracked-publication-object", true)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	first, name, err := directory.CreateTemporary()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Write([]byte("first immutable bytes")); err != nil {
		t.Fatal(err)
	}
	first.Close()
	published := false
	if err := directory.PublishTemporaryTracked(name, &published); err != nil || !published {
		t.Fatalf("new publication not owned: %v %v", published, err)
	}
	directory.RemoveTemporary(name)
	second, name, err := directory.CreateTemporary()
	if err != nil {
		t.Fatal(err)
	}
	second.Write([]byte("second bytes"))
	second.Close()
	defer directory.RemoveTemporary(name)
	published = true
	if err := directory.PublishTemporaryTracked(name, &published); err == nil || published {
		t.Fatalf("existing object became owned: %v %v", published, err)
	}
	got, err := os.ReadFile(filepath.Join(root, "tr", "tracked-publication-object"))
	if err != nil || string(got) != "first immutable bytes" {
		t.Fatalf("immutable object changed: %v", err)
	}
}
