package fssecure

import "testing"

func TestOpenDirectoryRejectsEmptyPath(t *testing.T) {
	if directory, err := OpenDirectory(""); err == nil || directory != nil {
		if directory != nil {
			_ = directory.Close()
		}
		t.Fatalf("empty path resolved to the working directory: %v", err)
	}
}
