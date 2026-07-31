// Command rename-directory-noreplace atomically publishes one Linux directory
// without ever replacing a concurrently created destination.
package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func main() {
	if len(os.Args) != 3 {
		fatal(errors.New("usage: rename-directory-noreplace SOURCE DESTINATION"))
	}
	source, destination := os.Args[1], os.Args[2]
	info, err := os.Lstat(source)
	if err != nil {
		fatal(err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		fatal(errors.New("source must be a real directory"))
	}
	if _, err := os.Lstat(destination); err == nil {
		fatal(fmt.Errorf("destination already exists: %w", fs.ErrExist))
	} else if !errors.Is(err, fs.ErrNotExist) {
		fatal(err)
	}
	if err := unix.Renameat2(
		unix.AT_FDCWD,
		source,
		unix.AT_FDCWD,
		destination,
		unix.RENAME_NOREPLACE,
	); err != nil {
		fatal(err)
	}
	parent, err := os.OpenFile(filepath.Dir(destination), os.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		fatal(err)
	}
	if err := parent.Sync(); err != nil {
		_ = parent.Close()
		fatal(err)
	}
	if err := parent.Close(); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
