package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"xdrive/internal/db"
)

const (
	tombstoneBuildLifetime = time.Hour
	maxTombstoneBatch      = 1000
	maxTombstoneRequest    = 128 << 10
)

type tombstoneBuildMember struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func createTombstoneBuild(w http.ResponseWriter, r *http.Request, database *db.DB) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var request struct {
		ExpectedGlobalRevision int64 `json:"expectedGlobalRevision"`
	}
	if decodeJSON(r, &request) != nil || request.ExpectedGlobalRevision < 0 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	id, err := randomOpaqueID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	now := time.Now()
	tx, err := database.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	defer tx.Rollback()
	var currentRevision int64
	if err := tx.QueryRowContext(r.Context(), "SELECT vault_mutation_revision FROM server_state WHERE id = 1").Scan(&currentRevision); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if currentRevision != request.ExpectedGlobalRevision {
		writeError(w, http.StatusConflict, "vault_mutation_conflict")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `DELETE FROM tombstone_builds WHERE state = 'active' AND expires_at <= ?`, now.Unix()); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO tombstone_builds (id, state, created_at, expires_at, expected_global_revision)
		VALUES (?, 'active', ?, ?, ?)`, id, now.Unix(), now.Add(tombstoneBuildLifetime).Unix(), request.ExpectedGlobalRevision); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"buildId": id, "expiresAt": now.Add(tombstoneBuildLifetime).Unix()})
}

func addTombstoneBuildMembers(w http.ResponseWriter, r *http.Request, database *db.DB) {
	r.Body = http.MaxBytesReader(w, r.Body, maxTombstoneRequest)
	body, err := io.ReadAll(io.LimitReader(r.Body, maxTombstoneRequest+1))
	if err != nil || len(body) > maxTombstoneRequest {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	var request struct {
		Members []tombstoneBuildMember `json:"members"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || len(request.Members) == 0 || len(request.Members) > maxTombstoneBatch {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	for _, member := range request.Members {
		if (member.Type != "object" && member.Type != "metadata") || !opaqueIDPattern.MatchString(member.ID) {
			writeError(w, http.StatusBadRequest, "invalid_member")
			return
		}
	}
	id := r.PathValue("id")
	if !opaqueIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	tx, err := database.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	defer tx.Rollback()
	var state string
	var expires int64
	if err := tx.QueryRowContext(r.Context(), "SELECT state, expires_at FROM tombstone_builds WHERE id = ?", id).Scan(&state, &expires); err != nil || state != "active" || expires <= time.Now().Unix() {
		writeError(w, http.StatusConflict, "tombstone_build_unavailable")
		return
	}
	for _, member := range request.Members {
		if member.Type == "object" {
			var objectState string
			if err := tx.QueryRowContext(r.Context(), "SELECT state FROM objects WHERE id = ?", member.ID).Scan(&objectState); err != nil || objectState != "live" {
				writeError(w, http.StatusConflict, "tombstone_member_unavailable")
				return
			}
		} else {
			var pointerCount int
			if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM metadata_pointers WHERE id = ?", member.ID).Scan(&pointerCount); err != nil || pointerCount != 1 {
				writeError(w, http.StatusConflict, "tombstone_member_unavailable")
				return
			}
		}
		if _, err := tx.ExecContext(r.Context(), "INSERT OR IGNORE INTO tombstone_build_members (build_id, member_type, opaque_id) VALUES (?, ?, ?)", id, member.Type, member.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"accepted": len(request.Members)})
}

