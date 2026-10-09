package backup

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"xdrive/internal/storage"
)

func TestArchiveDownloadRestoresThroughExistingCLIFormat(t *testing.T) {
	settings, _, objectID, content := backupFixture(t)
	export, err := PrepareArchive(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	defer export.Close()
	var archiveBytes bytes.Buffer
	if err := export.WriteTo(context.Background(), &archiveBytes); err != nil {
		t.Fatal(err)
	}
	if export.DownloadFilename() == "" || !bytes.HasSuffix([]byte(export.DownloadFilename()), []byte(".tar")) {
		t.Fatalf("invalid download name %q", export.DownloadFilename())
	}

	extracted := filepath.Join(t.TempDir(), "downloaded-backup")
	if err := extractTestArchive(extracted, bytes.NewReader(archiveBytes.Bytes())); err != nil {
		t.Fatal(err)
	}
	backupRoot := filepath.Join(extracted, export.rootName)
	if err := VerifyGeneration(context.Background(), backupRoot, ""); err != nil {
		t.Fatalf("downloaded archive is not a valid backup: %v", err)
	}

	restoredRoot := filepath.Join(t.TempDir(), "restored")
	restored := settings
	restored.DatabasePath = filepath.Join(restoredRoot, "drive.db")
	restored.StoragePath = filepath.Join(restoredRoot, "objects")
	restored.SecretPath = filepath.Join(restoredRoot, "server.secret")
	if err := RestoreGeneration(context.Background(), restored, backupRoot, ""); err != nil {
		t.Fatalf("restore downloaded archive: %v", err)
	}
	restoredObject, err := os.ReadFile(objectPath(restored.StoragePath, objectID))
	if err != nil || !bytes.Equal(restoredObject, content) {
		t.Fatalf("restored object differs: bytes=%d err=%v", len(restoredObject), err)
	}
	if _, err := os.Stat(restored.SecretPath); err != nil {
		t.Fatalf("restore did not create a fresh server secret: %v", err)
	}
}

func TestArchiveExportStopsOnWriterFailureAndReleasesBackupLease(t *testing.T) {
	settings, _, _, _ := backupFixture(t)
	export, err := PrepareArchive(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	want := errors.New("client disconnected")
	if err := export.WriteTo(context.Background(), failingArchiveWriter{err: want}); !errors.Is(err, want) {
		t.Fatalf("writer failure was not propagated: %v", err)
	}
	if err := export.Close(); err != nil {
		t.Fatal(err)
	}
	lease, err := storage.TryBackupLease(settings.StoragePath)
	if err != nil || lease == nil {
		t.Fatalf("failed export kept the deletion lock: lease=%v err=%v", lease, err)
	}
	_ = lease.Close()
}

func TestCleanupArchiveStagingRemovesOnlyOwnedTemporaryDirectories(t *testing.T) {
	settings, _, _, _ := backupFixture(t)
	root := filepath.Dir(settings.DatabasePath)
	owned := filepath.Join(root, ".xdrive-web-backup-abcdefghij")
	lookalike := filepath.Join(root, ".xdrive-web-backup-not-an-owned-temp")
	ownedFile := filepath.Join(root, ".xdrive-web-backup-abcdefghij-file")
	for _, path := range []string{owned, lookalike, ownedFile} {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := CleanupArchiveStaging(settings); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(owned); !os.IsNotExist(err) {
		t.Fatalf("owned staging directory remains: %v", err)
	}
	for _, path := range []string{lookalike, ownedFile} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("cleanup removed unrelated path %q: %v", path, err)
		}
	}
}

type failingArchiveWriter struct{ err error }

func (writer failingArchiveWriter) Write([]byte) (int, error) { return 0, writer.err }

func extractTestArchive(target string, input io.Reader) error {
	reader := tar.NewReader(input)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		clean := filepath.Clean(filepath.FromSlash(header.Name))
		if filepath.IsAbs(clean) || clean == ".." || len(clean) >= 3 && clean[:3] == ".."+string(os.PathSeparator) {
			return errors.New("unsafe generated archive path")
		}
		path := filepath.Join(target, clean)
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, 0o700); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				return err
			}
			file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(file, reader)
			closeErr := file.Close()
			if err := errors.Join(copyErr, closeErr); err != nil {
				return err
			}
		default:
			return errors.New("unexpected generated archive member type")
		}
	}
}
