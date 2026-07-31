package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const maxCompletedOutputEntries = 100_000

type completedOutputEntry struct {
	name   string
	mode   fs.FileMode
	size   int64
	sha256 [sha256.Size]byte
	isDir  bool
}

func createCompletedOutputStaging(destination string) (string, error) {
	if strings.TrimSpace(destination) == "" {
		return "", errors.New("completed output destination is required")
	}
	parent := filepath.Dir(destination)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return "", err
	}
	if !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("completed output parent must be a real directory")
	}
	staging, err := os.MkdirTemp(parent, "."+filepath.Base(destination)+".partial-*")
	if err != nil {
		return "", err
	}
	if err := os.Chmod(staging, 0o700); err != nil {
		_ = os.Remove(staging)
		return "", err
	}
	return staging, nil
}

// createOperationalVerificationRoot builds a private hard-linked view of the
// immutable phase transcript plus the unpublished operational tree. This lets
// the full bundle verifier run before the authoritative operational directory
// exists without copying multi-gigabyte MPC artifacts.
func createOperationalVerificationRoot(transcriptRoot, operationalStaging string) (string, error) {
	rootInfo, err := os.Lstat(transcriptRoot)
	if err != nil {
		return "", err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("transcript root must be a real directory")
	}
	shadow, err := os.MkdirTemp(transcriptRoot, ".operational.verify-*")
	if err != nil {
		return "", err
	}
	remove := true
	defer func() {
		if remove {
			_ = os.RemoveAll(shadow)
		}
	}()
	if err := os.Chmod(shadow, 0o700); err != nil {
		return "", err
	}
	for _, phase := range []string{"phase1", "phase2"} {
		if err := hardlinkCompletedOutputTree(
			filepath.Join(transcriptRoot, phase),
			filepath.Join(shadow, phase),
		); err != nil {
			return "", fmt.Errorf("materialize %s verification view: %w", phase, err)
		}
	}
	if err := hardlinkCompletedOutputTree(
		operationalStaging,
		filepath.Join(shadow, "operational"),
	); err != nil {
		return "", fmt.Errorf("materialize operational verification view: %w", err)
	}
	remove = false
	return shadow, nil
}

func hardlinkCompletedOutputTree(source, destination string) error {
	sourceInfo, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !sourceInfo.IsDir() || sourceInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("verification source must be a real directory")
	}
	if err := os.Mkdir(destination, sourceInfo.Mode().Perm()); err != nil {
		return err
	}
	entries := 0
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > maxCompletedOutputEntries {
			return fmt.Errorf("verification source exceeds %d entries", maxCompletedOutputEntries)
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		target := filepath.Join(destination, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			return fmt.Errorf("%q is a symlink", path)
		case info.IsDir():
			if err := os.Mkdir(target, info.Mode().Perm()); err != nil {
				return err
			}
		case info.Mode().IsRegular():
			if err := os.Link(path, target); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%q is not a regular file or directory", path)
		}
		return nil
	})
}

func verifyThenPublishCompletedDirectory(
	staging,
	destination string,
	verify func() error,
) error {
	if verify == nil {
		return errors.New("completed output verifier is required")
	}
	if err := verify(); err != nil {
		return fmt.Errorf("verify completed staging tree: %w", err)
	}
	return publishCompletedDirectory(staging, destination)
}

