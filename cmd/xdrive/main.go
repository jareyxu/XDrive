package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"xdrive/internal/backup"
	"xdrive/internal/config"
	"xdrive/internal/db"
	"xdrive/internal/server"
	"xdrive/internal/storage"
	"xdrive/internal/update"
)

// version and buildCommit are injected by the release builder. Local builds
// remain explicitly marked as development artifacts.
var version = "dev"
var buildCommit = "unknown"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := runContext(os.Args[1:], ctx); err != nil {
		// Command errors can wrap filesystem paths and opaque object IDs. Keep
		// process-level diagnostics useful without copying those values into
		// journald or a captured CLI log.
		slog.Error("xdrive stopped", "code", cliErrorCode(err))
		os.Exit(1)
	}
}

func cliErrorCode(err error) string {
	switch {
	case errors.Is(err, storage.ErrServiceInUse):
		return "resource_busy"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, syscall.ETIMEDOUT):
		return "timeout"
	case errors.Is(err, os.ErrNotExist):
		return "not_found"
	case errors.Is(err, os.ErrPermission), errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return "permission_denied"
	case errors.Is(err, os.ErrExist):
		return "already_exists"
	case errors.Is(err, syscall.ENOSPC):
		return "insufficient_storage"
	case errors.Is(err, syscall.EADDRINUSE):
		return "address_in_use"
	case errors.Is(err, syscall.EBUSY), errors.Is(err, syscall.EWOULDBLOCK), errors.Is(err, syscall.EMFILE), errors.Is(err, syscall.ENFILE):
		return "resource_busy"
	default:
		return "operation_failed"
	}
}

func run(args []string) error {
	return runContext(args, context.Background())
}

