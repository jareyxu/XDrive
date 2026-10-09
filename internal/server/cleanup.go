package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
	"xdrive/internal/storage"
)

const cleanupBatchSize = 1000
const trashRetention = 30 * 24 * time.Hour

// UpgradeRollbackHoldFilename is created while the service is stopped and
// kept until the updater either accepts the new release or restores the
// matching pre-migration database and binary. A persistent marker is needed
// because the updater and the service are separate processes.
const UpgradeRollbackHoldFilename = ".xdrive-upgrade-rollback-hold"

// UpgradeRollbackHoldPath places the marker beside the root-managed config
// when one is supplied by the service/CLI. Development invocations without an
// explicit config fall back beside the database file.
func UpgradeRollbackHoldPath(configPath, databasePath string) string {
	directory := filepath.Dir(databasePath)
	if configPath != "" {
		directory = filepath.Dir(configPath)
	}
	return filepath.Join(directory, UpgradeRollbackHoldFilename)
}

type gcBeforeProgressCASContextKey struct{}

func withGCBeforeProgressCASHook(ctx context.Context, hook func()) context.Context {
	return context.WithValue(ctx, gcBeforeProgressCASContextKey{}, hook)
}

// RecoverUploadClaimsAtStartup runs before the HTTP listener accepts requests.
// A claim left after a process exit has no receiving request and must not block
// a resumed upload or leave an unpublished final object path behind.
func RecoverUploadClaimsAtStartup(ctx context.Context, database *db.DB, storagePath string) error {
	lease, err := storage.AcquireDeletionLease(ctx, storagePath)
	if err != nil {
		return err
	}
	defer lease.Close()
	rows, err := database.QueryContext(ctx, `SELECT c.object_id FROM (SELECT object_id FROM upload_object_claims UNION SELECT object_id FROM upload_receive_fences UNION SELECT object_id FROM metadata_maintenance) c
		LEFT JOIN objects o ON o.id = c.object_id WHERE o.id IS NULL`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range ids {
		if !opaqueIDPattern.MatchString(id) {
			return fmt.Errorf("invalid orphan claim object id")
		}
		if err := storage.RemoveObjectFile(storagePath, id); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove orphan claimed object %s: %w", id, err)
		}
	}
	_, err = database.ExecContext(ctx, `DELETE FROM upload_object_claims WHERE object_id NOT IN (SELECT id FROM objects)`)
	if err != nil {
		return err
	}
	// A crash during body reception leaves a .upload-* temporary file before
	// the final path exists. No request can own one before the listener starts.
	shards, err := storage.ListObjectShards(storagePath)
	if err != nil {
		return err
	}
	for _, name := range shards {
		directory, err := storage.OpenObjectDirectory(storagePath, name, false)
		if err != nil {
			return err
		}
		err = directory.RemoveStaleUploadTemporaries()
		closeErr := directory.Close()
		if err != nil || closeErr != nil {
			return errors.Join(err, closeErr)
		}
	}
	if _, err := database.ExecContext(ctx, "DELETE FROM metadata_maintenance"); err != nil {
		return err
	}
	_, err = database.ExecContext(ctx, "DELETE FROM upload_receive_fences")
	return err
}

// CleanupOnce durably marks expired work unavailable before unlinking files.
// It is safe to repeat after a crash: failed unlinks remain in the deleted state.
func CleanupOnce(ctx context.Context, database *db.DB, storagePath string, now time.Time) error {
	return CleanupOnceWithRetention(ctx, database, storagePath, now, trashRetention)
}

func CleanupOnceWithRetention(ctx context.Context, database *db.DB, storagePath string, now time.Time, retention time.Duration) error {
	return CleanupOnceWithPolicy(ctx, database, storagePath, now, retention, config.DefaultMetadataKeepVersions)
}

func CleanupOnceWithPolicy(ctx context.Context, database *db.DB, storagePath string, now time.Time, retention time.Duration, keepVersions int) error {
	return cleanupWithPolicy(ctx, database, storagePath, now, true, retention, keepVersions, "")
}

// CleanupOnceWithPolicyAndHold performs logical cleanup as usual while
// deferring physical unlink operations when an upgrade rollback hold exists.
func CleanupOnceWithPolicyAndHold(ctx context.Context, database *db.DB, storagePath string, now time.Time, retention time.Duration, keepVersions int, rollbackHoldPath string) error {
	if rollbackHoldPath == "" {
		return fmt.Errorf("upgrade rollback hold path is required")
	}
	return cleanupWithPolicy(ctx, database, storagePath, now, true, retention, keepVersions, rollbackHoldPath)
}