// publishCompletedDirectory atomically renames a complete same-parent staging
// tree without replacing an existing destination. An exact complete
// destination is accepted so retry can recover from termination after rename
// but before the caller observed success.
func publishCompletedDirectory(staging, destination string) error {
	stagingParent, err := filepath.Abs(filepath.Dir(staging))
	if err != nil {
		return fmt.Errorf("resolve completed staging parent: %w", err)
	}
	destinationParent, err := filepath.Abs(filepath.Dir(destination))
	if err != nil {
		return fmt.Errorf("resolve completed destination parent: %w", err)
	}
	if stagingParent != destinationParent {
		return errors.New("completed staging and destination must have the same parent")
	}
	parentInfo, err := os.Lstat(destinationParent)
	if err != nil {
		return fmt.Errorf("inspect completed output parent: %w", err)
	}
	if !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("completed output parent must be a real directory")
	}

	expected, stagingInfo, err := inspectCompletedOutputTree(staging)
	if err != nil {
		return fmt.Errorf("inspect completed staging tree: %w", err)
	}
	if len(expected) <= 1 {
		return errors.New("refusing to publish an empty completed output tree")
	}
	if err := syncCompletedOutputDirectories(staging); err != nil {
		return err
	}

	parent := destinationParent
	destinationExisted := false
	if _, err := os.Lstat(destination); err == nil {
		destinationExisted = true
		if err := requireExactCompletedOutputTree(destination, expected); err != nil {
			return err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("inspect completed output destination: %w", err)
	}

	if !destinationExisted {
		if err := renameCompletedDirectoryNoReplace(staging, destination); err != nil {
			if exactErr := requireExactCompletedOutputTree(destination, expected); exactErr != nil {
				return errors.Join(
					fmt.Errorf("rename completed output without replacement: %w", err),
					exactErr,
				)
			}
			destinationExisted = true
		} else {
			destinationInfo, statErr := os.Lstat(destination)
			if statErr != nil || !destinationInfo.IsDir() ||
				destinationInfo.Mode()&os.ModeSymlink != 0 ||
				!os.SameFile(stagingInfo, destinationInfo) {
				if statErr == nil {
					statErr = errors.New("destination does not identify renamed staging directory")
				}
				return fmt.Errorf("validate renamed completed output: %w", statErr)
			}
		}
	}
	if err := requireExactCompletedOutputTree(destination, expected); err != nil {
		return fmt.Errorf("revalidate completed output destination: %w", err)
	}
	if destinationExisted {
		if currentInfo, err := os.Lstat(staging); err == nil {
			if !os.SameFile(stagingInfo, currentInfo) {
				return errors.New("completed staging tree changed before recovery cleanup")
			}
			if err := os.RemoveAll(staging); err != nil {
				return fmt.Errorf("remove exact retry staging tree: %w", err)
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("inspect exact retry staging tree: %w", err)
		}
	}
	if err := syncCompletedOutputDirectory(parent); err != nil {
		return err
	}
	return nil
}

func requireExactCompletedOutputTree(path string, expected []completedOutputEntry) error {
	actual, _, err := inspectCompletedOutputTree(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return fmt.Errorf("completed output conflicts with unsafe destination: %w", errors.Join(fs.ErrExist, err))
	}
	if len(actual) != len(expected) {
		return fmt.Errorf("completed output conflicts with a different tree: %w", fs.ErrExist)
	}
	for index := range expected {
		if actual[index] != expected[index] {
			return fmt.Errorf("completed output conflicts at %q: %w", expected[index].name, fs.ErrExist)
		}
	}
	return nil
}

func inspectCompletedOutputTree(root string) ([]completedOutputEntry, os.FileInfo, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, nil, err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, nil, errors.New("completed output root is not a real directory")
	}
	entries := make([]completedOutputEntry, 0, 32)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if len(entries) >= maxCompletedOutputEntries {
			return fmt.Errorf("completed output exceeds %d entries", maxCompletedOutputEntries)
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		item := completedOutputEntry{
			name:  filepath.ToSlash(relative),
			mode:  info.Mode() & (fs.ModePerm | fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky),
			isDir: info.IsDir(),
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			return fmt.Errorf("%q is a symlink", path)
		case info.IsDir():
		case info.Mode().IsRegular():
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			openInfo, err := file.Stat()
			if err != nil {
				_ = file.Close()
				return err
			}
			if !openInfo.Mode().IsRegular() || !os.SameFile(info, openInfo) {
				_ = file.Close()
				return fmt.Errorf("%q changed while being opened", path)
			}
			hasher := sha256.New()
			size, err := io.Copy(hasher, file)
			if err != nil {
				_ = file.Close()
				return err
			}
			finalInfo, statErr := file.Stat()
			closeErr := file.Close()
			if statErr != nil {
				return statErr
			}
			if closeErr != nil {
				return closeErr
			}
			if !os.SameFile(openInfo, finalInfo) || finalInfo.Size() != size {
				return fmt.Errorf("%q changed while being hashed", path)
			}
			item.size = size
			copy(item.sha256[:], hasher.Sum(nil))
		default:
			return fmt.Errorf("%q is not a regular file or directory", path)
		}
		entries = append(entries, item)
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].name < entries[j].name
	})
	return entries, rootInfo, nil
}

func syncCompletedOutputDirectories(root string) error {
	directories := make([]string, 0, 16)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("completed output directory %q is a symlink", path)
		}
		if entry.IsDir() {
			directories = append(directories, path)
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.Slice(directories, func(i, j int) bool {
		return strings.Count(directories[i], string(filepath.Separator)) >
			strings.Count(directories[j], string(filepath.Separator))
	})
	for _, directory := range directories {
		if err := syncCompletedOutputDirectory(directory); err != nil {
			return err
		}
	}
	return nil
}

func syncCompletedOutputDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open completed output directory for sync: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync completed output directory: %w", err)
	}
	return nil
}
