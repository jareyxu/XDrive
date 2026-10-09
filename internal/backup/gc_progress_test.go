package backup

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"xdrive/internal/config"
	"xdrive/internal/db"
)

func TestRestoreResetsGCProgressAndMigratesSchemaSix(t *testing.T) {
	for _, schema := range []int{6, 7} {
		t.Run(fmt.Sprint(schema), func(t *testing.T) {
			ctx := context.Background()
			settings, dest, id, content := backupFixture(t)
			live, err := db.OpenCurrent(ctx, settings.DatabasePath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := live.Exec("UPDATE object_gc_state SET cursor='zz-before-restore',generation=42 WHERE id=1"); err != nil {
				t.Fatal(err)
			}
			if err := live.Close(); err != nil {
				t.Fatal(err)
			}
			if err := Create(ctx, settings, dest, true); err != nil {
				t.Fatal(err)
			}
			backupGeneration, err := readCurrent(dest)
			if err != nil {
				t.Fatal(err)
			}
			stage := filepath.Join(dest, "snapshots", backupGeneration)
			if schema == 6 {
				snapshotPath := filepath.Join(stage, snapshotName)
				snapshot, err := sql.Open("sqlite", "file:"+snapshotPath)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := snapshot.Exec("DROP TABLE object_gc_state; DROP INDEX objects_deleted_gc_idx; PRAGMA user_version=6"); err != nil {
					t.Fatal(err)
				}
				if err := snapshot.Close(); err != nil {
					t.Fatal(err)
				}
				headerPath := filepath.Join(stage, backupName)
				raw, err := os.ReadFile(headerPath)
				if err != nil {
					t.Fatal(err)
				}
				var header Header
				if err := json.Unmarshal(raw, &header); err != nil {
					t.Fatal(err)
				}
				header.SchemaVersion = 6
				header.SnapshotSHA256, err = hashFile(snapshotPath)
				if err != nil {
					t.Fatal(err)
				}
				raw, err = json.Marshal(header)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(headerPath, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := Verify(ctx, dest); err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			restored := config.Config{DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret")}
			if err := Restore(ctx, restored, dest); err != nil {
				t.Fatal(err)
			}
			if got, err := os.ReadFile(objectPath(restored.StoragePath, id)); err != nil || !bytes.Equal(got, content) {
				t.Fatalf("restored bytes: %v", err)
			}
			database, err := db.OpenCurrent(ctx, restored.DatabasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()
			var cursor string
			var generation, version int
			if err := database.QueryRow("SELECT cursor,generation FROM object_gc_state WHERE id=1").Scan(&cursor, &generation); err != nil || cursor != "" || generation != 0 {
				t.Fatalf("restored stale cursor: %q %d %v", cursor, generation, err)
			}
			if err := database.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 7 {
				t.Fatalf("restored schema: %d %v", version, err)
			}
		})
	}
}
