package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
)

const (
	backupDownloadCookieName = "xdrive_backup_download"
	backupDownloadTicketTTL  = 2 * time.Minute
	maximumBackupTickets     = 8
)

var errBackupTicketLimit = errors.New("too many pending backup download tickets")

type backupDownloadTicket struct {
	sessionHash [32]byte
	expiresAt   time.Time
}

func (h *Handler) prepareBackupDownload(w http.ResponseWriter, r *http.Request, database *db.DB) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "origin_rejected")
		return
	}
	if !validSessionAndCSRF(r, database) {
		writeError(w, http.StatusUnauthorized, "invalid_session")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if _, err := io.Copy(io.Discard, r.Body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	sessionHash, ok := requestSessionHash(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid_session")
		return
	}
	token, err := h.issueBackupDownloadTicket(sessionHash)
	if err != nil {
		if errors.Is(err, errBackupTicketLimit) {
			writeError(w, http.StatusConflict, "backup_download_in_progress")
		} else {
			writeError(w, http.StatusInternalServerError, "internal_error")
		}
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: backupDownloadCookieName, Value: token, Path: "/api/v1/backups/download",
		Expires: time.Now().Add(backupDownloadTicketTTL), MaxAge: int(backupDownloadTicketTTL / time.Second),
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ready": true})
}

func (h *Handler) downloadBackup(w http.ResponseWriter, r *http.Request, database *db.DB, settings config.Config) {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		writeError(w, http.StatusForbidden, "origin_rejected")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "origin_rejected")
		return
	}
	if !validSession(r, database) {
		http.SetCookie(w, expiredBackupDownloadCookie())
		writeError(w, http.StatusUnauthorized, "invalid_session")
		return
	}
	ticketCookie, err := r.Cookie(backupDownloadCookieName)
	if err != nil {
		http.SetCookie(w, expiredBackupDownloadCookie())
		writeError(w, http.StatusUnauthorized, "backup_download_ticket_unavailable")
		return
	}
	sessionHash, ok := requestSessionHash(r)
	if !ok || !h.consumeBackupDownloadTicket(ticketCookie.Value, sessionHash, time.Now()) {
		http.SetCookie(w, expiredBackupDownloadCookie())
		writeError(w, http.StatusUnauthorized, "backup_download_ticket_unavailable")
		return
	}
	http.SetCookie(w, expiredBackupDownloadCookie())
	if !h.backupExportMu.TryLock() {
		writeError(w, http.StatusConflict, "backup_in_progress")
		return
	}
	defer h.backupExportMu.Unlock()

	if h.backupPreparer == nil {
		writeError(w, http.StatusServiceUnavailable, "backup_unavailable")
		return
	}
	export, err := h.backupPreparer(r.Context(), settings)
	if err != nil {
		if errors.Is(err, ErrBackupInProgress) {
			writeError(w, http.StatusConflict, "backup_in_progress")
		} else if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			writeError(w, http.StatusServiceUnavailable, "service_closing")
		} else {
			writeError(w, http.StatusInternalServerError, "backup_export_failed")
		}
		return
	}
	defer func() {
		if err := export.Close(); err != nil {
			slog.Error("backup download cleanup failed", "request_id", w.Header().Get("X-Request-ID"), "code", "backup_export_cleanup_failed")
		}
	}()

	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", "attachment; filename="+strconv.Quote(export.DownloadFilename()))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if err := http.NewResponseController(w).Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		slog.Error("backup download stream failed", "request_id", w.Header().Get("X-Request-ID"), "code", "backup_export_failed")
		return
	}
	if err := export.WriteTo(r.Context(), w); err != nil {
		// The archive is deliberately streamed. Once headers are sent, a failure
		// leaves an incomplete tar that xdrive verify-backup will reject.
		slog.Error("backup download stream failed", "request_id", w.Header().Get("X-Request-ID"), "code", "backup_export_failed")
	}
}

func (h *Handler) issueBackupDownloadTicket(sessionHash [32]byte) (string, error) {
	var random [32]byte
	if _, err := io.ReadFull(rand.Reader, random[:]); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(random[:])
	key := sha256.Sum256([]byte(token))
	now := time.Now()
	h.backupTicketMu.Lock()
	defer h.backupTicketMu.Unlock()
	if h.backupTickets == nil {
		h.backupTickets = make(map[[32]byte]backupDownloadTicket)
	}
	for id, ticket := range h.backupTickets {
		if !now.Before(ticket.expiresAt) {
			delete(h.backupTickets, id)
		}
	}
	if len(h.backupTickets) >= maximumBackupTickets {
		return "", errBackupTicketLimit
	}
	h.backupTickets[key] = backupDownloadTicket{sessionHash: sessionHash, expiresAt: now.Add(backupDownloadTicketTTL)}
	return token, nil
}

func (h *Handler) consumeBackupDownloadTicket(token string, sessionHash [32]byte, now time.Time) bool {
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != token {
		return false
	}
	key := sha256.Sum256([]byte(token))
	h.backupTicketMu.Lock()
	defer h.backupTicketMu.Unlock()
	ticket, exists := h.backupTickets[key]
	if !exists {
		return false
	}
	delete(h.backupTickets, key)
	return now.Before(ticket.expiresAt) && ticket.sessionHash == sessionHash
}

func requestSessionHash(r *http.Request) ([32]byte, bool) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return [32]byte{}, false
	}
	return sha256.Sum256([]byte(cookie.Value)), true
}

func expiredBackupDownloadCookie() *http.Cookie {
	return &http.Cookie{
		Name: backupDownloadCookieName, Value: "", Path: "/api/v1/backups/download",
		MaxAge: -1, Expires: time.Unix(1, 0), HttpOnly: true, Secure: true,
		SameSite: http.SameSiteStrictMode,
	}
}
