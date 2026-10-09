package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"time"

	"xdrive/internal/db"
	"xdrive/internal/storage"
)

// This is a bounded temporary metadata candidate, not an upload reservation.
// Only the atomic purge transaction can admit it as a live, quota-counted object.
const maxMaintenanceRequestBytes = 6 << 20

type maintenancePurgeRequest struct {
	ExpectedGlobalRevision int64                   `json:"expectedGlobalRevision"`
	PurgeTombstoneIDs      []string                `json:"purgeTombstoneIds"`
	Updates                []metadataPointerUpdate `json:"updates"`
	EncryptedObject        string                  `json:"encryptedObject"`
}

type maintenanceError struct {
	status int
	code   string
}

func (e maintenanceError) Error() string              { return e.code }
func maintenanceReject(status int, code string) error { return maintenanceError{status, code} }

func maintenancePurge(w http.ResponseWriter, r *http.Request, database *db.DB, storagePath string, quotaBytes, diskSafetyBytes int64) {
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(objectReceiveTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		writeError(w, 500, "receive_deadline_unavailable")
		return
	}
	defer controller.SetReadDeadline(time.Time{})
	r.Body = http.MaxBytesReader(w, r.Body, maxMaintenanceRequestBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, 400, "invalid_request")
		return
	}
	var request maintenancePurgeRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || len(request.Updates) != 1 {
		writeError(w, 400, "invalid_request")
		return
	}
	update := request.Updates[0]
	// Reuse the transaction's ID, count and integer validation; no other action
	// or upload/activation field is accepted by this dedicated protocol.
	validation := metadataTransactionRequest{UploadID: update.ObjectID, ExpectedGlobalRevision: request.ExpectedGlobalRevision, ActivateObjectIDs: []string{update.ObjectID}, Updates: request.Updates, PurgeTombstoneIDs: request.PurgeTombstoneIDs}
	if !validMetadataTransaction(validation) || update.ExpectedRevision < 1 || request.PurgeTombstoneIDs == nil {
		writeError(w, 400, "invalid_request")
		return
	}
	data, err := decodeSetupIndex(setupObject{MetadataID: update.MetadataID, ObjectID: update.ObjectID, Revision: 1, EncryptedObject: request.EncryptedObject})
	if err != nil {
		writeError(w, 400, "invalid_encrypted_index")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if !idempotencyKeyPattern.MatchString(key) {
		writeError(w, 400, "invalid_idempotency_key")
		return
	}
	hash := sha256.Sum256(append([]byte("xdrive/maintenance-purge/v1\x00"), body...))
	response, err := runMaintenancePurge(r.Context(), database, storagePath, quotaBytes, diskSafetyBytes, request, data, key, hash[:])
	if err != nil {
		var failure maintenanceError
		if errors.As(err, &failure) {
			writeError(w, failure.status, failure.code)
		} else {
			writeError(w, 500, "internal_error")
		}
		return
	}
	writeJSON(w, 200, json.RawMessage(response))
}

func maintenanceReplay(ctx context.Context, q rowQueryer, key string, hash []byte) ([]byte, error) {
	var oldHash, response []byte
	err := q.QueryRowContext(ctx, "SELECT request_sha256,response_json FROM tx_log WHERE idempotency_key=? AND expires_at>?", key, time.Now().Unix()).Scan(&oldHash, &response)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !equalBytes(oldHash, hash) {
		return nil, maintenanceReject(409, "idempotency_conflict")
	}
	if !json.Valid(response) {
		return nil, errors.New("invalid saved response")
	}
	return response, nil
}

func checkMaintenanceRevisions(ctx context.Context, tx *sql.Tx, request maintenancePurgeRequest) error {
	var revision int64
	if err := tx.QueryRowContext(ctx, "SELECT vault_mutation_revision FROM server_state WHERE id=1").Scan(&revision); err != nil {
		return err
	}
	if revision != request.ExpectedGlobalRevision {
		return maintenanceReject(409, "vault_mutation_conflict")
	}
	update := request.Updates[0]
	blocked, err := metadataWriteBlocked(ctx, tx, update.MetadataID)
	if err != nil {
		return err
	}
	if blocked {
		return maintenanceReject(409, "metadata_tombstoned")
	}
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM metadata_pointers WHERE id=?", update.MetadataID).Scan(&revision); err != nil || revision != update.ExpectedRevision {
		return maintenanceReject(409, "metadata_revision_conflict")
	}
	return nil
}

