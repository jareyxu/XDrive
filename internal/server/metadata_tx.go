package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"time"

	"xdrive/internal/db"
	"xdrive/internal/storage"
)

const (
	maxMetadataTransactionBytes = 2 << 20
	maxTransactionObjects       = 4096
	maxMetadataUpdates          = 500
	maxEncryptedMetadataBytes   = maxIndexObject
)

var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

type tombstoneBuildFinalization struct {
	BuildID     string `json:"buildId"`
	TombstoneID string `json:"tombstoneId"`
}

type metadataTransactionRequest struct {
	UploadID                 string                       `json:"uploadId"`
	ExpectedGlobalRevision   int64                        `json:"expectedGlobalRevision"`
	ActivateObjectIDs        []string                     `json:"activateObjectIds"`
	Updates                  []metadataPointerUpdate      `json:"updates"`
	FinalizeTombstoneBuilds  []tombstoneBuildFinalization `json:"finalizeTombstoneBuilds,omitempty"`
	FinalizeTombstoneBuildID string                       `json:"finalizeTombstoneBuildId,omitempty"`
	CreateTombstoneID        string                       `json:"createTombstoneId,omitempty"`
	RestoreTombstoneID       string                       `json:"restoreTombstoneId,omitempty"`
	RestoreTombstoneIDs      []string                     `json:"restoreTombstoneIds,omitempty"`
	PurgeTombstoneID         string                       `json:"purgeTombstoneId,omitempty"`
	PurgeTombstoneIDs        []string                     `json:"purgeTombstoneIds,omitempty"`
}

type metadataPointerUpdate struct {
	MetadataID       string `json:"metadataId"`
	ExpectedRevision int64  `json:"expectedRevision"`
	ObjectID         string `json:"objectId"`
}

type metadataTransactionResponse struct {
	VaultMutationRevision int64 `json:"vaultMutationRevision"`
	ActivatedObjects      int   `json:"activatedObjects"`
	UpdatedPointers       int   `json:"updatedPointers"`
}

