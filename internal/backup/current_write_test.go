package backup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCurrentPublicationRejectsReplacedDirectory(t *testing.T) {
	base := t.TempDir()
	root, outside := filepath.Join(base, "backup"), filepath.Join(base, "outside")
	for _, p := range []string{root, outside} {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	moved := root + "-owned"
	var temporary string
	err := writeAtomicWithHook(root, "CURRENT", []byte("new-generation\n"), func(step string) {
		if step != "temp-synced" {
			return
		}
		entries, e := os.ReadDir(root)
		if e != nil {
			t.Fatal(e)
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".current-") {
				temporary = entry.Name()
			}
		}
		if temporary == "" {
			t.Fatal("missing temporary")
		}
		if e := os.Rename(root, moved); e != nil {
			t.Fatal(e)
		}
		if e := os.Symlink(outside, root); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(filepath.Join(outside, temporary), []byte("preserve-temp"), 0600); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(filepath.Join(outside, "CURRENT"), []byte("preserve-current"), 0600); e != nil {
			t.Fatal(e)
		}
	})
	if err == nil {
		t.Error("replaced publication directory accepted")
	}
	for name, want := range map[string]string{temporary: "preserve-temp", "CURRENT": "preserve-current"} {
		data, e := os.ReadFile(filepath.Join(outside, name))
		if e != nil || string(data) != want {
			t.Fatalf("outside file changed: %s %q %v", name, data, e)
		}
	}
	entries, e := os.ReadDir(moved)
	if e != nil || len(entries) != 0 {
		t.Fatalf("owned temporary remains: %v %v", entries, e)
	}
}

func TestCurrentAfterRenameFailureRetainsCommittedOriginalMarker(t *testing.T) {
	base := t.TempDir()
	root, outside := filepath.Join(base, "backup"), filepath.Join(base, "outside")
	for _, path := range []string{root, outside} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	moved := root + "-owned"
	if err := os.WriteFile(filepath.Join(root, "CURRENT"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "CURRENT"), []byte("preserve\n"), 0600); err != nil {
		t.Fatal(err)
	}
	changed := false
	err := writeAtomicWithHook(root, "CURRENT", []byte("committed\n"), func(step string) {
		if step != "renamed" {
			return
		}
		changed = true
		if err := os.Rename(root, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, root); err != nil {
			t.Fatal(err)
		}
	})
	if !changed || err == nil {
		t.Fatalf("post-rename replacement was not reported: %v", err)
	}
	for path, want := range map[string]string{filepath.Join(moved, "CURRENT"): "committed\n", filepath.Join(outside, "CURRENT"): "preserve\n"} {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != want {
			t.Fatalf("marker changed: %q %q %v", path, data, err)
		}
	}
	entries, err := os.ReadDir(moved)
	if err != nil || len(entries) != 1 || entries[0].Name() != "CURRENT" {
		t.Fatalf("unexpected owned directory contents: %v %v", entries, err)
	}
}

func TestCurrentPublicationRefusesExistingLinkedMarker(t *testing.T) {
	root := t.TempDir()
	victim := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(victim, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "CURRENT")
	if err := os.Symlink(victim, marker); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(root, "CURRENT", []byte("new\n")); err == nil {
		t.Fatal("linked completion marker accepted")
	}
	target, err := os.Readlink(marker)
	if err != nil || target != victim {
		t.Fatalf("marker link replaced: %q %v", target, err)
	}
	data, err := os.ReadFile(victim)
	if err != nil || string(data) != "preserve" {
		t.Fatalf("linked victim changed: %q %v", data, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 || entries[0].Name() != "CURRENT" {
		t.Fatalf("temporary leak: %v %v", entries, err)
	}
}
