package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/server"
)

func TestOnlineCLIObservesOwnershipWithoutRunningRecovery(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "xdrive")
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %s %v", output, err)
	}
	cfg := config.Config{ListenAddr: "127.0.0.1:1", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", QuotaBytes: 4096}
	owner, err := server.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if _, err := server.CreateSetupToken(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	database := owner.Database()
	if _, err := database.Exec("INSERT INTO upload_sessions VALUES('active-upload-aaaaaaaaaa','active',36,0,?,?)", time.Now().Unix(), time.Now().Add(time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	digest := bytes.Repeat([]byte{1}, 32)
	if _, err := database.Exec("INSERT INTO upload_object_claims VALUES('active-upload-aaaaaaaaaa','active-receive-aaaaaaaaa',36,?,1)", digest); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("INSERT INTO upload_receive_fences VALUES('active-receive-aaaaaaaaa','active-upload-aaaaaaaaaa',36,?,1)", digest); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("INSERT INTO metadata_maintenance VALUES(1,'active-candidate-aaaaaaaa',36,1)"); err != nil {
		t.Fatal(err)
	}
	environment := make([]string, 0)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "XDRIVE_") {
			environment = append(environment, entry)
		}
	}
	environment = append(environment, "XDRIVE_DATABASE_PATH="+cfg.DatabasePath, "XDRIVE_STORAGE_PATH="+cfg.StoragePath, "XDRIVE_SECRET_PATH="+cfg.SecretPath, "XDRIVE_LISTEN_ADDR="+cfg.ListenAddr, "XDRIVE_USERNAME=admin", "XDRIVE_DISK_SAFETY_BYTES=0")
	for _, command := range []string{"serve", "migrate", "init", "doctor", "setup-token", "backup"} {
		t.Run(command, func(t *testing.T) {
			holdPath := filepath.Join(root, server.UpgradeRollbackHoldFilename)
			if command == "doctor" {
				if err := os.WriteFile(holdPath, nil, 0o640); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			args := []string{command}
			if command == "backup" {
				args = append(args, t.TempDir())
			}
			child := exec.CommandContext(ctx, binary, args...)
			child.Env = environment
			output, err := child.CombinedOutput()
			if command == "serve" || command == "migrate" || command == "init" {
				if err == nil || !bytes.Contains(output, []byte("code=resource_busy")) {
					t.Fatalf("offline command bypassed live owner: %s %v", output, err)
				}
			} else if err != nil {
				t.Fatalf("online command failed: %s %v", output, err)
			}
			if command == "doctor" && !bytes.Contains(output, []byte("read-only check")) {
				t.Fatal("doctor did not use explicit read-only diagnostics")
			}
			if command == "doctor" {
				if !bytes.Contains(output, []byte("Physical cleanup: held for upgrade recovery")) {
					t.Fatalf("doctor did not expose the persistent rollback hold: %s", output)
				}
				if err := os.Remove(holdPath); err != nil {
					t.Fatal(err)
				}
			}
			for _, table := range []string{"upload_object_claims", "upload_receive_fences", "metadata_maintenance"} {
				var count int
				if err := database.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 1 {
					t.Fatalf("%s cleared %s: count=%d %v", command, table, count, err)
				}
			}
		})
	}
}
