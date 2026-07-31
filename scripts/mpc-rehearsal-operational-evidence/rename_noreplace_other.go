//go:build !linux

package main

import "os"

// Production release binaries are Linux-only. This fallback preserves local
// development portability but does not provide Linux renameat2 semantics.
func renameCompletedDirectoryNoReplace(source, destination string) error {
	return os.Rename(source, destination)
}
