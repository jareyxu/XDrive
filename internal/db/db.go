package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

const schemaVersion = 7

// CurrentSchemaVersion is recorded in backup manifests and checked on restore.
const CurrentSchemaVersion = schemaVersion

// SupportedBackupSchemaVersion accepts only explicitly compatible snapshot layouts.
func SupportedBackupSchemaVersion(version int) bool {
	return version >= 2 && version <= schemaVersion
}

type DB struct {
	*sql.DB
}

func Open(ctx context.Context, path string) (*DB, error) {
	if path == "" {
		return nil, errors.New("database path is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve database path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	_ = os.Chmod(filepath.Dir(absolute), 0o700)

	dsn := (&url.URL{Scheme: "file", Path: absolute}).String() + "?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(FULL)&_pragma=busy_timeout(5000)"
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	sqlDB.SetConnMaxIdleTime(5 * time.Minute)
	if err := sqlDB.PingContext(ctx); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if err := os.Chmod(absolute, 0o600); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("restrict database permissions: %w", err)
	}
	database := &DB{DB: sqlDB}
	if err := database.Migrate(ctx); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	return database, nil
}

func (database *DB) Migrate(ctx context.Context) error {
	var current int
	if err := database.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if current > schemaVersion {
		return fmt.Errorf("database schema %d is newer than this binary supports (%d)", current, schemaVersion)
	}
	if current == schemaVersion {
		return nil
	}
	migrations, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("list migrations: %w", err)
	}
	sort.Strings(migrations)
	for _, migrationPath := range migrations {
		var version int
		if _, err := fmt.Sscanf(filepath.Base(migrationPath), "%04d_", &version); err != nil {
			return fmt.Errorf("parse migration version %q: %w", migrationPath, err)
		}
		if version <= current {
			continue
		}
		sqlText, err := migrationFiles.ReadFile(migrationPath)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", migrationPath, err)
		}
		tx, err := database.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %s: %w", migrationPath, err)
		}
		if _, err := tx.ExecContext(ctx, string(sqlText)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %s: %w", migrationPath, err)
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record migration %s: %w", migrationPath, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %s: %w", migrationPath, err)
		}
		current = version
	}
	if current != schemaVersion {
		return fmt.Errorf("database migrations end at version %d, expected %d", current, schemaVersion)
	}
	return nil
}

// SetupState reports only whether first-run setup is still required. It never
// returns account identifiers or any authentication material.
func (database *DB) SetupState(ctx context.Context) (string, error) {
	var state string
	err := database.QueryRowContext(ctx, "SELECT state FROM users WHERE id = 1").Scan(&state)
	if err == sql.ErrNoRows {
		return "uninitialized", nil
	}
	if err != nil {
		return "", err
	}
	return state, nil
}
