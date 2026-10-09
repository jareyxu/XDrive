package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/pelletier/go-toml/v2"
)

// Config contains only server-side configuration. User passwords and
// decryption keys must never be added here.
type Config struct {
	ListenAddr              string `toml:"listen_addr"`
	LogLevel                string `toml:"log_level"`
	DatabasePath            string `toml:"database_path"`
	StoragePath             string `toml:"storage_path"`
	SecretPath              string `toml:"secret_path"`
	Username                string `toml:"username"`
	QuotaBytes              int64  `toml:"quota_bytes"`
	DiskSafetyBytes         int64  `toml:"-"`
	MaintenanceReserveBytes int64  `toml:"maintenance_reserve_bytes"`
	ZipMemoryFallbackLimit  int64  `toml:"zip_memory_fallback_limit"`
	VideoBlobFallbackLimit  int64  `toml:"video_blob_fallback_limit"`
	TextPreviewLimit        int64  `toml:"text_preview_limit"`
	ObjectPutMaxBytes       int64  `toml:"object_put_max_bytes"`
	UploadExpiry            string `toml:"upload_expiry"`
	TrashRetention          string `toml:"trash_retention"`
	SessionIdleTimeout      string `toml:"session_idle_timeout"`
	SetupTokenTTL           string `toml:"setup_token_ttl"`
	BackupWarnAfterDays     int    `toml:"backup_warn_after_days"`
	MetadataKeepVersions    int    `toml:"metadata_keep_versions"`
}

const DefaultQuotaBytes int64 = 10 * 1024 * 1024 * 1024
const DefaultLogLevel = "info"
const DefaultMaintenanceReserveBytes int64 = 8 * 1024 * 1024
const DefaultDiskSafetyBytes int64 = 3 * 1024 * 1024 * 1024
const DefaultZipMemoryFallbackLimit int64 = 512 * 1024 * 1024
const MaxZipMemoryFallbackLimit int64 = 512 * 1024 * 1024
const DefaultVideoBlobFallbackLimit int64 = 256 * 1024 * 1024
const MaxVideoBlobFallbackLimit int64 = 512 * 1024 * 1024
const DefaultTextPreviewLimit int64 = 20 * 1024 * 1024
const MaxTextPreviewLimit int64 = 512 * 1024 * 1024
const DefaultObjectPutMaxBytes int64 = 16 * 1024 * 1024
const MinObjectPutMaxBytes int64 = 8*1024*1024 + 37

// The receiver reads size+1 to detect excess bytes without signed overflow.
const MaxObjectPutMaxBytes int64 = 1<<63 - 2
const DefaultUploadExpiry = "24h"
const DefaultTrashRetention = "720h"
const DefaultSessionIdleTimeout = "12h"
const DefaultSetupTokenTTL = "24h"
const DefaultMetadataKeepVersions = 5
const DefaultBackupWarnAfterDays = 30

