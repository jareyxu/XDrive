package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"

	"xdrive/internal/update"
)

var updateRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

type systemUpdateRequest struct {
	Version string `json:"version"`
}

func (h *Handler) systemUpdateInfo(w http.ResponseWriter, r *http.Request) {
	latest, err := h.checkLatestRelease(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "release_check_failed")
		return
	}
	available := false
	if comparison, compareErr := update.CompareVersions(h.buildVersion, latest.Version); compareErr == nil {
		available = comparison < 0
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"currentVersion":  h.buildVersion,
		"latestVersion":   latest.Version,
		"name":            latest.Name,
		"releaseUrl":      latest.URL,
		"publishedAt":     latest.PublishedAt,
		"releaseNotes":    latest.Notes,
		"updateAvailable": available,
		"canInstall":      h.updateManagerActive(r.Context()),
	})
}

func (h *Handler) startSystemUpdate(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "origin_rejected")
		return
	}
	if !validSessionAndCSRF(r, h.database) {
		writeError(w, http.StatusUnauthorized, "invalid_session")
		return
	}
	if !h.updateManagerActive(r.Context()) {
		writeError(w, http.StatusConflict, "update_manager_unavailable")
		return
	}
	request := systemUpdateRequest{}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || !update.IsStableVersion(request.Version) {
		writeError(w, http.StatusBadRequest, "invalid_update_request")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid_update_request")
		return
	}
	latest, err := h.checkLatestRelease(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "release_check_failed")
		return
	}
	comparison, err := update.CompareVersions(h.buildVersion, latest.Version)
	if err != nil || comparison >= 0 || latest.Version != request.Version {
		writeError(w, http.StatusConflict, "release_changed")
		return
	}
	var randomID [16]byte
	if _, err := rand.Read(randomID[:]); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	id := base64.RawURLEncoding.EncodeToString(randomID[:])
	queued := update.Request{ID: id, Version: latest.Version}
	if err := queueSystemUpdate(h.updateRequestPath, queued); err != nil {
		if errors.Is(err, os.ErrExist) {
			writeError(w, http.StatusConflict, "update_already_queued")
			return
		}
		writeError(w, http.StatusServiceUnavailable, "update_queue_unavailable")
		return
	}
	writeJSON(w, http.StatusAccepted, update.Status{ID: id, Version: latest.Version, State: "queued", UpdatedAt: time.Now().Unix()})
}

func (h *Handler) systemUpdateStatus(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if !updateRequestIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid_update_request")
		return
	}
	if request, requestErr := update.ReadRequest(h.updateRequestPath); requestErr == nil && request.ID == id {
		writeJSON(w, http.StatusOK, update.Status{ID: id, Version: request.Version, State: "queued", UpdatedAt: time.Now().Unix()})
		return
	}
	status, err := update.ReadStatus(h.updateStatusPath)
	if err == nil && status.ID == id {
		writeJSON(w, http.StatusOK, status)
		return
	}
	writeError(w, http.StatusNotFound, "update_status_not_found")
}

// ContinueLegacyUpdate completes the already approved target after a legacy
// worker installs the bridge. It does not schedule unrelated future updates.
func (h *Handler) ContinueLegacyUpdate(ctx context.Context, rollbackHold string) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	request, err := update.AwaitBridgeContinuation(ctx, h.buildVersion, h.updateStatusPath, rollbackHold)
	if err != nil || request == nil {
		return
	}
	if !h.updateManagerActive(ctx) {
		return
	}
	if err := queueSystemUpdate(h.updateRequestPath, *request); err != nil && !errors.Is(err, os.ErrExist) {
		slog.Warn("legacy update continuation could not be queued", "code", "update_queue_unavailable")
	}
}

func queueSystemUpdate(path string, request update.Request) error {
	if path == "" || !updateRequestIDPattern.MatchString(request.ID) || !update.IsStableVersion(request.Version) {
		return errors.New("update queue is unavailable")
	}
	directory := filepath.Dir(path)
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("update queue directory is unavailable")
	}
	file, err := os.CreateTemp(directory, ".request-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		return err
	}
	if err := json.NewEncoder(file).Encode(request); err != nil {
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
	// A hard link makes publication atomic and fails if another request is
	// already queued; the path unit never observes a partially written file.
	if err := os.Link(temporary, path); err != nil {
		return err
	}
	if dir, err := os.Open(directory); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func checkSystemdUpdateManager(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/usr/bin/systemctl", "is-active", "--quiet", "xdrive-web-update.path")
	return command.Run() == nil
}

func (h *Handler) checkLatestRelease(ctx context.Context) (update.Release, error) {
	if h.updateCheck != nil {
		return h.updateCheck(ctx)
	}
	h.updateCacheMu.Lock()
	defer h.updateCacheMu.Unlock()
	if !h.updateCacheAt.IsZero() && time.Since(h.updateCacheAt) < 5*time.Minute {
		return h.updateCache, nil
	}
	release, err := update.CheckLatest(ctx, h.updateHTTPClient, "")
	if err == nil {
		h.updateCache = release
		h.updateCacheAt = time.Now()
	}
	return release, err
}

func (h *Handler) updateManagerActive(ctx context.Context) bool {
	if h.updateManagerCheck != nil {
		return h.updateManagerCheck(ctx)
	}
	return checkSystemdUpdateManager(ctx)
}
