package backup

import (
	"bytes"
	"context"
	"errors"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestProbeSQLiteReopenAfterSnapshotHash(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, false); err != nil {
		t.Fatal(err)
	}
	generation, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(destination, "snapshots", generation, snapshotName)
	if _, err := hashFile(path); err != nil {
		t.Fatal(err)
	}
	moved := path + "-original"
	if err := os.Rename(path, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moved, path); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readSnapshotObjects(context.Background(), path); err == nil {
		t.Fatal("SQLite driver accepted linked snapshot after successful original hash")
	}
}

func TestPrivateSnapshotReadBindsCopiedDigestAndCleansCancellation(t *testing.T) {
	settings, destination, _, _ := backupFixture(t)
	if err := Create(context.Background(), settings, destination, false); err != nil {
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
	private, cleanup, err := prepareSnapshotRead(context.Background(), source, digest)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	folder := filepath.Dir(private)
	info, err := os.Stat(folder)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("folder permissions: %v %v", info, err)
	}
	info, err = os.Stat(private)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("snapshot permissions: %v %v", info, err)
	}
	if got, err := hashFile(private); err != nil || got != digest {
		t.Fatalf("copy digest %q %v", got, err)
	}
	cleanup()
	if _, err := os.Stat(folder); !os.IsNotExist(err) {
		t.Fatalf("private staging remains: %v", err)
	}
	file, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readSnapshotObjectsWithDigest(context.Background(), source, digest); err == nil {
		t.Fatal("changed snapshot accepted with old digest")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := prepareSnapshotRead(ctx, source, digest); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled staging: %v", err)
	}
}

// The context switches to cancellation only after the real input has supplied
// one block, so this cannot pass by cancelling before staging starts.
func TestSnapshotReaderStopsAfterCancellationMidCopy(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	input := &cancelAfterRead{reader: bytes.NewReader(bytes.Repeat([]byte{0x63}, 512*1024)), cancel: cancel}
	var output bytes.Buffer
	written, err := io.CopyBuffer(&output, snapshotContextReader{ctx: ctx, reader: input}, make([]byte, 128*1024))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("mid-copy error: %v", err)
	}
	if input.calls != 1 || written == 0 || written > 128*1024 || int64(output.Len()) != written {
		t.Fatalf("unexpected reads/bytes: calls=%d written=%d buffered=%d", input.calls, written, output.Len())
	}
}

type cancelAfterRead struct {
	reader io.Reader
	cancel context.CancelFunc
	calls  int
}

func (r *cancelAfterRead) Read(b []byte) (int, error) {
	r.calls++
	n, err := r.reader.Read(b)
	r.cancel()
	return n, err
}

func TestPrivateSnapshotMidCopyCancellationRemovesPartialStage(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.db")
	if err := os.WriteFile(source, bytes.Repeat([]byte{0x71}, 512*1024), 0600); err != nil {
		t.Fatal(err)
	}
	staging := t.TempDir()
	t.Setenv("TMPDIR", staging)
	ctx := &cancelDuringSnapshotRead{Context: context.Background(), root: staging}
	path, cleanup, err := prepareSnapshotRead(ctx, source, "")
	if !errors.Is(err, context.Canceled) || path != "" || cleanup != nil {
		t.Fatalf("cancelled preparation: %q %v %v", path, cleanup != nil, err)
	}
	if !ctx.sawPartial {
		t.Fatal("cancellation did not follow a written partial snapshot")
	}
	entries, err := os.ReadDir(staging)
	if err != nil || len(entries) != 0 {
		t.Fatalf("partial staging remains: %v %v", entries, err)
	}
	data, err := os.ReadFile(source)
	if err != nil || len(data) != 512*1024 {
		t.Fatalf("source changed: %v", err)
	}
}

type cancelDuringSnapshotRead struct {
	context.Context
	root       string
	calls      int
	sawPartial bool
}

