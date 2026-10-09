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

func TestRestoreSnapshotWritesOriginalRootAfterParentReplacement(t *testing.T) {
	source := filepath.Join(t.TempDir(), "snapshot")
	content := bytes.Repeat([]byte{0x51}, 256*1024)
	if err := os.WriteFile(source, content, 0600); err != nil {
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
	if err := copyRestoredSnapshot(context.Background(), source, root, "database/vault.sqlite", hexDigest(content)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(outside, "stage/database/vault.sqlite")); !os.IsNotExist(err) {
		t.Fatalf("snapshot escaped owned root: %v", err)
	}
	actual, err := os.ReadFile(filepath.Join(original, "stage/database/vault.sqlite"))
	if err != nil || !bytes.Equal(actual, content) {
		t.Fatalf("original snapshot differs: %v", err)
	}
	if err := copyRestoredSnapshot(context.Background(), source, root, "database/vault.sqlite", hexDigest(content)); err == nil {
		t.Fatal("existing snapshot overwritten")
	}
	actual, err = os.ReadFile(filepath.Join(original, "stage/database/vault.sqlite"))
	if err != nil || !bytes.Equal(actual, content) {
		t.Fatal("existing snapshot changed")
	}
}

func TestRestoreRootSnapshotRejectsUnsafeAndInterruptedCopies(t *testing.T) {
	for _, kind := range []string{"initial-cancel", "partial-cancel", "digest", "parent-link", "leaf-link", "escape", "grow", "truncate", "same-size"} {
		t.Run(kind, func(t *testing.T) {
			source := filepath.Join(t.TempDir(), "snapshot")
			data := bytes.Repeat([]byte{17}, 512*1024)
			if err := os.WriteFile(source, data, 0600); err != nil {
				t.Fatal(err)
			}
			stage := filepath.Join(t.TempDir(), "stage")
			if err := os.Mkdir(stage, 0700); err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(stage)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			name := "database/vault.sqlite"
			target := filepath.Join(stage, name)
			outside := t.TempDir()
			victim := filepath.Join(outside, "victim")
			if err := os.WriteFile(victim, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			digest := hexDigest(data)
			var mutation *mutateRestoreSourceAfterPartial
			switch kind {
			case "initial-cancel":
				c, cancel := context.WithCancel(ctx)
				cancel()
				ctx = c
			case "partial-cancel":
				ctx = &cancelRestoreAfterPartial{Context: ctx, destination: target}
			case "digest":
				digest = strings.Repeat("0", 64)
			case "parent-link":
				if err := os.Symlink(outside, filepath.Join(stage, "database")); err != nil {
					t.Fatal(err)
				}
			case "leaf-link":
				if err := os.Mkdir(filepath.Join(stage, "database"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(victim, target); err != nil {
					t.Fatal(err)
				}
			case "escape":
				name = "../escaped.sqlite"
			default:
				mutation = &mutateRestoreSourceAfterPartial{Context: ctx, source: source, destination: target, kind: kind, t: t}
				ctx = mutation
			}
			err = copyRestoredSnapshot(ctx, source, root, name, digest)
			if err == nil {
				t.Fatal("invalid copy accepted")
			}
			if kind == "initial-cancel" || kind == "partial-cancel" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation ignored: %v", err)
				}
				info, e := os.Stat(target)
				if kind == "initial-cancel" {
					if !os.IsNotExist(e) {
						t.Fatal("cancel created destination")
					}
				} else if e != nil || info.Size() <= 0 || info.Size() > 128*1024 {
					t.Fatalf("partial copy exceeded bound: %v %v", info, e)
				}
			}
			expected := data
			if mutation != nil {
				if !mutation.acted {
					t.Fatal("mutation never occurred")
				}
				expected = mutation.changed
				info, e := os.Stat(target)
				if e != nil || info.Size() > int64(len(data))+1 {
					t.Fatalf("copy exceeded bound: %v %v", info, e)
				}
				if kind == "grow" && info.Size() != int64(len(data))+1 {
					t.Fatal("growth guard bound incorrect")
				}
			}
			actual, e := os.ReadFile(source)
			if e != nil || !bytes.Equal(actual, expected) {
				t.Fatal("source changed beyond injected mutation")
			}
			actual, e = os.ReadFile(victim)
			if e != nil || string(actual) != "preserve" {
				t.Fatal("external victim changed")
			}
			if _, e := os.Stat(filepath.Join(outside, "vault.sqlite")); !os.IsNotExist(e) {
				t.Fatal("outside snapshot created")
			}
			if _, e := os.Stat(filepath.Join(filepath.Dir(stage), "escaped.sqlite")); !os.IsNotExist(e) {
				t.Fatal("escaped snapshot created")
			}
		})
	}
}
