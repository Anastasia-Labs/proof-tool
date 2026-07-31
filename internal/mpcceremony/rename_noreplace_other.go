//go:build !linux

package mpcceremony

import "os"

// Production release binaries are Linux-only. This fallback preserves local
// development portability but cannot provide Linux renameat2 no-replace
// semantics against a hostile concurrent creator of an empty destination.
func renameDirectoryNoReplace(source, destination string) error {
	return os.Rename(source, destination)
}
