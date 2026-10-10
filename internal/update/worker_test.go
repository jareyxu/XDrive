package update

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

const testRequestID = "abcdefghijklmnopqrstu_"

func TestRunWorkerChecksReleaseAndRecordsSuccess(t *testing.T) {
	root := t.TempDir()
	requestPath := filepath.Join(root, "request.json")
	statusPath := filepath.Join(root, "status.json")
	request := Request{ID: testRequestID, Version: "v1.4.0"}
	if err := os.WriteFile(requestPath, []byte(fmt.Sprintf(`{"id":%q,"version":%q}`, request.ID, request.Version)), 0600); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch request.URL.String() {
		case LatestReleaseAPI:
			return response(http.StatusOK, `{"tag_name":"v1.4.0","html_url":"https://github.com/jareyxu/XDrive/releases/tag/v1.4.0"}`), nil
		case ReleaseBaseURL + "v1.4.0/SHA256SUMS":
			return response(http.StatusOK, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  xdrive-v1.4.0-linux-amd64-package.tar.gz\n"), nil
		default:
			t.Fatalf("unexpected request: %s", request.URL)
			return nil, nil
		}
	})}
	called := false
	err := RunWorker(context.Background(), WorkerOptions{
		RequestPath: requestPath, StatusPath: statusPath, UpgradePath: "/tmp/upgrade.sh",
		Current: "v1.3.1", Architecture: "amd64", HTTPClient: client,
		RunUpgrade: func(_ context.Context, path, archiveURL, digest string) error {
			called = true
			if path != "/tmp/upgrade.sh" || archiveURL != ReleaseBaseURL+"v1.4.0/xdrive-v1.4.0-linux-amd64-package.tar.gz" || digest != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
				t.Fatalf("unexpected upgrade args: %q %q %q", path, archiveURL, digest)
			}
			return nil
		},
	})
	if err != nil || !called {
		t.Fatalf("worker err=%v called=%t", err, called)
	}
	if _, err := os.Stat(requestPath); !os.IsNotExist(err) {
		t.Fatalf("request trigger remains: %v", err)
	}
	status, err := ReadStatus(statusPath)
	if err != nil || status.ID != request.ID || status.Version != request.Version || status.State != "succeeded" {
		t.Fatalf("unexpected status: %+v, %v", status, err)
	}
}

func TestRunWorkerRefusesStaleRequestedRelease(t *testing.T) {
	root := t.TempDir()
	requestPath := filepath.Join(root, "request.json")
	statusPath := filepath.Join(root, "status.json")
	if err := os.WriteFile(requestPath, []byte(fmt.Sprintf(`{"id":%q,"version":"v1.4.0"}`, testRequestID)), 0600); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return response(http.StatusOK, `{"tag_name":"v1.4.1","html_url":"https://github.com/jareyxu/XDrive/releases/tag/v1.4.1"}`), nil
	})}
	called := false
	err := RunWorker(context.Background(), WorkerOptions{RequestPath: requestPath, StatusPath: statusPath, Current: "v1.3.1", Architecture: "amd64", HTTPClient: client, RunUpgrade: func(context.Context, string, string, string) error { called = true; return nil }})
	if err == nil || called {
		t.Fatal("worker installed a release different from the user's selection")
	}
	status, readErr := ReadStatus(statusPath)
	if readErr != nil || status.State != "failed" || status.ErrorCode != "release_changed" {
		t.Fatalf("unexpected status: %+v, %v", status, readErr)
	}
}

func TestReadRequestRejectsSymlinkAndUnknownFields(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(root, "outside.json")
	if err := os.WriteFile(outside, []byte(fmt.Sprintf(`{"id":%q,"version":"v1.4.0"}`, testRequestID)), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "request.json")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := ReadRequest(link); err == nil {
		t.Fatal("symlink request accepted")
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(link, []byte(fmt.Sprintf(`{"id":%q,"version":"v1.4.0","command":"/bin/sh"}`, testRequestID)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRequest(link); err == nil {
		t.Fatal("request with an unknown field accepted")
	}
}
