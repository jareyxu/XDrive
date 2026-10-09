package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"xdrive/internal/db"
)

const (
	sessionCookieName = "xdrive_session"
	sessionIdle       = 12 * time.Hour
	maxSetupBody      = 12 << 20
	maxIndexObject    = 4 << 20
	authAttemptWindow = 15 * time.Minute
)

var opaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

type sessionIdleContextKey struct{}

func requestSessionIdle(r *http.Request) time.Duration {
	if duration, ok := r.Context().Value(sessionIdleContextKey{}).(time.Duration); ok && duration >= time.Second {
		return duration
	}
	return sessionIdle
}

type vaultConfigV1 struct {
	FormatVersion uint32      `json:"formatVersion"`
	Revision      uint64      `json:"revision"`
	Slots         []keySlotV1 `json:"slots"`
}

type keySlotV1 struct {
	SlotID  string    `json:"slotId"`
	Type    string    `json:"type"`
	KDF     kdfV1     `json:"kdf"`
	Wrapped wrappedV1 `json:"wrapped"`
}

type kdfV1 struct {
	Alg  string `json:"alg"`
	Salt string `json:"salt"`
	M    uint32 `json:"m"`
	T    uint32 `json:"t"`
	P    uint32 `json:"p"`
}

type wrappedV1 struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type setupObject struct {
	MetadataID      string `json:"metadataId"`
	ObjectID        string `json:"objectId"`
	Revision        uint64 `json:"revision"`
	EncryptedObject string `json:"encryptedObject"`
}

var errSetupObjectConflict = errors.New("setup object already exists")

