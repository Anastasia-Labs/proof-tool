// Package keyprofile defines the proof-circuit profiles accepted by key
// ceremony and bundle tooling.
package keyprofile

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/consensys/gnark/constraint"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
)

// Profile binds a key version to the exact circuit identity and the prover
// operations used to compile and inspect its native gnark key bundle.
type Profile struct {
	KeyVersion     string
	CircuitID      string
	Label          string
	DefaultKeysDir string
	Compile        func() (constraint.ConstraintSystem, error)
	Inspect        func(string, bool) prover.BundleStatus
	LoadVerifier   func(string) (*prover.OwnershipBundle, error)
}

// ForBundle resolves the profile explicitly when keyVersion is supplied, or
// from the bundle's manifest when it is omitted.
func ForBundle(keysDir, keyVersion string) (Profile, error) {
	if strings.TrimSpace(keyVersion) != "" {
		return ForKeyVersion(keyVersion)
	}
	manifest, err := artifact.ReadKeyManifest(filepath.Join(keysDir, "manifest.json"))
	if err != nil {
		return Profile{}, err
	}
	return ForKeyVersion(manifest.KeyVersion)
}

// ForKeyVersion returns the circuit profile for a supported production key
// identity. Legacy destination key versions are deliberately rejected.
func ForKeyVersion(keyVersion string) (Profile, error) {
	switch strings.TrimSpace(keyVersion) {
	case prover.DefaultKeyVersion:
		return Profile{
			KeyVersion:     prover.DefaultKeyVersion,
			CircuitID:      ownership.CircuitID,
			Label:          "ownership",
			DefaultKeysDir: prover.DefaultKeyDir(),
			Compile:        prover.CompileOwnership,
			Inspect:        prover.InspectOwnershipBundle,
			LoadVerifier:   prover.LoadOwnershipVerifier,
		}, nil
	case prover.DefaultDestinationKeyVersion:
		return Profile{
			KeyVersion:     prover.DefaultDestinationKeyVersion,
			CircuitID:      ownershipdest.CircuitID,
			Label:          "ownership destination",
			DefaultKeysDir: prover.DefaultDestinationKeyDir(),
			Compile:        prover.CompileOwnershipDestination,
			Inspect:        prover.InspectOwnershipDestinationBundle,
			LoadVerifier:   prover.LoadOwnershipDestinationVerifier,
		}, nil
	default:
		return Profile{}, fmt.Errorf(
			"unsupported key version %q; expected %q or %q",
			keyVersion,
			prover.DefaultKeyVersion,
			prover.DefaultDestinationKeyVersion,
		)
	}
}