// Load reads an optional strict TOML file and then applies supported
// environment overrides. It intentionally has no password or key fields.
func Load(path string) (Config, error) {
	cfg := Config{
		ListenAddr:              envOr("XDRIVE_LISTEN_ADDR", "127.0.0.1:8787"),
		LogLevel:                DefaultLogLevel,
		DatabasePath:            envOr("XDRIVE_DATABASE_PATH", "data/xdrive.db"),
		StoragePath:             envOr("XDRIVE_STORAGE_PATH", "data/objects"),
		SecretPath:              envOr("XDRIVE_SECRET_PATH", "data/server.secret"),
		Username:                envOr("XDRIVE_USERNAME", "admin"),
		QuotaBytes:              DefaultQuotaBytes,
		DiskSafetyBytes:         DefaultDiskSafetyBytes,
		MaintenanceReserveBytes: DefaultMaintenanceReserveBytes,
		TextPreviewLimit:        DefaultTextPreviewLimit,
		VideoBlobFallbackLimit:  DefaultVideoBlobFallbackLimit,
		ZipMemoryFallbackLimit:  DefaultZipMemoryFallbackLimit,
		ObjectPutMaxBytes:       DefaultObjectPutMaxBytes,
		UploadExpiry:            DefaultUploadExpiry,
		TrashRetention:          DefaultTrashRetention,
		SessionIdleTimeout:      DefaultSessionIdleTimeout,
		SetupTokenTTL:           DefaultSetupTokenTTL,
		MetadataKeepVersions:    DefaultMetadataKeepVersions,
		BackupWarnAfterDays:     DefaultBackupWarnAfterDays,
	}
	if path != "" {
		file, err := os.Open(path)
		if err != nil {
			return Config{}, fmt.Errorf("open config file: %w", err)
		}
		defer file.Close()
		// Wire aliases are optional so an explicit zero differs from an absent
		// setting. Business code consumes only the resolved DiskSafetyBytes.
		fileConfig := struct {
			Config
			MinFreeDiskBytes      *int64 `toml:"min_free_disk_bytes"`
			LegacyDiskSafetyBytes *int64 `toml:"disk_safety_bytes"`
		}{Config: cfg}
		if err := toml.NewDecoder(file).DisallowUnknownFields().Decode(&fileConfig); err != nil {
			return Config{}, fmt.Errorf("decode config file: %w", err)
		}
		if fileConfig.MinFreeDiskBytes != nil && fileConfig.LegacyDiskSafetyBytes != nil {
			return Config{}, errors.New("use only min_free_disk_bytes or legacy disk_safety_bytes, not both")
		}
		cfg = fileConfig.Config
		if fileConfig.MinFreeDiskBytes != nil {
			cfg.DiskSafetyBytes = *fileConfig.MinFreeDiskBytes
		}
		if fileConfig.LegacyDiskSafetyBytes != nil {
			cfg.DiskSafetyBytes = *fileConfig.LegacyDiskSafetyBytes
		}
		cfg.ListenAddr = envOr("XDRIVE_LISTEN_ADDR", cfg.ListenAddr)
		cfg.DatabasePath = envOr("XDRIVE_DATABASE_PATH", cfg.DatabasePath)
		cfg.StoragePath = envOr("XDRIVE_STORAGE_PATH", cfg.StoragePath)
		cfg.SecretPath = envOr("XDRIVE_SECRET_PATH", cfg.SecretPath)
		cfg.Username = envOr("XDRIVE_USERNAME", cfg.Username)
	}
	cfg.LogLevel = envOr("XDRIVE_LOG_LEVEL", cfg.LogLevel)
	if err := ValidateLogLevel(cfg.LogLevel); err != nil {
		return Config{}, err
	}
	if value := os.Getenv("XDRIVE_QUOTA_BYTES"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("parse XDRIVE_QUOTA_BYTES: %w", err)
		}
		cfg.QuotaBytes = parsed
	}
	canonicalDiskValue, legacyDiskValue := os.Getenv("XDRIVE_MIN_FREE_DISK_BYTES"), os.Getenv("XDRIVE_DISK_SAFETY_BYTES")
	if canonicalDiskValue != "" && legacyDiskValue != "" {
		return Config{}, errors.New("use only XDRIVE_MIN_FREE_DISK_BYTES or legacy XDRIVE_DISK_SAFETY_BYTES, not both")
	}
	diskValue, diskKey := canonicalDiskValue, "XDRIVE_MIN_FREE_DISK_BYTES"
	if diskValue == "" {
		diskValue, diskKey = legacyDiskValue, "XDRIVE_DISK_SAFETY_BYTES"
	}
	if value := diskValue; value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("parse %s: %w", diskKey, err)
		}
		cfg.DiskSafetyBytes = parsed
	}
	if value := os.Getenv("XDRIVE_MAINTENANCE_RESERVE_BYTES"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("parse XDRIVE_MAINTENANCE_RESERVE_BYTES: %w", err)
		}
		cfg.MaintenanceReserveBytes = parsed
	}
	if value := os.Getenv("XDRIVE_ZIP_MEMORY_FALLBACK_LIMIT"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("parse XDRIVE_ZIP_MEMORY_FALLBACK_LIMIT: %w", err)
		}
		cfg.ZipMemoryFallbackLimit = parsed
	}
	if err := ValidateZipMemoryFallbackLimit(cfg.ZipMemoryFallbackLimit); err != nil {
		return Config{}, err
	}
	if value := os.Getenv("XDRIVE_VIDEO_BLOB_FALLBACK_LIMIT"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("parse XDRIVE_VIDEO_BLOB_FALLBACK_LIMIT: %w", err)
		}
		cfg.VideoBlobFallbackLimit = parsed
	}
	if err := ValidateVideoBlobFallbackLimit(cfg.VideoBlobFallbackLimit); err != nil {
		return Config{}, err
	}
	if value := os.Getenv("XDRIVE_TEXT_PREVIEW_LIMIT"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("parse XDRIVE_TEXT_PREVIEW_LIMIT: %w", err)
		}
		cfg.TextPreviewLimit = parsed
	}
	if cfg.TextPreviewLimit < 1 || cfg.TextPreviewLimit > MaxTextPreviewLimit {
		return Config{}, errors.New("text preview limit must be between 1 and 536870912 bytes")
	}
	if value := os.Getenv("XDRIVE_OBJECT_PUT_MAX_BYTES"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("parse XDRIVE_OBJECT_PUT_MAX_BYTES: %w", err)
		}
		cfg.ObjectPutMaxBytes = parsed
	}
	if err := ValidateObjectPutMaxBytes(cfg.ObjectPutMaxBytes); err != nil {
		return Config{}, err
	}
	cfg.UploadExpiry = envOr("XDRIVE_UPLOAD_EXPIRY", cfg.UploadExpiry)
	if _, err := ParseUploadExpiry(cfg.UploadExpiry); err != nil {
		return Config{}, err
	}
	cfg.TrashRetention = envOr("XDRIVE_TRASH_RETENTION", cfg.TrashRetention)
	if _, err := ParseTrashRetention(cfg.TrashRetention); err != nil {
		return Config{}, err
	}
	cfg.SessionIdleTimeout = envOr("XDRIVE_SESSION_IDLE_TIMEOUT", cfg.SessionIdleTimeout)
	if _, err := ParseSessionIdleTimeout(cfg.SessionIdleTimeout); err != nil {
		return Config{}, err
	}
	cfg.SetupTokenTTL = envOr("XDRIVE_SETUP_TOKEN_TTL", cfg.SetupTokenTTL)
	if _, err := ParseSetupTokenTTL(cfg.SetupTokenTTL); err != nil {
		return Config{}, err
	}
	if value := os.Getenv("XDRIVE_BACKUP_WARN_AFTER_DAYS"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return Config{}, fmt.Errorf("parse XDRIVE_BACKUP_WARN_AFTER_DAYS: %w", err)
		}
		cfg.BackupWarnAfterDays = parsed
	}
	if err := ValidateBackupWarnAfterDays(cfg.BackupWarnAfterDays); err != nil {
		return Config{}, err
	}
	if value := os.Getenv("XDRIVE_METADATA_KEEP_VERSIONS"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return Config{}, fmt.Errorf("parse XDRIVE_METADATA_KEEP_VERSIONS: %w", err)
		}
		cfg.MetadataKeepVersions = parsed
	}
	if err := ValidateMetadataKeepVersions(cfg.MetadataKeepVersions); err != nil {
		return Config{}, err
	}
	if cfg.MaintenanceReserveBytes < 0 || cfg.MaintenanceReserveBytes > DefaultMaintenanceReserveBytes {
		return Config{}, errors.New("maintenance reserve must be between 0 and 8388608 bytes")
	}
	// Small test/development quotas scale the same precharged policy.
	if cfg.MaintenanceReserveBytes > cfg.QuotaBytes/4 {
		cfg.MaintenanceReserveBytes = cfg.QuotaBytes / 4
	}
	if _, _, err := net.SplitHostPort(cfg.ListenAddr); err != nil {
		return Config{}, fmt.Errorf("invalid listen address: %w", err)
	}
	if cfg.QuotaBytes <= 0 {
		return Config{}, errors.New("quota must be positive")
	}
	if cfg.DiskSafetyBytes < 0 {
		return Config{}, errors.New("disk safety reserve cannot be negative")
	}
	if err := validateDataPath("database path", cfg.DatabasePath); err != nil {
		return Config{}, err
	}
	if err := validateDataPath("storage path", cfg.StoragePath); err != nil {
		return Config{}, err
	}
	if err := validateDataPath("server secret path", cfg.SecretPath); err != nil {
		return Config{}, err
	}
	if len(cfg.Username) < 1 || len(cfg.Username) > 128 {
		return Config{}, errors.New("username must contain 1 to 128 characters")
	}
	return cfg, nil
}

