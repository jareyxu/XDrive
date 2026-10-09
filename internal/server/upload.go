package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"xdrive/internal/db"
	"xdrive/internal/storage"
)

const (
	objectReceiveTimeout = 10 * time.Minute
)

type uploadDestinationWriter struct {
	destination io.Writer
	writeErr    error
}

func (w *uploadDestinationWriter) Write(p []byte) (int, error) {
	n, err := w.destination.Write(p)
	if err != nil {
		w.writeErr = err
	} else if n != len(p) {
		w.writeErr = io.ErrShortWrite
	}
	return n, err
}

func receiveUploadBody(destination io.Writer, digest io.Writer, body io.Reader, declaredSize int64) (written int64, copyErr, storageErr error) {
	trackedDestination := &uploadDestinationWriter{destination: destination}
	written, copyErr = io.Copy(io.MultiWriter(trackedDestination, digest), io.LimitReader(body, declaredSize+1))
	return written, copyErr, trackedDestination.writeErr
}

func createUpload(w http.ResponseWriter, r *http.Request, database *db.DB, uploadExpiry time.Duration) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var request struct{}
	if decodeJSON(r, &request) != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	id, err := randomOpaqueID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	now := time.Now()
	expiresAt := now.Add(uploadExpiry).Unix()
	if _, err := database.ExecContext(r.Context(), `INSERT INTO upload_sessions
		(id, state, reserved_bytes, consumed_bytes, created_at, expires_at) VALUES (?, 'active', 0, 0, ?, ?)`, id, now.Unix(), expiresAt); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"uploadId": id, "expiresAt": expiresAt})
}