func purgeConfirmedRoots(ctx context.Context, tx *sql.Tx, ids []string) error {
	encoded, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	members := string(encoded)
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM tombstones WHERE state='active' AND id IN (SELECT value FROM json_each(?))", members).Scan(&count); err != nil {
		return err
	}
	if count != len(ids) {
		return maintenanceReject(409, "tombstone_unavailable")
	}
	for _, statement := range []string{
		`UPDATE objects SET state='deleted' WHERE state='live' AND id IN (SELECT object_id FROM tombstone_objects WHERE tombstone_id IN (SELECT value FROM json_each(?)))`,
		`DELETE FROM metadata_pointers WHERE id IN (SELECT metadata_id FROM tombstone_metadata WHERE tombstone_id IN (SELECT value FROM json_each(?)))`,
		`DELETE FROM metadata_versions WHERE metadata_id IN (SELECT metadata_id FROM tombstone_metadata WHERE tombstone_id IN (SELECT value FROM json_each(?)))`,
		`DELETE FROM tombstones WHERE id IN (SELECT value FROM json_each(?))`,
	} {
		if _, err := tx.ExecContext(ctx, statement, members); err != nil {
			return err
		}
	}
	return nil
}

func runMaintenancePurge(ctx context.Context, database *db.DB, storagePath string, quotaBytes, diskSafetyBytes int64, request maintenancePurgeRequest, data []byte, key string, hash []byte) ([]byte, error) {
	if replay, err := maintenanceReplay(ctx, database, key, hash); err != nil || replay != nil {
		return replay, err
	}
	// Physical publication and rollback cleanup share the same lease. A backup
	// can therefore snapshot before or after this operation, never lose its object.
	lease, err := storage.AcquireDeletionLease(ctx, storagePath)
	if err != nil {
		return nil, err
	}
	defer lease.Close()
	update := request.Updates[0]
	stage, err := database.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer stage.Rollback()
	if err := checkMaintenanceRevisions(ctx, stage, request); err != nil {
		return nil, err
	}
	var journalCount int
	if err := stage.QueryRowContext(ctx, "SELECT COUNT(*) FROM metadata_maintenance").Scan(&journalCount); err != nil {
		return nil, err
	}
	if journalCount != 0 {
		return nil, maintenanceReject(409, "maintenance_in_progress")
	}
	var existing int
	if err := stage.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM objects WHERE id=?) + (SELECT COUNT(*) FROM upload_receive_fences WHERE object_id=?) + (SELECT COUNT(*) FROM upload_object_claims WHERE object_id=?)`, update.ObjectID, update.ObjectID, update.ObjectID).Scan(&existing); err != nil {
		return nil, err
	}
	if existing != 0 {
		return nil, maintenanceReject(409, "object_conflict")
	}
	var diskBudget int64
	if err := stage.QueryRowContext(ctx, `SELECT COALESCE((SELECT SUM(reserved_bytes-consumed_bytes) FROM upload_sessions WHERE state='active' AND expires_at>?),0) + COALESCE((SELECT SUM(f.expected_size_bytes) FROM upload_receive_fences f JOIN upload_sessions s ON s.id=f.session_id WHERE s.state<>'active' OR s.expires_at<=?),0)`, time.Now().Unix(), time.Now().Unix()).Scan(&diskBudget); err != nil {
		return nil, err
	}
	available, err := availableDiskBytes(storagePath)
	if err != nil {
		return nil, maintenanceReject(507, "storage_unavailable")
	}
	if diskBudget < 0 || diskBudget > available || int64(len(data)) > available-diskBudget || diskSafetyBytes < 0 || diskSafetyBytes > available-diskBudget-int64(len(data)) {
		return nil, maintenanceReject(507, "disk_space_low")
	}
	if _, err := stage.ExecContext(ctx, "INSERT INTO metadata_maintenance(id,object_id,size_bytes,created_at) VALUES(1,?,?,?)", update.ObjectID, len(data), time.Now().Unix()); err != nil {
		return nil, maintenanceReject(409, "maintenance_in_progress")
	}
	if err := stage.Commit(); err != nil {
		return nil, err
	}
	published := false
	var directory *storage.ObjectDirectory
	defer func() {
		if directory != nil {
			_ = directory.Close()
		}
	}()
	defer func() {
		// Commit errors may be ambiguous. Never unlink an object admitted by SQL.
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		var stored int
		if err := database.QueryRowContext(cleanupCtx, "SELECT COUNT(*) FROM objects WHERE id=?", update.ObjectID).Scan(&stored); err != nil {
			return
		}
		if published && stored == 0 {
			if err := removeMaintenanceCandidate(directory); err != nil {
				return
			}
		}
		_, _ = database.ExecContext(cleanupCtx, "DELETE FROM metadata_maintenance WHERE object_id=?", update.ObjectID)
	}()
	directory, err = storage.OpenObjectDirectory(storagePath, update.ObjectID, true)
	if err != nil {
		return nil, maintenanceReject(507, "storage_unavailable")
	}
	if err := publishMaintenanceCandidate(directory, data, &published); err != nil {
		return nil, err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if replay, err := maintenanceReplay(ctx, tx, key, hash); err != nil || replay != nil {
		return replay, err
	}
	if err := checkMaintenanceRevisions(ctx, tx, request); err != nil {
		return nil, err
	}
	if err := purgeConfirmedRoots(ctx, tx, request.PurgeTombstoneIDs); err != nil {
		return nil, err
	}
	// Retained metadata history is still charged. Only deleted live members
	// provide credit, and all concurrent outstanding uploads remain charged.
	var used, reserved int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT SUM(size_bytes) FROM objects WHERE state IN ('live','pending')),0),COALESCE((SELECT SUM(reserved_bytes-consumed_bytes) FROM upload_sessions WHERE state='active' AND expires_at>?),0)`, time.Now().Unix()).Scan(&used, &reserved); err != nil {
		return nil, err
	}
	maintenanceReserve, err := maintenanceRemaining(ctx, tx)
	if err != nil {
		return nil, err
	}
	reserved += maintenanceReserve
	if used < 0 || reserved < 0 || used > quotaBytes || reserved > quotaBytes-used || int64(len(data)) > quotaBytes-used-reserved {
		return nil, maintenanceReject(507, "quota_exceeded")
	}
	// Do not allow a generic pointer already owned by the purged subtree.
	var pointerCount int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM metadata_pointers WHERE id=?", update.MetadataID).Scan(&pointerCount); err != nil {
		return nil, err
	}
	if pointerCount != 1 {
		return nil, maintenanceReject(409, "metadata_tombstoned")
	}
	digest := sha256.Sum256(data)
	now := time.Now().Unix()
	if _, err := tx.ExecContext(ctx, "INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,?,?,'live',?)", update.ObjectID, len(data), digest[:], now); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE metadata_pointers SET object_id=?,revision=?,updated_at=? WHERE id=? AND revision=?", update.ObjectID, update.ExpectedRevision+1, now, update.MetadataID, update.ExpectedRevision); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO metadata_versions(metadata_id,revision,object_id,created_at) VALUES(?,?,?,?)", update.MetadataID, update.ExpectedRevision+1, update.ObjectID, now); err != nil {
		return nil, err
	}
	if request.ExpectedGlobalRevision == math.MaxInt64 {
		return nil, maintenanceReject(400, "invalid_request")
	}
	if _, err := tx.ExecContext(ctx, "UPDATE server_state SET vault_mutation_revision=? WHERE id=1", request.ExpectedGlobalRevision+1); err != nil {
		return nil, err
	}
	response, err := json.Marshal(metadataTransactionResponse{VaultMutationRevision: request.ExpectedGlobalRevision + 1, ActivatedObjects: 1, UpdatedPointers: 1})
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM tx_log WHERE expires_at<=?", now); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO tx_log VALUES(?,?,?,?,?)", key, hash, response, now, now+86400); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM metadata_maintenance WHERE object_id=?", update.ObjectID); err != nil {
		return nil, err
	}
	if err := directory.Validate(); err != nil {
		return nil, maintenanceReject(507, "storage_unavailable")
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return response, nil
}

func publishMaintenanceObject(root, id string, data []byte, published *bool) error {
	directory, err := storage.OpenObjectDirectory(root, id, true)
	if err != nil {
		return err
	}
	defer directory.Close()
	return publishMaintenanceCandidate(directory, data, published)
}
func publishMaintenanceCandidate(directory *storage.ObjectDirectory, data []byte, published *bool) error {
	file, name, err := directory.CreateTemporary()
	if err != nil {
		return err
	}
	defer func() {
		if err := directory.RemoveTemporary(name); err == nil {
			_ = directory.Sync()
		}
	}()
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := directory.PublishTemporaryTracked(name, published); err != nil {
		return err
	}
	if err := directory.RemoveTemporary(name); err != nil {
		return err
	}
	if err := directory.Sync(); err != nil {
		return err
	}
	return directory.Validate()
}
func removeMaintenanceCandidate(directory *storage.ObjectDirectory) error {
	if directory == nil {
		return errors.New("missing owned maintenance directory")
	}
	if err := directory.RemoveObject(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return directory.Sync()
}
