package server

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"time"

	"xdrive/internal/db"
	"xdrive/internal/storage"
)

func metadata(w http.ResponseWriter, r *http.Request, database *db.DB) {
	metadataID := r.PathValue("id")
	if !opaqueIDPattern.MatchString(metadataID) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	var objectID string
	var revision, size int64
	var digest []byte
	err := database.QueryRowContext(r.Context(), `SELECT p.object_id, p.revision, o.size_bytes, o.sha256
		FROM metadata_pointers p JOIN objects o ON o.id = p.object_id AND o.state = 'live' WHERE p.id = ?`, metadataID).
		Scan(&objectID, &revision, &size, &digest)
	if err == sql.ErrNoRows {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"metadataId": metadataID, "objectId": objectID, "revision": revision,
		"sizeBytes": size, "sha256": hex.EncodeToString(digest),
	})
}

func readObject(w http.ResponseWriter, r *http.Request, database *db.DB, storagePath string) {
	objectID := r.PathValue("id")
	if !opaqueIDPattern.MatchString(objectID) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	var expectedSize int64
	var digest []byte
	err := database.QueryRowContext(r.Context(), "SELECT size_bytes, sha256 FROM objects WHERE id = ? AND state = 'live'", objectID).Scan(&expectedSize, &digest)
	if err == sql.ErrNoRows {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	file, err := storage.OpenObjectRead(storagePath, objectID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "object_unavailable")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != expectedSize || len(digest) != sha256.Size {
		writeError(w, http.StatusServiceUnavailable, "object_unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprint(expectedSize))
	w.Header().Set("ETag", `"`+hex.EncodeToString(digest)+`"`)
	http.ServeContent(w, r, "object", time.Unix(0, 0), file)
}
