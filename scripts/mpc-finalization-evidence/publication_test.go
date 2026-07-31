package main

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestPublishCompletedFileRecoversOnlyExactOutput(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	destination := filepath.Join(parent, "evidence.json")
	data := []byte("{\"complete\":true}\n")
	if err := publishCompletedFile(destination, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publishCompletedFile(destination, data, 0o600); err != nil {
		t.Fatalf("exact retry failed: %v", err)
	}
	actual, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, data) {
		t.Fatal("published output differs")
	}

	err = publishCompletedFile(destination, []byte("{\"complete\":false}\n"), 0o600)
	if !errors.Is(err, fs.ErrExist) {
		t.Fatalf("conflicting retry error = %v, want fs.ErrExist", err)
	}
	actual, err = os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, data) {
		t.Fatal("conflicting retry changed authoritative output")
	}
}

func TestPublishCompletedFileIgnoresInterruptedStagingFile(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	stale := filepath.Join(parent, ".evidence.json.partial-interrupted")
	if err := os.WriteFile(stale, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(parent, "evidence.json")
	data := []byte("complete")
	if err := publishCompletedFile(destination, data, 0o600); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, data) {
		t.Fatal("interrupted staging file affected publication")
	}
}
