// Package releasepackage validates and stages release files inside the managed
// application directory. Configuration, user data and system services are never
// destinations described by a release manifest.
package releasepackage

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

const (
	BeginManifest = "--BEGIN XDRIVE PACKAGE MANIFEST--"
	EndManifest   = "--END XDRIVE PACKAGE MANIFEST--"
	maxFiles      = 4096
	maxBytes      = 512 << 20
	maxMetadata   = 1 << 20
)

var componentPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
var versionPattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$`)

type File struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Mode   uint32 `json:"mode"`
}

type Manifest struct {
	Format int    `json:"format"`
	Files  []File `json:"files"`
}

type Package struct {
	Version      string
	Architecture string
	Files        []File
	Metadata     []byte
	Legacy       bool
}

// SafePath intentionally defines a portable release-resource path, independent
// of user filenames. Components cannot navigate or escape the application root.
func SafePath(name string) bool {
	if name == "xdrive.candidate" || name == "upgrade.sh.candidate" || name == "uninstall.sh.candidate" {
		return false
	}
	if len(name) == 0 || len(name) > 240 || path.Clean(name) != name || strings.HasPrefix(name, "/") {
		return false
	}
	for _, component := range strings.Split(name, "/") {
		if component == "." || component == ".." || !componentPattern.MatchString(component) {
			return false
		}
	}
	return true
}

func metadata(data []byte) (Package, *Manifest, error) {
	if len(data) > maxMetadata {
		return Package{}, nil, errors.New("release metadata exceeds its limit")
	}
	pkg := Package{Metadata: data, Legacy: true}
	text := string(data)
	if strings.Count(text, BeginManifest) != strings.Count(text, EndManifest) || strings.Count(text, BeginManifest) > 1 {
		return Package{}, nil, errors.New("invalid release manifest delimiters")
	}
	var manifest *Manifest
	if start := strings.Index(text, BeginManifest); start >= 0 {
		end := strings.Index(text, EndManifest)
		if end <= start || (start > 0 && text[start-1] != '\n') || !strings.HasPrefix(text[start+len(BeginManifest):], "\n") || text[end-1] != '\n' {
			return Package{}, nil, errors.New("invalid release manifest delimiters")
		}
		decoder := json.NewDecoder(strings.NewReader(text[start+len(BeginManifest) : end]))
		decoder.DisallowUnknownFields()
		manifest = &Manifest{}
		if err := decoder.Decode(manifest); err != nil {
			return Package{}, nil, errors.New("invalid release manifest")
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF || manifest.Format != 1 {
			return Package{}, nil, errors.New("unsupported release manifest")
		}
		text = text[:start]
		pkg.Legacy = false
	}
	values := make(map[string]string)
	seenKeys := make(map[string]bool)
	// Only the leading metadata section is interpreted. License text follows it.
	for _, line := range strings.Split(text, "\n") {
		if line == "" {
			break
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || seenKeys[key] {
			return Package{}, nil, errors.New("invalid or duplicate release metadata")
		}
		values[key] = value
		seenKeys[key] = true
	}
	if !versionPattern.MatchString(values["version"]) || values["os"] != "linux" || (values["architecture"] != "amd64" && values["architecture"] != "arm64") {
		return Package{}, nil, errors.New("invalid release platform or version")
	}
	if (!pkg.Legacy && values["packageFormat"] != "1") || (pkg.Legacy && values["packageFormat"] != "") {
		return Package{}, nil, errors.New("release manifest is missing or unsupported")
	}
	pkg.Version, pkg.Architecture = values["version"], values["architecture"]
	return pkg, manifest, nil
}

func validateFiles(files []File) error {
	if len(files) < 4 || len(files) > maxFiles {
		return errors.New("release file count exceeds its bounds")
	}
	seen := make(map[string]bool)
	var total int64
	for _, file := range files {
		decoded, err := hex.DecodeString(file.SHA256)
		if !SafePath(file.Path) || file.Path == "RELEASE.txt" || seen[file.Path] || err != nil || len(decoded) != 32 || file.SHA256 != strings.ToLower(file.SHA256) || file.Size < 0 || file.Size > maxBytes || (file.Mode != 0644 && file.Mode != 0755) {
			return fmt.Errorf("invalid release file declaration: %q", file.Path)
		}
		seen[file.Path] = true
		total += file.Size
		if total > maxBytes {
			return errors.New("release unpacked size exceeds its limit")
		}
	}
	for _, file := range files {
		for parent := path.Dir(file.Path); parent != "."; parent = path.Dir(parent) {
			if seen[parent] || parent == "RELEASE.txt" {
				return errors.New("release contains a file/directory path collision")
			}
		}
	}
	for _, required := range []string{"xdrive", "install.sh", "upgrade.sh", "uninstall.sh"} {
		if !seen[required] {
			return fmt.Errorf("release is missing %s", required)
		}
		for _, file := range files {
			if file.Path == required && file.Mode != 0755 {
				return errors.New("release executable has an invalid mode")
			}
		}
	}
	return nil
}

// Inspect validates every tar member and every manifest digest without writing
// any output. Directory entries are unnecessary: directories are derived from
// file paths. Links, devices, duplicate names and sparse records are rejected.
func Inspect(archive string) (Package, error) {
	file, err := os.Open(archive)
	if err != nil {
		return Package{}, err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return Package{}, err
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	var files []File
	var release []byte
	seen := make(map[string]bool)
	var total int64
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Package{}, err
		}
		if (header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA) || header.Linkname != "" || !SafePath(header.Name) || seen[header.Name] || header.Size < 0 || header.Size > maxBytes || header.Mode & ^int64(0777) != 0 {
			return Package{}, fmt.Errorf("invalid release archive member: %q", header.Name)
		}
		for key := range header.PAXRecords {
			if strings.HasPrefix(key, "GNU.sparse") {
				return Package{}, errors.New("sparse release members are not supported")
			}
		}
		seen[header.Name] = true
		total += header.Size
		if total > maxBytes || len(seen) > maxFiles+1 {
			return Package{}, errors.New("release archive exceeds its bounds")
		}
		if header.Name == "RELEASE.txt" {
			if header.Size > maxMetadata || header.Mode != 0644 {
				return Package{}, errors.New("invalid release metadata size or mode")
			}
			release, err = io.ReadAll(reader)
			if err != nil {
				return Package{}, err
			}
			continue
		}
		hash := sha256.New()
		count, err := io.Copy(hash, reader)
		if err != nil || count != header.Size {
			return Package{}, errors.New("release member is truncated")
		}
		mode := uint32(header.Mode)
		// Legacy bundles did not declare modes for scripts. Normalize them to
		// the modes the legacy installer used; manifests require an exact match.
		files = append(files, File{Path: header.Name, Size: count, SHA256: hex.EncodeToString(hash.Sum(nil)), Mode: mode})
	}
	// Drain to validate the gzip checksum and reject non-zero trailing data.
	trailing, err := io.Copy(io.Discard, &zeroReader{reader: gz})
	if err != nil || trailing > 1<<20 {
		return Package{}, errors.New("invalid release archive trailer")
	}
	pkg, manifest, err := metadata(release)
	if err != nil {
		return Package{}, err
	}
	if manifest == nil {
		for index := range files {
			if strings.HasSuffix(files[index].Path, ".sh") || files[index].Path == "xdrive" {
				files[index].Mode = 0755
			} else if files[index].Mode&0111 != 0 {
				files[index].Mode = 0755
			} else {
				files[index].Mode = 0644
			}
		}
	} else {
		if err := validateFiles(manifest.Files); err != nil {
			return Package{}, err
		}
		declared := make(map[string]File)
		for _, file := range manifest.Files {
			declared[file.Path] = file
		}
		if len(declared) != len(files) {
			return Package{}, errors.New("release manifest and archive file sets disagree")
		}
		for _, file := range files {
			if declared[file.Path] != file {
				return Package{}, fmt.Errorf("release file does not match its manifest: %q", file.Path)
			}
		}
	}
	if err := validateFiles(files); err != nil {
		return Package{}, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	pkg.Files = files
	return pkg, nil
}

type zeroReader struct{ reader io.Reader }

func (r *zeroReader) Read(data []byte) (int, error) {
	n, err := r.reader.Read(data)
	for _, value := range data[:n] {
		if value != 0 {
			return n, errors.New("nonzero data after tar terminator")
		}
	}
	return n, err
}

func canonicalDirectory(root string) error {
	abs, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil || resolved != abs {
		return errors.New("release directory must be canonical and must not be symlinked")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() {
		return errors.New("release directory is invalid")
	}
	return nil
}

// Prepare writes only into an existing empty canonical directory after the
// complete archive has passed validation. Failed staging is safe to discard.
func Prepare(archive, output, architecture string) error {
	pkg, err := Inspect(archive)
	if err != nil {
		return err
	}
	if pkg.Architecture != architecture {
		return errors.New("release architecture mismatch")
	}
	if err := canonicalDirectory(output); err != nil {
		return err
	}
	info, err := os.Lstat(output)
	if err != nil {
		return err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0022 != 0 {
		return errors.New("release staging must be owned by the caller and not writable by others")
	}
	entries, err := os.ReadDir(output)
	if err != nil || len(entries) != 0 {
		return errors.New("release staging directory must be empty")
	}
	modes := map[string]os.FileMode{"RELEASE.txt": 0644}
	for _, file := range pkg.Files {
		modes[file.Path] = os.FileMode(file.Mode)
	}
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		mode, ok := modes[header.Name]
		if !ok || !SafePath(header.Name) || (header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA) {
			return errors.New("release archive changed during staging")
		}
		target := filepath.Join(output, filepath.FromSlash(header.Name))
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, copyErr := io.Copy(io.MultiWriter(out, hash), reader)
		if copyErr == nil {
			if header.Name == "RELEASE.txt" {
				expected := sha256.Sum256(pkg.Metadata)
				if hex.EncodeToString(hash.Sum(nil)) != hex.EncodeToString(expected[:]) {
					copyErr = errors.New("release metadata changed during staging")
				}
			} else {
				for _, expected := range pkg.Files {
					if expected.Path == header.Name && hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
						copyErr = errors.New("release file changed during staging")
					}
				}
			}
		}
		if copyErr == nil {
			copyErr = out.Chmod(mode)
		}
		if copyErr == nil {
			copyErr = out.Sync()
		}
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if pkg.Legacy {
		// Turn a legacy package into a receipt so the next upgrade can identify
		// all managed files, including additions and removals.
		manifest, err := json.Marshal(Manifest{Format: 1, Files: pkg.Files})
		if err != nil {
			return err
		}
		data := append([]byte("packageFormat=1\n"), pkg.Metadata...)
		if bytes.IndexByte(pkg.Metadata, '\n') < 0 {
			return errors.New("invalid legacy metadata")
		}
		data = append(data, []byte("\n"+BeginManifest+"\n"+string(manifest)+"\n"+EndManifest+"\n")...)
		file, err := os.OpenFile(filepath.Join(output, "RELEASE.txt"), os.O_WRONLY|os.O_TRUNC, 0644)
		if err != nil {
			return err
		}
		_, writeErr := file.Write(data)
		if writeErr == nil {
			writeErr = file.Sync()
		}
		closeErr := file.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if err := filepath.WalkDir(output, func(current string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if err := os.Chmod(current, 0755); err != nil {
				return err
			}
			dir, err := os.Open(current)
			if err != nil {
				return err
			}
			syncErr := dir.Sync()
			closeErr := dir.Close()
			if syncErr != nil {
				return syncErr
			}
			return closeErr
		}
		return nil
	}); err != nil {
		return err
	}
	return CheckInstalled(output)
}

// CheckInstalled refuses modified, linked or untracked application files before
// an upgrade can replace the directory. Legacy installations have three files.
func CheckInstalled(root string) error {
	if err := canonicalDirectory(root); err != nil {
		return err
	}
	expected := make(map[string]File)
	receipt := filepath.Join(root, "RELEASE.txt")
	if info, err := os.Lstat(receipt); err == nil {
		if !info.Mode().IsRegular() || info.Size() > maxMetadata {
			return errors.New("invalid installed release receipt")
		}
		data, err := os.ReadFile(receipt)
		if err != nil {
			return err
		}
		_, manifest, err := metadata(data)
		if err != nil || manifest == nil {
			return errors.New("installed release receipt is invalid")
		}
		if err := validateFiles(manifest.Files); err != nil {
			return err
		}
		for _, file := range manifest.Files {
			expected[file.Path] = file
		}
		expected["RELEASE.txt"] = File{Path: "RELEASE.txt", Size: info.Size(), Mode: 0644}
	} else if errors.Is(err, os.ErrNotExist) {
		for _, name := range []string{"xdrive", "upgrade.sh", "uninstall.sh"} {
			expected[name] = File{Path: name}
		}
	} else {
		return err
	}
	seen := make(map[string]bool)
	err := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == root {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			return checkRootOwnership(info)
		}
		name, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		name = filepath.ToSlash(name)
		if !SafePath(name) || entry.Type()&os.ModeSymlink != 0 {
			return errors.New("unsafe installed application path")
		}
		if entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if err := checkRootOwnership(info); err != nil {
				return err
			}
			for key := range expected {
				if strings.HasPrefix(key, name+"/") {
					return nil
				}
			}
			return fmt.Errorf("untracked application directory: %q", name)
		}
		declared, ok := expected[name]
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || !ok {
			return fmt.Errorf("untracked or unsafe application file: %q", name)
		}
		if err := checkRootOwnership(info); err != nil {
			return err
		}
		if declared.Mode != 0 && (info.Mode().Perm() != os.FileMode(declared.Mode) || info.Size() != declared.Size) {
			return fmt.Errorf("installed application file changed: %q", name)
		}
		if declared.SHA256 != "" {
			file, err := os.Open(current)
			if err != nil {
				return err
			}
			hash := sha256.New()
			_, readErr := io.Copy(hash, file)
			closeErr := file.Close()
			if readErr != nil {
				return readErr
			}
			if closeErr != nil {
				return closeErr
			}
			if hex.EncodeToString(hash.Sum(nil)) != declared.SHA256 {
				return fmt.Errorf("installed application file changed: %q", name)
			}
		}
		seen[name] = true
		return nil
	})
	if err != nil {
		return err
	}
	if len(seen) != len(expected) {
		return errors.New("installed application files are missing")
	}
	return nil
}

func checkRootOwnership(info os.FileInfo) error {
	if info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		return errors.New("special permissions are not allowed on application files")
	}
	if os.Geteuid() != 0 {
		return nil
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 || info.Mode().Perm()&0022 != 0 {
		return errors.New("application files must be root-owned and not writable by other users")
	}
	return nil
}

// SyncTree flushes staged application resources before publication.
func SyncTree(root string) error {
	if err := CheckInstalled(root); err != nil {
		return err
	}
	return filepath.WalkDir(root, func(current string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		file, err := os.Open(current)
		if err != nil {
			return err
		}
		syncErr := file.Sync()
		closeErr := file.Close()
		if syncErr != nil {
			return syncErr
		}
		return closeErr
	})
}

func SyncDirectory(root string) error {
	if err := canonicalDirectory(root); err != nil {
		return err
	}
	dir, err := os.Open(root)
	if err != nil {
		return err
	}
	syncErr := dir.Sync()
	closeErr := dir.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

// RemoveInstalled removes only files declared by the installed release. Local
// additions remain in place; their parent directories are removed only if empty.
func RemoveInstalled(root string) error {
	if err := canonicalDirectory(root); err != nil {
		return err
	}
	info, err := os.Lstat(filepath.Join(root, "RELEASE.txt"))
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxMetadata {
		return errors.New("invalid installed release receipt")
	}
	if err := checkRootOwnership(info); err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(root, "RELEASE.txt"))
	if err != nil {
		return err
	}
	_, manifest, err := metadata(data)
	if err != nil || manifest == nil {
		return errors.New("installed release receipt is invalid")
	}
	if err := validateFiles(manifest.Files); err != nil {
		return err
	}
	paths := []string{"RELEASE.txt"}
	for _, file := range manifest.Files {
		paths = append(paths, file.Path)
	}
	// Preflight all parent paths before deleting anything.
	for _, name := range paths {
		for current := filepath.Join(root, filepath.FromSlash(name)); current != root; current = filepath.Dir(current) {
			info, err := os.Lstat(current)
			leaf := current == filepath.Join(root, filepath.FromSlash(name))
			if err != nil || info.Mode()&os.ModeSymlink != 0 || (leaf && !info.Mode().IsRegular()) || (!leaf && !info.IsDir()) {
				return errors.New("unsafe managed application path")
			}
		}
	}
	for _, name := range paths {
		if err := os.Remove(filepath.Join(root, filepath.FromSlash(name))); err != nil {
			return err
		}
	}
	dirs := make(map[string]bool)
	for _, name := range paths {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			dirs[parent] = true
		}
	}
	list := make([]string, 0, len(dirs))
	for dir := range dirs {
		list = append(list, dir)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(list)))
	for _, dir := range list {
		_ = os.Remove(filepath.Join(root, filepath.FromSlash(dir)))
	}
	return nil
}
