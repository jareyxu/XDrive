package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
	"xdrive/internal/db"
	"xdrive/internal/storage"
)

const maxMaintenanceTrashRequestBytes = 12 << 20

type maintenanceTrashRequest struct {
	ExpectedGlobalRevision   int64                        `json:"expectedGlobalRevision"`
	FinalizeTombstoneBuilds  []tombstoneBuildFinalization `json:"finalizeTombstoneBuilds,omitempty"`
	FinalizeTombstoneBuildID string                       `json:"finalizeTombstoneBuildId"`
	CreateTombstoneID        string                       `json:"createTombstoneId"`
	Updates                  []metadataPointerUpdate      `json:"updates"`
	EncryptedObjects         []string                     `json:"encryptedObjects"`
}

func maintenanceTrash(w http.ResponseWriter, r *http.Request, database *db.DB, root string, quota, safety int64) {
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(objectReceiveTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		writeError(w, 500, "receive_deadline_unavailable")
		return
	}
	defer controller.SetReadDeadline(time.Time{})
	r.Body = http.MaxBytesReader(w, r.Body, maxMaintenanceTrashRequestBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, 400, "invalid_request")
		return
	}
	var request maintenanceTrashRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || len(request.Updates) < 2 || len(request.Updates) > maxMetadataUpdates || len(request.EncryptedObjects) != len(request.Updates) {
		writeError(w, 400, "invalid_request")
		return
	}
	ids := make([]string, len(request.Updates))
	for i, update := range request.Updates {
		ids[i] = update.ObjectID
		if update.ExpectedRevision < 1 {
			writeError(w, 400, "invalid_request")
			return
		}
	}
	validation := metadataTransactionRequest{UploadID: ids[0], ExpectedGlobalRevision: request.ExpectedGlobalRevision, ActivateObjectIDs: ids, Updates: request.Updates, FinalizeTombstoneBuildID: request.FinalizeTombstoneBuildID, CreateTombstoneID: request.CreateTombstoneID, FinalizeTombstoneBuilds: request.FinalizeTombstoneBuilds}
	if !validMetadataTransaction(validation) || len(requestedTombstoneBuilds(validation)) == 0 {
		writeError(w, 400, "invalid_request")
		return
	}
	data := make([][]byte, len(request.Updates))
	total := 0
	for i, update := range request.Updates {
		data[i], err = decodeSetupIndex(setupObject{MetadataID: update.MetadataID, ObjectID: update.ObjectID, Revision: 1, EncryptedObject: request.EncryptedObjects[i]})
		if err != nil {
			writeError(w, 400, "invalid_encrypted_index")
			return
		}
	}
	for _, envelope := range data {
		total += len(envelope)
		if total > 8<<20 {
			writeError(w, 413, "maintenance_metadata_limit")
			return
		}
	}
	key := r.Header.Get("Idempotency-Key")
	if !idempotencyKeyPattern.MatchString(key) {
		writeError(w, 400, "invalid_idempotency_key")
		return
	}
	hash := sha256.Sum256(append([]byte("xdrive/maintenance-trash/v1\x00"), body...))
	response, err := runMaintenanceTrash(r.Context(), r, database, root, quota, safety, request, data, key, hash[:])
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

func checkMaintenanceTrash(ctx context.Context, tx rowQueryer, request maintenanceTrashRequest) error {
	var revision int64
	if err := tx.QueryRowContext(ctx, "SELECT vault_mutation_revision FROM server_state WHERE id=1").Scan(&revision); err != nil {
		return err
	}
	if revision != request.ExpectedGlobalRevision {
		return maintenanceReject(409, "vault_mutation_conflict")
	}
	blockedUpdates, err := updatesInsideBuilds(ctx, tx, maintenanceTrashBuilds(request), request.Updates)
	if err != nil {
		return err
	}
	if blockedUpdates {
		return maintenanceReject(409, "metadata_tombstoned")
	}
	for _, update := range request.Updates {
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
	}
	builds := maintenanceTrashBuilds(request)
	ids := make([]string, len(builds))
	for i, build := range builds {
		ids[i] = build.BuildID
	}
	encoded, _ := json.Marshal(ids)
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM tombstone_builds WHERE id IN (SELECT value FROM json_each(?)) AND state='active' AND expires_at>? AND expected_global_revision=?", string(encoded), time.Now().Unix(), request.ExpectedGlobalRevision).Scan(&count); err != nil {
		return err
	}
	if count != len(builds) {
		return maintenanceReject(409, "tombstone_build_unavailable")
	}

	return nil
}