func cleanupWithPolicy(ctx context.Context, database *db.DB, storagePath string, now time.Time, unlink bool, retention time.Duration, keepVersions int, rollbackHoldPath string) error {
	if retention < time.Second || retention%time.Second != 0 {
		return fmt.Errorf("invalid trash retention")
	}
	if err := config.ValidateMetadataKeepVersions(keepVersions); err != nil {
		return err
	}
	return cleanupOnceCore(ctx, database, storagePath, now, unlink, retention, keepVersions, rollbackHoldPath)
}

// StartupCleanup commits logical expiry before accepting requests but leaves
// physical unlink to the periodic pass. The updater's persistent rollback hold
// protects objects for the entire automatic rollback window; startup deferral
// alone only gives the candidate its initial readiness check.
func StartupCleanup(ctx context.Context, database *db.DB, storagePath string, now time.Time) error {
	return cleanupOnceCore(ctx, database, storagePath, now, false, trashRetention, config.DefaultMetadataKeepVersions, "")
}

func cleanupOnce(ctx context.Context, database *db.DB, storagePath string, now time.Time, unlink bool, retention time.Duration, keepVersions int) error {
	return cleanupOnceCore(ctx, database, storagePath, now, unlink, retention, keepVersions, "")
}

func cleanupOnceCore(ctx context.Context, database *db.DB, storagePath string, now time.Time, unlink bool, retention time.Duration, keepVersions int, rollbackHoldPath string) error {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM login_attempts WHERE window_started_at <= ?", now.Add(-authAttemptWindow).Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE upload_sessions SET state = 'expired'
		WHERE state = 'active' AND expires_at <= ?`, now.Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE objects SET state = 'deleted'
		WHERE state = 'pending' AND upload_session_id IN
		(SELECT id FROM upload_sessions WHERE state IN ('aborted', 'expired'))`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM upload_object_claims WHERE session_id IN (SELECT id FROM upload_sessions WHERE state <> 'active')"); err != nil {
		return err
	}
	// Closed sessions with receiving fences remain until the receiving PUT exits.
	// Startup recovery removes fences after a process crash, before accepting PUTs.
	if _, err := tx.ExecContext(ctx, `DELETE FROM upload_sessions WHERE state IN ('aborted', 'expired', 'committed')
		AND expires_at <= ? AND NOT EXISTS (SELECT 1 FROM upload_receive_fences c WHERE c.session_id = upload_sessions.id)`, now.Add(-24*time.Hour).Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM tx_log WHERE expires_at <= ?", now.Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE expires_at <= ?", now.Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM setup_tokens WHERE expires_at <= ?", now.Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM tombstone_builds WHERE state IN ('expired', 'cancelled', 'finalized') OR (state = 'active' AND expires_at <= ?)`, now.Unix()); err != nil {
		return err
	}
	// Expired trash is made unavailable atomically before its object files are unlinked.
	// Keep this bounded so cleanup never holds SQLite's writer lock for an unbounded tree.
	expiredTombstones, err := tx.QueryContext(ctx, `SELECT id FROM tombstones
		WHERE state = 'active' AND deleted_at <= ? ORDER BY deleted_at LIMIT 100`, now.Add(-retention).Unix())
	if err != nil {
		return err
	}
	var expiredIDs []string
	for expiredTombstones.Next() {
		var id string
		if err := expiredTombstones.Scan(&id); err != nil {
			_ = expiredTombstones.Close()
			return err
		}
		expiredIDs = append(expiredIDs, id)
	}
	if err := expiredTombstones.Err(); err != nil {
		_ = expiredTombstones.Close()
		return err
	}
	if err := expiredTombstones.Close(); err != nil {
		return err
	}
	for _, id := range expiredIDs {
		if _, err := tx.ExecContext(ctx, `UPDATE objects SET state = 'deleted'
			WHERE id IN (SELECT object_id FROM tombstone_objects WHERE tombstone_id = ?) AND state = 'live'`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM metadata_pointers WHERE id IN
			(SELECT metadata_id FROM tombstone_metadata WHERE tombstone_id = ?)`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM metadata_versions WHERE metadata_id IN
			(SELECT metadata_id FROM tombstone_metadata WHERE tombstone_id = ?)`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM tombstones WHERE id = ? AND state = 'active'`, id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE tombstone_builds SET state = 'expired'
		WHERE state = 'active' AND expires_at <= ?`, now.Unix()); err != nil {
		return err
	}
	if err := pruneMetadataVersions(ctx, tx, now, keepVersions); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if !unlink {
		return nil
	}
	if rollbackHoldPath != "" {
		held, err := UpgradeRollbackHoldActive(rollbackHoldPath)
		if err != nil {
			return err
		}
		if held {
			return nil
		}
	}
	lease, err := storage.TryDeletionLease(storagePath)
	if err != nil {
		return err
	}
	if lease == nil {
		return nil
	}
	defer lease.Close()
	// Recheck after acquiring the cross-process deletion lease. The updater
	// itself creates the marker only while the service is stopped, so this also
	// protects against an operator-created hold racing a periodic pass.
	if rollbackHoldPath != "" {
		held, err := UpgradeRollbackHoldActive(rollbackHoldPath)
		if err != nil {
			return err
		}
		if held {
			return nil
		}
	}

	return cleanupDeletedObjectBatch(ctx, database, storagePath)
}

