package server

import (
	"bytes"
	"database/sql"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"xdrive/internal/db"
)

const maxWallpaperBytes = 10 << 20

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
	if _, err := database.ExecContext(r.Context(), `INSERT INTO system_assets (asset_id, content_type, content, updated_at)
		VALUES ('desktop_wallpaper', ?, ?, ?)
		ON CONFLICT(asset_id) DO UPDATE SET content_type = excluded.content_type, content = excluded.content, updated_at = excluded.updated_at`, mediaType, content, time.Now().Unix()); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func deleteSystemWallpaper(w http.ResponseWriter, r *http.Request, database *db.DB) {
	if _, err := database.ExecContext(r.Context(), "DELETE FROM system_assets WHERE asset_id = 'desktop_wallpaper'"); err != nil {
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