func metadataTransaction(w http.ResponseWriter, r *http.Request, database *db.DB, storagePath string) {
	r.Body = http.MaxBytesReader(w, r.Body, maxMetadataTransactionBytes)
	body, err := io.ReadAll(io.LimitReader(r.Body, maxMetadataTransactionBytes+1))
	if err != nil || len(body) > maxMetadataTransactionBytes {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	var request metadataTransactionRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || !validMetadataTransaction(request) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	idempotencyKey := r.Header.Get("Idempotency-Key")
	if !idempotencyKeyPattern.MatchString(idempotencyKey) {
		writeError(w, http.StatusBadRequest, "invalid_idempotency_key")
		return
	}
	requestHash := sha256.Sum256(body)
	tx, err := database.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM tx_log WHERE expires_at <= ?", now); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	var priorHash, priorResponse []byte
	err = tx.QueryRowContext(r.Context(), `SELECT request_sha256, response_json FROM tx_log
		WHERE idempotency_key = ? AND expires_at > ?`, idempotencyKey, now).Scan(&priorHash, &priorResponse)
	if err == nil {
		if !equalBytes(priorHash, requestHash[:]) {
			writeError(w, http.StatusConflict, "idempotency_conflict")
			return
		}
		if json.Valid(priorResponse) {
			writeJSON(w, http.StatusOK, json.RawMessage(priorResponse))
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	var globalRevision int64
	if err := tx.QueryRowContext(r.Context(), "SELECT vault_mutation_revision FROM server_state WHERE id = 1").Scan(&globalRevision); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if globalRevision != request.ExpectedGlobalRevision {
		writeError(w, http.StatusConflict, "vault_mutation_conflict")
		return
	}
	if len(requestedTombstoneBuilds(request)) > 0 {
		blocked, err := updatesInsideBuilds(r.Context(), tx, requestedTombstoneBuilds(request), request.Updates)
		if err != nil {
			writeError(w, 500, "internal_error")
			return
		}
		if blocked {
			writeError(w, 409, "metadata_tombstoned")
			return
		}
	}

	restoreIDs := request.RestoreTombstoneIDs
	if request.RestoreTombstoneID != "" {
		restoreIDs = []string{request.RestoreTombstoneID}
	}
	if len(restoreIDs) > 0 {
		encoded, _ := json.Marshal(restoreIDs)
		result, err := tx.ExecContext(r.Context(), "DELETE FROM tombstones WHERE state='active' AND id IN (SELECT value FROM json_each(?))", string(encoded))
		if err != nil {
			writeError(w, 500, "internal_error")
			return
		}
		if count, _ := result.RowsAffected(); count != int64(len(restoreIDs)) {
			writeError(w, 409, "tombstone_unavailable")
			return
		}
	}
	var sessionState string
	var reserved, consumed, expires int64
	if err := tx.QueryRowContext(r.Context(), `SELECT state, reserved_bytes, consumed_bytes, expires_at
		FROM upload_sessions WHERE id = ?`, request.UploadID).Scan(&sessionState, &reserved, &consumed, &expires); err != nil || sessionState != "active" || expires <= now {
		writeError(w, http.StatusConflict, "upload_unavailable")
		return
	}
	var receivingObjects int
	if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM upload_receive_fences WHERE session_id = ?", request.UploadID).Scan(&receivingObjects); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if receivingObjects != 0 {
		writeError(w, http.StatusConflict, "object_receive_in_progress")
		return
	}
	var pendingBytes int64
	if err := tx.QueryRowContext(r.Context(), `SELECT COALESCE(SUM(size_bytes), 0) FROM objects
		WHERE upload_session_id = ? AND state = 'pending'`, request.UploadID).Scan(&pendingBytes); err != nil || pendingBytes != consumed {
		writeError(w, http.StatusConflict, "upload_state_mismatch")
		return
	}
	activationSet := make(map[string]struct{}, len(request.ActivateObjectIDs))
	for _, objectID := range request.ActivateObjectIDs {
		activationSet[objectID] = struct{}{}
	}
	rows, err := tx.QueryContext(r.Context(), "SELECT id FROM objects WHERE upload_session_id = ? AND state = 'pending'", request.UploadID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	var unactivatedObjectIDs []string
	for rows.Next() {
		var objectID string
		if err := rows.Scan(&objectID); err != nil {
			_ = rows.Close()
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		if _, activated := activationSet[objectID]; !activated {
			unactivatedObjectIDs = append(unactivatedObjectIDs, objectID)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := rows.Close(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	for _, objectID := range request.ActivateObjectIDs {
		var state string
		var owner sql.NullString
		if err := tx.QueryRowContext(r.Context(), "SELECT state, upload_session_id FROM objects WHERE id = ?", objectID).Scan(&state, &owner); err != nil || state != "pending" || !owner.Valid || owner.String != request.UploadID {
			writeError(w, http.StatusConflict, "object_unavailable")
			return
		}
	}
	for _, update := range request.Updates {
		blocked, err := metadataWriteBlocked(r.Context(), tx, update.MetadataID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		if blocked {
			writeError(w, http.StatusConflict, "metadata_tombstoned")
			return
		}
		var currentObjectID string
		var currentRevision int64
		err = tx.QueryRowContext(r.Context(), "SELECT object_id, revision FROM metadata_pointers WHERE id = ?", update.MetadataID).Scan(&currentObjectID, &currentRevision)
		if update.ExpectedRevision == 0 {
			if !errors.Is(err, sql.ErrNoRows) {
				writeError(w, http.StatusConflict, "metadata_revision_conflict")
				return
			}
		} else if err != nil || currentRevision != update.ExpectedRevision {
			writeError(w, http.StatusConflict, "metadata_revision_conflict")
			return
		}
		var objectState string
		var objectSize int64
		if err := tx.QueryRowContext(r.Context(), "SELECT state, size_bytes FROM objects WHERE id = ?", update.ObjectID).Scan(&objectState, &objectSize); err != nil || (objectState != "live" && objectState != "pending") {
			writeError(w, http.StatusConflict, "object_unavailable")
			return
		}
		if objectSize > maxEncryptedMetadataBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "metadata_object_too_large")
			return
		}
		if objectState == "pending" && !containsID(request.ActivateObjectIDs, update.ObjectID) {
			writeError(w, http.StatusConflict, "object_not_activated")
			return
		}
		if update.ExpectedRevision == 0 {
			if _, err := tx.ExecContext(r.Context(), "INSERT INTO metadata_pointers (id, object_id, revision, updated_at) VALUES (?, ?, 1, ?)", update.MetadataID, update.ObjectID, now); err != nil {
				writeError(w, http.StatusConflict, "metadata_revision_conflict")
				return
			}
			if _, err := tx.ExecContext(r.Context(), "INSERT INTO metadata_versions (metadata_id, revision, object_id, created_at) VALUES (?, 1, ?, ?)", update.MetadataID, update.ObjectID, now); err != nil {
				writeError(w, http.StatusInternalServerError, "internal_error")
				return
			}
		} else {
			newRevision := update.ExpectedRevision + 1
			result, err := tx.ExecContext(r.Context(), "UPDATE metadata_pointers SET object_id = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?", update.ObjectID, newRevision, now, update.MetadataID, update.ExpectedRevision)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal_error")
				return
			}
			changed, _ := result.RowsAffected()
			if changed != 1 {
				writeError(w, http.StatusConflict, "metadata_revision_conflict")
				return
			}
			if _, err := tx.ExecContext(r.Context(), "INSERT INTO metadata_versions (metadata_id, revision, object_id, created_at) VALUES (?, ?, ?, ?)", update.MetadataID, newRevision, update.ObjectID, now); err != nil {
				writeError(w, http.StatusInternalServerError, "internal_error")
				return
			}
		}
	}
	for _, objectID := range request.ActivateObjectIDs {
		result, err := tx.ExecContext(r.Context(), "UPDATE objects SET state = 'live', upload_session_id = NULL WHERE id = ? AND state = 'pending' AND upload_session_id = ?", objectID, request.UploadID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		changed, _ := result.RowsAffected()
		if changed != 1 {
			writeError(w, http.StatusConflict, "object_unavailable")
			return
		}
	}
	for _, build := range requestedTombstoneBuilds(request) {
		if err := finalizeTombstoneBuild(tx, r, build.BuildID, build.TombstoneID, globalRevision, now); err != nil {
			if errors.Is(err, errTombstoneOverlap) {
				writeError(w, http.StatusConflict, "tombstone_overlap")
			} else {
				writeError(w, http.StatusConflict, "tombstone_build_unavailable")
			}
			return
		}
	}

	var purgeIDs = request.PurgeTombstoneIDs
	if request.PurgeTombstoneID != "" {
		purgeIDs = []string{request.PurgeTombstoneID}
	}
	if len(purgeIDs) > 0 {
		if err := purgeConfirmedRoots(r.Context(), tx, purgeIDs); err != nil {
			var failure maintenanceError
			if errors.As(err, &failure) {
				writeError(w, failure.status, failure.code)
			} else {
				writeError(w, http.StatusInternalServerError, "internal_error")
			}
			return
		}
	}

	if _, err := tx.ExecContext(r.Context(), `UPDATE objects SET state = 'deleted' WHERE upload_session_id = ? AND state = 'pending'`, request.UploadID); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	// Receivers not selected for activation must retain their object-ID fence
	// until they observe this closed session and finish cleaning temporary files.
	if _, err := tx.ExecContext(r.Context(), "UPDATE upload_sessions SET state = 'committed', reserved_bytes = consumed_bytes WHERE id = ?", request.UploadID); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	newGlobalRevision := globalRevision + 1
	if _, err := tx.ExecContext(r.Context(), "UPDATE server_state SET vault_mutation_revision = ? WHERE id = ? AND vault_mutation_revision = ?", newGlobalRevision, 1, globalRevision); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	result := metadataTransactionResponse{VaultMutationRevision: newGlobalRevision, ActivatedObjects: len(request.ActivateObjectIDs), UpdatedPointers: len(request.Updates)}
	responseJSON, err := json.Marshal(result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO tx_log
		(idempotency_key, request_sha256, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, idempotencyKey, requestHash[:], responseJSON, now, now+24*60*60); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	for _, objectID := range unactivatedObjectIDs {
		_ = storage.RemoveObjectFile(storagePath, objectID)
	}
	writeJSON(w, http.StatusOK, result)
}

type rowQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func metadataWriteBlocked(ctx context.Context, queryer rowQueryer, metadataID string) (bool, error) {
	var count int
	err := queryer.QueryRowContext(ctx, `SELECT COUNT(*) FROM tombstone_metadata m JOIN tombstones t ON t.id = m.tombstone_id
		WHERE m.metadata_id = ? AND t.state = 'active'`, metadataID).Scan(&count)
	return count > 0, err
}

func validMetadataTransaction(request metadataTransactionRequest) bool {
	if !opaqueIDPattern.MatchString(request.UploadID) || request.ExpectedGlobalRevision < 0 || request.ExpectedGlobalRevision == int64(^uint64(0)>>1) || len(request.ActivateObjectIDs) == 0 || len(request.ActivateObjectIDs) > maxTransactionObjects || len(request.Updates) == 0 || len(request.Updates) > maxMetadataUpdates {
		return false
	}
	seenObjects := make(map[string]struct{}, len(request.ActivateObjectIDs))
	for _, id := range request.ActivateObjectIDs {
		if !opaqueIDPattern.MatchString(id) {
			return false
		}
		if _, exists := seenObjects[id]; exists {
			return false
		}
		seenObjects[id] = struct{}{}
	}
	seenMetadata := make(map[string]struct{}, len(request.Updates))
	for _, update := range request.Updates {
		if !opaqueIDPattern.MatchString(update.MetadataID) || !opaqueIDPattern.MatchString(update.ObjectID) || update.ExpectedRevision < 0 || update.ExpectedRevision == int64(^uint64(0)>>1) {
			return false
		}
		if _, exists := seenMetadata[update.MetadataID]; exists {
			return false
		}
		seenMetadata[update.MetadataID] = struct{}{}
	}
	if (request.FinalizeTombstoneBuildID == "") != (request.CreateTombstoneID == "") ||
		(request.FinalizeTombstoneBuildID != "" && (!opaqueIDPattern.MatchString(request.FinalizeTombstoneBuildID) || !opaqueIDPattern.MatchString(request.CreateTombstoneID))) ||
		(request.RestoreTombstoneID != "" && !opaqueIDPattern.MatchString(request.RestoreTombstoneID)) ||
		(request.PurgeTombstoneID != "" && !opaqueIDPattern.MatchString(request.PurgeTombstoneID)) {
		return false
	}
	if request.FinalizeTombstoneBuilds != nil {
		if len(request.FinalizeTombstoneBuilds) < 1 || len(request.FinalizeTombstoneBuilds) > 5000 {
			return false
		}
		builds, roots := make(map[string]bool), make(map[string]bool)
		for _, build := range request.FinalizeTombstoneBuilds {
			if !opaqueIDPattern.MatchString(build.BuildID) || !opaqueIDPattern.MatchString(build.TombstoneID) || builds[build.BuildID] || roots[build.TombstoneID] {
				return false
			}
			builds[build.BuildID] = true
			roots[build.TombstoneID] = true
		}
	}
	if request.RestoreTombstoneIDs != nil {
		if len(request.RestoreTombstoneIDs) < 1 || len(request.RestoreTombstoneIDs) > 5000 {
			return false
		}
		seen := make(map[string]bool)
		for _, id := range request.RestoreTombstoneIDs {
			if !opaqueIDPattern.MatchString(id) || seen[id] {
				return false
			}
			seen[id] = true
		}
	}
	if request.PurgeTombstoneIDs != nil {
		if len(request.PurgeTombstoneIDs) == 0 || len(request.PurgeTombstoneIDs) > 5000 {
			return false
		}
		seen := make(map[string]struct{}, len(request.PurgeTombstoneIDs))
		for _, id := range request.PurgeTombstoneIDs {
			if !opaqueIDPattern.MatchString(id) {
				return false
			}
			if _, exists := seen[id]; exists {
				return false
			}
			seen[id] = struct{}{}
		}
	}
	actions := 0
	if request.FinalizeTombstoneBuilds != nil {
		actions++
	}
	if request.RestoreTombstoneIDs != nil {
		actions++
	}
	if len(request.PurgeTombstoneIDs) > 0 {
		actions++
	}
	if request.FinalizeTombstoneBuildID != "" {
		actions++
	}
	if request.RestoreTombstoneID != "" {
		actions++
	}
	if request.PurgeTombstoneID != "" {
		actions++
	}
	if actions > 1 {
		return false
	}
	return true
}

func containsID(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func requestedTombstoneBuilds(request metadataTransactionRequest) []tombstoneBuildFinalization {
	if request.FinalizeTombstoneBuildID != "" {
		return []tombstoneBuildFinalization{{BuildID: request.FinalizeTombstoneBuildID, TombstoneID: request.CreateTombstoneID}}
	}
	return request.FinalizeTombstoneBuilds
}

func updatesInsideBuilds(ctx context.Context, tx rowQueryer, builds []tombstoneBuildFinalization, updates []metadataPointerUpdate) (bool, error) {
	ids := make([]string, len(builds))
	for i, build := range builds {
		ids[i] = build.BuildID
	}
	metadata := make([]string, len(updates))
	for i, update := range updates {
		metadata[i] = update.MetadataID
	}
	encodedBuilds, _ := json.Marshal(ids)
	encodedMetadata, _ := json.Marshal(metadata)
	var blocked bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM tombstone_build_members WHERE member_type='metadata' AND build_id IN (SELECT value FROM json_each(?)) AND opaque_id IN (SELECT value FROM json_each(?)))`, string(encodedBuilds), string(encodedMetadata)).Scan(&blocked)
	return blocked, err
}
