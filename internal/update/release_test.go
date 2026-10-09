package update

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestCheckLatestValidatesOfficialStableRelease(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != LatestReleaseAPI || request.Header.Get("Accept") != "application/vnd.github+json" {
			t.Fatalf("unexpected request: %s %#v", request.URL, request.Header)
		}
		return response(http.StatusOK, `{"tag_name":"v1.4.0","name":"XDrive 1.4.0","html_url":"https://github.com/jareyxu/XDrive/releases/tag/v1.4.0","published_at":"2026-10-09T10:00:00Z","body":"stable notes","draft":false,"prerelease":false}`), nil
	})}
	release, err := CheckLatest(context.Background(), client, "")
	if err != nil {
		t.Fatal(err)
	}
	if release.Version != "v1.4.0" || release.URL != "https://github.com/jareyxu/XDrive/releases/tag/v1.4.0" || release.Notes != "stable notes" {
		t.Fatalf("unexpected release: %+v", release)
	}
}

func TestCheckLatestRejectsDraftPrereleaseAndForeignURL(t *testing.T) {
	for name, body := range map[string]string{
		"prerelease":  `{"tag_name":"v1.4.0-rc.1","html_url":"https://github.com/jareyxu/XDrive/releases/tag/v1.4.0-rc.1","prerelease":true}`,
		"draft":       `{"tag_name":"v1.4.0","html_url":"https://github.com/jareyxu/XDrive/releases/tag/v1.4.0","draft":true}`,
		"foreign URL": `{"tag_name":"v1.4.0","html_url":"https://example.com/release"}`,
	} {
		t.Run(name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return response(http.StatusOK, body), nil })}
			if _, err := CheckLatest(context.Background(), client, ""); err == nil {
				t.Fatal("invalid release metadata accepted")
			}
		})
	}
}

func TestCompareVersions(t *testing.T) {
	for _, test := range []struct {
		left, right string
		want        int
	}{
		{"v1.3.9", "v1.3.10", -1},
		{"v2.0.0", "v1.99.99", 1},
		{"v1.3.1", "v1.3.1", 0},
	} {
		got, err := CompareVersions(test.left, test.right)
		if err != nil || got != test.want {
			t.Fatalf("CompareVersions(%q, %q) = %d, %v; want %d", test.left, test.right, got, err, test.want)
		}
	}
	for _, version := range []string{"dev", "v1.0", "v01.2.3", "v1.2.3-rc.1", "v999999999999.0.0"} {
		if IsStableVersion(version) {
			t.Fatalf("non-stable or out-of-range version accepted: %s", version)
		}
	}
}

func TestChecksumSelectsExactArchiveAndRejectsDuplicates(t *testing.T) {
	const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != ReleaseBaseURL+"v1.4.0/SHA256SUMS" {
			t.Fatalf("unexpected checksum URL: %s", request.URL)
		}
		return response(http.StatusOK, fmt.Sprintf("%s  xdrive-v1.4.0-linux-amd64.tar.gz\n%s  xdrive-v1.4.0-linux-arm64.tar.gz\n", digest, strings.ToUpper(digest))), nil
	})}
	got, err := Checksum(context.Background(), client, "v1.4.0", "amd64")
	if err != nil || got != digest {
		t.Fatalf("checksum = %q, %v", got, err)
	}
	duplicateClient := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return response(http.StatusOK, digest+"  xdrive-v1.4.0-linux-amd64.tar.gz\n"+digest+"  xdrive-v1.4.0-linux-amd64.tar.gz\n"), nil
	})}
	if _, err := Checksum(context.Background(), duplicateClient, "v1.4.0", "amd64"); err == nil {
		t.Fatal("duplicate archive digest accepted")
	}
}

func TestRedirectPolicyRejectsNonGitHubHosts(t *testing.T) {
	client := HTTPClient()
	request, _ := http.NewRequest(http.MethodGet, "https://api.github.com/repos/jareyxu/XDrive/releases/latest", nil)
	if err := client.CheckRedirect(&http.Request{URL: mustURL("https://example.com/evil")}, []*http.Request{request}); err == nil {
		t.Fatal("redirect to a foreign host accepted")
	}
}

func mustURL(raw string) *url.URL {
	parsed, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return parsed
}
