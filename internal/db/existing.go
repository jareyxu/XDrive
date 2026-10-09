package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"time"
)

// OpenCurrent performs no migrations, initialization or permission changes.
// Online token/backup operations may only use the already deployed schema.
func OpenCurrent(ctx context.Context, path string) (*DB, error) {
	return openExisting(ctx, path, false, false)
}

// OpenReadOnly additionally prevents SQL writes; it never creates a database.
func OpenReadOnly(ctx context.Context, path string) (*DB, error) {
	return openExisting(ctx, path, true, false)
}

// OpenBackupMetadata opens an already-existing schema that the backup format
// can preserve. It never migrates; callers may only update metadata fields
// present in every accepted schema and must not use it to serve requests.
func OpenBackupMetadata(ctx context.Context, path string) (*DB, error) {
	return openExisting(ctx, path, false, true)
}

func openExisting(ctx context.Context, path string, readOnly, allowSupportedBackupSchema bool) (*DB, error) {
	if path == "" {
		return nil, errors.New("database path is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	mode := "rw"
	if readOnly {
		mode = "ro"
	}
	dsn := (&url.URL{Scheme: "file", Path: absolute}).String() + "?mode=" + mode + "&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	if !readOnly {
		dsn += "&_pragma=synchronous(FULL)"
	}
	raw, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	raw.SetMaxOpenConns(1)
	raw.SetMaxIdleConns(1)
	raw.SetConnMaxIdleTime(5 * time.Minute)
	ok := false
	defer func() {
		if !ok {
			_ = raw.Close()
		}
	}()
	var version int
	if err := raw.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return nil, fmt.Errorf("read existing database: %w", err)
	}
	if version > CurrentSchemaVersion {
		return nil, fmt.Errorf("database schema %d is newer than binary schema %d; use a compatible newer binary", version, CurrentSchemaVersion)
	}
	if allowSupportedBackupSchema {
		if !SupportedBackupSchemaVersion(version) {
			return nil, fmt.Errorf("database schema %d is not supported for backup metadata", version)
		}
	} else if version != CurrentSchemaVersion {
		return nil, fmt.Errorf("database schema %d does not match binary schema %d; stop the service and run migrate using the upgrade procedure", version, CurrentSchemaVersion)
	}
	ok = true
	return &DB{DB: raw}, nil
}