func runContext(args []string, operationContext context.Context) error {
	if operationContext == nil {
		operationContext = context.Background()
	}
	command := "serve"
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		command, args = args[0], args[1:]
	}
	if command == "update" {
		return runInstalledScript("upgrade.sh", args)
	}
	if command == "enable-web-updates" {
		if len(args) != 0 {
			return errors.New("enable-web-updates does not accept arguments")
		}
		return runEnableWebUpdates()
	}
	if command == "disable-web-updates" {
		if len(args) != 0 {
			return errors.New("disable-web-updates does not accept arguments")
		}
		return runDisableWebUpdates()
	}
	if command == "web-update-worker" {
		if len(args) != 0 {
			return errors.New("web-update-worker does not accept arguments")
		}
		return update.RunWorker(operationContext, update.WorkerOptions{Current: version, RequireRoot: true})
	}
	if command == "uninstall" {
		return runInstalledScript("uninstall.sh", args)
	}
	flags := flag.NewFlagSet("xdrive", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	configPath := flags.String("config", "", "path to TOML configuration")
	showVersion := flags.Bool("version", false, "print version and exit")
	verifyBackup := flags.Bool("verify", false, "verify all encrypted objects while creating a backup")
	backupGeneration := flags.String("generation", "", "backup generation for inspect, verify, or restore; default CURRENT")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *backupGeneration != "" && command != "inspect-backup" && command != "verify-backup" && command != "restore" && command != "restore-staged" {
		return errors.New("--generation is valid only with inspect-backup, verify-backup, restore, or restore-staged")
	}
	if *showVersion {
		fmt.Printf("xdrive %s (%s)\n", version, buildCommit)
		return nil
	}
	if command == "version" {
		fmt.Printf("xdrive %s (%s)\n", version, buildCommit)
		return nil
	}
	if command == "inspect-backup" {
		if len(flags.Args()) != 1 {
			return errors.New("usage: xdrive inspect-backup [--generation ID] <backup-dir>")
		}
		info, err := backup.InspectGeneration(operationContext, flags.Args()[0], *backupGeneration)
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(info)
	}
	settings, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	slog.SetDefault(loggerForLevel(os.Stderr, settings.LogLevel))
	if command == "snapshot-db" {
		if len(flags.Args()) != 1 {
			return errors.New("usage: xdrive snapshot-db --config <config.toml> <destination>")
		}
		if err := db.Snapshot(operationContext, settings.DatabasePath, flags.Args()[0]); err != nil {
			return err
		}
		fmt.Println("SQLite snapshot created.")
		return nil
	}
	if command == "restore-staged" {
		if len(flags.Args()) != 1 {
			return errors.New("usage: xdrive restore-staged [--generation ID] --config <config.toml> <backup-dir>")
		}
		if err := backup.RestoreGenerationStaged(operationContext, settings, flags.Args()[0], *backupGeneration); err != nil {
			return err
		}
		selected := *backupGeneration
		if selected == "" {
			selected = "CURRENT"
		}
		fmt.Printf("Generation %s restored to the configured empty target without application migration or startup checks.\n", selected)
		return nil
	}
	if command == "backup" || command == "verify-backup" || command == "restore" {
		if len(flags.Args()) != 1 {
			if command == "restore" {
				return errors.New("usage: xdrive restore [--generation ID] [--config <config.toml>] <backup-dir>")
			}
			if command == "verify-backup" {
				return errors.New("usage: xdrive verify-backup [--generation ID] <backup-dir>")
			}
			return errors.New("usage: xdrive backup [--verify] <backup-dir>")
		}
		if command == "verify-backup" {
			return backup.VerifyGeneration(operationContext, flags.Args()[0], *backupGeneration)
		}
		if command == "restore" {
			if err := backup.RestoreGeneration(operationContext, settings, flags.Args()[0], *backupGeneration); err != nil {
				return err
			}
			handler, err := server.NewWithBuild(settings, version, buildCommit)
			if err != nil {
				return fmt.Errorf("restored data did not pass startup checks: %w", err)
			}
			if err := handler.Close(); err != nil {
				return fmt.Errorf("close restored data after startup checks: %w", err)
			}
			selected := *backupGeneration
			if selected == "" {
				selected = "CURRENT"
			}
			fmt.Printf("Restore generation %s activated. Start XDrive and sign in again.\n", selected)
			return nil
		}
		if err := backup.Create(operationContext, settings, flags.Args()[0], *verifyBackup); err != nil {
			return err
		}
		fmt.Println("Backup completed and published.")
		return nil
	}
	if command == "doctor" {
		return runDoctor(settings, *configPath)
	}
	if command == "setup-token" {
		token, err := server.CreateSetupToken(operationContext, settings)
		if err != nil {
			return err
		}
		fmt.Printf("Open /setup#%s within 24 hours to configure XDrive.\n", token)
		return nil
	}
	if command == "init" || command == "migrate" {
		handler, err := server.NewWithBuild(settings, version, buildCommit)
		if err != nil {
			return err
		}
		defer handler.Close()
		if command == "migrate" {
			fmt.Println("Database migrations are current.")
			return nil
		}
		token, err := server.CreateSetupToken(operationContext, settings)
		if err != nil {
			return err
		}
		fmt.Printf("Open /setup#%s within 24 hours to configure XDrive.\n", token)
		return nil
	}

	if command != "serve" {
		return fmt.Errorf("unknown command %q", command)
	}
	handler, err := server.NewWithBuild(settings, version, buildCommit)
	if err != nil {
		return err
	}
	defer handler.Close()

	httpServer := &http.Server{
		Addr:              settings.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	ctx := operationContext
	var stop context.CancelFunc
	if ctx.Done() == nil {
		ctx, stop = signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	} else {
		ctx, stop = context.WithCancel(ctx)
	}
	cleanupDone := make(chan struct{})
	go func() {
		defer close(cleanupDone)
		rollbackHoldPath := server.UpgradeRollbackHoldPath(*configPath, settings.DatabasePath)
		server.RunCleanup(ctx, handler.Database(), settings.StoragePath, rollbackHoldPath, time.Minute, handler.TrashRetention(), handler.MetadataKeepVersions())
	}()
	defer func() {
		stop()
		<-cleanupDone
	}()

	serveErr := make(chan error, 1)
	go func() { serveErr <- httpServer.ListenAndServe() }()
	slog.Info("xdrive API listening", "address", settings.ListenAddr)

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			return errors.Join(fmt.Errorf("shutdown server: %w", err), httpServer.Close())
		}
		return nil
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve API: %w", err)
	}
}

func loggerForLevel(output io.Writer, configured string) *slog.Logger {
	level := slog.LevelInfo
	switch configured {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	return slog.New(slog.NewTextHandler(output, &slog.HandlerOptions{Level: level}))
}

func runInstalledScript(name string, args []string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	script := filepath.Join(filepath.Dir(resolved), name)
	info, err := os.Lstat(script)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("installed %s is unavailable beside %s", name, resolved)
	}
	command := exec.Command(script, args...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command.Run()
}
