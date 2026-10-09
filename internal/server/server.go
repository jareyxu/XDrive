package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
	"xdrive/internal/storage"
	"xdrive/internal/update"
)

// Vite may emit legitimate lazy modules beginning with an underscore. Plain
// directory embedding omits them and silently produces a broken release.
//
//go:embed all:static
var embeddedWeb embed.FS

var requestCounter atomic.Uint64

// clientProtocolVersion identifies the frontend/server mutation contract. It
// must be incremented when a client protocol change makes an older loaded page
// unsafe to use for writes.
const clientProtocolVersion = 1

const clientProtocolHeader = "X-XDrive-Client-Protocol"

// New constructs the API handler after durable storage is initialized.
type Handler struct {
	mux                  *http.ServeMux
	database             *db.DB
	secret               []byte
	serviceLease         *storage.ServiceLease
	closeOnce            sync.Once
	closeError           error
	lifecycleMutex       sync.Mutex
	requests             sync.WaitGroup
	closing              bool
	trashRetention       time.Duration
	sessionIdleTimeout   time.Duration
	metadataKeepVersions int
	buildVersion         string
	updateHTTPClient     *http.Client
	updateRequestPath    string
	updateStatusPath     string
	updateCheck          func(context.Context) (update.Release, error)
	updateManagerCheck   func(context.Context) bool
	updateCacheMu        sync.Mutex
	updateCache          update.Release
	updateCacheAt        time.Time
	backupTicketMu       sync.Mutex
	backupTickets        map[[32]byte]backupDownloadTicket
	backupExportMu       sync.Mutex
	backupPreparer       BackupArchivePreparer
	// uploadPublishedHook is an unexported fault-injection point for same-package
	// crash tests. Production handlers leave it nil.
	uploadPublishedHook func()
	// uploadReceiveTimeout lets same-package tests exercise the real TCP read
	// deadline with a short duration; zero uses the production ten-minute limit.
	uploadReceiveTimeout time.Duration
}

func New(cfg config.Config) (*Handler, error) {
	return NewWithBuild(cfg, "dev", "unknown")
}