func (c *cancelDuringSnapshotRead) Err() error {
	c.calls++

	entries, _ := os.ReadDir(c.root)
	for _, entry := range entries {
		info, err := os.Stat(filepath.Join(c.root, entry.Name(), snapshotName))
		if err == nil && info.Size() > 0 && info.Size() <= 128*1024 {
			c.sawPartial = true
		}
	}
	if c.sawPartial {
		return context.Canceled
	}
	return nil
}

func TestPrivateSnapshotRejectsMidCopySourceMutationAndCleansStage(t *testing.T) {
	for _, mode := range []string{"grow", "truncate", "same-size"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			source := filepath.Join(root, "source.db")
			original := bytes.Repeat([]byte{0x71}, 512*1024)
			if err := os.WriteFile(source, original, 0600); err != nil {
				t.Fatal(err)
			}
			staging := t.TempDir()
			t.Setenv("TMPDIR", staging)
			ctx := &mutateDuringSnapshotRead{Context: context.Background(), source: source, root: staging, mode: mode}
			path, cleanup, err := prepareSnapshotRead(ctx, source, hexDigest(original))
			if err == nil || path != "" || cleanup != nil {
				t.Fatalf("mutation accepted: %q %v %v", path, cleanup != nil, err)
			}
			if !ctx.sawPartial || ctx.mutationErr != nil {
				t.Fatalf("no valid mid-copy mutation: observed=%v error=%v", ctx.sawPartial, ctx.mutationErr)
			}
			if ctx.maxStage > int64(len(original))+1 {
				t.Fatalf("copy exceeded original size+1: %d", ctx.maxStage)
			}
			entries, err := os.ReadDir(staging)
			if err != nil || len(entries) != 0 {
				t.Fatalf("staging remains: %v %v", entries, err)
			}
			expected := append([]byte(nil), original...)
			switch mode {
			case "grow":
				expected = append(expected, bytes.Repeat([]byte{0x72}, 128*1024)...)
			case "truncate":
				expected = expected[:128*1024]
			case "same-size":
				expected[256*1024] = 0x72
			}
			actual, err := os.ReadFile(source)
			if err != nil || !bytes.Equal(actual, expected) {
				t.Fatalf("unexpected source modification: %v", err)
			}
		})
	}
}

type mutateDuringSnapshotRead struct {
	context.Context
	source, root, mode string
	calls              int
	sawPartial         bool
	maxStage           int64
	acted              bool
	mutationErr        error
}

func (c *mutateDuringSnapshotRead) Err() error {
	c.calls++
	entries, _ := os.ReadDir(c.root)
	for _, entry := range entries {
		info, err := os.Stat(filepath.Join(c.root, entry.Name(), snapshotName))
		if err == nil {
			if info.Size() > c.maxStage {
				c.maxStage = info.Size()
			}
			if info.Size() > 0 && info.Size() <= 128*1024 {
				c.sawPartial = true
			}
		}
	}
	if !c.sawPartial || c.acted {
		return c.mutationErr
	}
	c.acted = true
	switch c.mode {
	case "unlink", "replace-link":
		c.mutationErr = os.Remove(c.source)
		if c.mutationErr == nil && c.mode == "replace-link" {
			c.mutationErr = os.Symlink(c.source+"-victim", c.source)
		}
	case "grow":
		var file *os.File
		file, c.mutationErr = os.OpenFile(c.source, os.O_APPEND|os.O_WRONLY, 0600)
		if c.mutationErr == nil {
			_, c.mutationErr = file.Write(bytes.Repeat([]byte{0x72}, 128*1024))
			_ = file.Close()
		}
	case "truncate":
		c.mutationErr = os.Truncate(c.source, 128*1024)
	case "same-size":
		var file *os.File
		file, c.mutationErr = os.OpenFile(c.source, os.O_WRONLY, 0600)
		if c.mutationErr == nil {
			_, c.mutationErr = file.WriteAt([]byte{0x72}, 256*1024)
			_ = file.Close()
		}
	}
	return c.mutationErr
}

