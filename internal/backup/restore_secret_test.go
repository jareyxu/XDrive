package backup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRestoredSecretWritesRetainedRootAfterParentReplacement(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "parent")
	stage := filepath.Join(parent, "stage")
	if err := os.MkdirAll(stage, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	original := parent + "-original"
	if err := os.Rename(parent, original); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(outside, "stage"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, parent); err != nil {
		t.Fatal(err)
	}
	secret := []byte("new server secret must remain owned")
	if err := writeRestoredSecret(root, "nested/server.secret", secret); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(outside, "stage", "nested", "server.secret")); !os.IsNotExist(err) {
		t.Fatalf("secret escaped original root: %v", err)
	}
	bytes, err := os.ReadFile(filepath.Join(original, "stage", "nested", "server.secret"))
	if err != nil || string(bytes) != string(secret) {
		t.Fatalf("owned secret missing: %q %v", bytes, err)
	}
	info, err := os.Stat(filepath.Join(original, "stage", "nested", "server.secret"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("secret permissions: %v %v", info, err)
	}
	if err := writeRestoredSecret(root, "nested/server.secret", []byte("replacement")); err == nil {
		t.Fatal("existing secret overwritten")
	}
	bytes, err = os.ReadFile(filepath.Join(original, "stage", "nested", "server.secret"))
	if err != nil || string(bytes) != string(secret) {
		t.Fatal("existing secret changed")
	}
}

func TestRestoredSecretRejectsEscapingLinksAndPaths(t *testing.T) {
	for _, kind := range []string{"parent-link", "leaf-link", "parent-traversal"} {
		t.Run(kind, func(t *testing.T) {
			stage, outside := t.TempDir(), t.TempDir()
			victim := filepath.Join(outside, "victim")
			if err := os.WriteFile(victim, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(stage)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			name := "server.secret"
			switch kind {
			case "parent-link":
				if err := os.Symlink(outside, filepath.Join(stage, "nested")); err != nil {
					t.Fatal(err)
				}
				name = "nested/server.secret"
			case "leaf-link":
				if err := os.Symlink(victim, filepath.Join(stage, name)); err != nil {
					t.Fatal(err)
				}
			case "parent-traversal":
				name = "../outside-secret"
			}
			if err := writeRestoredSecret(root, name, []byte("new secret")); err == nil {
				t.Fatal("unsafe path accepted")
			}
			bytes, err := os.ReadFile(victim)
			if err != nil || string(bytes) != "preserve" {
				t.Fatalf("external victim changed: %q %v", bytes, err)
			}
			if _, err := os.Stat(filepath.Join(outside, "server.secret")); !os.IsNotExist(err) {
				t.Fatalf("external secret created: %v", err)
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(stage), "outside-secret")); !os.IsNotExist(err) {
				t.Fatalf("parent escape created: %v", err)
			}
		})
	}
}
