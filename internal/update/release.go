package update

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	Repository       = "jareyxu/XDrive"
	LatestReleaseAPI = "https://api.github.com/repos/" + Repository + "/releases/latest"
	ReleaseBaseURL   = "https://github.com/" + Repository + "/releases/download/"
	maxReleaseJSON   = 1 << 20
	maxChecksumFile  = 1 << 20
)

var stableVersionPattern = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

// Release contains only the public metadata needed by the update screen.
type Release struct {
	Version     string `json:"version"`
	Name        string `json:"name"`
	URL         string `json:"url"`
	PublishedAt string `json:"publishedAt"`
	Notes       string `json:"notes"`
}

type githubRelease struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	HTMLURL     string `json:"html_url"`
	PublishedAt string `json:"published_at"`
	Body        string `json:"body"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
}

// HTTPClient restricts release downloads and API calls to HTTPS hosts owned by
// GitHub. The release version is separately validated before it is used in a
// download path.
func HTTPClient() *http.Client {
	return &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 || request.URL.Scheme != "https" || (request.URL.Port() != "" && request.URL.Port() != "443") || !allowedGitHubHost(request.URL.Hostname()) {
				return errors.New("release server redirected outside the GitHub HTTPS hosts")
			}
			return nil
		},
	}
}

func allowedGitHubHost(host string) bool {
	switch strings.ToLower(host) {
	case "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	default:
		return false
	}
}

func CheckLatest(ctx context.Context, client *http.Client, endpoint string) (Release, error) {
	if client == nil {
		client = HTTPClient()
	}
	if endpoint == "" {
		endpoint = LatestReleaseAPI
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "api.github.com" || parsed.Path != "/repos/"+Repository+"/releases/latest" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return Release{}, errors.New("invalid release metadata endpoint")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Release{}, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "XDrive-update-check")
	response, err := client.Do(request)
	if err != nil {
		return Release{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Release{}, fmt.Errorf("release metadata returned HTTP %d", response.StatusCode)
	}
	var remote githubRelease
	if err := json.NewDecoder(io.LimitReader(response.Body, maxReleaseJSON)).Decode(&remote); err != nil {
		return Release{}, errors.New("invalid release metadata")
	}
	if remote.Draft || remote.Prerelease || !IsStableVersion(remote.TagName) {
		return Release{}, errors.New("latest GitHub release is not a stable XDrive release")
	}
	wantURL := "https://github.com/" + Repository + "/releases/tag/" + remote.TagName
	if remote.HTMLURL != wantURL {
		return Release{}, errors.New("release metadata contains an unexpected release URL")
	}
	name := strings.TrimSpace(remote.Name)
	if name == "" {
		name = remote.TagName
	}
	notes := remote.Body
	if len(notes) > 8*1024 {
		notes = notes[:8*1024]
	}
	return Release{Version: remote.TagName, Name: name, URL: wantURL, PublishedAt: remote.PublishedAt, Notes: notes}, nil
}

func IsStableVersion(version string) bool {
	_, ok := versionParts(version)
	return ok
}

// CompareVersions compares two stable XDrive versions. It returns -1, 0, or 1.
func CompareVersions(left, right string) (int, error) {
	leftParts, ok := versionParts(left)
	if !ok {
		return 0, fmt.Errorf("invalid stable version %q", left)
	}
	rightParts, ok := versionParts(right)
	if !ok {
		return 0, fmt.Errorf("invalid stable version %q", right)
	}
	for index := range leftParts {
		if leftParts[index] < rightParts[index] {
			return -1, nil
		}
		if leftParts[index] > rightParts[index] {
			return 1, nil
		}
	}
	return 0, nil
}

func versionParts(version string) ([3]uint64, bool) {
	var parts [3]uint64
	matches := stableVersionPattern.FindStringSubmatch(version)
	if matches == nil {
		return parts, false
	}
	for index := range parts {
		value, err := strconv.ParseUint(matches[index+1], 10, 32)
		if err != nil {
			return parts, false
		}
		parts[index] = value
	}
	return parts, true
}

func ArchiveName(version, architecture string) (string, error) {
	if !IsStableVersion(version) || (architecture != "amd64" && architecture != "arm64") {
		return "", errors.New("unsupported release version or architecture")
	}
	return "xdrive-" + version + "-linux-" + architecture + ".tar.gz", nil
}

func ArchiveURL(version, architecture string) (string, string, error) {
	name, err := ArchiveName(version, architecture)
	if err != nil {
		return "", "", err
	}
	return ReleaseBaseURL + version + "/" + name, name, nil
}

// PackageArchiveName identifies the complete manifest-driven distribution.
// The original artifact name is reserved for legacy updater bootstrap packages.
func PackageArchiveName(version, architecture string) (string, error) {
	name, err := ArchiveName(version, architecture)
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(name, ".tar.gz") + "-package.tar.gz", nil
}

// SelectPackage prefers the complete distribution; releases predating the new
// format have only the original artifact and remain readable.
func SelectPackage(ctx context.Context, client *http.Client, version, architecture string) (string, string, error) {
	legacy, err := ArchiveName(version, architecture)
	if err != nil {
		return "", "", err
	}
	full, err := PackageArchiveName(version, architecture)
	if err != nil {
		return "", "", err
	}
	digests, err := readChecksums(ctx, client, version, []string{full, legacy})
	if err != nil {
		return "", "", err
	}
	if comparison, err := CompareVersions(version, LegacyBridgeVersion); err == nil && comparison >= 0 && digests[full] == "" {
		return "", "", errors.New("complete release package is missing; refusing to install a legacy bridge as the target version")
	}
	for _, name := range []string{full, legacy} {
		if digest := digests[name]; digest != "" {
			return ReleaseBaseURL + version + "/" + name, digest, nil
		}
	}
	return "", "", errors.New("release checksum manifest does not contain a supported archive")
}

// Checksum retains the original artifact lookup for older callers.
func Checksum(ctx context.Context, client *http.Client, version, architecture string) (string, error) {
	archive, err := ArchiveName(version, architecture)
	if err != nil {
		return "", err
	}
	digests, err := readChecksums(ctx, client, version, []string{archive})
	if err != nil {
		return "", err
	}
	if digests[archive] == "" {
		return "", errors.New("release checksum manifest does not contain the selected archive")
	}
	return digests[archive], nil
}

func readChecksums(ctx context.Context, client *http.Client, version string, names []string) (map[string]string, error) {
	if client == nil {
		client = HTTPClient()
	}
	if !IsStableVersion(version) {
		return nil, errors.New("invalid release version")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, ReleaseBaseURL+version+"/SHA256SUMS", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "XDrive-update-check")
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release checksums returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxChecksumFile+1))
	if err != nil || len(data) > maxChecksumFile {
		return nil, errors.New("release checksum manifest exceeds its limit")
	}
	wanted := make(map[string]bool)
	for _, name := range names {
		wanted[name] = true
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 1024), 4096)
	digests := make(map[string]string)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 || !wanted[fields[len(fields)-1]] {
			continue
		}
		if len(fields) != 2 || digests[fields[1]] != "" || len(fields[0]) != 64 {
			return nil, errors.New("release checksum manifest contains a duplicate or invalid archive digest")
		}
		for _, char := range fields[0] {
			if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
				return nil, errors.New("release checksum manifest contains an invalid digest")
			}
		}
		digests[fields[1]] = strings.ToLower(fields[0])
	}
	if err := scanner.Err(); err != nil {
		return nil, errors.New("release checksum manifest is too large or unreadable")
	}
	return digests, nil
}