func TestPrivateSnapshotRetainsOpenedSourceAfterPathRemovalOrReplacement(t *testing.T) {
	for _, mode := range []string{"unlink", "replace-link"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			source := filepath.Join(root, "source.db")
			original := bytes.Repeat([]byte{0x71}, 512*1024)
			if err := os.WriteFile(source, original, 0600); err != nil {
				t.Fatal(err)
			}
			victim := source + "-victim"
			replacement := bytes.Repeat([]byte{0x72}, len(original))
			if err := os.WriteFile(victim, replacement, 0600); err != nil {
				t.Fatal(err)
			}
			staging := t.TempDir()
			t.Setenv("TMPDIR", staging)
			ctx := &mutateDuringSnapshotRead{Context: context.Background(), source: source, root: staging, mode: mode}
			path, cleanup, err := prepareSnapshotRead(ctx, source, hexDigest(original))
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup()
			if !ctx.sawPartial || ctx.mutationErr != nil {
				t.Fatalf("no valid partial-copy replacement: %v %v", ctx.sawPartial, ctx.mutationErr)
			}
			data, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(data, original) {
				t.Fatalf("copy switched source: %v", err)
			}
			data, err = os.ReadFile(victim)
			if err != nil || !bytes.Equal(data, replacement) {
				t.Fatalf("replacement victim changed: %v", err)
			}
			cleanup()
			entries, err := os.ReadDir(staging)
			if err != nil || len(entries) != 0 {
				t.Fatalf("staging remains: %v %v", entries, err)
			}
			if mode == "unlink" {
				if _, err := os.Lstat(source); !os.IsNotExist(err) {
					t.Fatalf("source path recreated: %v", err)
				}
			} else {
				info, err := os.Lstat(source)
				if err != nil || info.Mode()&os.ModeSymlink == 0 {
					t.Fatalf("replacement link changed: %v", err)
				}
			}
		})
	}
}

func TestPrivateSnapshotWriteFailureRemovesPartialStage(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.db")
	original := bytes.Repeat([]byte{0x71}, 512*1024)
	if err := os.WriteFile(source, original, 0600); err != nil {
		t.Fatal(err)
	}
	staging := t.TempDir()
	t.Setenv("TMPDIR", staging)
	ctx := &failSnapshotOutput{Context: context.Background(), root: staging}
	path, cleanup, err := prepareSnapshotRead(ctx, source, hexDigest(original))
	if !errors.Is(err, unix.EBADF) || path != "" || cleanup != nil {
		t.Fatalf("write fault: %q %v %v", path, cleanup != nil, err)
	}
	if !ctx.injected || ctx.faultErr != nil {
		t.Fatalf("no actual output fault: %v %v", ctx.injected, ctx.faultErr)
	}
	entries, err := os.ReadDir(staging)
	if err != nil || len(entries) != 0 {
		t.Fatalf("partial stage remains: %v %v", entries, err)
	}
	actual, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(actual, original) {
		t.Fatalf("source changed: %v", err)
	}
}

type failSnapshotOutput struct {
	context.Context
	root     string
	calls    int
	injected bool
	faultErr error
}

func (c *failSnapshotOutput) Err() error {
	c.calls++
	if c.injected || c.faultErr != nil {
		return c.faultErr
	}
	entries, err := os.ReadDir(c.root)
	if err != nil {
		c.faultErr = err
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(c.root, entry.Name(), snapshotName)
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		var target unix.Stat_t
		err = unix.Fstat(int(file.Fd()), &target)
		if err != nil || target.Size <= 0 || target.Size > 128*1024 {
			_ = file.Close()
			continue
		}
		for fd := 0; fd < 4096; fd++ {
			var candidate unix.Stat_t
			if unix.Fstat(fd, &candidate) != nil || candidate.Dev != target.Dev || candidate.Ino != target.Ino {
				continue
			}
			flags, e := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
			if e != nil || flags&unix.O_ACCMODE != unix.O_WRONLY {
				continue
			}
			// Atomically replace only the identified, test-owned output descriptor.
			// It remains open until the production defer closes it; no freed FD race.
			c.faultErr = unix.Dup2(int(file.Fd()), fd)
			c.injected = c.faultErr == nil
			_ = file.Close()
			return c.faultErr
		}
		_ = file.Close()
	}
	return nil
}
