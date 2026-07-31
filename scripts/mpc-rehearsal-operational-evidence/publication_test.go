package main

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestPublishCompletedDirectoryRecoversOnlyExactTree(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	destination := filepath.Join(parent, "operational")
	first := completedOutputTree(t, destination, []byte("complete"))
	if err := publishCompletedDirectory(first, destination); err != nil {
		t.Fatal(err)
	}
	retry := completedOutputTree(t, destination, []byte("complete"))
	if err := publishCompletedDirectory(retry, destination); err != nil {
		t.Fatalf("exact retry failed: %v", err)
	}
	if _, err := os.Lstat(retry); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("exact retry staging remains: %v", err)
	}

	conflict := completedOutputTree(t, destination, []byte("different"))
	err := publishCompletedDirectory(conflict, destination)
	if !errors.Is(err, fs.ErrExist) {
		t.Fatalf("conflicting retry error = %v, want fs.ErrExist", err)
	}
	actual, err := os.ReadFile(filepath.Join(destination, "nested", "artifact.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, []byte("complete")) {
		t.Fatal("conflicting retry changed authoritative output")
	}
}

func TestPublishCompletedDirectoryIgnoresInterruptedStagingTree(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	destination := filepath.Join(parent, "operational")
	stale := filepath.Join(parent, ".operational.partial-interrupted")
	if err := os.Mkdir(stale, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, "partial"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	staging := completedOutputTree(t, destination, []byte("complete"))
	if err := publishCompletedDirectory(staging, destination); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(stale); err != nil {
		t.Fatalf("publication unexpectedly changed prior interrupted staging tree: %v", err)
	}
}

func TestOperationalVerificationRootUsesLogicalLayoutWithoutCopying(t *testing.T) {
	t.Parallel()

	transcript := t.TempDir()
	for _, phase := range []string{"phase1", "phase2"} {
		if err := os.Mkdir(filepath.Join(transcript, phase), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(
			filepath.Join(transcript, phase, "artifact.bin"),
			[]byte(phase),
			0o600,
		); err != nil {
			t.Fatal(err)
		}
	}
	destination := filepath.Join(transcript, "operational")
	staging := completedOutputTree(t, destination, []byte("complete"))
	shadow, err := createOperationalVerificationRoot(transcript, staging)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(shadow) })

	operationalPath := filepath.Join(shadow, "operational", "nested", "artifact.json")
	actual, err := os.ReadFile(operationalPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, []byte("complete")) {
		t.Fatal("shadow operational artifact differs")
	}
	if _, err := os.Lstat(filepath.Join(shadow, "operational", "operational")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("shadow view nested operational twice: %v", err)
	}
	sourceInfo, err := os.Lstat(filepath.Join(transcript, "phase1", "artifact.bin"))
	if err != nil {
		t.Fatal(err)
	}
	shadowInfo, err := os.Lstat(filepath.Join(shadow, "phase1", "artifact.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(sourceInfo, shadowInfo) {
		t.Fatal("phase artifact was copied instead of hard-linked")
	}
}

func TestVerificationFailureLeavesCompletedDestinationAbsent(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	destination := filepath.Join(parent, "operational")
	staging := completedOutputTree(t, destination, []byte("complete"))
	sentinel := errors.New("invalid generated bundle")
	err := verifyThenPublishCompletedDirectory(staging, destination, func() error {
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("verification error = %v, want sentinel", err)
	}
	if _, err := os.Lstat(destination); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("failed verification published destination: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(staging, "nested", "artifact.json")); err != nil {
		t.Fatalf("failed verification changed completed staging tree: %v", err)
	}
}

func completedOutputTree(t *testing.T, destination string, data []byte) string {
	t.Helper()
	staging, err := createCompletedOutputStaging(destination)
	if err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(staging, "nested")
	if err := os.Mkdir(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(nested, "artifact.json")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return staging
}