func runMaintenanceTrash(ctx context.Context, r *http.Request, database *db.DB, root string, quota, safety int64, request maintenanceTrashRequest, data [][]byte, key string, hash []byte) ([]byte, error) {
	if replay, err := maintenanceReplay(ctx, database, key, hash); err != nil || replay != nil {
		return replay, err
	}
	lease, err := storage.AcquireDeletionLease(ctx, root)
	if err != nil {
		return nil, err
	}
	defer lease.Close()
	var total int64
	for _, envelope := range data {
		total += int64(len(envelope))
	}
	stage, err := database.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer stage.Rollback()
	if err = checkMaintenanceTrash(ctx, stage, request); err != nil {
		return nil, err
	}
	remaining, err := maintenanceRemaining(ctx, stage)
	if err != nil {
		return nil, err
	}
	if total > remaining {
		return nil, maintenanceReject(507, "maintenance_reserve_exhausted")
	}
	var journalCount int
	if err = stage.QueryRowContext(ctx, "SELECT COUNT(*) FROM metadata_maintenance").Scan(&journalCount); err != nil {
		return nil, err
	}
	if journalCount != 0 {
		return nil, maintenanceReject(409, "maintenance_in_progress")
	}
	var diskBudget int64
	if err = stage.QueryRowContext(ctx, `SELECT COALESCE((SELECT SUM(reserved_bytes-consumed_bytes) FROM upload_sessions WHERE state='active' AND expires_at>?),0)+COALESCE((SELECT SUM(f.expected_size_bytes) FROM upload_receive_fences f JOIN upload_sessions s ON s.id=f.session_id WHERE s.state<>'active' OR s.expires_at<=?),0)`, time.Now().Unix(), time.Now().Unix()).Scan(&diskBudget); err != nil {
		return nil, err
	}
	available, err := availableDiskBytes(root)
	if err != nil {
		return nil, maintenanceReject(507, "storage_unavailable")
	}
	if diskBudget < 0 || diskBudget > available || total > available-diskBudget || safety < 0 || safety > available-diskBudget-total {
		return nil, maintenanceReject(507, "disk_space_low")
	}
	for i, update := range request.Updates {
		var occupied int
		if err = stage.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM objects WHERE id=?)+(SELECT COUNT(*) FROM upload_receive_fences WHERE object_id=?)+(SELECT COUNT(*) FROM upload_object_claims WHERE object_id=?)`, update.ObjectID, update.ObjectID, update.ObjectID).Scan(&occupied); err != nil {
			return nil, err
		}
		if occupied != 0 {
			return nil, maintenanceReject(409, "object_conflict")
		}
		if _, err = stage.ExecContext(ctx, "INSERT INTO metadata_maintenance VALUES(?,?,?,?)", i+1, update.ObjectID, len(data[i]), time.Now().Unix()); err != nil {
			return nil, maintenanceReject(409, "maintenance_in_progress")
		}
	}
	if err = stage.Commit(); err != nil {
		return nil, err
	}
	published := make([]bool, len(request.Updates))
	directories := make([]*storage.ObjectDirectory, len(request.Updates))
	// The whole batch owns one root and one descriptor per distinct shard,
	// rather than two descriptors per candidate. Keep them through rollback.
	var directorySet *storage.ObjectDirectorySet
	defer func() {
		if directorySet != nil {
			_ = directorySet.Close()
		}
	}()
	defer func() {
		clean, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		for i, update := range request.Updates {
			var stored int
			if err := database.QueryRowContext(clean, "SELECT COUNT(*) FROM objects WHERE id=?", update.ObjectID).Scan(&stored); err != nil {
				continue
			}
			if stored == 0 && published[i] {
				if err := removeMaintenanceCandidate(directories[i]); err != nil {
					continue
				}
			}
			_, _ = database.ExecContext(clean, "DELETE FROM metadata_maintenance WHERE object_id=?", update.ObjectID)
		}
	}()
	directorySet, err = storage.OpenObjectDirectorySet(root)
	if err != nil {
		return nil, maintenanceReject(507, "storage_unavailable")
	}
	for i, update := range request.Updates {
		directories[i], err = directorySet.Directory(update.ObjectID)
		if err != nil {
			return nil, maintenanceReject(507, "storage_unavailable")
		}
		if err = publishMaintenanceCandidate(directories[i], data[i], &published[i]); err != nil {
			return nil, err
		}
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if replay, err := maintenanceReplay(ctx, tx, key, hash); err != nil || replay != nil {
		return replay, err
	}
	if err = checkMaintenanceTrash(ctx, tx, request); err != nil {
		return nil, err
	}
	remaining, err = maintenanceRemaining(ctx, tx)
	if err != nil {
		return nil, err
	}
	if total > remaining {
		return nil, maintenanceReject(507, "maintenance_reserve_exhausted")
	}
	now := time.Now().Unix()
	for i, update := range request.Updates {
		digest := sha256.Sum256(data[i])
		if _, err = tx.ExecContext(ctx, "INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,?,?,'live',?)", update.ObjectID, len(data[i]), digest[:], now); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO maintenance_quota_objects VALUES(?)", update.ObjectID); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE metadata_pointers SET object_id=?,revision=?,updated_at=? WHERE id=? AND revision=?", update.ObjectID, update.ExpectedRevision+1, now, update.MetadataID, update.ExpectedRevision); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO metadata_versions VALUES(?,?,?,?)", update.MetadataID, update.ExpectedRevision+1, update.ObjectID, now); err != nil {
			return nil, err
		}
	}
	for _, build := range maintenanceTrashBuilds(request) {
		if err = finalizeTombstoneBuild(tx, r, build.BuildID, build.TombstoneID, request.ExpectedGlobalRevision, now); err != nil {
			if errors.Is(err, errTombstoneOverlap) {
				return nil, maintenanceReject(409, "tombstone_overlap")
			}
			return nil, maintenanceReject(409, "tombstone_build_unavailable")
		}
	}

	// Verify the full invariant after exchanging reserved headroom for live
	// ciphertext. No file/history object is removed to manufacture quota credit.
	remaining, err = maintenanceRemaining(ctx, tx)
	if err != nil {
		return nil, err
	}
	var used, uploads int64
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT SUM(size_bytes) FROM objects WHERE state IN ('live','pending')),0),COALESCE((SELECT SUM(reserved_bytes-consumed_bytes) FROM upload_sessions WHERE state='active' AND expires_at>?),0)`, now).Scan(&used, &uploads); err != nil {
		return nil, err
	}
	if used < 0 || uploads < 0 || used > quota || uploads > quota-used || remaining > quota-used-uploads {
		return nil, maintenanceReject(507, "quota_exceeded")
	}
	if _, err = tx.ExecContext(ctx, "UPDATE server_state SET vault_mutation_revision=? WHERE id=1", request.ExpectedGlobalRevision+1); err != nil {
		return nil, err
	}
	response, err := json.Marshal(metadataTransactionResponse{VaultMutationRevision: request.ExpectedGlobalRevision + 1, ActivatedObjects: len(request.Updates), UpdatedPointers: len(request.Updates)})
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM tx_log WHERE expires_at<=?", now); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO tx_log VALUES(?,?,?,?,?)", key, hash, response, now, now+86400); err != nil {
		return nil, err
	}
	for _, update := range request.Updates {
		if _, err = tx.ExecContext(ctx, "DELETE FROM metadata_maintenance WHERE object_id=?", update.ObjectID); err != nil {
			return nil, err
		}
	}

	for _, directory := range directories {
		if err := directory.Validate(); err != nil {
			return nil, maintenanceReject(507, "storage_unavailable")
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return response, nil
}

func maintenanceTrashBuilds(request maintenanceTrashRequest) []tombstoneBuildFinalization {
	return requestedTombstoneBuilds(metadataTransactionRequest{FinalizeTombstoneBuildID: request.FinalizeTombstoneBuildID, CreateTombstoneID: request.CreateTombstoneID, FinalizeTombstoneBuilds: request.FinalizeTombstoneBuilds})
}
