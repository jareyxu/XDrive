package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"xdrive/internal/db"
)

const maxWallpaperBytes = 10 << 20

type wallpaperSelection struct {
	BuiltinID string `json:"builtinId"`
}

func getSystemWallpaperSelection(w http.ResponseWriter, r *http.Request, database *db.DB) {
	var selection string
	if err := database.QueryRowContext(r.Context(), "SELECT selection FROM system_wallpaper_state WHERE id = 1").Scan(&selection); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, wallpaperSelection{BuiltinID: selection})
}

func putSystemWallpaperSelection(w http.ResponseWriter, r *http.Request, database *db.DB) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var selection wallpaperSelection
	if err := decoder.Decode(&selection); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !validBuiltinWallpaperID(selection.BuiltinID) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if _, err := database.ExecContext(r.Context(), "UPDATE system_wallpaper_state SET selection = ?, updated_at = ? WHERE id = 1", selection.BuiltinID, time.Now().Unix()); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validBuiltinWallpaperID(id string) bool {
	switch id {
	case "default", "02", "03", "04", "05", "06", "07", "08":
		return true
	default:
		return false
	}
}

func getSystemWallpaper(w http.ResponseWriter, r *http.Request, database *db.DB) {
	var contentType string
	var content []byte
	err := database.QueryRowContext(r.Context(), "SELECT content_type, content FROM system_assets WHERE asset_id = 'desktop_wallpaper'").Scan(&contentType, &content)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.Header().Set("Content-Disposition", `inline; filename="xdrive-wallpaper"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func putSystemWallpaper(w http.ResponseWriter, r *http.Request, database *db.DB) {
	if r.ContentLength > maxWallpaperBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "wallpaper_too_large")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxWallpaperBytes+1)
	content, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "wallpaper_too_large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid_request")
		}
		return
	}
	if len(content) == 0 || len(content) > maxWallpaperBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "wallpaper_too_large")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || !validWallpaperType(mediaType) || sniffWallpaper(content) != mediaType {
		writeError(w, http.StatusBadRequest, "invalid_wallpaper")
		return
	}
	tx, err := database.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO system_assets (asset_id, content_type, content, updated_at)
		VALUES ('desktop_wallpaper', ?, ?, ?)
		ON CONFLICT(asset_id) DO UPDATE SET content_type = excluded.content_type, content = excluded.content, updated_at = excluded.updated_at`, mediaType, content, time.Now().Unix()); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE system_wallpaper_state SET selection = 'custom', updated_at = ? WHERE id = 1", time.Now().Unix()); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func deleteSystemWallpaper(w http.ResponseWriter, r *http.Request, database *db.DB) {
	tx, err := database.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM system_assets WHERE asset_id = 'desktop_wallpaper'"); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE system_wallpaper_state SET selection = 'default', updated_at = ? WHERE id = 1", time.Now().Unix()); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validWallpaperType(mediaType string) bool {
	switch mediaType {
	case "image/jpeg", "image/png", "image/webp", "image/avif":
		return true
	default:
		return false
	}
}

func sniffWallpaper(content []byte) string {
	switch {
	case len(content) >= 3 && bytes.Equal(content[:3], []byte{0xff, 0xd8, 0xff}):
		return "image/jpeg"
	case len(content) >= 8 && bytes.Equal(content[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}):
		return "image/png"
	case len(content) >= 12 && bytes.Equal(content[:4], []byte("RIFF")) && bytes.Equal(content[8:12], []byte("WEBP")):
		return "image/webp"
	case len(content) >= 12 && bytes.Equal(content[4:8], []byte("ftyp")) && (bytes.Equal(content[8:12], []byte("avif")) || bytes.Equal(content[8:12], []byte("avis"))):
		return "image/avif"
	default:
		return ""
	}
}
