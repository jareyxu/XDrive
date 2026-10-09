package backup

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreSnapshotCopyHonorsInitialAndMidCopyCancellation(t *testing.T) {
	for _, phase := range []string{"initial", "partial"} {
		t.Run(phase, func(t *testing.T) {
			root := t.TempDir()
			source, destination := filepath.Join(root, "source.db"), filepath.Join(root, "target.db")
			data := make([]byte, 512*1024)
			if err := os.WriteFile(source, data, 0600); err != nil {
				t.Fatal(err)
			}
			var ctx context.Context
			if phase == "initial" {
				c, cancel := context.WithCancel(context.Background())
				cancel()
				ctx = c
			} else {
				ctx = &cancelRestoreAfterPartial{Context: context.Background(), destination: destination}
			}
			err := copyVerifiedSnapshot(ctx, source, destination, hexDigest(data))
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("snapshot copy ignored %s cancellation: %v", phase, err)
			}
			info, err := os.Stat(destination)
			if phase == "initial" {
				if !os.IsNotExist(err) {
					t.Fatalf("initial cancellation created output: %v", err)
				}
			} else {
				if err != nil || info.Size() <= 0 || info.Size() > 128*1024 {
					t.Fatalf("partial cancellation exceeded copy window: %v %v", info, err)
				}
			}
			observed, err := os.ReadFile(source)
			if err != nil || hexDigest(observed) != hexDigest(data) {
				t.Fatalf("source changed: %v", err)
			}
		})
	}
}

type cancelRestoreAfterPartial struct {
	context.Context
	destination string
}

func (c *cancelRestoreAfterPartial) Err() error {
	if info, err := os.Stat(c.destination); err == nil && info.Size() > 0 {
		return context.Canceled
	}
	return nil
}

func TestRestoreSnapshotCopyRefusesMidCopySourceMutation(t *testing.T) {
	for _, kind := range []string{"grow", "truncate", "same-size"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			source, destination := filepath.Join(root, "source.db"), filepath.Join(root, "target.db")
			original := bytes.Repeat([]byte{17}, 512*1024)
			if err := os.WriteFile(source, original, 0600); err != nil {
				t.Fatal(err)
			}
			ctx := &mutateRestoreSourceAfterPartial{Context: context.Background(), source: source, destination: destination, kind: kind, t: t}
			if err := copyVerifiedSnapshot(ctx, source, destination, hexDigest(original)); err == nil {
				t.Fatal("mutated source accepted")
			}
			if !ctx.acted {
				t.Fatal("mutation did not occur after real partial output")
			}
			info, err := os.Stat(destination)
			if err != nil || info.Size() > int64(len(original))+1 {
				t.Fatalf("copy exceeded initial source size+1: %v %v", info, err)
			}
			if kind == "grow" && info.Size() != int64(len(original))+1 {
				t.Fatalf("growth guard did not stop at bound: %d", info.Size())
			}
			actual, err := os.ReadFile(source)
			if err != nil || !bytes.Equal(actual, ctx.changed) {
				t.Fatalf("source changed beyond injected mutation: %v", err)
			}
			t.Logf("source mutation %s: source=%d output=%d bound=%d", kind, len(actual), info.Size(), len(original)+1)
		})
	}
}

type mutateRestoreSourceAfterPartial struct {
	context.Context
	source, destination, kind string
	acted                     bool
	changed                   []byte
	t                         *testing.T
}

func (c *mutateRestoreSourceAfterPartial) Err() error {
	if c.acted {
		return nil
	}
	info, err := os.Stat(c.destination)
	if err != nil || info.Size() == 0 {
		return nil
	}
	if info.Size() > 128*1024 {
		c.t.Fatalf("mutation missed first copy window: %d", info.Size())
	}
	c.acted = true
	c.changed = bytes.Repeat([]byte{17}, 512*1024)
	switch c.kind {
	case "grow":
		c.changed = append(c.changed, bytes.Repeat([]byte{31}, 4*1024*1024)...)
	case "truncate":
		c.changed = c.changed[:64*1024]
	case "same-size":
		c.changed[256*1024] = 99
	}
	if err := os.WriteFile(c.source, c.changed, 0600); err != nil {
		c.t.Fatal(err)
	}
	return nil
}
