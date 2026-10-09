package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	for _, key := range []string{"XDRIVE_LISTEN_ADDR", "XDRIVE_LOG_LEVEL", "XDRIVE_DATABASE_PATH", "XDRIVE_STORAGE_PATH", "XDRIVE_SECRET_PATH", "XDRIVE_USERNAME", "XDRIVE_QUOTA_BYTES", "XDRIVE_DISK_SAFETY_BYTES", "XDRIVE_MIN_FREE_DISK_BYTES", "XDRIVE_MAINTENANCE_RESERVE_BYTES", "XDRIVE_TEXT_PREVIEW_LIMIT", "XDRIVE_VIDEO_BLOB_FALLBACK_LIMIT", "XDRIVE_ZIP_MEMORY_FALLBACK_LIMIT", "XDRIVE_OBJECT_PUT_MAX_BYTES", "XDRIVE_UPLOAD_EXPIRY", "XDRIVE_TRASH_RETENTION", "XDRIVE_SESSION_IDLE_TIMEOUT", "XDRIVE_SETUP_TOKEN_TTL", "XDRIVE_METADATA_KEEP_VERSIONS", "XDRIVE_BACKUP_WARN_AFTER_DAYS"} {
		t.Setenv(key, "")
	}
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BackupWarnAfterDays != DefaultBackupWarnAfterDays || cfg.ZipMemoryFallbackLimit != DefaultZipMemoryFallbackLimit || cfg.VideoBlobFallbackLimit != DefaultVideoBlobFallbackLimit || cfg.MetadataKeepVersions != DefaultMetadataKeepVersions || cfg.SetupTokenTTL != DefaultSetupTokenTTL || cfg.SessionIdleTimeout != DefaultSessionIdleTimeout || cfg.TrashRetention != DefaultTrashRetention || cfg.UploadExpiry != DefaultUploadExpiry || cfg.ObjectPutMaxBytes != DefaultObjectPutMaxBytes || cfg.TextPreviewLimit != DefaultTextPreviewLimit || cfg.ListenAddr != "127.0.0.1:8787" || cfg.LogLevel != DefaultLogLevel || cfg.QuotaBytes != DefaultQuotaBytes || cfg.DiskSafetyBytes != DefaultDiskSafetyBytes || cfg.MaintenanceReserveBytes != DefaultMaintenanceReserveBytes {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestLoadTOMLAndEnvironmentOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	contents := "listen_addr = '127.0.0.1:9000'\nlog_level = 'warn'\ndatabase_path = 'state/drive.db'\nstorage_path = 'state/objects'\nquota_bytes = 12345\n"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_LISTEN_ADDR", "127.0.0.1:9001")
	t.Setenv("XDRIVE_LOG_LEVEL", "debug")
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != "127.0.0.1:9001" || cfg.LogLevel != "debug" || cfg.QuotaBytes != 12345 {
		t.Fatalf("TOML/env precedence incorrect: %+v", cfg)
	}
}

func TestLogLevelValidation(t *testing.T) {
	for _, value := range []string{"debug", "info", "warn", "error"} {
		if err := ValidateLogLevel(value); err != nil {
			t.Fatalf("accepted level %q: %v", value, err)
		}
	}
	for _, value := range []string{"INFO", "trace", "off", "debug ", "secret"} {
		t.Setenv("XDRIVE_LOG_LEVEL", value)
		if _, err := Load(""); err == nil {
			t.Fatalf("accepted invalid level %q", value)
		}
	}
}

func TestLoadRejectsUnknownTOMLField(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("password = 'must-not-be-configurable'"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("unknown field must be rejected")
	}
}

func TestMaintenanceReserveConfigurationBounds(t *testing.T) {
	for _, value := range []string{"-1", "8388609", "9223372036854775808", "invalid"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("XDRIVE_MAINTENANCE_RESERVE_BYTES", value)
			if _, err := Load(""); err == nil {
				t.Fatal("accepted invalid reserve")
			}
		})
	}
	t.Setenv("XDRIVE_QUOTA_BYTES", "4000")
	t.Setenv("XDRIVE_MAINTENANCE_RESERVE_BYTES", "8388608")
	cfg, err := Load("")
	if err != nil || cfg.MaintenanceReserveBytes != 1000 {
		t.Fatalf("small quota reserve %d %v", cfg.MaintenanceReserveBytes, err)
	}
	t.Setenv("XDRIVE_MAINTENANCE_RESERVE_BYTES", "0")
	cfg, err = Load("")
	if err != nil || cfg.MaintenanceReserveBytes != 0 {
		t.Fatal("explicit zero test reserve")
	}
}

func TestTextPreviewLimitConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("text_preview_limit = 1048576"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_TEXT_PREVIEW_LIMIT", "")
	cfg, err := Load(path)
	if err != nil || cfg.TextPreviewLimit != 1048576 {
		t.Fatalf("TOML limit: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_TEXT_PREVIEW_LIMIT", "2097152")
	cfg, err = Load(path)
	if err != nil || cfg.TextPreviewLimit != 2097152 {
		t.Fatalf("override: %+v %v", cfg, err)
	}
	for _, value := range []string{"0", "-1", "536870913", "9223372036854775808", "invalid"} {
		t.Setenv("XDRIVE_TEXT_PREVIEW_LIMIT", value)
		if _, err := Load(path); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
	for _, value := range []string{"1", "536870912"} {
		t.Setenv("XDRIVE_TEXT_PREVIEW_LIMIT", value)
		if _, err := Load(path); err != nil {
			t.Fatal(err)
		}
	}
}

func TestObjectPutMaxConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("object_put_max_bytes = 17825792"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_OBJECT_PUT_MAX_BYTES", "")
	cfg, err := Load(path)
	if err != nil || cfg.ObjectPutMaxBytes != 17825792 {
		t.Fatalf("TOML maximum: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_OBJECT_PUT_MAX_BYTES", "8388645")
	cfg, err = Load(path)
	if err != nil || cfg.ObjectPutMaxBytes != MinObjectPutMaxBytes {
		t.Fatalf("override: %+v %v", cfg, err)
	}
	for _, value := range []string{"0", "-1", "8388644", "9223372036854775807", "9223372036854775808", "invalid"} {
		t.Setenv("XDRIVE_OBJECT_PUT_MAX_BYTES", value)
		if _, err := Load(path); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
	t.Setenv("XDRIVE_OBJECT_PUT_MAX_BYTES", "9223372036854775806")
	if _, err := Load(path); err != nil {
		t.Fatal(err)
	}
}

func TestUploadExpiryConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("upload_expiry = '2h'"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_UPLOAD_EXPIRY", "")
	cfg, err := Load(path)
	if err != nil || cfg.UploadExpiry != "2h" {
		t.Fatalf("TOML expiry: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_UPLOAD_EXPIRY", "1h30m")
	cfg, err = Load(path)
	if err != nil || cfg.UploadExpiry != "1h30m" {
		t.Fatalf("expiry override: %+v %v", cfg, err)
	}
	for _, value := range []string{"0s", "-1h", "0.5s", "1.5s", "invalid", "999999999999999999h"} {
		t.Setenv("XDRIVE_UPLOAD_EXPIRY", value)
		if _, err := Load(path); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
	for _, value := range []string{"1s", "24h", "48h", "1m30s"} {
		t.Setenv("XDRIVE_UPLOAD_EXPIRY", value)
		if _, err := Load(path); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTrashRetentionConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("trash_retention = '48h'"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_TRASH_RETENTION", "")
	cfg, err := Load(path)
	if err != nil || cfg.TrashRetention != "48h" {
		t.Fatalf("TOML: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_TRASH_RETENTION", "1h")
	cfg, err = Load(path)
	if err != nil || cfg.TrashRetention != "1h" {
		t.Fatalf("override: %+v %v", cfg, err)
	}
	for _, value := range []string{"0s", "-1h", "0.5s", "1.5s", "invalid", "999999999999999999h"} {
		t.Setenv("XDRIVE_TRASH_RETENTION", value)
		if _, err := Load(path); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
}

func TestSessionIdleTimeoutConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("session_idle_timeout = '2h'"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_SESSION_IDLE_TIMEOUT", "")
	cfg, err := Load(path)
	if err != nil || cfg.SessionIdleTimeout != "2h" {
		t.Fatalf("TOML: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_SESSION_IDLE_TIMEOUT", "1h30m")
	cfg, err = Load(path)
	if err != nil || cfg.SessionIdleTimeout != "1h30m" {
		t.Fatalf("override: %+v %v", cfg, err)
	}
	for _, value := range []string{"0s", "-1h", "0.5s", "1.5s", "invalid", "999999999999999999h"} {
		t.Setenv("XDRIVE_SESSION_IDLE_TIMEOUT", value)
		if _, err := Load(path); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
}

func TestSetupTokenTTLConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("setup_token_ttl = '2h'"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_SETUP_TOKEN_TTL", "")
	cfg, err := Load(path)
	if err != nil || cfg.SetupTokenTTL != "2h" {
		t.Fatalf("TOML: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_SETUP_TOKEN_TTL", "90s")
	cfg, err = Load(path)
	if err != nil || cfg.SetupTokenTTL != "90s" {
		t.Fatalf("override: %+v %v", cfg, err)
	}
	for _, value := range []string{"0s", "-1h", "0.5s", "1.5s", "invalid", "999999999999999999h"} {
		t.Setenv("XDRIVE_SETUP_TOKEN_TTL", value)
		if _, err := Load(path); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
}

func TestMetadataKeepVersionsConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("metadata_keep_versions = 2"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDRIVE_METADATA_KEEP_VERSIONS", "")
	cfg, err := Load(path)
	if err != nil || cfg.MetadataKeepVersions != 2 {
		t.Fatalf("TOML: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_METADATA_KEEP_VERSIONS", "1")
	cfg, err = Load(path)
	if err != nil || cfg.MetadataKeepVersions != 1 {
		t.Fatalf("override: %+v %v", cfg, err)
	}
	for _, value := range []string{"0", "-1", "1001", "1.5", "invalid", "9223372036854775808"} {
		t.Setenv("XDRIVE_METADATA_KEEP_VERSIONS", value)
		if _, err := Load(path); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
}

func TestMinimumFreeDiskCanonicalAndLegacyAliases(t *testing.T) {
	for _, item := range []struct {
		file, canonical, legacy string
		want                    int64
		bad                     bool
	}{
		{"min_free_disk_bytes = 0", "", "", 0, false},
		{"disk_safety_bytes = 123", "", "", 123, false},
		{"min_free_disk_bytes = 123", "456", "", 456, false},
		{"disk_safety_bytes = 123", "456", "", 456, false},
		{"min_free_disk_bytes = 123", "", "456", 456, false},
		{"min_free_disk_bytes = 0\ndisk_safety_bytes = 0", "", "", 0, true},
		{"", "0", "0", 0, true},
		{"min_free_disk_bytes = -1", "", "", 0, true},
		{"min_free_disk_bytes = 1.5", "", "", 0, true},
		{"", "-1", "", 0, true},
		{"", "invalid", "", 0, true},
		{"", "9223372036854775808", "", 0, true},
		{"min_free_disk_bytes = 9223372036854775807", "", "", 9223372036854775807, false},
	} {
		t.Run(item.file+item.canonical+item.legacy, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.toml")
			if err := os.WriteFile(path, []byte(item.file), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("XDRIVE_MIN_FREE_DISK_BYTES", item.canonical)
			t.Setenv("XDRIVE_DISK_SAFETY_BYTES", item.legacy)
			cfg, err := Load(path)
			if item.bad {
				if err == nil {
					t.Fatal("accepted ambiguous/invalid disk configuration")
				}
				return
			}
			if err != nil || cfg.DiskSafetyBytes != item.want {
				t.Fatalf("resolved disk value: %d %v", cfg.DiskSafetyBytes, err)
			}
		})
	}
}

func TestVideoBlobFallbackLimitConfiguration(t *testing.T) {
	for _, value := range []string{"0", "-1", "536870913", "9223372036854775808", "invalid"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("XDRIVE_VIDEO_BLOB_FALLBACK_LIMIT", value)
			if _, err := Load(""); err == nil {
				t.Fatal("invalid limit accepted")
			}
		})
	}
	t.Setenv("XDRIVE_VIDEO_BLOB_FALLBACK_LIMIT", "")
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("video_blob_fallback_limit = 1"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil || cfg.VideoBlobFallbackLimit != 1 {
		t.Fatalf("minimum: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_VIDEO_BLOB_FALLBACK_LIMIT", "536870912")
	cfg, err = Load(path)
	if err != nil || cfg.VideoBlobFallbackLimit != MaxVideoBlobFallbackLimit {
		t.Fatalf("env maximum: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_VIDEO_BLOB_FALLBACK_LIMIT", "")
	if err := os.WriteFile(path, []byte("video_blob_fallback_limit = 1.5"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("fraction accepted")
	}
}
func TestZipMemoryFallbackLimitConfiguration(t *testing.T) {
	for _, value := range []string{"0", "-1", "536870913", "9223372036854775808", "invalid"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("XDRIVE_ZIP_MEMORY_FALLBACK_LIMIT", value)
			if _, err := Load(""); err == nil {
				t.Fatal("invalid limit accepted")
			}
		})
	}
	t.Setenv("XDRIVE_ZIP_MEMORY_FALLBACK_LIMIT", "")
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("zip_memory_fallback_limit = 1"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil || cfg.ZipMemoryFallbackLimit != 1 {
		t.Fatalf("minimum: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_ZIP_MEMORY_FALLBACK_LIMIT", "536870912")
	cfg, err = Load(path)
	if err != nil || cfg.ZipMemoryFallbackLimit != MaxZipMemoryFallbackLimit {
		t.Fatalf("env maximum: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_ZIP_MEMORY_FALLBACK_LIMIT", "")
	if err := os.WriteFile(path, []byte("zip_memory_fallback_limit = 1.5"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("fraction accepted")
	}
}

func TestBackupWarnAfterDaysConfiguration(t *testing.T) {
	for _, value := range []string{"0", "-1", "3651", "1.5", "invalid", "9223372036854775808"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("XDRIVE_BACKUP_WARN_AFTER_DAYS", value)
			if _, err := Load(""); err == nil {
				t.Fatal("invalid days accepted")
			}
		})
	}
	t.Setenv("XDRIVE_BACKUP_WARN_AFTER_DAYS", "")
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("backup_warn_after_days = 1"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil || cfg.BackupWarnAfterDays != 1 {
		t.Fatalf("minimum: %+v %v", cfg, err)
	}
	t.Setenv("XDRIVE_BACKUP_WARN_AFTER_DAYS", "3650")
	cfg, err = Load(path)
	if err != nil || cfg.BackupWarnAfterDays != 3650 {
		t.Fatalf("override: %+v %v", cfg, err)
	}
}
