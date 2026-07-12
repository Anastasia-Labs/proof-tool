//go:build !linux

package main

import "errors"

// Stage 2g is a Linux-only Preprod evaluator flow. Refuse to write rather
// than falling back to a pathname-based writer that reintroduces the symlink
// race closed by the Linux implementation.
func writeStage2gMaterialExclusive(_ string, _ []byte) error {
	return errors.New("secure Stage 2g material output requires Linux")
}
