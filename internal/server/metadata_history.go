package server

import (
	"context"
	"database/sql"
	"time"
)

// Retain the newest N rows per index, including its current version. Active
// staged builds protect captured history until finalization or expiry.
func pruneMetadataVersions(ctx context.Context, tx *sql.Tx, now time.Time, keep int) error {
	rows, err := tx.QueryContext(ctx, `SELECT metadata_id,revision,object_id FROM (
  SELECT metadata_id,revision,object_id,ROW_NUMBER() OVER (PARTITION BY metadata_id ORDER BY revision DESC) AS position
  FROM metadata_versions
 ) v WHERE position > ?
 AND NOT EXISTS (SELECT 1 FROM metadata_pointers p WHERE p.object_id=v.object_id)
 AND NOT EXISTS (SELECT 1 FROM tombstone_objects t WHERE t.object_id=v.object_id)
 AND NOT EXISTS (SELECT 1 FROM tombstone_build_members m JOIN tombstone_builds b ON b.id=m.build_id
   WHERE b.state='active' AND b.expires_at > ? AND ((m.member_type='metadata' AND m.opaque_id=v.metadata_id) OR (m.member_type='object' AND m.opaque_id=v.object_id)))
 ORDER BY metadata_id,revision LIMIT ?`, keep, now.Unix(), cleanupBatchSize)
	if err != nil {
		return err
	}
	type version struct {
		metadata, object string
		revision         int64
	}
	var stale []version
	for rows.Next() {
		var v version
		if err := rows.Scan(&v.metadata, &v.revision, &v.object); err != nil {
			rows.Close()
			return err
		}
		stale = append(stale, v)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, v := range stale {
		if _, err := tx.ExecContext(ctx, "DELETE FROM metadata_versions WHERE metadata_id=? AND revision=? AND object_id=?", v.metadata, v.revision, v.object); err != nil {
			return err
		}
		// Only this pruned index object is a candidate. Never sweep all unreferenced
		// live objects: file data references are inside encrypted manifests.
		if _, err := tx.ExecContext(ctx, `UPDATE objects SET state='deleted' WHERE id=? AND state='live'
   AND NOT EXISTS (SELECT 1 FROM metadata_pointers WHERE object_id=objects.id)
   AND NOT EXISTS (SELECT 1 FROM metadata_versions WHERE object_id=objects.id)
   AND NOT EXISTS (SELECT 1 FROM tombstone_objects WHERE object_id=objects.id)
   AND NOT EXISTS (SELECT 1 FROM tombstone_build_members m JOIN tombstone_builds b ON b.id=m.build_id
    WHERE m.member_type='object' AND m.opaque_id=objects.id AND b.state='active' AND b.expires_at>?)`, v.object, now.Unix()); err != nil {
			return err
		}
	}
	return nil
}
