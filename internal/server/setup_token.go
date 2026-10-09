package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"io"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
)

// CreateSetupToken creates the pending single-user account if needed, replaces
// any previous setup token, and returns the one-time token for CLI display.
func CreateSetupToken(ctx context.Context, cfg config.Config) (string, error) {
	if cfg.SetupTokenTTL == "" {
		cfg.SetupTokenTTL = config.DefaultSetupTokenTTL
	}
	ttl, err := config.ParseSetupTokenTTL(cfg.SetupTokenTTL)
	if err != nil {
		return "", err
	}
	database, err := db.OpenCurrent(ctx, cfg.DatabasePath)
	if err != nil {
		return "", err
	}
	defer database.Close()
	token := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, token); err != nil {
		return "", err
	}
	defer zero(token)
	tokenHash := sha256.Sum256(token)
	now := time.Now()
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var state, username string
	err = tx.QueryRowContext(ctx, "SELECT state, username FROM users WHERE id = 1").Scan(&state, &username)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := tx.ExecContext(ctx, "INSERT INTO users (id, username, state, created_at) VALUES (1, ?, 'pending_setup', ?)", cfg.Username, now.Unix()); err != nil {
			return "", err
		}
	case err != nil:
		return "", err
	case state != "pending_setup":
		return "", errors.New("setup is already complete")
	case username != cfg.Username:
		return "", errors.New("configured username does not match the pending account")
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM setup_tokens WHERE id = 1"); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO setup_tokens (id, token_hash, expires_at, created_at) VALUES (1, ?, ?, ?)", tokenHash[:], now.Add(ttl).Unix(), now.Unix()); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(token), nil
}