// NewWithBuild exposes the version of the actual embedded application binary.
func NewWithBuild(cfg config.Config, version, commit string) (*Handler, error) {
	if cfg.DiskSafetyBytes < 0 {
		return nil, fmt.Errorf("disk safety reserve cannot be negative")
	}
	if cfg.BackupWarnAfterDays == 0 {
		cfg.BackupWarnAfterDays = config.DefaultBackupWarnAfterDays
	}
	if err := config.ValidateBackupWarnAfterDays(cfg.BackupWarnAfterDays); err != nil {
		return nil, err
	}
	if cfg.MetadataKeepVersions == 0 {
		cfg.MetadataKeepVersions = config.DefaultMetadataKeepVersions
	}
	if err := config.ValidateMetadataKeepVersions(cfg.MetadataKeepVersions); err != nil {
		return nil, err
	}
	if cfg.SetupTokenTTL == "" {
		cfg.SetupTokenTTL = config.DefaultSetupTokenTTL
	}
	if _, err := config.ParseSetupTokenTTL(cfg.SetupTokenTTL); err != nil {
		return nil, err
	}
	if cfg.SessionIdleTimeout == "" {
		cfg.SessionIdleTimeout = config.DefaultSessionIdleTimeout
	}
	idleTimeout, err := config.ParseSessionIdleTimeout(cfg.SessionIdleTimeout)
	if err != nil {
		return nil, err
	}
	if cfg.TrashRetention == "" {
		cfg.TrashRetention = config.DefaultTrashRetention
	}
	retention, err := config.ParseTrashRetention(cfg.TrashRetention)
	if err != nil {
		return nil, err
	}
	if cfg.UploadExpiry == "" {
		cfg.UploadExpiry = config.DefaultUploadExpiry
	}
	uploadExpiry, err := config.ParseUploadExpiry(cfg.UploadExpiry)
	if err != nil {
		return nil, err
	}
	if cfg.ObjectPutMaxBytes == 0 {
		cfg.ObjectPutMaxBytes = config.DefaultObjectPutMaxBytes
	}
	if err := config.ValidateObjectPutMaxBytes(cfg.ObjectPutMaxBytes); err != nil {
		return nil, err
	}
	if cfg.ZipMemoryFallbackLimit == 0 {
		cfg.ZipMemoryFallbackLimit = config.DefaultZipMemoryFallbackLimit
	}
	if err := config.ValidateZipMemoryFallbackLimit(cfg.ZipMemoryFallbackLimit); err != nil {
		return nil, err
	}
	if cfg.VideoBlobFallbackLimit == 0 {
		cfg.VideoBlobFallbackLimit = config.DefaultVideoBlobFallbackLimit
	}
	if err := config.ValidateVideoBlobFallbackLimit(cfg.VideoBlobFallbackLimit); err != nil {
		return nil, err
	}
	if cfg.TextPreviewLimit == 0 {
		cfg.TextPreviewLimit = config.DefaultTextPreviewLimit
	}
	if cfg.TextPreviewLimit < 1 || cfg.TextPreviewLimit > config.MaxTextPreviewLimit {
		return nil, fmt.Errorf("invalid text preview limit")
	}
	if cfg.QuotaBytes == 0 {
		cfg.QuotaBytes = config.DefaultQuotaBytes
	}
	if cfg.ListenAddr == "" {
		return nil, fmt.Errorf("listen address is required")
	}
	if cfg.SecretPath == "" {
		cfg.SecretPath = filepath.Join(filepath.Dir(cfg.StoragePath), "server.secret")
	}
	lease, err := storage.AcquireServiceLease(cfg.DatabasePath, cfg.StoragePath)
	if err != nil {
		return nil, fmt.Errorf("acquire data ownership before startup: %w", err)
	}
	initialized := false
	defer func() {
		if !initialized {
			_ = lease.Close()
		}
	}()
	database, err := db.Open(context.Background(), cfg.DatabasePath)
	if err != nil {
		return nil, fmt.Errorf("initialize database: %w", err)
	}
	if err := os.MkdirAll(cfg.StoragePath, 0o700); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("initialize object storage: %w", err)
	}
	if err := os.Chmod(cfg.StoragePath, 0o700); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("restrict object storage permissions: %w", err)
	}
	if err := RecoverUploadClaimsAtStartup(context.Background(), database, cfg.StoragePath); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("recover interrupted object claims: %w", err)
	}
	// Shortening policy caps existing deadlines; extending policy cannot revive
	// cookies whose persisted deadline has already passed.
	if _, err := database.ExecContext(context.Background(), "UPDATE sessions SET expires_at = MIN(expires_at, last_seen_at + ?)", int64(idleTimeout/time.Second)); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("apply session idle policy: %w", err)
	}
	if err := cleanupOnce(context.Background(), database, cfg.StoragePath, time.Now(), false, retention, cfg.MetadataKeepVersions); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("recover expired uploads and deleted objects: %w", err)
	}
	if err := initializeMaintenanceQuota(context.Background(), database, cfg.QuotaBytes, cfg.MaintenanceReserveBytes); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("initialize maintenance quota: %w", err)
	}
	secret, err := loadOrCreateServerSecret(cfg.SecretPath)
	if err != nil {
		_ = database.Close()
		return nil, err
	}

	mux := http.NewServeMux()
	var handler *Handler
	mux.HandleFunc("GET /", serveWebApp)
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("GET /api/v1/status", func(w http.ResponseWriter, r *http.Request) {
		state, err := database.SetupState(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"setupRequired": state != "active",
			"accountState":  state,
		})
	})
	mux.HandleFunc("POST /api/v1/auth/prelogin", func(w http.ResponseWriter, r *http.Request) {
		prelogin(w, r, database, secret)
	})
	mux.HandleFunc("POST /api/v1/setup", func(w http.ResponseWriter, r *http.Request) {
		setup(w, r, database, cfg.StoragePath, cfg.Username, cfg.QuotaBytes)
	})
	mux.HandleFunc("POST /api/v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		login(w, r, database, cfg.Username, secret)
	})
	mux.HandleFunc("POST /api/v1/auth/unlock", func(w http.ResponseWriter, r *http.Request) {
		unlock(w, r, database, secret)
	})
	mux.HandleFunc("POST /api/v1/auth/change-password", func(w http.ResponseWriter, r *http.Request) {
		changePassword(w, r, database, secret)
	})
	mux.HandleFunc("POST /api/v1/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		logout(w, r, database)
	})
	mux.HandleFunc("GET /api/v1/auth/session", func(w http.ResponseWriter, r *http.Request) {
		sessionInfo(w, r, database)
	})
	mux.HandleFunc("GET /api/v1/vault/config", func(w http.ResponseWriter, r *http.Request) {
		if !validSession(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		var configuration []byte
		if err := database.QueryRowContext(r.Context(), "SELECT config_json FROM vault_config WHERE id = 1").Scan(&configuration); err != nil {
			writeError(w, http.StatusNotFound, "vault_not_found")
			return
		}
		writeJSON(w, http.StatusOK, json.RawMessage(configuration))
	})
	mux.HandleFunc("GET /api/v1/system/info", func(w http.ResponseWriter, r *http.Request) {
		if !validSession(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"version": version, "commit": commit, "clientProtocolVersion": clientProtocolVersion, "encryptedFormatVersion": 2, "textPreviewLimit": cfg.TextPreviewLimit, "videoBlobFallbackLimit": cfg.VideoBlobFallbackLimit, "zipMemoryFallbackLimit": cfg.ZipMemoryFallbackLimit, "trashRetentionSeconds": int64(retention / time.Second)})
	})
	mux.HandleFunc("GET /api/v1/system/update", func(w http.ResponseWriter, r *http.Request) {
		if !validSession(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		handler.systemUpdateInfo(w, r)
	})
	mux.HandleFunc("GET /api/v1/system/update/status", func(w http.ResponseWriter, r *http.Request) {
		if !validSession(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		handler.systemUpdateStatus(w, r)
	})
	mux.HandleFunc("POST /api/v1/system/update", func(w http.ResponseWriter, r *http.Request) {
		handler.startSystemUpdate(w, r)
	})
	mux.HandleFunc("GET /api/v1/vault/state", func(w http.ResponseWriter, r *http.Request) {
		if !validSession(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		var revision int64
		if err := database.QueryRowContext(r.Context(), "SELECT vault_mutation_revision FROM server_state WHERE id = 1").Scan(&revision); err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]int64{"vaultMutationRevision": revision})
	})
	mux.HandleFunc("GET /api/v1/storage/usage", func(w http.ResponseWriter, r *http.Request) {
		if !validSession(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		storageUsage(w, r, database, cfg.QuotaBytes, cfg.StoragePath, cfg.BackupWarnAfterDays)
	})
	mux.HandleFunc("POST /api/v1/backups/download", func(w http.ResponseWriter, r *http.Request) {
		handler.prepareBackupDownload(w, r, database)
	})
	mux.HandleFunc("GET /api/v1/backups/download", func(w http.ResponseWriter, r *http.Request) {
		handler.downloadBackup(w, r, database, cfg)
	})
	mux.HandleFunc("GET /api/v1/trash/tombstones", func(w http.ResponseWriter, r *http.Request) {
		if !validSession(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		listTrashTombstones(w, r, database)
	})
	mux.HandleFunc("GET /api/v1/metadata/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !validSession(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		metadata(w, r, database)
	})
	var maintenanceMutex sync.Mutex
	mux.HandleFunc("POST /api/v1/metadata/maintenance-trash", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, 403, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, 401, "invalid_session")
			return
		}
		if !maintenanceMutex.TryLock() {
			writeError(w, 409, "maintenance_in_progress")
			return
		}
		defer maintenanceMutex.Unlock()
		maintenanceTrash(w, r, database, cfg.StoragePath, cfg.QuotaBytes, cfg.DiskSafetyBytes)
	})
	mux.HandleFunc("POST /api/v1/metadata/maintenance-purge", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		if !maintenanceMutex.TryLock() {
			writeError(w, http.StatusConflict, "maintenance_in_progress")
			return
		}
		defer maintenanceMutex.Unlock()
		maintenancePurge(w, r, database, cfg.StoragePath, cfg.QuotaBytes, cfg.DiskSafetyBytes)
	})
	mux.HandleFunc("POST /api/v1/metadata/transactions", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		metadataTransaction(w, r, database, cfg.StoragePath)
	})
	mux.HandleFunc("GET /api/v1/objects/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !validSession(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		readObject(w, r, database, cfg.StoragePath)
	})
	mux.HandleFunc("POST /api/v1/uploads", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		createUpload(w, r, database, uploadExpiry)
	})
	mux.HandleFunc("GET /api/v1/uploads/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !validSession(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		getUpload(w, r, database)
	})
	mux.HandleFunc("POST /api/v1/uploads/{id}/reserve", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		reserveUpload(w, r, database, cfg.QuotaBytes, cfg.StoragePath, cfg.DiskSafetyBytes)
	})
	mux.HandleFunc("PUT /api/v1/uploads/{id}/objects/{objectId}", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		putUploadObject(w, r, database, cfg.StoragePath, cfg.DiskSafetyBytes, cfg.ObjectPutMaxBytes, handler.uploadPublishedHook, handler.uploadReceiveTimeout)
	})
	mux.HandleFunc("DELETE /api/v1/uploads/{id}/objects/{objectId}", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		abandonUploadObject(w, r, database, cfg.StoragePath)
	})
	mux.HandleFunc("POST /api/v1/uploads/{id}/abandon", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		abandonUpload(w, r, database, cfg.StoragePath)
	})
	mux.HandleFunc("POST /api/v1/tombstone-builds", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		createTombstoneBuild(w, r, database)
	})
	mux.HandleFunc("POST /api/v1/tombstone-builds/{id}/members", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		addTombstoneBuildMembers(w, r, database)
	})
	mux.HandleFunc("DELETE /api/v1/tombstone-builds/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "origin_rejected")
			return
		}
		if !validSessionAndCSRF(r, database) {
			writeError(w, http.StatusUnauthorized, "invalid_session")
			return
		}
		cancelTombstoneBuild(w, r, database)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := database.PingContext(r.Context()); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	initialized = true
	handler = &Handler{mux: mux, database: database, secret: secret, serviceLease: lease, trashRetention: retention, sessionIdleTimeout: idleTimeout, metadataKeepVersions: cfg.MetadataKeepVersions, buildVersion: version, updateHTTPClient: update.HTTPClient(), updateRequestPath: update.DefaultRequestPath, updateStatusPath: update.DefaultStatusPath}
	return handler, nil
}

