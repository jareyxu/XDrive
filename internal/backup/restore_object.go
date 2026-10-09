package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"xdrive/internal/storage"
)

// The entire owned stage remains invisible until Restore activates it. Partial
// files stay in that stage for its owned failure cleanup, never in a live tree.
func copyRestoredObject(ctx context.Context, source string, root *os.Root, storagePath string, item Object) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !safeID.MatchString(item.ID) || item.SizeBytes < 0 || item.SizeBytes == math.MaxInt64 {
		return errors.New("invalid restored object identity or size")
	}
	input, err := storage.OpenObjectRead(source, item.ID)
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil || info.Size() != item.SizeBytes {
		return errors.New("restored source object size mismatch")
	}
	name := objectPath(storagePath, item.ID)
	if err := root.MkdirAll(filepath.Dir(name), 0700); err != nil {
		return err
	}
	output, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer output.Close()
	prepareBackupStream(input)
	prepareBackupStream(output)
	digest := sha256.New()
	copied, err := copyRestoredObjectWindows(ctx, io.MultiWriter(output, digest), input, output, item.SizeBytes)
	if err != nil {
		return err
	}
	if copied != item.SizeBytes || hex.EncodeToString(digest.Sum(nil)) != item.SHA256 {
		return fmt.Errorf("restored source object %s failed size or SHA-256 verification", item.ID)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := output.Sync(); err != nil {
		return err
	}
	return output.Close()
}

func copyRestoredObjectWindows(ctx context.Context, target io.Writer, source, destination *os.File, expectedSize int64) (int64, error) {
	buffer := make([]byte, 128*1024)
	var copied int64
	for copied < expectedSize {
		if err := ctx.Err(); err != nil {
			return copied, err
		}
		windowSize := min(backupStreamWindowBytes, expectedSize-copied)
		reader := snapshotContextReader{ctx: ctx, reader: io.LimitReader(source, windowSize)}
		written, err := io.CopyBuffer(target, reader, buffer)
		if err != nil {
			return copied + written, err
		}
		if written != windowSize {
			return copied + written, io.ErrUnexpectedEOF
		}
		if err := flushBackupStreamWindow(destination, copied, written); err != nil {
			return copied + written, err
		}
		discardBackupStreamWindow(source, copied, written)
		discardBackupStreamWindow(destination, copied, written)
		copied += written
	}
	var extra [1]byte
	reader := snapshotContextReader{ctx: ctx, reader: io.LimitReader(source, 1)}
	if n, err := reader.Read(extra[:]); n != 0 {
		written, writeErr := target.Write(extra[:n])
		if writeErr != nil {
			return copied + int64(written), writeErr
		}
		if written != n {
			return copied + int64(written), io.ErrShortWrite
		}
		return copied + int64(written), errors.New("restored source object grew while copying")
	} else if err == nil {
		return copied, errors.New("restored source object reader returned no data")
	} else if !errors.Is(err, io.EOF) {
		return copied, err
	}
	return copied, ctx.Err()
}
