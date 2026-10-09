package db

import (
	"context"
	"database/sql"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestSchemaSixUpgradePreservesLedgerAndRollbackSnapshot(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	path := filepath.Join(root, "schema-six.db")
	legacy, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	names, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	for _, name := range names {
		if strings.HasPrefix(filepath.Base(name), "0007_") {
			break
		}
		raw, err := migrationFiles.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.Exec(string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := legacy.Exec("PRAGMA user_version=6; UPDATE server_state SET vault_mutation_revision=42 WHERE id=1; INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES('zz-deleted-ledger-object',36,zeroblob(32),'deleted',1)"); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	if opened, err := OpenCurrent(ctx, path); err == nil {
		opened.Close()
		t.Fatal("candidate accepted unmigrated schema6 for online writes")
	}
	rollback := filepath.Join(root, "before-upgrade.db")
	if err := Snapshot(ctx, path, rollback); err != nil {
		t.Fatal(err)
	}
	migrated, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	var cursor string
	var generation, version, revision int
	if err := migrated.QueryRow("SELECT cursor,generation FROM object_gc_state WHERE id=1").Scan(&cursor, &generation); err != nil || cursor != "" || generation != 0 {
		t.Fatalf("migrated cursor: %q %d %v", cursor, generation, err)
	}
	if err := migrated.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 7 {
		t.Fatalf("version: %d %v", version, err)
	}
	if err := migrated.QueryRow("SELECT vault_mutation_revision FROM server_state WHERE id=1").Scan(&revision); err != nil || revision != 42 {
		t.Fatalf("revision changed: %d %v", revision, err)
	}
	if _, err := migrated.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES('zz-deleted-ledger-object',36,zeroblob(32),'live',2)"); err == nil {
		t.Fatal("migration allowed deleted ID reuse")
	}
	if err := migrated.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	saved, err := sql.Open("sqlite", "file:"+rollback+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer saved.Close()
	if err := saved.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 6 {
		t.Fatalf("rollback snapshot migrated: %d %v", version, err)
	}
	var state string
	if err := saved.QueryRow("SELECT state FROM objects WHERE id='zz-deleted-ledger-object'").Scan(&state); err != nil || state != "deleted" {
		t.Fatalf("rollback ledger changed: %q %v", state, err)
	}
	var tables int
	if err := saved.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE name='object_gc_state'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("new table leaked into rollback: %d %v", tables, err)
	}
}
