package backup

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRestoreObjectWritesOriginalRootAfterParentReplacement(t *testing.T) {
	source := t.TempDir()
	id := strings.Repeat("a", 32)
	content := bytes.Repeat([]byte{0x5b}, 256*1024)
	if err := os.MkdirAll(filepath.Dir(objectPath(source, id)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(objectPath(source, id), content, 0600); err != nil {
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
	original := parent + "-original"
	if err := os.Rename(parent, original); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(outside, "stage"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, parent); err != nil {
		t.Fatal(err)
	}
	item := Object{ID: id, SizeBytes: int64(len(content)), SHA256: hexDigest(content)}
	if err := copyRestoredObject(context.Background(), source, root, "objects", item); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(objectPath(filepath.Join(outside, "stage", "objects"), id)); !os.IsNotExist(err) {
		t.Fatalf("object escaped owned root: %v", err)
	}
	actual, err := os.ReadFile(objectPath(filepath.Join(original, "stage", "objects"), id))
	if err != nil || !bytes.Equal(actual, content) {
		t.Fatalf("original restored object differs: %v", err)
	}
	if err := copyRestoredObject(context.Background(), source, root, "objects", item); err == nil {
		t.Fatal("existing staged object overwritten")
	}
	actual, err = os.ReadFile(objectPath(filepath.Join(original, "stage", "objects"), id))
	if err != nil || !bytes.Equal(actual, content) {
		t.Fatal("existing object changed")
	}
}

func restoreObjectCopyFixture(t *testing.T) (string, *os.Root, Object, []byte) {
	t.Helper()
	source, stage := t.TempDir(), t.TempDir()
	id := strings.Repeat("b", 32)
	data := bytes.Repeat([]byte{17}, 512*1024)
	if err := os.MkdirAll(filepath.Dir(objectPath(source, id)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(objectPath(source, id), data, 0600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	return source, root, Object{ID: id, SizeBytes: int64(len(data)), SHA256: hexDigest(data)}, data
}

func TestRestoreObjectRejectsCancelledCorruptAndLinkedCopies(t *testing.T) {
	for _, kind := range []string{"initial-cancel", "partial-cancel", "digest", "parent-link", "leaf-link", "escape", "invalid-id"} {
		t.Run(kind, func(t *testing.T) {
			source, root, item, data := restoreObjectCopyFixture(t)
			target := objectPath(filepath.Join(root.Name(), "objects"), item.ID)
			path := "objects"
			ctx := context.Background()
			outside := t.TempDir()
			victim := filepath.Join(outside, "victim")
			if err := os.WriteFile(victim, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "initial-cancel":
				c, cancel := context.WithCancel(ctx)
				cancel()
				ctx = c
			case "partial-cancel":
				ctx = &cancelRestoreAfterPartial{Context: ctx, destination: target}
			case "digest":
				item.SHA256 = strings.Repeat("0", 64)
			case "parent-link":
				if err := os.Symlink(outside, filepath.Join(root.Name(), "objects")); err != nil {
					t.Fatal(err)
				}
			case "leaf-link":
				if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(victim, target); err != nil {
					t.Fatal(err)
				}
			case "escape":
				path = "../escaped-restore-objects"
			case "invalid-id":
				item.ID = "x"
			}
			err := copyRestoredObject(ctx, source, root, path, item)
			if err == nil {
				t.Fatal("unsafe copy accepted")
			}
			if strings.Contains(kind, "cancel") && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation lost: %v", err)
			}
			if kind == "initial-cancel" {
				if _, err := os.Lstat(target); !os.IsNotExist(err) {
					t.Fatalf("initial cancel created output: %v", err)
				}
			}
			if kind == "partial-cancel" {
				info, err := os.Stat(target)
				if err != nil || info.Size() <= 0 || info.Size() > 128*1024 {
					t.Fatalf("partial cancel exceeded one window: %v %v", info, err)
				}
			}
			actual, err := os.ReadFile(objectPath(source, strings.Repeat("b", 32)))
			if err != nil || !bytes.Equal(actual, data) {
				t.Fatal("source bytes changed")
			}
			actual, err = os.ReadFile(victim)
			if err != nil || string(actual) != "preserve" {
				t.Fatal("outside victim changed")
			}
			if _, err := os.Stat(objectPath(outside, strings.Repeat("b", 32))); !os.IsNotExist(err) {
				t.Fatalf("outside object created: %v", err)
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(root.Name()), "escaped-restore-objects")); !os.IsNotExist(err) {
				t.Fatalf("escape directory created: %v", err)
			}
		})
	}
}

func TestRestoreObjectRefusesMutationAfterRealPartialCopy(t *testing.T) {
	for _, kind := range []string{"grow", "truncate", "same-size"} {
		t.Run(kind, func(t *testing.T) {
			source, root, item, data := restoreObjectCopyFixture(t)
			target := objectPath(filepath.Join(root.Name(), "objects"), item.ID)
			ctx := &mutateRestoreSourceAfterPartial{Context: context.Background(), source: objectPath(source, item.ID), destination: target, kind: kind, t: t}
			if err := copyRestoredObject(ctx, source, root, "objects", item); err == nil {
				t.Fatal("changed source accepted")
			}
			if !ctx.acted {
				t.Fatal("mutation never occurred")
			}
			info, err := os.Stat(target)
			if err != nil || info.Size() > int64(len(data))+1 {
				t.Fatalf("copy exceeded bound: %v %v", info, err)
			}
			if kind == "grow" && info.Size() != int64(len(data))+1 {
				t.Fatalf("growth stopped at wrong bound: %d", info.Size())
			}
			actual, err := os.ReadFile(objectPath(source, item.ID))
			if err != nil || !bytes.Equal(actual, ctx.changed) {
				t.Fatal("source changed beyond injected mutation")
			}
		})
	}
}
