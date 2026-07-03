package helper

import (
	"context"
	"encoding/hex"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/verifier"
)

type FixtureGenerator struct{}

func (FixtureGenerator) GenerateProof(_ context.Context, input ProveInput) (artifact.ProofArtifact, error) {
	publicInput, err := ownership.PublicInputForCredential(input.TargetCredential)
	if err != nil {
		return artifact.ProofArtifact{}, err
	}
	return artifact.ProofArtifact{
		Schema:           artifact.ProofSchema,
		CircuitID:        ownership.CircuitID,
		VKHash:           verifier.FixtureVKHash,
		TargetCredential: hex.EncodeToString(input.TargetCredential),
		PublicInput:      ownership.PublicInputHex(publicInput),
		Proof:            "fixture-proof",
		Path:             &artifact.PathMetadata{Account: 0, Role: 0, Index: 0},
	}, nil
}

func (FixtureGenerator) KeyStatus() KeyStatus {
	return KeyStatus{
		State:      "fixture",
		Ready:      true,
		KeyVersion: "fixture",
		VKHash:     verifier.FixtureVKHash,
	}
}
