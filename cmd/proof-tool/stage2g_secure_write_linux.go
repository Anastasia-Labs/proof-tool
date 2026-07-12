//go:build linux

package main

import (
	"errors"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// writeStage2gMaterialExclusive creates every output-directory component and
// the final material file relative to already-open directory descriptors. This
// prevents a concurrent local process from swapping a checked parent directory
// for a symlink between validation and the final write.
func writeStage2gMaterialExclusive(outPath string, contents []byte) error {
	if filepath.IsAbs(outPath) {
		return errors.New("Stage 2g material output must stay under the working directory")
	}
	relative := filepath.Clean(outPath)
	if relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("Stage 2g material output must stay under the working directory")
	}
	components := make([]string, 0, len(strings.Split(relative, string(filepath.Separator))))
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		if component == ".." {
			return errors.New("Stage 2g material output path is unsafe")
		}
		components = append(components, component)
	}
	if len(components) == 0 {
		return errors.New("Stage 2g material output path is unsafe")
	}

	directoryFD, err := unix.Open(".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return errors.New("open Stage 2g material working directory")
	}
	defer func() { _ = unix.Close(directoryFD) }()

	for _, component := range components[:len(components)-1] {
		if err := unix.Mkdirat(directoryFD, component, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
			return errors.New("create secure Stage 2g material directory")
		}
		nextDirectoryFD, err := unix.Openat(directoryFD, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return errors.New("open secure Stage 2g material directory")
		}
		if err := unix.Close(directoryFD); err != nil {
			_ = unix.Close(nextDirectoryFD)
			return errors.New("close Stage 2g material directory")
		}
		directoryFD = nextDirectoryFD
	}

	fileFD, err := unix.Openat(
		directoryFD,
		components[len(components)-1],
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0o600,
	)
	if err != nil {
		if errors.Is(err, unix.EEXIST) {
			return errors.New("refuse to overwrite Stage 2g material output")
		}
		return errors.New("create secure Stage 2g material output")
	}
	defer func() { _ = unix.Close(fileFD) }()
	for len(contents) > 0 {
		written, err := unix.Write(fileFD, contents)
		if err != nil {
			return errors.New("write Stage 2g material")
		}
		if written <= 0 {
			return errors.New("write Stage 2g material")
		}
		contents = contents[written:]
	}
	if err := unix.Fsync(fileFD); err != nil {
		return errors.New("sync Stage 2g material")
	}
	if err := unix.Close(fileFD); err != nil {
		return errors.New("close Stage 2g material output")
	}
	fileFD = -1
	return nil
}
