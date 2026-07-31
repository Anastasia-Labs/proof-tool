package mpcceremony

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestDirectoryPublicationFaultRecovery(t *testing.T) {
	t.Run("guard runs immediately before rename", func(t *testing.T) {
		parent := t.TempDir()
		staging := makePublicationTestTree(t, parent, "staging", "candidate")
		destination := filepath.Join(parent, "release")
		guarded := false
		ops := defaultPublicationOps
		ops.renameDirectory = func(source, target string) error {
			if !guarded {
				t.Fatal("rename called before publication guard")
			}
			return renameDirectoryNoReplace(source, target)
		}

		if err := publishDirectoryNoReplaceOrExactGuardedWithOps(
			staging,
			destination,
			func() error {
				guarded = true
				return nil
			},
			ops,
		); err != nil {
			t.Fatalf("guarded publication: %v", err)
		}
		assertPublicationFile(t, filepath.Join(destination, "artifact.bin"), "candidate")
	})

	t.Run("guard rejection leaves publication uncommitted", func(t *testing.T) {
		parent := t.TempDir()
		staging := makePublicationTestTree(t, parent, "staging", "candidate")
		destination := filepath.Join(parent, "release")
		injected := errors.New("injected expired deadline")
		renameCalls := 0
		ops := defaultPublicationOps
		ops.renameDirectory = func(source, target string) error {
			renameCalls++
			return renameDirectoryNoReplace(source, target)
		}

		err := publishDirectoryNoReplaceOrExactGuardedWithOps(
			staging,
			destination,
			func() error { return injected },
			ops,
		)
		requirePublicationState(t, err, publicationNotCommitted)
		if !errors.Is(err, injected) {
			t.Fatalf("error = %v, want injected guard failure", err)
		}
		if renameCalls != 0 {
			t.Fatalf("rename calls = %d, want 0", renameCalls)
		}
		assertPublicationFile(t, filepath.Join(staging, "artifact.bin"), "candidate")
		if _, statErr := os.Lstat(destination); !errors.Is(statErr, fs.ErrNotExist) {
			t.Fatalf("destination exists after guard failure: %v", statErr)
		}
	})

	t.Run("exact retry bypasses guard", func(t *testing.T) {
		parent := t.TempDir()
		destination := makePublicationTestTree(t, parent, "release", "candidate")
		staging := makePublicationTestTree(t, parent, "retry", "candidate")
		guardCalls := 0

		if err := publishDirectoryNoReplaceOrExactGuardedWithOps(
			staging,
			destination,
			func() error {
				guardCalls++
				return errors.New("guard must not run")
			},
			defaultPublicationOps,
		); err != nil {
			t.Fatalf("exact guarded retry: %v", err)
		}
		if guardCalls != 0 {
			t.Fatalf("guard calls = %d, want 0", guardCalls)
		}
		if _, statErr := os.Lstat(staging); !errors.Is(statErr, fs.ErrNotExist) {
			t.Fatalf("exact retry staging was not removed: %v", statErr)
		}
	})

	t.Run("pre-rename failure is not committed", func(t *testing.T) {
		parent := t.TempDir()
		staging := makePublicationTestTree(t, parent, "staging", "candidate")
		destination := filepath.Join(parent, "release")
		injected := errors.New("injected pre-rename failure")
		syncCalls := 0
		ops := defaultPublicationOps
		ops.renameDirectory = func(_, _ string) error { return injected }
		ops.syncDirectory = func(string) error {
			syncCalls++
			return nil
		}

		err := publishDirectoryNoReplaceOrExactWithOps(staging, destination, ops)
		requirePublicationState(t, err, publicationNotCommitted)
		if !errors.Is(err, injected) {
			t.Fatalf("error = %v, want injected rename failure", err)
		}
		if syncCalls != 0 {
			t.Fatalf("parent sync calls = %d, want 0", syncCalls)
		}
		assertPublicationFile(t, filepath.Join(staging, "artifact.bin"), "candidate")
		if _, statErr := os.Lstat(destination); !errors.Is(statErr, fs.ErrNotExist) {
			t.Fatalf("destination exists after pre-rename failure: %v", statErr)
		}
	})

	t.Run("post-rename parent sync failure is recovered", func(t *testing.T) {
		parent := t.TempDir()
		staging := makePublicationTestTree(t, parent, "staging", "candidate")
		destination := filepath.Join(parent, "release")
		syncCalls := 0
		ops := defaultPublicationOps
		ops.syncDirectory = func(path string) error {
			syncCalls++
			if syncCalls == 1 {
				return errors.New("injected parent sync failure")
			}
			return syncDirectory(path)
		}

		if err := publishDirectoryNoReplaceOrExactWithOps(staging, destination, ops); err != nil {
			t.Fatalf("recover post-rename failure: %v", err)
		}
		if syncCalls != 2 {
			t.Fatalf("parent sync calls = %d, want 2", syncCalls)
		}
		if _, err := os.Lstat(staging); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("renamed staging still exists: %v", err)
		}
		assertPublicationFile(t, filepath.Join(destination, "artifact.bin"), "candidate")
	})

	t.Run("ambiguous rename error recovers by inode and content", func(t *testing.T) {
		parent := t.TempDir()
		staging := makePublicationTestTree(t, parent, "staging", "candidate")
		destination := filepath.Join(parent, "release")
		ops := defaultPublicationOps
		ops.renameDirectory = func(source, target string) error {
			if err := renameDirectoryNoReplace(source, target); err != nil {
				return err
			}
			return errors.New("injected error after successful rename")
		}

		if err := publishDirectoryNoReplaceOrExactWithOps(staging, destination, ops); err != nil {
			t.Fatalf("recover ambiguous rename result: %v", err)
		}
		assertPublicationFile(t, filepath.Join(destination, "artifact.bin"), "candidate")
	})

	t.Run("persistent parent sync failure reports committed and retries", func(t *testing.T) {
		parent := t.TempDir()
		staging := makePublicationTestTree(t, parent, "staging", "candidate")
		destination := filepath.Join(parent, "release")
		ops := defaultPublicationOps
		ops.syncDirectory = func(string) error {
			return errors.New("injected persistent parent sync failure")
		}

		err := publishDirectoryNoReplaceOrExactWithOps(staging, destination, ops)
		requirePublicationState(t, err, publicationCommitted)
		assertPublicationFile(t, filepath.Join(destination, "artifact.bin"), "candidate")
		if _, statErr := os.Lstat(staging); !errors.Is(statErr, fs.ErrNotExist) {
			t.Fatalf("successful rename left staging path: %v", statErr)
		}

		retry := makePublicationTestTree(t, parent, "retry", "candidate")
		destinationInfo, statErr := os.Lstat(destination)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if err := publishDirectoryNoReplaceOrExact(retry, destination); err != nil {
			t.Fatalf("exact committed retry: %v", err)
		}
		finalInfo, statErr := os.Lstat(destination)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if !os.SameFile(destinationInfo, finalInfo) {
			t.Fatal("exact retry replaced the committed destination directory")
		}
		if _, statErr := os.Lstat(retry); !errors.Is(statErr, fs.ErrNotExist) {
			t.Fatalf("exact retry staging was not removed: %v", statErr)
		}
	})

	t.Run("conflicting retry is untouched", func(t *testing.T) {
		parent := t.TempDir()
		staging := makePublicationTestTree(t, parent, "staging", "candidate")
		destination := makePublicationTestTree(t, parent, "release", "different")

		err := publishDirectoryNoReplaceOrExact(staging, destination)
		requirePublicationState(t, err, publicationNotCommitted)
		if !errors.Is(err, fs.ErrExist) {
			t.Fatalf("conflict error = %v, want fs.ErrExist", err)
		}
		assertPublicationFile(t, filepath.Join(staging, "artifact.bin"), "candidate")
		assertPublicationFile(t, filepath.Join(destination, "artifact.bin"), "different")
	})
}