func ValidateLogLevel(value string) error {
	switch value {
	case "debug", "info", "warn", "error":
		return nil
	default:
		return errors.New("log level must be one of: debug, info, warn, error")
	}
}

func ValidateObjectPutMaxBytes(value int64) error {
	if value < MinObjectPutMaxBytes || value > MaxObjectPutMaxBytes {
		return errors.New("object PUT maximum must exceed 8388644 bytes and be less than 9223372036854775807 bytes")
	}
	return nil
}

func ParseUploadExpiry(value string) (time.Duration, error) {
	duration, err := time.ParseDuration(value)
	if err != nil || duration < time.Second || duration%time.Second != 0 {
		return 0, errors.New("upload expiry must be a positive whole-second duration, for example 24h")
	}
	return duration, nil
}

func ParseTrashRetention(value string) (time.Duration, error) {
	duration, err := time.ParseDuration(value)
	if err != nil || duration < time.Second || duration%time.Second != 0 {
		return 0, errors.New("trash retention must be a positive whole-second duration, for example 720h")
	}
	return duration, nil
}

func ParseSessionIdleTimeout(value string) (time.Duration, error) {
	duration, err := time.ParseDuration(value)
	if err != nil || duration < time.Second || duration%time.Second != 0 {
		return 0, errors.New("session idle timeout must be a positive whole-second duration, for example 12h")
	}
	return duration, nil
}

