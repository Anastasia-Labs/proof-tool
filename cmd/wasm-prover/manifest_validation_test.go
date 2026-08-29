package main

import (
	"strings"
	"testing"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
)

func TestValidateDestinationManifestRejectsStaleGnark(t *testing.T) {
	manifest := &artifact.KeyManifest{
		Schema:       artifact.ManifestSchema,
		KeyVersion:   prover.DefaultDestinationKeyVersion,
		CircuitID:    ownershipdest.CircuitID,
		GnarkVersion: prover.GnarkVersion,
		Curve:        "BLS12-381",
		Backend:      "groth16",
		VKHash:       "blake2b256:" + strings.Repeat("11", 32),
	}
	if err := validateDestinationManifest(manifest); err != nil {
		t.Fatalf("fixed manifest failed validation: %v", err)
	}

	manifest.GnarkVersion = "v0.15.0"
	if err := validateDestinationManifest(manifest); err == nil || !strings.Contains(err.Error(), "gnark version") {
		t.Fatalf("stale gnark version was not rejected: %v", err)
	}
}