func cancelTombstoneBuild(w http.ResponseWriter, r *http.Request, database *db.DB) {
	id := r.PathValue("id")
	if !opaqueIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	result, err := database.ExecContext(r.Context(), "UPDATE tombstone_builds SET state = 'cancelled' WHERE id = ? AND state = 'active'", id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	changed, err := result.RowsAffected()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if changed == 0 {
		var exists int
		if err := database.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM tombstone_builds WHERE id = ?", id).Scan(&exists); err != nil || exists == 0 {
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
	}
	_, _ = database.ExecContext(r.Context(), "DELETE FROM tombstone_build_members WHERE build_id = ?", id)
	w.WriteHeader(http.StatusNoContent)
}

func finalizeTombstoneBuild(tx *sql.Tx, r *http.Request, buildID, tombstoneID string, expectedGlobalRevision int64, now int64) error {
	if !opaqueIDPattern.MatchString(buildID) || !opaqueIDPattern.MatchString(tombstoneID) {
		return errInvalidTombstoneBuild
	}
	var state string
	var expires, buildRevision int64
	if err := tx.QueryRowContext(r.Context(), "SELECT state, expires_at, expected_global_revision FROM tombstone_builds WHERE id = ?", buildID).Scan(&state, &expires, &buildRevision); err != nil || state != "active" || expires <= now || buildRevision != expectedGlobalRevision {
		return errInvalidTombstoneBuild
	}
	var count int
	if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM tombstone_build_members WHERE build_id = ?", buildID).Scan(&count); err != nil || count == 0 {
		return errInvalidTombstoneBuild
	}
	if _, err := tx.ExecContext(r.Context(), "INSERT INTO tombstones (id, deleted_at, state) VALUES (?, ?, 'active')", tombstoneID, now); err != nil {
		return err
	}
	var overlap int
	if err := tx.QueryRowContext(r.Context(), `SELECT
		(SELECT COUNT(*) FROM tombstone_build_members b JOIN tombstone_objects t ON b.opaque_id = t.object_id JOIN tombstones x ON x.id = t.tombstone_id AND x.state = 'active' WHERE b.build_id = ? AND b.member_type = 'object') +
		(SELECT COUNT(*) FROM tombstone_build_members b JOIN tombstone_metadata t ON b.opaque_id = t.metadata_id JOIN tombstones x ON x.id = t.tombstone_id AND x.state = 'active' WHERE b.build_id = ? AND b.member_type = 'metadata')`, buildID, buildID).Scan(&overlap); err != nil || overlap > 0 {
		return errTombstoneOverlap
	}
	var unavailable int
	if err := tx.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM tombstone_build_members b
		LEFT JOIN objects o ON b.member_type = 'object' AND o.id = b.opaque_id
		LEFT JOIN metadata_pointers p ON b.member_type = 'metadata' AND p.id = b.opaque_id
		WHERE b.build_id = ? AND ((b.member_type = 'object' AND (o.id IS NULL OR o.state <> 'live')) OR (b.member_type = 'metadata' AND p.id IS NULL))`, buildID).Scan(&unavailable); err != nil || unavailable > 0 {
		return errInvalidTombstoneBuild
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO tombstone_objects (tombstone_id, object_id)
		SELECT ?, opaque_id FROM tombstone_build_members WHERE build_id = ? AND member_type = 'object'`, tombstoneID, buildID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT OR IGNORE INTO tombstone_objects (tombstone_id, object_id)
		SELECT ?, v.object_id FROM metadata_versions v JOIN tombstone_build_members b ON b.opaque_id = v.metadata_id
		WHERE b.build_id = ? AND b.member_type = 'metadata'`, tombstoneID, buildID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO tombstone_metadata (tombstone_id, metadata_id)
		SELECT ?, opaque_id FROM tombstone_build_members WHERE build_id = ? AND member_type = 'metadata'`, tombstoneID, buildID); err != nil {
		return err
	}
	_, err := tx.ExecContext(r.Context(), "UPDATE tombstone_builds SET state = 'finalized' WHERE id = ? AND state = 'active'", buildID)
	return err
}

var (
	errInvalidTombstoneBuild = errors.New("invalid or expired tombstone build")
	errTombstoneOverlap      = errors.New("tombstone membership overlaps an active tombstone")
)
