package prover

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/consensys/gnark/frontend"

	"proof-tool/internal/artifact"
)

// tinyCircuit stands in for the destination circuit: the loader only checks
// the manifest digest pin and deserializes, so any valid serialized constraint
// system exercises it.
type tinyCircuit struct {
	X frontend.Variable
	Y frontend.Variable `gnark:",public"`
}

func (c *tinyCircuit) Define(api frontend.API) error {
	api.AssertIsEqual(api.Mul(c.X, c.X), c.Y)
	return nil
}

func writeTinyCCS(t *testing.T, dir string) string {
	t.Helper()
	ccs, err := Compile(&tinyCircuit{})
	if err != nil {
		t.Fatalf("compile tiny circuit: %v", err)
	}
	path := filepath.Join(dir, DestinationConstraintSystemFile)
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create ccs file: %v", err)
	}
	defer f.Close()
	if _, err := ccs.WriteTo(f); err != nil {
		t.Fatalf("serialize ccs: %v", err)
	}
	return path
}

func TestLoadOwnershipDestinationCCSVerifiesManifestPin(t *testing.T) {
	dir := t.TempDir()
	path := writeTinyCCS(t, dir)
	digest, err := DigestFile(path)
	if err != nil {
		t.Fatalf("digest ccs: %v", err)
	}

	ccs, err := LoadOwnershipDestinationCCS(dir, &artifact.KeyManifest{ConstraintSystemHash: digest.Blake2b256})
	if err != nil {
		t.Fatalf("load with matching pin: %v", err)
	}
	if ccs.GetNbConstraints() == 0 {
		t.Fatal("loaded constraint system is empty")
	}
}

func TestLoadOwnershipDestinationCCSRejectsMismatchedPin(t *testing.T) {
	dir := t.TempDir()
	writeTinyCCS(t, dir)
	_, err := LoadOwnershipDestinationCCS(dir, &artifact.KeyManifest{ConstraintSystemHash: "blake2b256:" + "00"})
	if err == nil {
		t.Fatal("mismatched constraint_system_hash unexpectedly accepted")
	}
}

func TestLoadOwnershipDestinationCCSRejectsUnpinnedFile(t *testing.T) {
	dir := t.TempDir()
	writeTinyCCS(t, dir)
	_, err := LoadOwnershipDestinationCCS(dir, &artifact.KeyManifest{})
	if err == nil {
		t.Fatal("unpinned ownership-destination.ccs unexpectedly accepted")
	}
	if errors.Is(err, fs.ErrNotExist) {
		t.Fatal("unpinned present file must not report fs.ErrNotExist (callers would fall back to compile)")
	}
}

func TestLoadOwnershipDestinationCCSMissingFileReportsNotExist(t *testing.T) {
	_, err := LoadOwnershipDestinationCCS(t.TempDir(), &artifact.KeyManifest{ConstraintSystemHash: "blake2b256:aa"})
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing file err = %v, want fs.ErrNotExist for compile fallback", err)
	}
}
