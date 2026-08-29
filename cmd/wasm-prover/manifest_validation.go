package main

import (
	"fmt"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
)

func validateDestinationManifest(manifest *artifact.KeyManifest) error {
	if manifest == nil {
		return fmt.Errorf("manifest is required")
	}
	if manifest.Schema != artifact.ManifestSchema {
		return fmt.Errorf("manifest schema %q, want %q", manifest.Schema, artifact.ManifestSchema)
	}
	if manifest.KeyVersion != prover.DefaultDestinationKeyVersion {
		return fmt.Errorf("manifest key version %q, want %q", manifest.KeyVersion, prover.DefaultDestinationKeyVersion)
	}
	if manifest.CircuitID != ownershipdest.CircuitID {
		return fmt.Errorf("manifest circuit id %q, want %q", manifest.CircuitID, ownershipdest.CircuitID)
	}
	if manifest.GnarkVersion != prover.GnarkVersion {
		return fmt.Errorf("manifest gnark version %q, want %q", manifest.GnarkVersion, prover.GnarkVersion)
	}
	if manifest.Curve != "BLS12-381" {
		return fmt.Errorf("manifest curve %q, want BLS12-381", manifest.Curve)
	}
	if manifest.Backend != "groth16" {
		return fmt.Errorf("manifest backend %q, want groth16", manifest.Backend)
	}
	if manifest.VKHash == "" {
		return fmt.Errorf("manifest vk_hash is required")
	}
	return nil
}
