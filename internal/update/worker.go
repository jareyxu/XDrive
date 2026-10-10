package update

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	DefaultRequestPath = "/run/xdrive-web-update/request.json"
	DefaultStatusPath  = "/run/xdrive-web-update/status.json"
	DefaultUpgradePath = "/usr/local/libexec/xdrive/upgrade.sh"
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

type Request struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}

type Status struct {
	ID        string `json:"id"`
	Version   string `json:"version"`
	State     string `json:"state"`
	ErrorCode string `json:"errorCode,omitempty"`
	UpdatedAt int64  `json:"updatedAt"`
}

type WorkerOptions struct {
	RequestPath  string
	StatusPath   string
	UpgradePath  string
	Current      string
	Architecture string
	HTTPClient   *http.Client
	RunUpgrade   func(context.Context, string, string, string) error
	RequireRoot  bool
}

func RunWorker(ctx context.Context, options WorkerOptions) error {
	if options.RequestPath == "" {
		options.RequestPath = DefaultRequestPath
	}
	if options.StatusPath == "" {
		options.StatusPath = DefaultStatusPath
	}
	if options.UpgradePath == "" {
		options.UpgradePath = DefaultUpgradePath
	}
	if options.HTTPClient == nil {
		options.HTTPClient = HTTPClient()
	}
	if options.Architecture == "" {
		options.Architecture = runtime.GOARCH
	}
	if options.RequireRoot && os.Geteuid() != 0 {
		return errors.New("update worker must run as root")
	}
	request, err := ReadRequest(options.RequestPath)
	if err != nil {
		return err
	}
	// Remove the trigger before doing network work so a repeated path event
	// cannot start a second update while this one is running.
	if err := os.Remove(options.RequestPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("cannot consume update request")
	}
	writeStatus := func(state, errorCode string) error {
		return WriteStatus(options.StatusPath, Status{ID: request.ID, Version: request.Version, State: state, ErrorCode: errorCode, UpdatedAt: time.Now().Unix()})
	}
	if err := writeStatus("checking", ""); err != nil {
		return errors.New("cannot record update status")
	}
	latest, err := CheckLatest(ctx, options.HTTPClient, "")
	if err != nil {
		_ = writeStatus("failed", "release_check_failed")
		return errors.New("release check failed")
	}
	if latest.Version != request.Version {
		_ = writeStatus("failed", "release_changed")
		return errors.New("latest release changed after the update was requested")
	}
	comparison, err := CompareVersions(options.Current, latest.Version)
	if err != nil || comparison >= 0 {
		_ = writeStatus("failed", "version_not_newer")
		return errors.New("selected release is not newer than the installed release")
	}
	architecture := options.Architecture
	switch architecture {
	case "amd64", "arm64":
	default:
		_ = writeStatus("failed", "unsupported_architecture")
		return errors.New("unsupported server architecture")
	}
	if err := writeStatus("downloading", ""); err != nil {
		return errors.New("cannot record update status")
	}
	archiveURL, digest, err := SelectPackage(ctx, options.HTTPClient, latest.Version, architecture)
	if err != nil {
		_ = writeStatus("failed", "checksum_unavailable")
		return errors.New("release checksum could not be verified")
	}
	if err := writeStatus("installing", ""); err != nil {
		return errors.New("cannot record update status")
	}
	runUpgrade := options.RunUpgrade
	if runUpgrade == nil {
		runUpgrade = runUpgradeCommand
	}
	if err := runUpgrade(ctx, options.UpgradePath, archiveURL, digest); err != nil {
		_ = writeStatus("failed", "upgrade_failed")
		return errors.New("release installation failed")
	}
	if err := writeStatus("succeeded", ""); err != nil {
		return errors.New("update completed but its final status could not be recorded")
	}
	return nil
}

func ReadRequest(path string) (Request, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return Request{}, errors.New("update request is missing or invalid")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 2 || info.Size() > 1024 {
		return Request{}, errors.New("update request is missing or invalid")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 1025))
	decoder.DisallowUnknownFields()
	var request Request
	if err := decoder.Decode(&request); err != nil {
		return Request{}, errors.New("update request is invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Request{}, errors.New("update request contains trailing data")
	}
	if !requestIDPattern.MatchString(request.ID) || !IsStableVersion(request.Version) {
		return Request{}, errors.New("update request has invalid fields")
	}
	return request, nil
}

func ReadStatus(path string) (Status, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return Status{}, errors.New("update status is unavailable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 2 || info.Size() > 4096 {
		return Status{}, errors.New("update status is invalid")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	decoder.DisallowUnknownFields()
	var status Status
	if err := decoder.Decode(&status); err != nil || !requestIDPattern.MatchString(status.ID) || !IsStableVersion(status.Version) || !validState(status.State) {
		return Status{}, errors.New("update status is invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Status{}, errors.New("update status contains trailing data")
	}
	return status, nil
}

func WriteStatus(path string, status Status) error {
	if !requestIDPattern.MatchString(status.ID) || !IsStableVersion(status.Version) || !validState(status.State) {
		return errors.New("invalid update status")
	}
	parent := filepath.Dir(path)
	file, err := os.CreateTemp(parent, ".xdrive-update-status-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0644); err != nil {
		_ = file.Close()
		return err
	}
	if err := json.NewEncoder(file).Encode(status); err != nil {
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
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	directory, err := os.Open(parent)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func validState(state string) bool {
	switch state {
	case "queued", "checking", "downloading", "installing", "succeeded", "failed":
		return true
	default:
		return false
	}
}

func runUpgradeCommand(ctx context.Context, upgradePath, archiveURL, digest string) error {
	// Do not tie the privileged upgrade subprocess to the worker's signal
	// context. The shell updater has an EXIT rollback trap; an abrupt process
	// kill during its database/binary transaction could bypass that recovery.
	_ = ctx
	selectedVersion, _, ok := strings.Cut(strings.TrimPrefix(archiveURL, ReleaseBaseURL), "/")
	if !strings.HasPrefix(archiveURL, ReleaseBaseURL) || !ok || !IsStableVersion(selectedVersion) {
		return errors.New("invalid release archive URL")
	}
	command := exec.Command(upgradePath, "--release-url", archiveURL, "--sha256", digest, "--expected-version", selectedVersion)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return errors.New("upgrade command failed")
	}
	return nil
}
