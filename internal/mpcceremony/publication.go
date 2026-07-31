package mpcceremony

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/crypto/blake2b"
)

type publicationCommitState string

const (
	publicationNotCommitted publicationCommitState = "not-committed"
	publicationCommitted    publicationCommitState = "committed"
)

// publicationError records whether an error happened before an authoritative
// destination was created or after exact committed bytes were observed there.
// Callers must never roll back a publicationCommitted destination.
type publicationError struct {
	state publicationCommitState
	op    string
	err   error
}

func (e *publicationError) Error() string {
	return fmt.Sprintf("%s publication %s: %v", e.state, e.op, e.err)
}

func (e *publicationError) Unwrap() error {
	return e.err
}

func publicationWasCommitted(err error) bool {
	var publicationErr *publicationError
	return errors.As(err, &publicationErr) &&
		publicationErr.state == publicationCommitted
}

type publicationOps struct {
	link            func(string, string) error
	renameDirectory func(string, string) error
	remove          func(string) error
	removeAll       func(string) error
	syncDirectory   func(string) error
}

var defaultPublicationOps = publicationOps{
	link:            os.Link,
	renameDirectory: renameDirectoryNoReplace,
	remove:          os.Remove,
	removeAll:       os.RemoveAll,
	syncDirectory:   syncDirectory,
}

// createRecoveryStagingDir creates a fresh same-parent staging directory even
// when destination already exists. The publication step later accepts that
// destination only if its complete tree is byte-for-byte identical. This is
// what makes a crash after rename but before parent fsync safely retryable.
func createRecoveryStagingDir(destination string) (string, error) {
	if strings.TrimSpace(destination) == "" {
		return "", errors.New("publication destination is required")
	}
	parent := filepath.Dir(destination)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return "", err
	}
	if !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("publication destination parent is not a real directory")
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

type publicationFile struct {
	mode   fs.FileMode
	digest Digest
}

func publicationMode(mode fs.FileMode) fs.FileMode {
	return mode & (fs.ModePerm | fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky)
}

func inspectPublicationFile(path string) (publicationFile, error) {
	linkInfo, err := os.Lstat(path)
	if err != nil {
		return publicationFile{}, err
	}
	if !linkInfo.Mode().IsRegular() || linkInfo.Mode()&os.ModeSymlink != 0 {
		return publicationFile{}, fmt.Errorf("%q is not a real regular file", path)
	}
	if linkInfo.Size() < 0 || linkInfo.Size() > MaxArtifactSize {
		return publicationFile{}, fmt.Errorf(
			"%q size %d is outside [0,%d]",
			path,
			linkInfo.Size(),
			MaxArtifactSize,
		)
	}
	file, err := os.Open(path)
	if err != nil {
		return publicationFile{}, err
	}
	defer file.Close()
	openInfo, err := file.Stat()
	if err != nil {
		return publicationFile{}, err
	}
	if !openInfo.Mode().IsRegular() ||
		!os.SameFile(linkInfo, openInfo) ||
		openInfo.Size() != linkInfo.Size() {
		return publicationFile{}, fmt.Errorf("%q changed while being opened", path)
	}
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return publicationFile{}, err
	}
	n, err := io.Copy(io.MultiWriter(sha, blake), file)
	if err != nil {
		return publicationFile{}, err
	}
	if n != openInfo.Size() {
		return publicationFile{}, fmt.Errorf("%q changed size while hashing", path)
	}
	finalInfo, err := file.Stat()
	if err != nil {
		return publicationFile{}, err
	}
	if !finalInfo.Mode().IsRegular() ||
		!os.SameFile(openInfo, finalInfo) ||
		finalInfo.Size() != openInfo.Size() {
		return publicationFile{}, fmt.Errorf("%q changed while being hashed", path)
	}
	return publicationFile{
		mode: publicationMode(openInfo.Mode()),
		digest: Digest{
			SHA256:     "sha256:" + hex.EncodeToString(sha.Sum(nil)),
			Blake2b256: "blake2b256:" + hex.EncodeToString(blake.Sum(nil)),
			Size:       n,
		},
	}, nil
}

func equalPublicationFile(actual, expected publicationFile) bool {
	return actual.mode == expected.mode && actual.digest == expected.digest
}

// publishFileNoReplace publishes a synced temporary file with a same-directory
// hard link while preserving the public no-replace contract: any destination
// that existed when the call began yields fs.ErrExist.
func publishFileNoReplace(tempPath, destination string) error {
	return publishFileWithOps(
		tempPath,
		destination,
		false,
		defaultPublicationOps,
	)
}

// publishFileNoReplaceOrExact is the recovery variant. It accepts an exact
// existing destination but never replaces a different one.
func publishFileNoReplaceOrExact(tempPath, destination string) error {
	return publishFileNoReplaceOrExactWithOps(
		tempPath,
		destination,
		defaultPublicationOps,
	)
}

