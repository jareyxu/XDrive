package server

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
)

func TestAuthRateLimitHasSharedWindowAndExpires(t *testing.T) {
	database, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "drive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	key := make([]byte, 32)
	start := time.Unix(1_800_000_000, 0)
	for attempt := 1; attempt < 30; attempt++ {
		allowed, _, err := consumeAuthAttempt(context.Background(), database, key, start.Add(time.Duration(attempt)*time.Second))
		if err != nil || !allowed {
			t.Fatalf("attempt %d: allowed=%v err=%v", attempt, allowed, err)
		}
	}
	allowed, retryAfter, err := consumeAuthAttempt(context.Background(), database, key, start.Add(30*time.Second))
	if err != nil || allowed || retryAfter <= 0 {
		t.Fatalf("limit boundary: allowed=%v retryAfter=%d err=%v", allowed, retryAfter, err)
	}
	allowed, _, err = consumeAuthAttempt(context.Background(), database, key, start.Add(31*time.Second))
	if err != nil || allowed {
		t.Fatalf("blocked attempt: allowed=%v err=%v", allowed, err)
	}
	allowed, _, err = consumeAuthAttempt(context.Background(), database, key, start.Add(16*time.Minute))
	if err != nil || !allowed {
		t.Fatalf("expired window: allowed=%v err=%v", allowed, err)
	}
}

func TestCleanupPrunesExpiredAuthRateLimitRows(t *testing.T) {
	root := t.TempDir()
	handler, err := New(config.Config{
		ListenAddr:   "127.0.0.1:0",
		DatabasePath: filepath.Join(root, "drive.db"),
		StoragePath:  filepath.Join(root, "objects"),
		SecretPath:   filepath.Join(root, "server.secret"),
		Username:     "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()

	now := time.Unix(1_800_000_000, 0)
	expiredKey := make([]byte, 32)
	expiredKey[0] = 1
	activeKey := make([]byte, 32)
	activeKey[0] = 2
	if _, err := handler.Database().Exec(`INSERT INTO login_attempts (attempt_key, failures, window_started_at, blocked_until) VALUES (?, 1, ?, 0), (?, 1, ?, 0)`, expiredKey, now.Add(-authAttemptWindow-time.Second).Unix(), activeKey, now.Add(-time.Second).Unix()); err != nil {
		t.Fatal(err)
	}
	if err := cleanupOnceCore(context.Background(), handler.Database(), filepath.Join(root, "objects"), now, false, trashRetention, config.DefaultMetadataKeepVersions, ""); err != nil {
		t.Fatal(err)
	}
	var expiredRows, activeRows int
	if err := handler.Database().QueryRow("SELECT COUNT(*) FROM login_attempts WHERE attempt_key = ?", expiredKey).Scan(&expiredRows); err != nil {
		t.Fatal(err)
	}
	if err := handler.Database().QueryRow("SELECT COUNT(*) FROM login_attempts WHERE attempt_key = ?", activeKey).Scan(&activeRows); err != nil {
		t.Fatal(err)
	}
	if expiredRows != 0 || activeRows != 1 {
		t.Fatalf("cleanup kept expired=%d and active=%d rows, want 0 and 1", expiredRows, activeRows)
	}
}
