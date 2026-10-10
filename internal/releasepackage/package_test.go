package releasepackage

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func canonicalTemp(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

type testMember struct {
	name string
	data []byte
	mode int64
	kind byte
}

func testFiles(count int) []testMember {
	var files []testMember
	for _, name := range []string{"xdrive", "install.sh", "upgrade.sh", "uninstall.sh"} {
		files = append(files, testMember{name: name, data: []byte("executable " + name), mode: 0755, kind: tar.TypeReg})
	}
	for i := 0; i < count; i++ {
		files = append(files, testMember{name: fmt.Sprintf("assets/group/%03d.bin", i), data: []byte(fmt.Sprintf("resource-%d", i)), mode: 0644, kind: tar.TypeReg})
	}
	return files
}

func testArchive(t *testing.T, members []testMember, manifestChange func(*Manifest), memberChange func([]testMember) []testMember, legacy bool) string {
	t.Helper()
	manifest := Manifest{Format: 1}
	for _, member := range members {
		hash := sha256.Sum256(member.data)
		manifest.Files = append(manifest.Files, File{Path: member.name, Size: int64(len(member.data)), SHA256: hex.EncodeToString(hash[:]), Mode: uint32(member.mode)})
	}
	if manifestChange != nil {
		manifestChange(&manifest)
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	metadata := "version=v1.3.7\nos=linux\narchitecture=amd64\n\nLicense text\n"
	if !legacy {
		metadata = "packageFormat=1\n" + metadata + "\n" + BeginManifest + "\n" + string(encoded) + "\n" + EndManifest + "\n"
	}
	members = append(members, testMember{name: "RELEASE.txt", data: []byte(metadata), mode: 0644, kind: tar.TypeReg})
	if memberChange != nil {
		members = memberChange(members)
	}
	archive := filepath.Join(t.TempDir(), "release.tar.gz")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(file)
	writer := tar.NewWriter(gz)
	for _, member := range members {
		header := &tar.Header{Name: member.name, Size: int64(len(member.data)), Mode: member.mode, Typeflag: member.kind}
		if member.kind == tar.TypeSymlink || member.kind == tar.TypeLink {
			header.Linkname = "/outside"
			header.Size = 0
		}
		if member.kind == tar.TypeDir || member.kind == tar.TypeFifo {
			header.Size = 0
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Size > 0 {
			if _, err := writer.Write(member.data); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, closer := range []interface{ Close() error }{writer, gz, file} {
		if err := closer.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return archive
}

func TestPrepareVariableFilesAndLegacyReceipts(t *testing.T) {
	for _, count := range []int{0, 5, 6, 15, 16, 30} {
		for _, legacy := range []bool{false, true} {
			t.Run(fmt.Sprintf("extra%d-legacy%t", count, legacy), func(t *testing.T) {
				archive := testArchive(t, testFiles(count), nil, nil, legacy)
				root := canonicalTemp(t)
				if err := Prepare(archive, root, "amd64"); err != nil {
					t.Fatal(err)
				}
				for _, member := range testFiles(count) {
					data, err := os.ReadFile(filepath.Join(root, member.name))
					if err != nil || string(data) != string(member.data) {
						t.Fatalf("resource lost: %s: %v", member.name, err)
					}
				}
				if err := CheckInstalled(root); err != nil {
					t.Fatal(err)
				}
				if count > 0 {
					if err := os.WriteFile(filepath.Join(root, "assets/group/000.bin"), []byte("changed"), 0644); err != nil {
						t.Fatal(err)
					}
					if err := CheckInstalled(root); err == nil {
						t.Fatal("modified resource accepted")
					}
				}
			})
		}
	}
}

func TestMalformedPackagesNeverWriteFiles(t *testing.T) {
	cases := []struct {
		name     string
		manifest func(*Manifest)
		members  func([]testMember) []testMember
	}{
		{"wrong-digest", func(m *Manifest) { m.Files[0].SHA256 = strings.Repeat("0", 64) }, nil},
		{"wrong-size", func(m *Manifest) { m.Files[0].Size++ }, nil},
		{"wrong-mode", func(m *Manifest) { m.Files[0].Mode = 0644 }, nil},
		{"unknown-format", func(m *Manifest) { m.Format = 2 }, nil},
		{"missing-declaration", func(m *Manifest) { m.Files = m.Files[1:] }, nil},
		{"duplicate-declaration", func(m *Manifest) { m.Files = append(m.Files, m.Files[0]) }, nil},
		{"duplicate-member", nil, func(m []testMember) []testMember { return append(m, m[0]) }},
		{"missing-member", nil, func(m []testMember) []testMember { return m[1:] }},
		{"extra-member", nil, func(m []testMember) []testMember {
			return append(m, testMember{name: "unknown.txt", data: []byte("extra"), mode: 0644, kind: tar.TypeReg})
		}},
		{"absolute-path", nil, func(m []testMember) []testMember { m[0].name = "/outside"; return m }},
		{"traversal", nil, func(m []testMember) []testMember { m[0].name = "assets/../../outside"; return m }},
		{"symlink", nil, func(m []testMember) []testMember { m[0].kind = tar.TypeSymlink; return m }},
		{"hardlink", nil, func(m []testMember) []testMember { m[0].kind = tar.TypeLink; return m }},
		{"fifo", nil, func(m []testMember) []testMember { m[0].kind = tar.TypeFifo; return m }},
		{"directory-member", nil, func(m []testMember) []testMember { m[0].kind = tar.TypeDir; return m }},
		{"setuid", nil, func(m []testMember) []testMember { m[0].mode = 04755; return m }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			root := canonicalTemp(t)
			archive := testArchive(t, testFiles(2), test.manifest, test.members, false)
			if err := Prepare(archive, root, "amd64"); err == nil {
				t.Fatal("malformed package accepted")
			}
			entries, err := os.ReadDir(root)
			if err != nil || len(entries) != 0 {
				t.Fatal("validation failure wrote release files")
			}
		})
	}
}

func TestArchitectureAndStagingConfinement(t *testing.T) {
	archive := testArchive(t, testFiles(1), nil, nil, false)
	root := canonicalTemp(t)
	if err := Prepare(archive, root, "arm64"); err == nil {
		t.Fatal("wrong architecture accepted")
	}
	if err := os.WriteFile(filepath.Join(root, "local.txt"), []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := Prepare(archive, root, "amd64"); err == nil {
		t.Fatal("nonempty staging directory accepted")
	}
	link := filepath.Join(t.TempDir(), "redirect")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	if err := Prepare(archive, link, "amd64"); err == nil {
		t.Fatal("linked staging directory accepted")
	}
	unsafe := canonicalTemp(t)
	if err := os.Chmod(unsafe, 0777); err != nil {
		t.Fatal(err)
	}
	if err := Prepare(archive, unsafe, "amd64"); err == nil {
		t.Fatal("writable staging directory accepted")
	}
}

func TestUninstallPreservesLocalFilesAndRejectsLinkedParents(t *testing.T) {
	archive := testArchive(t, testFiles(2), nil, nil, false)
	root := canonicalTemp(t)
	if err := Prepare(archive, root, "amd64"); err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(root, "assets/group/local.txt")
	if err := os.WriteFile(local, []byte("administrator file"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := CheckInstalled(root); err == nil {
		t.Fatal("upgrade would discard an untracked file")
	}
	if err := RemoveInstalled(root); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(local); err != nil || string(data) != "administrator file" {
		t.Fatal("local file was removed")
	}
	root = canonicalTemp(t)
	if err := Prepare(archive, root, "amd64"); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.Rename(filepath.Join(root, "assets"), outside); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "assets")); err != nil {
		t.Fatal(err)
	}
	if err := RemoveInstalled(root); err == nil {
		t.Fatal("linked resource directory was followed")
	}
	if _, err := os.Stat(filepath.Join(root, "xdrive")); err != nil {
		t.Fatal("failed preflight partially removed application")
	}
}