func setup(w http.ResponseWriter, r *http.Request, database *db.DB, storagePath, username string, quotaBytes int64) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "origin_rejected")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSetupBody)
	var request struct {
		Token       string          `json:"token"`
		AuthKey     string          `json:"authKey"`
		VaultConfig json.RawMessage `json:"vaultConfig"`
		RootIndex   setupObject     `json:"rootIndex"`
		TrashIndex  setupObject     `json:"trashIndex"`
	}
	if err := decodeJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	token, err := base64.RawURLEncoding.Strict().DecodeString(request.Token)
	if err != nil || len(token) != 32 {
		writeError(w, http.StatusNotFound, "setup_unavailable")
		return
	}
	defer zero(token)
	authKey, err := base64.StdEncoding.Strict().DecodeString(request.AuthKey)
	if err != nil || len(authKey) != 32 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	defer zero(authKey)
	configuration, err := parseVaultConfig(request.VaultConfig)
	if err != nil || configuration.Revision != 1 {
		writeError(w, http.StatusBadRequest, "invalid_vault_config")
		return
	}
	rootBytes, err := decodeSetupIndex(request.RootIndex)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_root_index")
		return
	}
	trashBytes, err := decodeSetupIndex(request.TrashIndex)
	if err != nil || request.RootIndex.MetadataID == request.TrashIndex.MetadataID || request.RootIndex.ObjectID == request.TrashIndex.ObjectID {
		writeError(w, http.StatusBadRequest, "invalid_trash_index")
		return
	}

	var storedTokenHash []byte
	var expiresAt int64
	err = database.QueryRowContext(r.Context(), "SELECT token_hash, expires_at FROM setup_tokens WHERE id = 1").Scan(&storedTokenHash, &expiresAt)
	if err != nil || time.Now().Unix() >= expiresAt {
		writeError(w, http.StatusNotFound, "setup_unavailable")
		return
	}
	tokenHash := sha256.Sum256(token)
	if len(storedTokenHash) != len(tokenHash) || subtle.ConstantTimeCompare(storedTokenHash, tokenHash[:]) != 1 {
		writeError(w, http.StatusNotFound, "setup_unavailable")
		return
	}

	rootPath, err := persistOpaqueObject(storagePath, request.RootIndex.ObjectID, rootBytes)
	if err != nil {
		if errors.Is(err, errSetupObjectConflict) {
			writeError(w, http.StatusConflict, "setup_conflict")
		} else {
			writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		}
		return
	}
	trashPath, err := persistOpaqueObject(storagePath, request.TrashIndex.ObjectID, trashBytes)
	if err != nil {
		_ = os.Remove(rootPath)
		if errors.Is(err, errSetupObjectConflict) {
			writeError(w, http.StatusConflict, "setup_conflict")
		} else {
			writeError(w, http.StatusInsufficientStorage, "storage_unavailable")
		}
		return
	}
	cleanupFiles := true
	defer func() {
		if cleanupFiles {
			_ = os.Remove(rootPath)
			_ = os.Remove(trashPath)
		}
	}()

	var authSalt [16]byte
	if _, err := io.ReadFull(rand.Reader, authSalt[:]); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	authHash := sha256.New()
	_, _ = authHash.Write(authSalt[:])
	_, _ = authHash.Write(authKey)
	now := time.Now().Unix()
	tx, err := database.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	defer tx.Rollback()
	reserve, err := maintenanceRemaining(r.Context(), tx)
	if err != nil {
		writeError(w, 500, "internal_error")
		return
	}
	var used int64
	if err = tx.QueryRowContext(r.Context(), "SELECT COALESCE(SUM(size_bytes),0) FROM objects WHERE state IN ('live','pending')").Scan(&used); err != nil {
		writeError(w, 500, "internal_error")
		return
	}
	if used > quotaBytes || reserve > quotaBytes-used || int64(len(rootBytes)+len(trashBytes)) > quotaBytes-used-reserve {
		writeError(w, 507, "quota_exceeded")
		return
	}
	var state, storedUsername string
	if err := tx.QueryRowContext(r.Context(), "SELECT state, username FROM users WHERE id = 1").Scan(&state, &storedUsername); err != nil || state != "pending_setup" || storedUsername != username {
		writeError(w, http.StatusNotFound, "setup_unavailable")
		return
	}
	var latestHash []byte
	var latestExpiry int64
	if err := tx.QueryRowContext(r.Context(), "SELECT token_hash, expires_at FROM setup_tokens WHERE id = 1").Scan(&latestHash, &latestExpiry); err != nil || latestExpiry <= now || subtle.ConstantTimeCompare(latestHash, tokenHash[:]) != 1 {
		writeError(w, http.StatusNotFound, "setup_unavailable")
		return
	}
	if err := insertSetupObject(r.Context(), tx, request.RootIndex, rootBytes, now); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := insertSetupObject(r.Context(), tx, request.TrashIndex, trashBytes, now); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO vault_config (id, format_version, revision, config_json) VALUES (1, ?, ?, ?)`, configuration.FormatVersion, configuration.Revision, request.VaultConfig); err != nil {
		writeError(w, http.StatusConflict, "setup_conflict")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE users SET auth_salt = ?, auth_hash = ?, state = 'active' WHERE id = 1 AND state = 'pending_setup'`, authSalt[:], authHash.Sum(nil)); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM setup_tokens WHERE id = 1"); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE server_state SET vault_mutation_revision = 1 WHERE id = 1"); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusConflict, "setup_conflict")
		return
	}
	cleanupFiles = false
	writeJSON(w, http.StatusCreated, map[string]string{"status": "setup_complete"})
}