func ParseSetupTokenTTL(value string) (time.Duration, error) {
	duration, err := time.ParseDuration(value)
	if err != nil || duration < time.Second || duration%time.Second != 0 {
		return 0, errors.New("setup token TTL must be a positive whole-second duration, for example 24h")
	}
	return duration, nil
}

func ValidateMetadataKeepVersions(value int) error {
	if value < 1 || value > 1000 {
		return errors.New("metadata keep versions must be between 1 and 1000")
	}
	return nil
}

func validateDataPath(label, value string) error {
	if value == "" || filepath.Clean(value) == "." {
		return fmt.Errorf("%s must be a non-empty path", label)
	}
	return nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func ValidateVideoBlobFallbackLimit(value int64) error {
	if value < 1 || value > MaxVideoBlobFallbackLimit {
		return errors.New("video Blob fallback limit must be between 1 and 536870912 bytes")
	}
	return nil
}

func ValidateZipMemoryFallbackLimit(value int64) error {
	if value < 1 || value > MaxZipMemoryFallbackLimit {
		return errors.New("ZIP memory fallback limit must be between 1 and 536870912 bytes")
	}
	return nil
}

func ValidateBackupWarnAfterDays(days int) error {
	if days < 1 || days > 3650 {
		return errors.New("backup warning days must be between 1 and 3650")
	}
	return nil
}