func publishFileNoReplaceOrExactWithOps(
	tempPath, destination string,
	ops publicationOps,
) error {
	return publishFileWithOps(tempPath, destination, true, ops)
}

func publishFileWithOps(
	tempPath, destination string,
	acceptExactExisting bool,
	ops publicationOps,
) error {
	expected, err := inspectPublicationFile(tempPath)
	if err != nil {
		return &publicationError{publicationNotCommitted, "inspect temporary file", err}
	}
	tempInfo, err := os.Lstat(tempPath)
	if err != nil {
		return &publicationError{publicationNotCommitted, "inspect temporary file identity", err}
	}
	parent := filepath.Dir(destination)
	destinationExisted := false
	if _, statErr := os.Lstat(destination); statErr == nil {
		destinationExisted = true
		actual, inspectErr := inspectPublicationFile(destination)
		if inspectErr != nil ||
			!acceptExactExisting ||
			!equalPublicationFile(actual, expected) {
			return &publicationError{
				publicationNotCommitted,
				"conflicts with an existing destination",
				errors.Join(
					fmt.Errorf("%w: %s", fs.ErrExist, destination),
					inspectErr,
				),
			}
		}
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return &publicationError{
			publicationNotCommitted,
			"inspect destination",
			statErr,
		}
	}

	if !destinationExisted {
		if linkErr := ops.link(tempPath, destination); linkErr != nil {
			destinationInfo, destinationStatErr := os.Lstat(destination)
			if destinationStatErr != nil ||
				!destinationInfo.Mode().IsRegular() ||
				!os.SameFile(tempInfo, destinationInfo) {
				return &publicationError{
					publicationNotCommitted,
					"link without replacement",
					linkErr,
				}
			}
		}
		destinationInfo, statErr := os.Lstat(destination)
		if statErr != nil ||
			!destinationInfo.Mode().IsRegular() ||
			!os.SameFile(tempInfo, destinationInfo) {
			if statErr == nil {
				statErr = errors.New("destination does not identify the published temporary file")
			}
			return &publicationError{
				publicationCommitted,
				"validate destination identity",
				statErr,
			}
		}
	}

	actual, err := inspectPublicationFile(destination)
	if err != nil || !equalPublicationFile(actual, expected) {
		if err == nil {
			err = errors.New("destination bytes or permissions differ from validated temporary file")
		}
		return &publicationError{publicationCommitted, "revalidate destination", err}
	}
	if err := ops.remove(tempPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return &publicationError{publicationCommitted, "remove temporary link", err}
	}
	if err := syncPublicationDirectoryWithRecovery(
		parent,
		func() error {
			actual, err := inspectPublicationFile(destination)
			if err != nil {
				return err
			}
			if !equalPublicationFile(actual, expected) {
				return errors.New("destination changed after publication")
			}
			return nil
		},
		ops,
	); err != nil {
		return err
	}
	return nil
}

type publicationTreeEntry struct {
	name   string
	mode   fs.FileMode
	digest Digest
	isDir  bool
}

func inspectPublicationTree(root string) ([]publicationTreeEntry, os.FileInfo, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, nil, err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, nil, errors.New("publication root is not a real directory")
	}
	const maxPublicationEntries = 100_000
	entries := make([]publicationTreeEntry, 0, 32)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if len(entries) >= maxPublicationEntries {
			return fmt.Errorf("publication tree exceeds %d entries", maxPublicationEntries)
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("publication entry %q is a symbolic link", name)
		}
		switch {
		case entry.IsDir():
			entries = append(entries, publicationTreeEntry{
				name:  name,
				mode:  publicationMode(info.Mode()),
				isDir: true,
			})
		case info.Mode().IsRegular():
			file, err := inspectPublicationFile(path)
			if err != nil {
				return err
			}
			entries = append(entries, publicationTreeEntry{
				name:   name,
				mode:   file.mode,
				digest: file.digest,
			})
		default:
			return fmt.Errorf("publication entry %q is not a regular file or directory", name)
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	finalRootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, nil, err
	}
	if !os.SameFile(rootInfo, finalRootInfo) {
		return nil, nil, errors.New("publication root changed while being inspected")
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].name < entries[j].name
	})
	return entries, rootInfo, nil
}

func equalPublicationTrees(actual, expected []publicationTreeEntry) bool {
	if len(actual) != len(expected) {
		return false
	}
	for index := range expected {
		if actual[index] != expected[index] {
			return false
		}
	}
	return true
}

// publishDirectoryNoReplaceOrExact atomically renames a complete same-parent
// staging tree. Exact existing trees are accepted only as idempotent recovery;
// conflicting trees are never replaced.
func publishDirectoryNoReplaceOrExact(stagingDir, destination string) error {
	return publishDirectoryNoReplaceOrExactGuardedWithOps(
		stagingDir,
		destination,
		nil,
		defaultPublicationOps,
	)
}

