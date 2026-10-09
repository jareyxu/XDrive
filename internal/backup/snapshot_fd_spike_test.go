package backup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"modernc.org/sqlite"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// This is a portability spike, not a production switch: verifies that the
// actual bundled SQLite VFS can parse an unlinked, descriptor-owned snapshot.
func TestSQLiteReadsUnlinkedSnapshotThroughOwnedDescriptor(t *testing.T) {
	ctx := context.Background()
	settings, destination, _, _ := backupFixture(t)
	if err := Create(ctx, settings, destination, false); err != nil {
		t.Fatal(err)
	}
	generation, err := readCurrent(destination)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(destination, "snapshots", generation, snapshotName)
	manifest, _, err := readSnapshotObjects(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := hashFile(source)
	if err != nil {
		t.Fatal(err)
	}
	private, cleanup, err := prepareSnapshotRead(ctx, source, digest)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	file, err := os.Open(private)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	cleanup()
	if _, err := os.Stat(filepath.Dir(private)); !os.IsNotExist(err) {
		t.Fatalf("named staging remains: %v", err)
	}
	dsn := (&url.URL{Scheme: "file", Path: fmt.Sprintf("/dev/fd/%d", file.Fd())}).String() + "?mode=ro&immutable=1"
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	database.SetMaxOpenConns(1)
	var integrity string
	if err := database.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil {
		var failure *sqlite.Error
		if runtime.GOOS == "linux" && errors.As(err, &failure) && failure.Code() == 14 {
			t.Log("CAPABILITY: unlinked descriptor snapshot unsupported by current Linux SQLite VFS (code14); production must retain named staging")
			return
		}
		t.Fatalf("unlinked snapshot integrity: %q %v", integrity, err)
	}
	if integrity != "ok" {
		t.Fatalf("unlinked snapshot integrity: %q", integrity)
	}
	var count int
	if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM objects WHERE state='live'").Scan(&count); err != nil || count != len(manifest.Objects) {
		t.Fatalf("unlinked snapshot objects: %d want %d error %v", count, len(manifest.Objects), err)
	}
	var version int
	if err := database.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil || version != 7 {
		t.Fatalf("unlinked schema: %d %v", version, err)
	}
}
