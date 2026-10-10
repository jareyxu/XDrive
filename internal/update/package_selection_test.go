package update

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type packageTransport func(*http.Request) (*http.Response, error)

func (f packageTransport) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }
func packageResponse(body string) *http.Response {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestSelectPackagePrefersFullManifestAndRejectsCorruption(t *testing.T) {
	full := "xdrive-v1.4.0-linux-amd64-package.tar.gz"
	legacy := "xdrive-v1.4.0-linux-amd64.tar.gz"
	for _, test := range []struct {
		name, body, want string
		invalid          bool
	}{
		{"full", strings.Repeat("a", 64) + "  " + legacy + "\n" + strings.Repeat("b", 64) + "  " + full + "\n", full, false},
		{"missing-full", strings.Repeat("a", 64) + "  " + legacy + "\n", "", true},
		{"duplicate-full", strings.Repeat("a", 64) + "  " + legacy + "\n" + strings.Repeat("b", 64) + "  " + full + "\n" + strings.Repeat("b", 64) + "  " + full + "\n", "", true},
		{"corrupt-full", strings.Repeat("a", 64) + "  " + legacy + "\nwrong  " + full + "\n", "", true},
		{"oversized", strings.Repeat(" ", maxChecksumFile+1), "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: packageTransport(func(request *http.Request) (*http.Response, error) {
				if request.URL.String() != ReleaseBaseURL+"v1.4.0/SHA256SUMS" {
					t.Fatalf("unexpected request: %s", request.URL)
				}
				return packageResponse(test.body), nil
			})}
			selected, digest, err := SelectPackage(context.Background(), client, "v1.4.0", "amd64")
			if test.invalid {
				if err == nil {
					t.Fatal("corrupt manifest fell back to legacy")
				}
				return
			}
			if err != nil || selected != ReleaseBaseURL+"v1.4.0/"+test.want || len(digest) != 64 {
				t.Fatalf("selected=%s err=%v", selected, err)
			}
		})
	}
}

func TestWorkerInstallsFullPackageRatherThanLegacyBridge(t *testing.T) {
	root := t.TempDir()
	id := "abcdefghijklmnopqrstu_"
	requestPath := filepath.Join(root, "request.json")
	statusPath := filepath.Join(root, "status.json")
	if err := os.WriteFile(requestPath, []byte(fmt.Sprintf(`{"id":%q,"version":"v1.4.0"}`, id)), 0600); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: packageTransport(func(request *http.Request) (*http.Response, error) {
		switch request.URL.String() {
		case LatestReleaseAPI:
			return packageResponse(`{"tag_name":"v1.4.0","html_url":"https://github.com/jareyxu/XDrive/releases/tag/v1.4.0"}`), nil
		case ReleaseBaseURL + "v1.4.0/SHA256SUMS":
			return packageResponse(strings.Repeat("a", 64) + "  xdrive-v1.4.0-linux-amd64.tar.gz\n" + strings.Repeat("b", 64) + "  xdrive-v1.4.0-linux-amd64-package.tar.gz\n"), nil
		default:
			t.Fatalf("unexpected request: %s", request.URL)
			return nil, nil
		}
	})}
	called := false
	err := RunWorker(context.Background(), WorkerOptions{RequestPath: requestPath, StatusPath: statusPath, Current: "v1.3.7", Architecture: "amd64", HTTPClient: client, RunUpgrade: func(_ context.Context, _ string, url, digest string) error {
		called = true
		if url != ReleaseBaseURL+"v1.4.0/xdrive-v1.4.0-linux-amd64-package.tar.gz" || digest != strings.Repeat("b", 64) {
			t.Fatal("worker selected the legacy bridge")
		}
		return nil
	}})
	if err != nil || !called {
		t.Fatalf("worker=%v called=%t", err, called)
	}
	status, err := ReadStatus(statusPath)
	if err != nil || status.State != "succeeded" {
		t.Fatalf("status=%+v err=%v", status, err)
	}
}

func TestUpgradeCommandBindsApprovedVersion(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "upgrade.sh")
	output := filepath.Join(root, "arguments")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > '"+output+"'\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := runUpgradeCommand(context.Background(), script, ReleaseBaseURL+"v1.4.0/xdrive-v1.4.0-linux-amd64-package.tar.gz", strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil || !strings.HasSuffix(string(data), "--expected-version\nv1.4.0\n") {
		t.Fatalf("upgrade did not bind target version: %s err=%v", data, err)
	}
}