func login(w http.ResponseWriter, r *http.Request, database *db.DB, username string, secret []byte) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "origin_rejected")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var request struct {
		Username string `json:"username"`
		AuthKey  string `json:"authKey"`
	}
	if decodeJSON(r, &request) != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !allowAuthAttempt(w, r, database, secret, "login") {
		return
	}
	if request.Username != username {
		writeError(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	key, err := base64.StdEncoding.Strict().DecodeString(request.AuthKey)
	if err != nil || len(key) != 32 || !verifyAuthKey(r.Context(), database, key) {
		zero(key)
		writeError(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	defer zero(key)
	csrf, err := issueSession(w, r, database)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeVaultResponseWithCSRF(w, r, database, csrf)
}

func unlock(w http.ResponseWriter, r *http.Request, database *db.DB, secret []byte) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "origin_rejected")
		return
	}
	if !validSessionAndCSRF(r, database) {
		writeError(w, http.StatusUnauthorized, "invalid_session")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var request struct {
		AuthKey string `json:"authKey"`
	}
	if decodeJSON(r, &request) != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !allowAuthAttempt(w, r, database, secret, "unlock") {
		return
	}
	key, err := base64.StdEncoding.Strict().DecodeString(request.AuthKey)
	if err != nil || len(key) != 32 || !verifyAuthKey(r.Context(), database, key) {
		zero(key)
		writeError(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	defer zero(key)
	writeVaultResponseWithCSRF(w, r, database, csrfTokenForRequest(r, database))
}

func changePassword(w http.ResponseWriter, r *http.Request, database *db.DB, secret []byte) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "origin_rejected")
		return
	}
	if !validSessionAndCSRF(r, database) {
		writeError(w, http.StatusUnauthorized, "invalid_session")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var request struct {
		CurrentAuthKey         string          `json:"currentAuthKey"`
		NewAuthKey             string          `json:"newAuthKey"`
		NewVaultConfig         json.RawMessage `json:"newVaultConfig"`
		ExpectedConfigRevision uint64          `json:"expectedConfigRevision"`
	}
	if decodeJSON(r, &request) != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !allowAuthAttempt(w, r, database, secret, "change-password") {
		return
	}
	currentKey, currentError := base64.StdEncoding.Strict().DecodeString(request.CurrentAuthKey)
	newKey, newError := base64.StdEncoding.Strict().DecodeString(request.NewAuthKey)
	defer zero(currentKey)
	defer zero(newKey)
	if currentError != nil || newError != nil || len(currentKey) != 32 || len(newKey) != 32 ||
		base64.StdEncoding.EncodeToString(currentKey) != request.CurrentAuthKey || base64.StdEncoding.EncodeToString(newKey) != request.NewAuthKey {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	configuration, err := parseVaultConfig(request.NewVaultConfig)
	if err != nil || request.ExpectedConfigRevision == 0 || request.ExpectedConfigRevision >= math.MaxInt64 || configuration.Revision != request.ExpectedConfigRevision+1 {
		writeError(w, http.StatusBadRequest, "invalid_vault_config")
		return
	}
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_session")
		return
	}
	sessionHash := sha256.Sum256([]byte(cookie.Value))
	tx, err := database.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	defer tx.Rollback()
	var activeSessionCount int
	if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM sessions WHERE id_hash = ? AND expires_at > ?", sessionHash[:], time.Now().Unix()).Scan(&activeSessionCount); err != nil || activeSessionCount != 1 {
		writeError(w, http.StatusUnauthorized, "invalid_session")
		return
	}
	var salt, storedHash []byte
	var state string
	if err := tx.QueryRowContext(r.Context(), "SELECT auth_salt, auth_hash, state FROM users WHERE id = 1").Scan(&salt, &storedHash, &state); err != nil || state != "active" || len(salt) != 16 || len(storedHash) != 32 {
		writeError(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	currentHasher := sha256.New()
	_, _ = currentHasher.Write(salt)
	_, _ = currentHasher.Write(currentKey)
	if subtle.ConstantTimeCompare(currentHasher.Sum(nil), storedHash) != 1 {
		writeError(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	var currentRevision int64
	if err := tx.QueryRowContext(r.Context(), "SELECT revision FROM vault_config WHERE id = 1").Scan(&currentRevision); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if uint64(currentRevision) != request.ExpectedConfigRevision {
		writeError(w, http.StatusConflict, "vault_config_conflict")
		return
	}
	var newSalt [16]byte
	if _, err := io.ReadFull(rand.Reader, newSalt[:]); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	defer zero(newSalt[:])
	newHasher := sha256.New()
	_, _ = newHasher.Write(newSalt[:])
	_, _ = newHasher.Write(newKey)
	if _, err := tx.ExecContext(r.Context(), "UPDATE users SET auth_salt = ?, auth_hash = ? WHERE id = 1 AND state = 'active'", newSalt[:], newHasher.Sum(nil)); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE vault_config SET revision = ?, config_json = ? WHERE id = 1 AND revision = ?", configuration.Revision, request.NewVaultConfig, currentRevision); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM sessions WHERE id_hash <> ?", sessionHash[:]); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"vaultConfig": json.RawMessage(request.NewVaultConfig)})
}

func logout(w http.ResponseWriter, r *http.Request, database *db.DB) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "origin_rejected")
		return
	}
	cookie, err := r.Cookie(sessionCookieName)
	if err == nil {
		hash := sha256.Sum256([]byte(cookie.Value))
		if validSessionAndCSRF(r, database) {
			_, _ = database.ExecContext(r.Context(), "DELETE FROM sessions WHERE id_hash = ?", hash[:])
		}
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	w.WriteHeader(http.StatusNoContent)
}