func (h *Handler) TrashRetention() time.Duration { return h.trashRetention }
func (h *Handler) MetadataKeepVersions() int     { return h.metadataKeepVersions }

// SetBackupArchivePreparer connects the CLI-owned backup package to the HTTP
// handler without coupling the server package back to that package.
func (h *Handler) SetBackupArchivePreparer(preparer BackupArchivePreparer) {
	h.backupPreparer = preparer
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.lifecycleMutex.Lock()
	if h.closing {
		h.lifecycleMutex.Unlock()
		securityHeaders(logAPIRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeError(w, http.StatusServiceUnavailable, "service_closing")
		}))).ServeHTTP(w, r)
		return
	}
	h.requests.Add(1)
	h.lifecycleMutex.Unlock()
	defer h.requests.Done()
	r = r.WithContext(context.WithValue(r.Context(), sessionIdleContextKey{}, h.sessionIdleTimeout))
	securityHeaders(logAPIRequests(requireClientProtocol(apiRoutingErrors(h.mux)))).ServeHTTP(w, r)
}

// requireClientProtocol rejects writes from stale in-memory pages before a
// route can read the body or mutate server state. Reads remain available so a
// stale page can still discover session and version information and reload.
func requireClientProtocol(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/") && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get(clientProtocolHeader) != strconv.Itoa(clientProtocolVersion) {
			w.Header().Set("X-XDrive-Required-Client-Protocol", strconv.Itoa(clientProtocolVersion))
			writeError(w, http.StatusUpgradeRequired, "client_update_required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Handler) Close() error {
	h.closeOnce.Do(func() {
		h.lifecycleMutex.Lock()
		h.closing = true
		h.lifecycleMutex.Unlock()
		h.requests.Wait()
		h.closeError = errors.Join(h.database.Close(), h.serviceLease.Close())
	})
	return h.closeError
}

// Database returns the service's database handle for supervised maintenance tasks.
func (h *Handler) Database() *db.DB { return h.database }

func healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func serveWebApp(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/__xdrive_media/") || strings.HasPrefix(r.URL.Path, "/__xdrive_download/") {
		http.NotFound(w, r)
		return
	}
	webFS, err := fs.Sub(embeddedWeb, "static")
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "web_assets_unavailable")
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "." || name == "" || name == "setup" || name == "login" || name == "drive" || name == "storage" || name == "settings" || name == "trash" {
		name = "index.html"
	}
	file, err := webFS.Open(name)
	if err != nil {
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		name = "index.html"
		file, err = webFS.Open(name)
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "web_assets_unavailable")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if name == "index.html" || !strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	if path.Ext(name) == ".wasm" {
		w.Header().Set("Content-Type", "application/wasm")
	} else if contentType := mime.TypeByExtension(path.Ext(name)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Content-Length", fmt.Sprint(info.Size()))
	reader, ok := file.(io.ReadSeeker)
	if !ok {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	http.ServeContent(w, r, name, info.ModTime(), reader)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeErrorDetails(w, status, code, nil)
}

func writeErrorDetails(w http.ResponseWriter, status int, code string, details map[string]any) {
	id := w.Header().Get("X-Request-ID")
	if tracked, ok := w.(*requestLogWriter); ok {
		tracked.recordError(status, code)
	} else {
		// Direct handler tests and non-HTTP callers still get the fixed-field
		// diagnostic. Never serialize request/response data or raw errors.
		attributes := []any{"request_id", id, "status", status, "code", code}
		if status >= http.StatusInternalServerError {
			slog.Error("API request failed", attributes...)
		} else {
			slog.Warn("API request rejected", attributes...)
		}
	}
	payload := make(map[string]any, len(details)+2)
	for key, value := range details {
		payload[key] = value
	}
	payload["error"] = code
	payload["requestId"] = id
	writeJSON(w, status, payload)
}

func prelogin(w http.ResponseWriter, r *http.Request, database *db.DB, secret []byte) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var request struct {
		Username string `json:"username"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || len(request.Username) > 128 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !allowAuthAttempt(w, r, database, secret, "login") {
		return
	}
	var username string
	var state string
	var vaultConfig []byte
	err := database.QueryRowContext(r.Context(), `SELECT u.username, u.state, COALESCE(v.config_json, X'')
		FROM users u LEFT JOIN vault_config v ON v.id = 1 WHERE u.id = 1`).Scan(&username, &state, &vaultConfig)
	if err == nil && request.Username == username && state == "active" {
		var configuration struct {
			Slots []struct {
				Type string `json:"type"`
				KDF  struct {
					Alg  string `json:"alg"`
					Salt string `json:"salt"`
					M    uint32 `json:"m"`
					T    uint32 `json:"t"`
					P    uint32 `json:"p"`
				} `json:"kdf"`
			} `json:"slots"`
		}
		if json.Unmarshal(vaultConfig, &configuration) == nil {
			for _, slot := range configuration.Slots {
				salt, saltErr := base64.StdEncoding.Strict().DecodeString(slot.KDF.Salt)
				if slot.Type == "password" && saltErr == nil && base64.StdEncoding.EncodeToString(salt) == slot.KDF.Salt && len(salt) >= 16 && len(salt) <= 64 && slot.KDF.Alg == "argon2id" && slot.KDF.M >= 32768 && slot.KDF.M <= 131072 && slot.KDF.T >= 2 && slot.KDF.T <= 6 && slot.KDF.P >= 1 && slot.KDF.P <= 4 {
					writeJSON(w, http.StatusOK, map[string]any{"kdf": slot.KDF})
					return
				}
			}
		}
		writeError(w, http.StatusInternalServerError, "vault_config_invalid")
		return
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("prelogin"))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(request.Username))
	fakeSalt := base64.StdEncoding.EncodeToString(mac.Sum(nil)[:16])
	writeJSON(w, http.StatusOK, map[string]any{"kdf": map[string]any{
		"alg": "argon2id", "salt": fakeSalt, "m": 65536, "t": 3, "p": 1,
	}})
}

func loadOrCreateServerSecret(path string) ([]byte, error) {
	if path == "" {
		return nil, fmt.Errorf("server secret path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create server secret directory: %w", err)
	}
	data, err := os.ReadFile(path)
	if err == nil {
		if len(data) != 32 {
			return nil, fmt.Errorf("server secret must contain exactly 32 bytes")
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return nil, fmt.Errorf("restrict server secret permissions: %w", err)
		}
		return data, nil
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read server secret: %w", err)
	}
	secret := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, secret); err != nil {
		return nil, fmt.Errorf("generate server secret: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return loadOrCreateServerSecret(path)
		}
		return nil, fmt.Errorf("create server secret: %w", err)
	}
	if _, err := file.Write(secret); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return nil, fmt.Errorf("write server secret: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return nil, fmt.Errorf("sync server secret: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("close server secret: %w", err)
	}
	return secret, nil
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
		w.Header().Set("X-Request-ID", newRequestID())
		next.ServeHTTP(w, r)
	})
}

func newRequestID() string {
	var id [16]byte
	if _, err := io.ReadFull(rand.Reader, id[:]); err == nil {
		return fmt.Sprintf("%x", id[:])
	}
	return fmt.Sprintf("%x-%x", time.Now().UTC().UnixNano(), requestCounter.Add(1))
}
