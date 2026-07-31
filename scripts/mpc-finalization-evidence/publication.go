package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// publishCompletedFile writes and syncs a same-parent temporary file before
// publishing it with a hard link. A complete exact destination is accepted so
// a retry can recover from termination after the link but before the caller
// received success. A different destination is never replaced.
func publishCompletedFile(destination string, data []byte, mode fs.FileMode) error {
	if destination == "" {
		return errors.New("publication destination is required")
	}
	parent := filepath.Dir(destination)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return fmt.Errorf("inspect publication parent: %w", err)
	}
	if !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("publication parent must be a real directory")
	}

	temporary, err := os.CreateTemp(parent, "."+filepath.Base(destination)+".partial-*")
	if err != nil {
		return fmt.Errorf("create publication staging file: %w", err)
	}
	temporaryPath := temporary.Name()
	keepTemporary := true
	defer func() {
		if keepTemporary {
			_ = temporary.Close()
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(mode); err != nil {
		return fmt.Errorf("set publication staging permissions: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		return fmt.Errorf("write publication staging file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync publication staging file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close publication staging file: %w", err)
	}

	exact, err := completedFileIsExact(destination, data, mode)
	if err != nil {
		return err
	}
	if !exact {
		if err := os.Link(temporaryPath, destination); err != nil {
			exact, inspectErr := completedFileIsExact(destination, data, mode)
			if inspectErr != nil {
				return errors.Join(
					fmt.Errorf("publish completed output without replacement: %w", err),
					inspectErr,
				)
			}
			if !exact {
				return fmt.Errorf("publish completed output without replacement: %w", err)
			}
		}
		exact, err = completedFileIsExact(destination, data, mode)
		if err != nil {
			return fmt.Errorf("validate published output: %w", err)
		}
		if !exact {
			return errors.New("published output differs from completed staging file")
		}
	}

	if err := os.Remove(temporaryPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove publication staging link: %w", err)
	}
	keepTemporary = false
	if err := syncOutputDirectory(parent); err != nil {
		return err
	}
	return nil
}

func completedFileIsExact(path string, expected []byte, mode fs.FileMode) (bool, error) {
	linkInfo, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect completed output: %w", err)
	}
	if !linkInfo.Mode().IsRegular() || linkInfo.Mode()&os.ModeSymlink != 0 {
		return false, fmt.Errorf("completed output conflicts with unsafe path: %w", fs.ErrExist)
	}
	if linkInfo.Mode().Perm() != mode.Perm() || linkInfo.Size() != int64(len(expected)) {
		return false, fmt.Errorf("completed output conflicts with different bytes or permissions: %w", fs.ErrExist)
	}
	file, err := os.Open(path)
	if err != nil {
		return false, fmt.Errorf("open completed output: %w", err)
	}
	defer file.Close()
	openInfo, err := file.Stat()
	if err != nil {
		return false, fmt.Errorf("inspect open completed output: %w", err)
	}
	if !openInfo.Mode().IsRegular() || !os.SameFile(linkInfo, openInfo) ||
		openInfo.Size() != int64(len(expected)) {
		return false, fmt.Errorf("completed output changed while being opened: %w", fs.ErrExist)
	}
	actual := make([]byte, len(expected))
	if _, err := io.ReadFull(file, actual); err != nil && len(expected) != 0 {
		return false, fmt.Errorf("read completed output: %w", err)
	}
	finalInfo, err := file.Stat()
	if err != nil {
		return false, fmt.Errorf("reinspect completed output: %w", err)
	}
	if !os.SameFile(openInfo, finalInfo) || finalInfo.Size() != openInfo.Size() ||
		!bytes.Equal(actual, expected) {
		return false, fmt.Errorf("completed output conflicts with different bytes: %w", fs.ErrExist)
	}
	return true, nil
}

func syncOutputDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open publication parent for sync: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync publication parent: %w", err)
	}
	return nil
}