func sessionInfo(w http.ResponseWriter, r *http.Request, database *db.DB) {
	if !validSession(r, database) {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
		return
	}
	csrf := csrfTokenForRequest(r, database)
	writeVaultResponseWithCSRF(w, r, database, csrf)
}

func verifyAuthKey(ctx context.Context, database *db.DB, key []byte) bool {
	var salt, expected []byte
	var state string
	if err := database.QueryRowContext(ctx, "SELECT auth_salt, auth_hash, state FROM users WHERE id = 1").Scan(&salt, &expected, &state); err != nil || state != "active" || len(salt) != 16 || len(expected) != 32 {
		return false
	}
	hash := sha256.New()
	_, _ = hash.Write(salt)
	_, _ = hash.Write(key)
	return subtle.ConstantTimeCompare(hash.Sum(nil), expected) == 1
}

func issueSession(w http.ResponseWriter, r *http.Request, database *db.DB) (string, error) {
	var tokenBytes, csrfBytes [32]byte
	defer zero(tokenBytes[:])
	defer zero(csrfBytes[:])
	if _, err := io.ReadFull(rand.Reader, tokenBytes[:]); err != nil {
		return "", err
	}
	if _, err := io.ReadFull(rand.Reader, csrfBytes[:]); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes[:])
	csrf := base64.RawURLEncoding.EncodeToString(csrfBytes[:])
	hash := sha256.Sum256([]byte(token))
	now := time.Now()
	if _, err := database.ExecContext(r.Context(), "INSERT INTO sessions (id_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)", hash[:], csrf, now.Unix(), now.Unix(), now.Add(requestSessionIdle(r)).Unix()); err != nil {
		return "", err
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: token, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
	return csrf, nil
}

func validSession(r *http.Request, database *db.DB) bool {
	return validSessionAt(r, database, time.Now())
}

func validSessionAt(r *http.Request, database *db.DB, now time.Time) bool {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || len(cookie.Value) < 32 || len(cookie.Value) > 64 {
		return false
	}
	hash := sha256.Sum256([]byte(cookie.Value))
	nowUnix := now.Unix()
	idle := requestSessionIdle(r)
	// Validate and renew in one statement; a stale read must not resurrect an
	// expired/deleted session, and out-of-order requests must not move time back.
	result, err := database.ExecContext(r.Context(), `UPDATE sessions SET
		last_seen_at = MAX(last_seen_at, ?),
		expires_at = CASE WHEN last_seen_at > ? THEN expires_at ELSE ? END
		WHERE id_hash = ? AND expires_at > ? AND last_seen_at > ?`, nowUnix, nowUnix, now.Add(idle).Unix(), hash[:], nowUnix, nowUnix-int64(idle/time.Second))
	if err != nil {
		return false
	}
	count, err := result.RowsAffected()
	return err == nil && count == 1
}

func validSessionAndCSRF(r *http.Request, database *db.DB) bool {
	if !validSession(r, database) {
		return false
	}
	provided := r.Header.Get("X-CSRF-Token")
	stored := csrfTokenForRequest(r, database)
	if provided == "" || stored == "" || len(provided) != len(stored) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(stored)) == 1
}

func csrfTokenForRequest(r *http.Request, database *db.DB) string {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	hash := sha256.Sum256([]byte(cookie.Value))
	var csrf string
	if err := database.QueryRowContext(r.Context(), "SELECT csrf_token FROM sessions WHERE id_hash = ?", hash[:]).Scan(&csrf); err != nil {
		return ""
	}
	return csrf
}