// UpgradeRollbackHoldActive fails closed on any present but unsafe marker.
// It is also used by read-only diagnostics so an interrupted update is visible.
func UpgradeRollbackHoldActive(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return true, fmt.Errorf("inspect upgrade rollback hold: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return true, fmt.Errorf("unsafe upgrade rollback hold")
	}
	return true, nil
}

const deletedObjectBatchQuery = `SELECT id FROM objects INDEXED BY objects_deleted_gc_idx
	WHERE state = 'deleted' AND id > ? ORDER BY id LIMIT ?`

// The caller holds the deletion lease. Filesystem operations happen outside a
// DB transaction. A crash before the progress CAS simply repeats this batch.
func cleanupDeletedObjectBatch(ctx context.Context, database *db.DB, storagePath string) error {
	var cursor string
	var generation int64
	if err := database.QueryRowContext(ctx, "SELECT cursor, generation FROM object_gc_state WHERE id = 1").Scan(&cursor, &generation); err != nil {
		return err
	}
	objectIDs, err := deletedObjectBatch(ctx, database, cursor)
	if err != nil {
		return err
	}
	if len(objectIDs) == 0 && cursor != "" {
		// New deletions may have IDs before the persisted cursor. Wrap without
		// spending another whole interval on an empty tail.
		objectIDs, err = deletedObjectBatch(ctx, database, "")
		if err != nil {
			return err
		}
	}
	for _, objectID := range objectIDs {
		if err := ctx.Err(); err != nil {
			return err
		}
		if opaqueIDPattern.MatchString(objectID) {
			// Failed paths stay deleted and are retried on a later sweep. They
			// must not prevent later IDs from ever receiving an attempt.
			_ = storage.RemoveObjectFile(storagePath, objectID)
		}
	}
	if hook, ok := ctx.Value(gcBeforeProgressCASContextKey{}).(func()); ok {
		hook()
	}
	nextCursor := ""
	if len(objectIDs) == cleanupBatchSize {
		nextCursor = objectIDs[len(objectIDs)-1]
	}
	// Multiple deletion leases may coexist. Use a monotonic generation rather
	// than cursor equality, which would admit stale writes after a wrap (ABA).
	// A lost CAS is harmless: another pass already advanced the scan. No ID
	// rows are deleted, and this private state does not change vault revision.
	return advanceObjectGC(ctx, database, generation, nextCursor)
}

func advanceObjectGC(ctx context.Context, database *db.DB, generation int64, nextCursor string) error {
	_, err := database.ExecContext(ctx, `UPDATE object_gc_state SET cursor = ?, generation = generation + 1
		WHERE id = 1 AND generation = ?`, nextCursor, generation)
	return err
}

func deletedObjectBatch(ctx context.Context, database *db.DB, cursor string) ([]string, error) {
	rows, err := database.QueryContext(ctx, deletedObjectBatchQuery, cursor, cleanupBatchSize)
	if err != nil {
		return nil, err
	}
	objectIDs := make([]string, 0, cleanupBatchSize)
	for rows.Next() {
		var objectID string
		if err := rows.Scan(&objectID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		objectIDs = append(objectIDs, objectID)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return objectIDs, nil
}

// RunCleanup repeats bounded cleanup work until ctx is cancelled.
func RunCleanup(ctx context.Context, database *db.DB, storagePath, rollbackHoldPath string, interval, retention time.Duration, keepVersions int) {
	if interval <= 0 {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			cleanupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			_ = CleanupOnceWithPolicyAndHold(cleanupCtx, database, storagePath, now, retention, keepVersions, rollbackHoldPath)
			cancel()
		}
	}
}
