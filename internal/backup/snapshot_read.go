package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"golang.org/x/sys/unix"
	"io"
	"math"
	"os"
	"path/filepath"
	"time"
)

// SQLite only opens a request-private copy made from one no-follow descriptor.
// The digest is verified over the exact bytes copied before any SQL is parsed.
func prepareSnapshotRead(ctx context.Context, path, expected string) (string, func(), error) {
	if err := ctx.Err(); err != nil {
		return "", nil, err
	}
	tempRoot, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		return "", nil, err
	}
	if err := reapSnapshotCopies(ctx, tempRoot, time.Now()); err != nil {
		return "", nil, err
	}
	input, err := openBackupRegular(path)
	if err != nil {
		return "", nil, err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return "", nil, err
	}
	folder, err := os.MkdirTemp(tempRoot, ".xdrive-snapshot-read-")
	if err != nil {
		return "", nil, err
	}
	lease, err := lockSnapshotFolder(folder)
	if err != nil {
		_ = os.RemoveAll(folder)
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(folder); _ = lease.Close() }
	success := false
	defer func() {
		if !success {
			cleanup()
		}
	}()
	var fs unix.Statfs_t
	if err := unix.Statfs(folder, &fs); err != nil {
		return "", nil, err
	}
	if fs.Bsize <= 0 || uint64(fs.Bavail) > math.MaxUint64/uint64(fs.Bsize) {
		return "", nil, errors.New("invalid snapshot staging filesystem capacity")
	}
	free := uint64(fs.Bavail) * uint64(fs.Bsize)
	const margin = 64 << 20
	if info.Size() < 0 || info.Size() == math.MaxInt64 || free < margin || uint64(info.Size()) > free-margin {
		return "", nil, errors.New("insufficient snapshot staging space")
	}
	target := filepath.Join(folder, snapshotName)
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", nil, err
	}
	defer output.Close()
	digest := sha256.New()
	written, err := io.CopyBuffer(io.MultiWriter(output, digest), io.LimitReader(snapshotContextReader{ctx: ctx, reader: input}, info.Size()+1), make([]byte, 128*1024))
	if err != nil {
		return "", nil, err
	}
	if written != info.Size() {
		return "", nil, errors.New("snapshot changed while staging")
	}
	if expected != "" && hex.EncodeToString(digest.Sum(nil)) != expected {
		return "", nil, errors.New("snapshot staging digest mismatch")
	}
	if err := ctx.Err(); err != nil {
		return "", nil, err
	}
	if err := output.Close(); err != nil {
		return "", nil, err
	}
	success = true
	return target, cleanup, nil
}

type snapshotContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r snapshotContextReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(b)
}
