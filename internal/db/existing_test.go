package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestExistingOpenNeverCreatesOrMigrates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing", "database.db")
	for _, readOnly := range []bool{false, true} {
		if handle, err := openExisting(context.Background(), path, readOnly, false); err == nil {
			handle.Close()
			t.Fatal("created missing database")
		}
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatal("created directory", err)
	}
	path = filepath.Join(t.TempDir(), "legacy.db")
	current, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := current.Exec("PRAGMA user_version=3"); err != nil {
		t.Fatal(err)
	}
	current.Close()
	for _, readOnly := range []bool{false, true} {
		if handle, err := openExisting(context.Background(), path, readOnly, false); err == nil {
			handle.Close()
			t.Fatal("silently migrated mismatched schema")
		}
	}
	raw, err := OpenReadOnly(context.Background(), path)
	if err == nil {
		raw.Close()
		t.Fatal("accepted legacy schema")
	}
	// Raw read verifies the version without invoking the production migrator.
	connection, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	var version int
	err = connection.QueryRow("PRAGMA user_version").Scan(&version)
	if err != nil || version != 3 {
		t.Fatalf("schema changed: %d %v", version, err)
	}
}

func TestOpenBackupMetadataUpdatesLegacySchemaWithoutMigrating(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schema-six.db")
	legacy, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	migrations, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	paths := make([]string, 0, len(migrations))
	for _, migration := range migrations {
		paths = append(paths, migration.Name())
	}
	sort.Strings(paths)
	for _, name := range paths {
		var version int
		if _, err := fmt.Sscanf(name, "%04d_", &version); err != nil {
			t.Fatal(err)
		}
		if version > 6 {
			break
		}
		contents, err := migrationFiles.ReadFile(filepath.Join("migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.Exec(string(contents)); err != nil {
			t.Fatalf("apply migration %s: %v", name, err)
		}
		if _, err := legacy.Exec(fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
			t.Fatal(err)
		}
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	database, err := OpenBackupMetadata(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var version int
	if err := database.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 6 {
		t.Fatalf("backup metadata open changed schema version: %d %v", version, err)
	}
	var gcTable int
	if err := database.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='object_gc_state'").Scan(&gcTable); err != nil || gcTable != 0 {
		t.Fatalf("backup metadata open applied schema-seven migration: object_gc_state=%d err=%v", gcTable, err)
	}
	if _, err := database.Exec("UPDATE server_state SET last_backup_at=123 WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	var backedUpAt int64
	if err := database.QueryRow("SELECT last_backup_at FROM server_state WHERE id=1").Scan(&backedUpAt); err != nil || backedUpAt != 123 {
		t.Fatalf("backup metadata update = %d, %v", backedUpAt, err)
	}
	if current, err := OpenCurrent(context.Background(), path); err == nil {
		current.Close()
		t.Fatal("serving connection accepted a pre-migration database")
	}
}

func TestReadOnlyConnectionRefusesMutationAndLeavesPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "database.db")
	initialized, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	initialized.Close()
	if err := os.Chmod(path, 0640); err != nil {
		t.Fatal(err)
	}
	read, err := OpenReadOnly(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	if _, err := read.Exec("UPDATE server_state SET vault_mutation_revision=42"); err == nil {
		t.Fatal("read-only connection allowed write")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0640 {
		t.Fatal("read-only open changed permissions", err)
	}
	writer, err := OpenCurrent(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if _, err := writer.Exec("UPDATE server_state SET vault_mutation_revision=1"); err != nil {
		t.Fatal(err)
	}
	var revision int
	if err := read.QueryRow("SELECT vault_mutation_revision FROM server_state").Scan(&revision); err != nil || revision != 1 {
		t.Fatal("online read-only connection did not see committed state", err)
	}
}