// publishDirectoryNoReplaceOrExactGuarded is the time-sensitive recovery
// variant. guard is evaluated only for a new destination, after both trees
// have been inspected and immediately before the no-replace rename. Exact
// existing destinations bypass the guard so a committed publication can be
// recovered after its original deadline.
func publishDirectoryNoReplaceOrExactGuarded(
	stagingDir, destination string,
	guard func() error,
) error {
	return publishDirectoryNoReplaceOrExactGuardedWithOps(
		stagingDir,
		destination,
		guard,
		defaultPublicationOps,
	)
}

func publishDirectoryNoReplaceOrExactWithOps(
	stagingDir, destination string,
	ops publicationOps,
) error {
	return publishDirectoryNoReplaceOrExactGuardedWithOps(
		stagingDir,
		destination,
		nil,
		ops,
	)
}

func publishDirectoryNoReplaceOrExactGuardedWithOps(
	stagingDir, destination string,
	guard func() error,
	ops publicationOps,
) error {
	expected, stagingInfo, err := inspectPublicationTree(stagingDir)
	if err != nil {
		return &publicationError{publicationNotCommitted, "inspect staging tree", err}
	}
	if len(expected) <= 1 {
		return &publicationError{
			publicationNotCommitted,
			"inspect staging tree",
			errors.New("refusing to publish an empty staging directory"),
		}
	}
	parent := filepath.Dir(destination)
	destinationExisted := false
	if _, statErr := os.Lstat(destination); statErr == nil {
		destinationExisted = true
		actual, _, inspectErr := inspectPublicationTree(destination)
		if inspectErr != nil || !equalPublicationTrees(actual, expected) {
			return &publicationError{
				publicationNotCommitted,
				"conflicts with an existing destination",
				errors.Join(
					fmt.Errorf("%w: %s", fs.ErrExist, destination),
					inspectErr,
				),
			}
		}
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return &publicationError{publicationNotCommitted, "inspect destination", statErr}
	}

	if !destinationExisted {
		if guard != nil {
			if guardErr := guard(); guardErr != nil {
				return &publicationError{
					publicationNotCommitted,
					"run pre-commit guard",
					guardErr,
				}
			}
		}
		if renameErr := ops.renameDirectory(stagingDir, destination); renameErr != nil {
			destinationInfo, destinationStatErr := os.Lstat(destination)
			if destinationStatErr != nil ||
				!destinationInfo.IsDir() ||
				!os.SameFile(stagingInfo, destinationInfo) {
				return &publicationError{
					publicationNotCommitted,
					"rename without replacement",
					renameErr,
				}
			}
		}
		destinationInfo, statErr := os.Lstat(destination)
		if statErr != nil ||
			!destinationInfo.IsDir() ||
			!os.SameFile(stagingInfo, destinationInfo) {
			if statErr == nil {
				statErr = errors.New("destination does not identify the renamed staging directory")
			}
			return &publicationError{
				publicationCommitted,
				"validate destination identity",
				statErr,
			}
		}
	}

	validateDestination := func() error {
		actual, _, err := inspectPublicationTree(destination)
		if err != nil {
			return err
		}
		if !equalPublicationTrees(actual, expected) {
			return errors.New("destination tree changed after publication")
		}
		return nil
	}
	if err := validateDestination(); err != nil {
		return &publicationError{publicationCommitted, "revalidate destination tree", err}
	}
	if destinationExisted {
		currentStagingInfo, err := os.Lstat(stagingDir)
		if err != nil {
			return &publicationError{publicationCommitted, "inspect recovered staging tree", err}
		}
		if !os.SameFile(stagingInfo, currentStagingInfo) {
			return &publicationError{
				publicationCommitted,
				"inspect recovered staging tree",
				errors.New("staging tree changed before cleanup"),
			}
		}
		if err := ops.removeAll(stagingDir); err != nil {
			return &publicationError{publicationCommitted, "remove exact retry staging tree", err}
		}
	}
	if err := syncPublicationDirectoryWithRecovery(
		parent,
		validateDestination,
		ops,
	); err != nil {
		return err
	}
	return nil
}

func syncPublicationDirectoryWithRecovery(
	parent string,
	validate func() error,
	ops publicationOps,
) error {
	if err := ops.syncDirectory(parent); err == nil {
		return nil
	} else {
		firstSyncErr := err
		if validationErr := validate(); validationErr != nil {
			return &publicationError{
				publicationCommitted,
				"recover after parent sync failure",
				errors.Join(firstSyncErr, validationErr),
			}
		}
		if retryErr := ops.syncDirectory(parent); retryErr != nil {
			return &publicationError{
				publicationCommitted,
				"retry parent directory sync",
				errors.Join(firstSyncErr, retryErr),
			}
		}
	}
	return nil
}
