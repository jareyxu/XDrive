package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"xdrive/internal/config"
	"xdrive/internal/db"
	"xdrive/internal/server"
)

// Doctor diagnoses current storage without acting as a second service owner.
// Migrations, expiry, journal recovery and secret generation belong to startup.
func runDoctor(settings config.Config, configPath string) error {
	database, err := db.OpenReadOnly(context.Background(), settings.DatabasePath)
	if err != nil {
		return err
	}
	defer database.Close()
	var integrity string
	if err := database.QueryRow("PRAGMA quick_check").Scan(&integrity); err != nil {
		return err
	}
	if integrity != "ok" {
		return errors.New("SQLite quick_check failed")
	}
	var violations int
	if err := database.QueryRow("SELECT COUNT(*) FROM pragma_foreign_key_check").Scan(&violations); err != nil {
		return err
	}
	if violations != 0 {
		return errors.New("SQLite foreign key check failed")
	}
	info, err := os.Stat(settings.StoragePath)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("object storage is not a directory")
	}
	state, err := database.SetupState(context.Background())
	if err != nil {
		return err
	}
	held, err := server.UpgradeRollbackHoldActive(server.UpgradeRollbackHoldPath(configPath, settings.DatabasePath))
	if err != nil {
		return err
	}
	cleanupStatus := "enabled"
	if held {
		cleanupStatus = "held for upgrade recovery"
	}
	fmt.Printf("Database: ready (schema %d; read-only check)\nObject storage: ready\nAccount state: %s\nPhysical cleanup: %s\n", db.CurrentSchemaVersion, state, cleanupStatus)
	return nil
}
