package db

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenMigratesAndRestrictsDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "drive.db")
	database, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	var version int
	if err := database.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != schemaVersion {
		t.Fatalf("schema version = %d, want %d", version, schemaVersion)
	}
	var table string
	if err := database.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='upload_object_claims'").Scan(&table); err != nil {
		t.Fatalf("upload claims table missing: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("database permissions = %o, want 600", got)
	}
}

func TestMigrateRejectsNewerSchema(t *testing.T) {
	database, err := Open(context.Background(), filepath.Join(t.TempDir(), "drive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.Exec("PRAGMA user_version = 999"); err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(context.Background()); err == nil {
		t.Fatal("expected newer schema version to be rejected")
	}
}

func TestMigrateUpgradesVersionOneDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := migrationFiles.ReadFile("migrations/0001_initial.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(string(initial)); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec("PRAGMA user_version = 1"); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	database, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var version int
	if err := database.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != schemaVersion {
		t.Fatalf("schema version = %d, want %d", version, schemaVersion)
	}
	var hasRevision int
	if err := database.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('tombstone_builds') WHERE name = 'expected_global_revision'`).Scan(&hasRevision); err != nil {
		t.Fatal(err)
	}
	if hasRevision != 1 {
		t.Fatal("version-two tombstone build revision column is missing")
	}
}

func TestVersionTwoClaimMigrationPreservesReceiveFence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_initial.sql", "0002_tombstone_build_revision.sql"} {
		contents, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.Exec(string(contents)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := legacy.Exec("PRAGMA user_version = 2"); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec("INSERT INTO upload_sessions (id,state,reserved_bytes,consumed_bytes,created_at,expires_at) VALUES ('session','active',36,0,1,99)"); err != nil {
		t.Fatal(err)
	}
	digest := make([]byte, 32)
	if _, err := legacy.Exec("INSERT INTO upload_object_claims VALUES ('session','object',36,?,1)", digest); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	database, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var owner string
	var size int64
	if err := database.QueryRow("SELECT session_id,expected_size_bytes FROM upload_receive_fences WHERE object_id='object'").Scan(&owner, &size); err != nil || owner != "session" || size != 36 {
		t.Fatalf("lost migrated fence: %q %d %v", owner, size, err)
	}
	for _, version := range []int{0, 1, schemaVersion + 1, 999} {
		if SupportedBackupSchemaVersion(version) {
			t.Fatalf("accepted unsupported backup schema %d", version)
		}
	}
}

func TestMigrateVersionThreeAddsBoundedMaintenanceJournal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-three.db")
	legacy, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_initial.sql", "0002_tombstone_build_revision.sql", "0003_upload_receive_fences.sql"} {
		data, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.Exec(string(data)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := legacy.Exec("PRAGMA user_version=3"); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	database, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.Exec("INSERT INTO metadata_maintenance VALUES(1,'candidate',4194304,1)"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("INSERT INTO metadata_maintenance VALUES(501,'over-limit',36,1)"); err == nil {
		t.Fatal("journal beyond 500 candidates")
	}
	if _, err := database.Exec("UPDATE metadata_maintenance SET size_bytes=4194305"); err == nil {
		t.Fatal("oversized candidate")
	}
	if !SupportedBackupSchemaVersion(3) || !SupportedBackupSchemaVersion(4) {
		t.Fatal("backup compatibility")
	}
}
