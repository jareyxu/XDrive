package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
)

// Snapshot writes a consistent SQLite database image into a new file. Callers
// must stop writes before using it as an upgrade rollback point; this function
// itself only guarantees a consistent image at one instant.
func Snapshot(ctx context.Context, databasePath, destination string) error {
	absolute, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(absolute); err == nil {
		return errors.New("database snapshot destination already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(absolute)
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() {
		return errors.New("database snapshot parent must be an existing directory")
	}
	stage, err := os.MkdirTemp(parent, ".xdrive-db-snapshot-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	stagedPath := filepath.Join(stage, "snapshot.db")
	source, err := filepath.Abs(databasePath)
	if err != nil {
		return err
	}
	if source == absolute {
		return errors.New("database snapshot cannot replace its source")
	}
	sourceInfo, err := os.Lstat(source)
	if err != nil || !sourceInfo.Mode().IsRegular() {
		return errors.New("database source must be an existing regular file")
	}
	// Open the existing schema without running migrations. An updater must take
	// this pre-migration snapshot with the candidate binary before migrate.
	dsn := (&url.URL{Scheme: "file", Path: source}).String() + "?mode=rw&_pragma=busy_timeout(5000)"
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	defer database.Close()
	if err := database.PingContext(ctx); err != nil {
		return err
	}
	var integrity string
	if err := database.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil || integrity != "ok" {
		return fmt.Errorf("source SQLite integrity check failed: %s: %v", integrity, err)
	}
	if _, err := database.ExecContext(ctx, "VACUUM INTO ?", stagedPath); err != nil {
		return fmt.Errorf("create SQLite snapshot: %w", err)
	}
	if err := os.Chmod(stagedPath, 0o600); err != nil {
		return err
	}
	file, err := os.Open(stagedPath)
	if err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Link(stagedPath, absolute); err != nil {
		return err
	}
	directory, err := os.Open(parent)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