func writeVaultResponseWithCSRF(w http.ResponseWriter, r *http.Request, database *db.DB, csrf string) {
	var config []byte
	var revision int64
	var username string
	err := database.QueryRowContext(r.Context(), `SELECT v.config_json, s.vault_mutation_revision, u.username
		FROM vault_config v CROSS JOIN server_state s CROSS JOIN users u WHERE v.id = 1 AND s.id = 1 AND u.id = 1`).Scan(&config, &revision, &username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	w.Header().Set("X-CSRF-Token", csrf)
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "username": username, "vaultConfig": json.RawMessage(config), "vaultMutationRevision": revision})
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || origin == "null" {
		return false
	}
	parsed, err := url.Parse(origin)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host == r.Host && parsed.User == nil && parsed.Path == "" && parsed.RawQuery == "" && parsed.Fragment == ""
}

func allowAuthAttempt(w http.ResponseWriter, r *http.Request, database *db.DB, secret []byte, operation string) bool {
	key := hmac.New(sha256.New, secret)
	_, _ = key.Write([]byte("auth-rate-v1\x00"))
	_, _ = key.Write([]byte(clientIP(r)))
	_, _ = key.Write([]byte{0})
	_, _ = key.Write([]byte(operation))
	allowed, retryAfter, err := consumeAuthAttempt(r.Context(), database, key.Sum(nil), time.Now())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error")
		return false
	}
	if !allowed {
		w.Header().Set("Retry-After", fmt.Sprint(retryAfter))
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return false
	}
	return true
}