type uploadStatusObject struct {
	ObjectID  string `json:"objectId"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

func getUpload(w http.ResponseWriter, r *http.Request, database *db.DB) {
	id := r.PathValue("id")
	if !opaqueIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	tx, err := database.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	defer tx.Rollback()
	var state string
	var reserved, consumed, expires int64
	if err := tx.QueryRowContext(r.Context(), `SELECT state, reserved_bytes, consumed_bytes, expires_at
		FROM upload_sessions WHERE id = ?`, id).Scan(&state, &reserved, &consumed, &expires); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "upload_unavailable")
		} else {
			writeError(w, http.StatusInternalServerError, "internal_error")
		}
		return
	}
	if state == "active" && expires <= time.Now().Unix() {
		state = "expired"
	}
	objects := make([]uploadStatusObject, 0)
	rows, err := tx.QueryContext(r.Context(), `SELECT id, size_bytes, sha256 FROM objects
		WHERE upload_session_id = ? AND state = 'pending' ORDER BY id LIMIT 4097`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	for rows.Next() {
		var item uploadStatusObject
		var digest []byte
		if err := rows.Scan(&item.ObjectID, &item.SizeBytes, &digest); err != nil {
			_ = rows.Close()
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		item.SHA256 = hex.EncodeToString(digest)
		objects = append(objects, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	_ = rows.Close()
	if len(objects) > 4096 {
		writeError(w, http.StatusConflict, "upload_state_too_large")
		return
	}
	claims := make([]uploadStatusObject, 0)
	claimRows, err := tx.QueryContext(r.Context(), `SELECT object_id, expected_size_bytes, expected_sha256
		FROM upload_object_claims WHERE session_id = ? ORDER BY object_id LIMIT 4097`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	for claimRows.Next() {
		var item uploadStatusObject
		var digest []byte
		if err := claimRows.Scan(&item.ObjectID, &item.SizeBytes, &digest); err != nil {
			_ = claimRows.Close()
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		item.SHA256 = hex.EncodeToString(digest)
		claims = append(claims, item)
	}
	if err := claimRows.Err(); err != nil {
		_ = claimRows.Close()
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	_ = claimRows.Close()
	if len(claims) > 4096 {
		writeError(w, http.StatusConflict, "upload_state_too_large")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"uploadId": id, "state": state, "reservedBytes": reserved,
		"consumedBytes": consumed, "expiresAt": expires, "objects": objects, "claims": claims,
	})
}

func abandonUploadObject(w http.ResponseWriter, r *http.Request, database *db.DB, storagePath string) {
	sessionID, objectID := r.PathValue("id"), r.PathValue("objectId")
	if !opaqueIDPattern.MatchString(sessionID) || !opaqueIDPattern.MatchString(objectID) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	tx, err := database.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	defer tx.Rollback()
	var sessionState string
	var expires int64
	if err := tx.QueryRowContext(r.Context(), "SELECT state, expires_at FROM upload_sessions WHERE id = ?", sessionID).Scan(&sessionState, &expires); err != nil || sessionState != "active" || expires <= time.Now().Unix() {
		writeError(w, http.StatusNotFound, "upload_unavailable")
		return
	}
	var objectState string
	var owner sql.NullString
	var size int64
	err = tx.QueryRowContext(r.Context(), "SELECT state, upload_session_id, size_bytes FROM objects WHERE id = ?", objectID).Scan(&objectState, &owner, &size)
	if errors.Is(err, sql.ErrNoRows) {
		var claimed int
		if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM upload_object_claims WHERE session_id = ? AND object_id = ?", sessionID, objectID).Scan(&claimed); err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		if claimed > 0 {
			writeError(w, http.StatusConflict, "object_receive_in_progress")
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if !owner.Valid || owner.String != sessionID {
		writeError(w, http.StatusConflict, "object_conflict")
		return
	}
	if objectState == "deleted" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if objectState != "pending" {
		writeError(w, http.StatusConflict, "object_conflict")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE objects SET state = 'deleted' WHERE id = ? AND state = 'pending' AND upload_session_id = ?", objectID, sessionID); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	result, err := tx.ExecContext(r.Context(), "UPDATE upload_sessions SET consumed_bytes = consumed_bytes - ? WHERE id = ? AND consumed_bytes >= ?", size, sessionID, size)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		writeError(w, http.StatusConflict, "upload_state_mismatch")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	_ = storage.RemoveObjectFile(storagePath, objectID)
	w.WriteHeader(http.StatusNoContent)
}

func reserveUpload(w http.ResponseWriter, r *http.Request, database *db.DB, quotaBytes int64, storagePath string, diskSafetyBytes int64) {
	var request struct {
		ReservedBytes int64 `json:"reservedBytes"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if decodeJSON(r, &request) != nil || request.ReservedBytes < 0 {
		writeError(w, http.StatusBadRequest, "invalid_reservation")
		return
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
	now := time.Now().Unix()
	if _, err := tx.ExecContext(r.Context(), `UPDATE upload_sessions SET state = 'expired'
		WHERE state = 'active' AND expires_at <= ?`, now); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM upload_object_claims WHERE session_id IN (SELECT id FROM upload_sessions WHERE state <> 'active')"); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	var state string
	var currentReserved, consumed int64
	var expires int64
	if err := tx.QueryRowContext(r.Context(), `SELECT state, reserved_bytes, consumed_bytes, expires_at
		FROM upload_sessions WHERE id = ?`, id).Scan(&state, &currentReserved, &consumed, &expires); err != nil || state != "active" || expires <= now {
		writeError(w, http.StatusNotFound, "upload_unavailable")
		return
	}
	var claimed int64
	if err := tx.QueryRowContext(r.Context(), "SELECT COALESCE(SUM(expected_size_bytes), 0) FROM upload_object_claims WHERE session_id = ?", id).Scan(&claimed); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if request.ReservedBytes < consumed+claimed {
		writeError(w, http.StatusConflict, "reservation_in_use")
		return
	}
	var used, otherReserved int64
	if err := tx.QueryRowContext(r.Context(), "SELECT COALESCE(SUM(size_bytes), 0) FROM objects WHERE state IN ('pending', 'live')").Scan(&used); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := tx.QueryRowContext(r.Context(), `SELECT COALESCE(SUM(reserved_bytes - consumed_bytes), 0)
		FROM upload_sessions WHERE state = 'active' AND expires_at > ? AND id <> ?`, now, id).Scan(&otherReserved); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	// Compare against remaining capacity before adding an untrusted int64 request.
	// A valid but oversized reservation is quota exhaustion, not malformed input.
	maintenanceReserve, err := maintenanceRemaining(r.Context(), tx)
	if err != nil {
		writeError(w, 500, "internal_error")
		return
	}
	remainingQuota := quotaBytes - used - otherReserved - maintenanceReserve
	if request.ReservedBytes-consumed > remainingQuota {
		shortfall := request.ReservedBytes - consumed
		// Existing usage can exceed a newly reduced configuration. Keep the
		// rejection fail-closed without wrapping its diagnostic byte count.
		if remainingQuota < 0 && shortfall > math.MaxInt64+remainingQuota {
			shortfall = math.MaxInt64
		} else {
			shortfall -= remainingQuota
		}
		writeErrorDetails(w, http.StatusInsufficientStorage, "quota_exceeded", map[string]any{"usedBytes": used, "reservedBytes": otherReserved + currentReserved - consumed, "requestedBytes": request.ReservedBytes, "shortfallBytes": shortfall})
		return
	}
	diskAvailable, err := availableDiskBytes(storagePath)
	if err != nil {
		writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		return
	}
	additionalReservation := otherReserved + (request.ReservedBytes - consumed)
	// A closed session may still have a receiving request. Its receive fence protects the
	// object ID until that request exits, and conservatively retains disk budget.
	var closingReceives int64
	if err := tx.QueryRowContext(r.Context(), `SELECT COALESCE(SUM(c.expected_size_bytes), 0)
		FROM upload_receive_fences c JOIN upload_sessions s ON s.id = c.session_id
		WHERE s.state <> 'active'`).Scan(&closingReceives); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	var maintenanceBytes int64
	if err := tx.QueryRowContext(r.Context(), "SELECT COALESCE(SUM(size_bytes),0) FROM metadata_maintenance").Scan(&maintenanceBytes); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	closingReceives += maintenanceBytes
	if closingReceives > diskAvailable || additionalReservation > diskAvailable-closingReceives {
		writeError(w, http.StatusInsufficientStorage, "disk_space_low")
		return
	}
	additionalReservation += closingReceives
	if diskSafetyBytes < 0 || additionalReservation > diskAvailable || diskSafetyBytes > diskAvailable-additionalReservation {
		writeError(w, http.StatusInsufficientStorage, "disk_space_low")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE upload_sessions SET reserved_bytes = ? WHERE id = ?", request.ReservedBytes, id); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"reservedBytes": request.ReservedBytes, "expiresAt": expires})
}

func putUploadObject(w http.ResponseWriter, r *http.Request, database *db.DB, storagePath string, diskSafetyBytes, maxObjectBytes int64, afterPublish func(), receiveTimeout time.Duration) {
	controller := http.NewResponseController(w)
	// Bound stalled receives on real net/http connections. Recorder-only tests
	// do not implement deadlines; all ownership checks still run there.
	if receiveTimeout <= 0 {
		receiveTimeout = objectReceiveTimeout
	}
	if err := controller.SetReadDeadline(time.Now().Add(receiveTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		writeError(w, http.StatusInternalServerError, "receive_deadline_unavailable")
		return
	}
	defer controller.SetReadDeadline(time.Time{})
	sessionID, objectID := r.PathValue("id"), r.PathValue("objectId")
	if !opaqueIDPattern.MatchString(sessionID) || !opaqueIDPattern.MatchString(objectID) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	declaredSize := r.Header.Get("X-XDrive-Object-Size")
	size, sizeErr := strconv.ParseInt(declaredSize, 10, 64)
	digestHeader := r.Header.Get("X-XDrive-Ciphertext-SHA256")
	digest, digestErr := hex.DecodeString(digestHeader)
	if sizeErr != nil || strconv.FormatInt(size, 10) != declaredSize || size < 36 || size > maxObjectBytes || digestErr != nil || len(digest) != sha256.Size || hex.EncodeToString(digest) != digestHeader {
		writeError(w, http.StatusBadRequest, "invalid_object_headers")
		return
	}
	if r.ContentLength >= 0 && r.ContentLength != size {
		writeError(w, http.StatusBadRequest, "object_length_header_mismatch")
		return
	}
	claim, err := acquireUploadClaim(r, database, sessionID, objectID, size, digest)
	if err != nil {
		if errors.Is(err, errUploadInProgress) {
			writeError(w, http.StatusConflict, "object_receive_in_progress")
		} else if errors.Is(err, errUploadConflict) {
			writeError(w, http.StatusConflict, "object_conflict")
		} else if errors.Is(err, errUploadUnavailable) {
			writeError(w, http.StatusNotFound, "upload_unavailable")
		} else {
			writeError(w, http.StatusInternalServerError, "internal_error")
		}
		return
	}
	if claim == claimAlreadyStored {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	committed := false
	defer func() {
		if !committed {
			releaseUploadClaim(context.WithoutCancel(r.Context()), database, sessionID, objectID)
		}
	}()

	diskAvailable, err := availableDiskBytes(storagePath)
	if err != nil {
		writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		return
	}
	if diskSafetyBytes < 0 || size > diskAvailable || diskSafetyBytes > diskAvailable-size {
		writeError(w, http.StatusInsufficientStorage, "disk_space_low")
		return
	}

	objectDir, err := storage.OpenObjectDirectory(storagePath, objectID, true)
	if err != nil {
		writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		return
	}
	defer objectDir.Close()
	tmp, tempName, err := objectDir.CreateTemporary()
	if err != nil {
		writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		return
	}
	defer objectDir.RemoveTemporary(tempName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		return
	}
	hasher := sha256.New()
	written, copyErr, storageErr := receiveUploadBody(tmp, hasher, r.Body, size)
	if storageErr != nil {
		_ = tmp.Close()
		writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		return
	}
	if written > size {
		_ = tmp.Close()
		writeError(w, http.StatusRequestEntityTooLarge, "object_size_exceeded")
		return
	}
	if copyErr != nil {
		var networkErr net.Error
		if errors.As(copyErr, &networkErr) && networkErr.Timeout() {
			_ = tmp.Close()
			writeError(w, http.StatusRequestTimeout, "upload_receive_timeout")
			return
		}
	}
	if copyErr != nil || written != size {
		_ = tmp.Close()
		writeError(w, http.StatusBadRequest, "object_size_mismatch")
		return
	}
	if !equalDigest(hasher, digest) {
		_ = tmp.Close()
		writeError(w, http.StatusUnprocessableEntity, "object_digest_mismatch")
		return
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		return
	}
	if err := tmp.Close(); err != nil {
		writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		return
	}
	var receiving int
	if err := database.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM upload_object_claims c
		JOIN upload_sessions s ON s.id = c.session_id
		WHERE c.session_id = ? AND c.object_id = ? AND s.state = 'active' AND s.expires_at > ?`,
		sessionID, objectID, time.Now().Unix()).Scan(&receiving); err != nil || receiving != 1 {
		writeError(w, http.StatusNotFound, "upload_unavailable")
		return
	}
	if err := objectDir.PublishTemporary(tempName); err != nil {
		if errors.Is(err, storage.ErrObjectDirectoryChanged) {
			writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		} else {
			writeError(w, http.StatusConflict, "object_conflict")
		}
		return
	}
	if err := objectDir.Sync(); err != nil {
		_ = objectDir.RemoveObject()
		writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		return
	}
	if err := objectDir.Validate(); err != nil {
		_ = objectDir.RemoveObject()
		writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		return
	}
	if afterPublish != nil {
		afterPublish()
	}
	finalized, err := finalizeUploadClaim(r, database, sessionID, objectID, size, digest)
	if err != nil || !finalized {
		_ = objectDir.RemoveObject()
		if errors.Is(err, errUploadUnavailable) || (err == nil && !finalized) {
			writeError(w, http.StatusNotFound, "upload_unavailable")
		} else {
			writeError(w, http.StatusInternalServerError, "internal_error")
		}
		return
	}
	committed = true
	w.WriteHeader(http.StatusCreated)
}

func abandonUpload(w http.ResponseWriter, r *http.Request, database *db.DB, storagePath string) {
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
	rows, err := tx.QueryContext(r.Context(), "SELECT id FROM objects WHERE upload_session_id = ? AND state = 'pending'", id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	var pendingObjectIDs []string
	for rows.Next() {
		var objectID string
		if err := rows.Scan(&objectID); err != nil {
			_ = rows.Close()
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		pendingObjectIDs = append(pendingObjectIDs, objectID)
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
	result, err := tx.ExecContext(r.Context(), "UPDATE upload_sessions SET state = 'aborted' WHERE id = ? AND state = 'active'", id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		writeError(w, http.StatusNotFound, "upload_unavailable")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM upload_object_claims WHERE session_id = ?", id); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	// Keep active receive fences until the PUT's deferred cleanup or startup
	// recovery. Deleting them here permits another session to receive the same ID.
	if _, err := tx.ExecContext(r.Context(), "UPDATE objects SET state = 'deleted' WHERE upload_session_id = ? AND state = 'pending'", id); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	for _, objectID := range pendingObjectIDs {
		if err := storage.RemoveObjectFile(storagePath, objectID); err != nil && !errors.Is(err, os.ErrNotExist) {
			// The deleted state prevents reads; a later garbage-collection pass retries unlink.
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

type uploadClaimResult int

const (
	claimAcquired uploadClaimResult = iota
	claimAlreadyStored
)

var (
	errUploadConflict    = errors.New("upload object conflict")
	errUploadInProgress  = errors.New("upload object already claimed")
	errUploadUnavailable = errors.New("upload unavailable")
)

func acquireUploadClaim(r *http.Request, database *db.DB, sessionID, objectID string, size int64, digest []byte) (uploadClaimResult, error) {
	return acquireUploadClaimOnce(r, database, sessionID, objectID, size, digest)
}

func acquireUploadClaimOnce(r *http.Request, database *db.DB, sessionID, objectID string, size int64, digest []byte) (uploadClaimResult, error) {
	tx, err := database.BeginTx(r.Context(), nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var state string
	var reserved, consumed, expires int64
	if err := tx.QueryRowContext(r.Context(), "SELECT state, reserved_bytes, consumed_bytes, expires_at FROM upload_sessions WHERE id = ?", sessionID).Scan(&state, &reserved, &consumed, &expires); err != nil || state != "active" || expires <= time.Now().Unix() {
		return 0, errUploadUnavailable
	}
	var existingSize int64
	var existingDigest []byte
	var existingState, existingSession sql.NullString
	err = tx.QueryRowContext(r.Context(), "SELECT size_bytes, sha256, state, upload_session_id FROM objects WHERE id = ?", objectID).Scan(&existingSize, &existingDigest, &existingState, &existingSession)
	if err == nil {
		if existingSize == size && equalBytes(existingDigest, digest) && existingState.String == "pending" && existingSession.Valid && existingSession.String == sessionID {
			return claimAlreadyStored, nil
		}
		return 0, errUploadConflict
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	var maintaining int
	if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM metadata_maintenance WHERE object_id=?", objectID).Scan(&maintaining); err != nil {
		return 0, err
	}
	if maintaining != 0 {
		return 0, errUploadConflict
	}
	var claimSession string
	var claimSize int64
	var claimDigest []byte
	err = tx.QueryRowContext(r.Context(), "SELECT session_id, expected_size_bytes, expected_sha256 FROM upload_receive_fences WHERE object_id = ?", objectID).Scan(&claimSession, &claimSize, &claimDigest)
	if err == nil {
		if claimSession == sessionID && claimSize == size && equalBytes(claimDigest, digest) {
			return 0, errUploadInProgress
		}
		return 0, errUploadConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	var claimed int64
	if err := tx.QueryRowContext(r.Context(), "SELECT COALESCE(SUM(expected_size_bytes), 0) FROM upload_object_claims WHERE session_id = ?", sessionID).Scan(&claimed); err != nil {
		return 0, err
	}
	if consumed+claimed+size > reserved {
		return 0, errUploadConflict
	}
	if _, err := tx.ExecContext(r.Context(), "INSERT INTO upload_receive_fences (session_id, object_id, expected_size_bytes, expected_sha256, created_at) VALUES (?, ?, ?, ?, ?)", sessionID, objectID, size, digest, time.Now().Unix()); err != nil {
		return 0, errUploadConflict
	}
	if _, err := tx.ExecContext(r.Context(), "INSERT INTO upload_object_claims (session_id, object_id, expected_size_bytes, expected_sha256, created_at) VALUES (?, ?, ?, ?, ?)", sessionID, objectID, size, digest, time.Now().Unix()); err != nil {
		return 0, errUploadConflict
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return claimAcquired, nil
}

func finalizeUploadClaim(r *http.Request, database *db.DB, sessionID, objectID string, size int64, digest []byte) (bool, error) {
	tx, err := database.BeginTx(r.Context(), nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	var reserved, consumed, expires int64
	var state string
	if err := tx.QueryRowContext(r.Context(), "SELECT state, reserved_bytes, consumed_bytes, expires_at FROM upload_sessions WHERE id = ?", sessionID).Scan(&state, &reserved, &consumed, &expires); err != nil || state != "active" || expires <= now {
		return false, errUploadUnavailable
	}
	var expectedSize int64
	var expectedDigest []byte
	if err := tx.QueryRowContext(r.Context(), "SELECT expected_size_bytes, expected_sha256 FROM upload_object_claims WHERE session_id = ? AND object_id = ?", sessionID, objectID).Scan(&expectedSize, &expectedDigest); err != nil || expectedSize != size || !equalBytes(expectedDigest, digest) || consumed+size > reserved {
		return false, errUploadUnavailable
	}
	if _, err := tx.ExecContext(r.Context(), "INSERT INTO objects (id, size_bytes, sha256, state, upload_session_id, created_at) VALUES (?, ?, ?, 'pending', ?, ?)", objectID, size, digest, sessionID, now); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE upload_sessions SET consumed_bytes = consumed_bytes + ? WHERE id = ?", size, sessionID); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM upload_object_claims WHERE session_id = ? AND object_id = ?", sessionID, objectID); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM upload_receive_fences WHERE session_id = ? AND object_id = ?", sessionID, objectID); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func releaseUploadClaim(ctx context.Context, database *db.DB, sessionID, objectID string) {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return
	}
	defer tx.Rollback()
	for _, table := range []string{"upload_object_claims", "upload_receive_fences"} {
		if _, err := tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE session_id = ? AND object_id = ?", sessionID, objectID); err != nil {
			return
		}
	}
	_ = tx.Commit()
}

func randomOpaqueID() (string, error) {
	value := make([]byte, 24)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	defer zero(value)
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func equalDigest(digest hash.Hash, expected []byte) bool {
	return equalBytes(digest.Sum(nil), expected)
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var difference byte
	for index := range left {
		difference |= left[index] ^ right[index]
	}
	return difference == 0
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open directory for sync: %w", err)
	}
	defer directory.Close()
	return directory.Sync()
}
