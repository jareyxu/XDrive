package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
)

const (
	webUpdatePathUnit    = "/etc/systemd/system/xdrive-web-update.path"
	webUpdateServiceUnit = "/etc/systemd/system/xdrive-web-update.service"
	webUpdateTmpfiles    = "/etc/tmpfiles.d/xdrive-web-update.conf"
)

const webUpdatePathContents = `[Unit]
Description=Watch for an approved XDrive update request

[Path]
PathExists=/run/xdrive-web-update/request.json
Unit=xdrive-web-update.service

[Install]
WantedBy=multi-user.target
`

const webUpdateServiceContents = `[Unit]
Description=Apply an approved XDrive release update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=/
ExecStart=/usr/local/libexec/xdrive/xdrive web-update-worker
TimeoutStartSec=30min
TimeoutStopSec=30min
KillMode=mixed
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
`

const webUpdateTmpfilesContents = "d /run/xdrive-web-update 0730 root xdrive -\n"

func runEnableWebUpdates() error {
	if os.Geteuid() != 0 {
		return errors.New("run 'xdrive enable-web-updates' as root")
	}
	if runtime.GOOS != "linux" {
		return errors.New("web update integration is supported only on Linux")
	}
	if err := validateInstalledLayout(); err != nil {
		return err
	}
	for path, contents := range map[string]string{
		webUpdatePathUnit:    webUpdatePathContents,
		webUpdateServiceUnit: webUpdateServiceContents,
		webUpdateTmpfiles:    webUpdateTmpfilesContents,
	} {
		if err := verifyManagedSystemFile(path, contents); err != nil {
			return err
		}
	}
	originalService, changed, err := ensureUpdateRequestPathWritable()
	if err != nil {
		return err
	}
	for path, contents := range map[string]string{
		webUpdatePathUnit:    webUpdatePathContents,
		webUpdateServiceUnit: webUpdateServiceContents,
		webUpdateTmpfiles:    webUpdateTmpfilesContents,
	} {
		if err := writeManagedSystemFile(path, contents); err != nil {
			return err
		}
	}
	if err := runSystemdCommand("systemd-tmpfiles", "--create", webUpdateTmpfiles); err != nil {
		return fmt.Errorf("create update runtime directory: %w", err)
	}
	if err := runSystemdCommand("systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("reload systemd units: %w", err)
	}
	if changed {
		if err := runSystemdCommand("systemctl", "restart", "xdrive"); err != nil {
			_ = replaceRootManagedFile("/etc/systemd/system/xdrive.service", originalService, 0644)
			_ = runSystemdCommand("systemctl", "daemon-reload")
			_ = runSystemdCommand("systemctl", "restart", "xdrive")
			return fmt.Errorf("restart XDrive to apply update queue permissions: %w", err)
		}
	}
	if err := runSystemdCommand("systemctl", "enable", "--now", "xdrive-web-update.path"); err != nil {
		return fmt.Errorf("enable web update service: %w", err)
	}
	fmt.Println("Web updates are enabled. The settings page can now check and install stable GitHub releases.")
	return nil
}

func runDisableWebUpdates() error {
	if os.Geteuid() != 0 {
		return errors.New("run 'xdrive disable-web-updates' as root")
	}
	if runtime.GOOS != "linux" {
		return errors.New("web update integration is supported only on Linux")
	}
	for path, contents := range map[string]string{
		webUpdatePathUnit:    webUpdatePathContents,
		webUpdateServiceUnit: webUpdateServiceContents,
		webUpdateTmpfiles:    webUpdateTmpfilesContents,
	} {
		if err := verifyManagedSystemFile(path, contents); err != nil {
			return err
		}
	}
	if !fileExists(webUpdatePathUnit) && !fileExists(webUpdateServiceUnit) && !fileExists(webUpdateTmpfiles) {
		fmt.Println("Web updates are already disabled.")
		return nil
	}
	if fileExists(webUpdatePathUnit) {
		if err := runSystemdCommand("systemctl", "disable", "--now", "xdrive-web-update.path"); err != nil {
			return fmt.Errorf("disable web update path unit: %w", err)
		}
	}
	if fileExists(webUpdateServiceUnit) {
		_ = runSystemdCommand("systemctl", "stop", "xdrive-web-update.service")
	}
	for _, path := range []string{webUpdatePathUnit, webUpdateServiceUnit, webUpdateTmpfiles} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove managed update file: %w", err)
		}
	}
	for _, path := range []string{"/run/xdrive-web-update/request.json", "/run/xdrive-web-update/status.json"} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove update runtime state: %w", err)
		}
	}
	_ = os.Remove("/run/xdrive-web-update")
	if err := runSystemdCommand("systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("reload systemd units: %w", err)
	}
	fmt.Println("Web updates are disabled.")
	return nil
}