func consumeAuthAttempt(ctx context.Context, database *db.DB, key []byte, now time.Time) (bool, int64, error) {
	const limit = int64(30)
	window := int64(authAttemptWindow / time.Second)
	started := now.Unix()
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return false, 0, err
	}
	defer tx.Rollback()
	var failures, windowStarted, blockedUntil int64
	err = tx.QueryRowContext(ctx, "SELECT failures, window_started_at, blocked_until FROM login_attempts WHERE attempt_key = ?", key).Scan(&failures, &windowStarted, &blockedUntil)
	if err != nil && err != sql.ErrNoRows {
		return false, 0, err
	}
	if err == sql.ErrNoRows || windowStarted+window <= started {
		failures, windowStarted, blockedUntil = 1, started, 0
	} else if blockedUntil > started {
		return false, blockedUntil - started, nil
	} else {
		failures++
	}
	if failures >= limit {
		blockedUntil = windowStarted + window
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO login_attempts (attempt_key, failures, window_started_at, blocked_until)
		VALUES (?, ?, ?, ?) ON CONFLICT(attempt_key) DO UPDATE SET failures = excluded.failures,
		window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until`, key, failures, windowStarted, blockedUntil)
	if err != nil {
		return false, 0, err
	}
	if err := tx.Commit(); err != nil {
		return false, 0, err
	}
	if blockedUntil > started {
		return false, blockedUntil - started, nil
	}
	return true, 0, nil
}

func clientIP(r *http.Request) string {
	remote := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	parsed, err := netip.ParseAddr(remote)
	if err != nil {
		return "unknown"
	}
	if parsed.IsLoopback() {
		forwarded := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		if len(forwarded) > 0 {
			candidate := strings.TrimSpace(forwarded[0])
			if ip, err := netip.ParseAddr(candidate); err == nil {
				return ip.Unmap().String()
			}
		}
	}
	return parsed.Unmap().String()
}

func decodeJSON(r *http.Request, destination any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return errors.New("expected JSON content type")
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("multiple JSON values")
	}
	return nil
}

func parseVaultConfig(raw json.RawMessage) (vaultConfigV1, error) {
	var configuration vaultConfigV1
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&configuration); err != nil {
		return configuration, err
	}
	if (configuration.FormatVersion != 1 && configuration.FormatVersion != 2) || configuration.Revision < 1 || configuration.Revision > math.MaxInt64 || len(configuration.Slots) != 1 {
		return configuration, errors.New("invalid vault config version or slots")
	}
	slot := configuration.Slots[0]
	if slot.Type != "password" || slot.SlotID == "" || len(slot.SlotID) > 128 || slot.KDF.Alg != "argon2id" || slot.KDF.M < 32768 || slot.KDF.M > 131072 || slot.KDF.T < 2 || slot.KDF.T > 6 || slot.KDF.P < 1 || slot.KDF.P > 4 {
		return configuration, errors.New("invalid password slot")
	}
	salt, err := base64.StdEncoding.Strict().DecodeString(slot.KDF.Salt)
	if err != nil || len(salt) < 16 || len(salt) > 64 || base64.StdEncoding.EncodeToString(salt) != slot.KDF.Salt {
		return configuration, errors.New("invalid KDF salt")
	}
	nonce, nonceErr := base64.StdEncoding.Strict().DecodeString(slot.Wrapped.Nonce)
	ciphertext, ciphertextErr := base64.StdEncoding.Strict().DecodeString(slot.Wrapped.Ciphertext)
	if nonceErr != nil || ciphertextErr != nil || len(nonce) != 12 || len(ciphertext) != 48 || base64.StdEncoding.EncodeToString(nonce) != slot.Wrapped.Nonce || base64.StdEncoding.EncodeToString(ciphertext) != slot.Wrapped.Ciphertext {
		return configuration, errors.New("invalid wrapped Vault Key")
	}
	return configuration, nil
}

func decodeSetupIndex(item setupObject) ([]byte, error) {
	if !opaqueIDPattern.MatchString(item.MetadataID) || !opaqueIDPattern.MatchString(item.ObjectID) || item.Revision != 1 {
		return nil, errors.New("invalid index identifiers or revision")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(item.EncryptedObject)
	if err != nil || len(data) < 36 || len(data) > maxIndexObject || base64.StdEncoding.EncodeToString(data) != item.EncryptedObject {
		return nil, errors.New("invalid encrypted index")
	}
	if string(data[:4]) != "XDRV" || data[4] != 1 || data[5] != 1 || data[6] != 0 || data[7] != 0 {
		return nil, errors.New("unsupported encrypted index envelope")
	}
	return data, nil
}

func persistOpaqueObject(storagePath, objectID string, data []byte) (string, error) {
	if !opaqueIDPattern.MatchString(objectID) {
		return "", errors.New("invalid object ID")
	}
	directory := filepath.Join(storagePath, objectID[:2])
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	finalPath := filepath.Join(directory, objectID)
	var random [8]byte
	if _, err := io.ReadFull(rand.Reader, random[:]); err != nil {
		return "", err
	}
	tmpPath := filepath.Join(directory, ".setup-"+hex.EncodeToString(random[:]))
	file, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := os.Link(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		if errors.Is(err, os.ErrExist) {
			return "", errors.Join(errSetupObjectConflict, err)
		}
		return "", err
	}
	_ = os.Remove(tmpPath)
	dir, err := os.Open(directory)
	if err == nil {
		err = dir.Sync()
		_ = dir.Close()
	}
	if err != nil {
		_ = os.Remove(finalPath)
		return "", err
	}
	return finalPath, nil
}

func insertSetupObject(ctx context.Context, tx *sql.Tx, item setupObject, data []byte, now int64) error {
	digest := sha256.Sum256(data)
	if _, err := tx.ExecContext(ctx, "INSERT INTO objects (id, size_bytes, sha256, state, upload_session_id, created_at) VALUES (?, ?, ?, 'live', NULL, ?)", item.ObjectID, len(data), digest[:], now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO metadata_pointers (id, object_id, revision, updated_at) VALUES (?, ?, 1, ?)", item.MetadataID, item.ObjectID, now); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO metadata_versions (metadata_id, revision, object_id, created_at) VALUES (?, 1, ?, ?)", item.MetadataID, item.ObjectID, now)
	return err
}

func zero(bytes []byte) {
	for i := range bytes {
		bytes[i] = 0
	}
}