func TestFilePublicationFaultRecovery(t *testing.T) {
	t.Run("pre-link failure is not committed", func(t *testing.T) {
		parent := t.TempDir()
		temporary := makePublicationTestFile(t, parent, ".artifact.partial-test", "candidate")
		destination := filepath.Join(parent, "artifact.bin")
		injected := errors.New("injected pre-link failure")
		ops := defaultPublicationOps
		ops.link = func(_, _ string) error { return injected }

		err := publishFileNoReplaceOrExactWithOps(temporary, destination, ops)
		requirePublicationState(t, err, publicationNotCommitted)
		if !errors.Is(err, injected) {
			t.Fatalf("error = %v, want injected link failure", err)
		}
		assertPublicationFile(t, temporary, "candidate")
		if _, statErr := os.Lstat(destination); !errors.Is(statErr, fs.ErrNotExist) {
			t.Fatalf("destination exists after pre-link failure: %v", statErr)
		}
	})

	t.Run("post-link parent sync failure is recovered", func(t *testing.T) {
		parent := t.TempDir()
		temporary := makePublicationTestFile(t, parent, ".artifact.partial-test", "candidate")
		destination := filepath.Join(parent, "artifact.bin")
		syncCalls := 0
		ops := defaultPublicationOps
		ops.syncDirectory = func(path string) error {
			syncCalls++
			if syncCalls == 1 {
				return errors.New("injected parent sync failure")
			}
			return syncDirectory(path)
		}

		if err := publishFileNoReplaceOrExactWithOps(temporary, destination, ops); err != nil {
			t.Fatalf("recover post-link failure: %v", err)
		}
		if syncCalls != 2 {
			t.Fatalf("parent sync calls = %d, want 2", syncCalls)
		}
		assertPublicationFile(t, destination, "candidate")
		if _, statErr := os.Lstat(temporary); !errors.Is(statErr, fs.ErrNotExist) {
			t.Fatalf("temporary link still exists: %v", statErr)
		}
	})

	t.Run("ambiguous link error recovers by inode and content", func(t *testing.T) {
		parent := t.TempDir()
		temporary := makePublicationTestFile(t, parent, ".artifact.partial-test", "candidate")
		destination := filepath.Join(parent, "artifact.bin")
		ops := defaultPublicationOps
		ops.link = func(source, target string) error {
			if err := os.Link(source, target); err != nil {
				return err
			}
			return errors.New("injected error after successful link")
		}

		if err := publishFileNoReplaceOrExactWithOps(temporary, destination, ops); err != nil {
			t.Fatalf("recover ambiguous link result: %v", err)
		}
		assertPublicationFile(t, destination, "candidate")
	})

	t.Run("persistent sync failure preserves exact committed bytes", func(t *testing.T) {
		parent := t.TempDir()
		temporary := makePublicationTestFile(t, parent, ".artifact.partial-test", "candidate")
		destination := filepath.Join(parent, "artifact.bin")
		ops := defaultPublicationOps
		ops.syncDirectory = func(string) error {
			return errors.New("injected persistent parent sync failure")
		}

		err := publishFileNoReplaceOrExactWithOps(temporary, destination, ops)
		requirePublicationState(t, err, publicationCommitted)
		assertPublicationFile(t, destination, "candidate")

		retry := makePublicationTestFile(t, parent, ".artifact.partial-retry", "candidate")
		destinationInfo, statErr := os.Lstat(destination)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if err := publishFileNoReplaceOrExact(retry, destination); err != nil {
			t.Fatalf("exact file retry: %v", err)
		}
		finalInfo, statErr := os.Lstat(destination)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if !os.SameFile(destinationInfo, finalInfo) {
			t.Fatal("exact file retry replaced the committed destination")
		}
	})

	t.Run("conflicting retry is untouched", func(t *testing.T) {
		parent := t.TempDir()
		temporary := makePublicationTestFile(t, parent, ".artifact.partial-test", "candidate")
		destination := makePublicationTestFile(t, parent, "artifact.bin", "different")

		err := publishFileNoReplaceOrExact(temporary, destination)
		requirePublicationState(t, err, publicationNotCommitted)
		if !errors.Is(err, fs.ErrExist) {
			t.Fatalf("conflict error = %v, want fs.ErrExist", err)
		}
		assertPublicationFile(t, temporary, "candidate")
		assertPublicationFile(t, destination, "different")
	})
}

func makePublicationTestTree(t *testing.T, parent, name, contents string) string {
	t.Helper()
	root := filepath.Join(parent, name)
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "evidence")
	if err := os.Mkdir(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	makePublicationTestFile(t, root, "artifact.bin", contents)
	makePublicationTestFile(t, nested, "receipt.json", `{"accepted":true}`)
	return root
}

func makePublicationTestFile(t *testing.T, dir, name, contents string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func requirePublicationState(
	t *testing.T,
	err error,
	expected publicationCommitState,
) {
	t.Helper()
	if err == nil {
		t.Fatalf("publication unexpectedly succeeded; want state %s", expected)
	}
	var publicationErr *publicationError
	if !errors.As(err, &publicationErr) {
		t.Fatalf("error %T %v is not a publicationError", err, err)
	}
	if publicationErr.state != expected {
		t.Fatalf("publication state = %s, want %s: %v", publicationErr.state, expected, err)
	}
}

func assertPublicationFile(t *testing.T, path, expected string) {
	t.Helper()
	actual, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, []byte(expected)) {
		t.Fatalf("%s = %q, want %q", path, actual, expected)
	}
}