func validateInstalledLayout() error {
	for _, path := range []string{"/etc/xdrive", "/etc/systemd/system", "/etc/tmpfiles.d", "/usr/local/libexec/xdrive", "/usr/local/bin"} {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("web update requires canonical installer directories")
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil || resolved != path {
			return fmt.Errorf("web update refuses redirected installer directories")
		}
	}
	for _, path := range []string{"/etc/xdrive/config.toml", "/etc/systemd/system/xdrive.service", "/usr/local/libexec/xdrive/xdrive", "/usr/local/libexec/xdrive/upgrade.sh"} {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("web update requires a complete installer-managed XDrive installation")
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != 0 {
			return fmt.Errorf("web update refuses non-root-owned installation files")
		}
	}
	unit, err := os.ReadFile("/etc/systemd/system/xdrive.service")
	if err != nil || !strings.Contains(string(unit), "User=xdrive\n") || !strings.Contains(string(unit), "ExecStart=/usr/local/libexec/xdrive/xdrive serve --config /etc/xdrive/config.toml\n") {
		return errors.New("web update requires the standard XDrive system service")
	}
	return nil
}

func ensureUpdateRequestPathWritable() ([]byte, bool, error) {
	const configuration = "/etc/xdrive/config.toml"
	const service = "/etc/systemd/system/xdrive.service"
	dataPathPattern := regexp.MustCompile(`(?m)^database_path = "(/[A-Za-z0-9/_-]+)/xdrive\.db"$`)
	configBytes, err := os.ReadFile(configuration)
	if err != nil {
		return nil, false, errors.New("cannot read the installed XDrive configuration")
	}
	matches := dataPathPattern.FindSubmatch(configBytes)
	if len(matches) != 2 {
		return nil, false, errors.New("cannot safely identify the XDrive data directory")
	}
	dataDirectory := string(matches[1])
	unitBytes, err := os.ReadFile(service)
	if err != nil {
		return nil, false, errors.New("cannot read the installed XDrive service")
	}
	lines := strings.Split(string(unitBytes), "\n")
	found := 0
	changed := false
	for index, line := range lines {
		if !strings.HasPrefix(line, "ReadWritePaths=") {
			continue
		}
		found++
		switch line {
		case "ReadWritePaths=" + dataDirectory:
			lines[index] = line + " /run/xdrive-web-update"
			changed = true
		case "ReadWritePaths=" + dataDirectory + " /run/xdrive-web-update":
		default:
			return nil, false, errors.New("the XDrive service write paths differ from the installer layout")
		}
	}
	if found != 1 {
		return nil, false, errors.New("the XDrive service must declare exactly one installer-managed ReadWritePaths entry")
	}
	if !changed {
		return unitBytes, false, nil
	}
	if err := replaceRootManagedFile(service, []byte(strings.Join(lines, "\n")), 0644); err != nil {
		return nil, false, fmt.Errorf("allow XDrive to queue approved updates: %w", err)
	}
	return unitBytes, true, nil
}

func replaceRootManagedFile(path string, contents []byte, mode os.FileMode) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("managed service file is missing or unsafe")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != 0 {
		return errors.New("managed service file is not root-owned")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".xdrive-service-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Write(contents); err != nil {
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
	return os.Rename(temporary, path)
}

func writeManagedSystemFile(path, contents string) error {
	if err := verifyManagedSystemFile(path, contents); err != nil {
		return err
	}
	if fileExists(path) {
		return nil
	}
	directory := filepath.Dir(path)
	file, err := os.CreateTemp(directory, ".xdrive-web-update-*")
	if err != nil {
		return fmt.Errorf("prepare managed update file: %w", err)
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0644); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.WriteString(contents); err != nil {
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
	if err := os.Link(temporary, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return verifyManagedSystemFile(path, contents)
		}
		return err
	}
	return nil
}

func verifyManagedSystemFile(path, contents string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("managed update path is unsafe: %s", filepath.Base(path))
	}
	if info.Sys() != nil {
		// Installer-owned files are root-owned. Refuse to adopt or remove files
		// that another account could have substituted.
		if stat, ok := info.Sys().(*syscall.Stat_t); ok && stat.Uid != 0 {
			return fmt.Errorf("managed update file is not root-owned: %s", filepath.Base(path))
		}
	}
	actual, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if string(actual) != contents {
		return fmt.Errorf("managed update file was modified; inspect %s before continuing", filepath.Base(path))
	}
	return nil
}

func fileExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func runSystemdCommand(name string, args ...string) error {
	path, err := exec.LookPath(name)
	if err != nil {
		return err
	}
	command := exec.Command(path, args...)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command.Run()
}
