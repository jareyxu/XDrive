package backup

import (
	"context"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"

	"xdrive/internal/config"
	"xdrive/internal/db"
)

// The prepared database never reopens an absolute stage path. The private VFS
// retains its main descriptor and roots all disk journals in the owned stage.
func prepareRestoredDatabase(ctx context.Context, root *os.Root, name string, identity os.FileInfo, backupAt int64, settings config.Config, applyMigrations bool) (err error) {
	database, cleanup, err := db.OpenPrivateStagedVerified(ctx, root, name, identity)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, cleanup()) }()
	if applyMigrations {
		if err := database.Migrate(ctx); err != nil {
			return err
		}
	}
	var schemaVersion int
	if err := database.QueryRowContext(ctx, "PRAGMA user_version").Scan(&schemaVersion); err != nil {
		return err
	}
	if !db.SupportedBackupSchemaVersion(schemaVersion) || (!applyMigrations && schemaVersion < 6) {
		return fmt.Errorf("restored schema %d is not supported for staged restore", schemaVersion)
	}
	if err := resetRestoredState(ctx, database, backupAt, schemaVersion); err != nil {
		return err
	}
	quota := settings.QuotaBytes
	if quota == 0 {
		quota = config.DefaultQuotaBytes
	}
	if err := database.InitializeMaintenanceQuota(ctx, quota, settings.MaintenanceReserveBytes); err != nil {
		return fmt.Errorf("refuse incompatible restored maintenance quota: %w", err)
	}
	return nil
}

func verifyRestoredDatabaseIdentity(ctx context.Context, root *os.Root, name string, expected os.FileInfo) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	file, err := root.OpenFile(name, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	info, statErr := file.Stat()
	closeErr := file.Close()
	if statErr != nil {
		return errors.Join(statErr, closeErr)
	}
	if !os.SameFile(expected, info) {
		return errors.Join(errors.New("prepared SQLite snapshot identity changed"), closeErr)
	}
	return closeErr
}
