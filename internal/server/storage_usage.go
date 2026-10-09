package server

import (
	"database/sql"
	"golang.org/x/sys/unix"
	"math"
	"net/http"

	"xdrive/internal/db"
)

func storageUsage(w http.ResponseWriter, r *http.Request, database *db.DB, quotaBytes int64, storagePath string, backupWarnAfterDays int) {
	var usedBytes, pendingBytes, reservedBytes, trashBytes, maintenanceReserve, maintenanceCapacity int64
	var lastBackupAt sql.NullInt64
	// One SQLite statement observes one snapshot across objects, sessions and
	// tombstones. Pending is a subset of used; claims are already in outstanding
	// reservations. Neither is added again when calculating available capacity.
	err := database.QueryRowContext(r.Context(), `SELECT
		(SELECT COALESCE(SUM(size_bytes), 0) FROM objects WHERE state IN ('live','pending')),
		(SELECT COALESCE(SUM(size_bytes), 0) FROM objects WHERE state = 'pending'),
		(SELECT COALESCE(SUM(reserved_bytes - consumed_bytes), 0) FROM upload_sessions
		 WHERE state = 'active' AND expires_at > unixepoch()),
		(SELECT COALESCE(SUM(o.size_bytes), 0) FROM objects o WHERE o.state = 'live'
		 AND EXISTS (SELECT 1 FROM tombstone_objects members JOIN tombstones t ON t.id = members.tombstone_id
		 WHERE members.object_id = o.id AND t.state = 'active')),
		last_backup_at, `+maintenanceRemainingSQL+`, COALESCE((SELECT capacity_bytes FROM maintenance_quota WHERE id=1),0) FROM server_state WHERE id = 1`).Scan(&usedBytes, &pendingBytes, &reservedBytes, &trashBytes, &lastBackupAt, &maintenanceReserve, &maintenanceCapacity)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if maintenanceReserve < 0 {
		writeError(w, 500, "internal_error")
		return
	}
	uploadReservedBytes := reservedBytes
	reservedBytes += maintenanceReserve
	freeDiskBytes, err := availableDiskBytes(storagePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "disk_usage_unavailable")
		return
	}
	var availableBytes int64
	if usedBytes < quotaBytes && reservedBytes < quotaBytes-usedBytes {
		availableBytes = quotaBytes - usedBytes - reservedBytes
	}
	var backupTime any
	if lastBackupAt.Valid {
		if lastBackupAt.Int64 < 0 || lastBackupAt.Int64 > math.MaxInt64/1000 {
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		backupTime = lastBackupAt.Int64 * 1000
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"quotaBytes": quotaBytes, "usedBytes": usedBytes, "pendingBytes": pendingBytes,
		"reservedBytes": reservedBytes, "trashBytes": trashBytes, "freeDiskBytes": freeDiskBytes,
		"availableBytes": availableBytes, "lastBackupAt": backupTime, "backupWarnAfterDays": backupWarnAfterDays,
		"uploadReservedBytes": uploadReservedBytes, "maintenanceReservedBytes": maintenanceReserve, "maintenanceCapacityBytes": maintenanceCapacity,
	})
}

func listTrashTombstones(w http.ResponseWriter, r *http.Request, database *db.DB) {
	rows, err := database.QueryContext(r.Context(), `SELECT id, deleted_at FROM tombstones
		WHERE state = 'active' ORDER BY deleted_at DESC LIMIT 5000`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	defer rows.Close()
	type tombstone struct {
		ID        string `json:"id"`
		DeletedAt int64  `json:"deletedAt"`
	}
	items := make([]tombstone, 0)
	for rows.Next() {
		var item tombstone
		if err := rows.Scan(&item.ID, &item.DeletedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	writeJSON(w, http.StatusOK, map[string]any{"tombstones": items})
}

func availableDiskBytes(path string) (int64, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return 0, err
	}
	blockSize := uint64(stat.Bsize)
	availableBlocks := uint64(stat.Bavail)
	if blockSize == 0 || availableBlocks > uint64(math.MaxInt64)/blockSize {
		return math.MaxInt64, nil
	}
	return int64(availableBlocks * blockSize), nil
}
