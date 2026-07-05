package helper

import (
	"context"
	"encoding/hex"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
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

func (FixtureGenerator) GenerateDestinationProofs(_ context.Context, input ProveDestinationInput) ([]DestinationProofArtifactItem, error) {
	results := make([]DestinationProofArtifactItem, 0, len(input.Requests))
	for _, request := range input.Requests {
		publicInput, err := ownershipdest.PublicInputForCredentialDestination(request.TargetCredential, request.DestinationAddress)
		if err != nil {
			return nil, err
		}
		publicInputDigest, err := ownershipdest.PublicInputDigestForCredentialDestination(request.TargetCredential, request.DestinationAddress)
		if err != nil {
			return nil, err
		}
		results = append(results, DestinationProofArtifactItem{
			OutRef: request.OutRef,
			Artifact: artifact.ProofArtifact{
				Schema:                     artifact.ProofSchema,
				CircuitID:                  ownershipdest.CircuitID,
				VKHash:                     verifier.FixtureVKHash,
				TargetCredential:           hex.EncodeToString(request.TargetCredential),
				DestinationAddressEncoding: ownershipdest.DestinationAddressEncoding,
				DestinationAddress:         hex.EncodeToString(request.DestinationAddress),
				PublicInputEncoding:        ownershipdest.PublicInputEncoding,
				PublicInput:                ownershipdest.PublicInputHex(publicInput),
				Proof:                      "fixture-destination-proof",
				Cardano: &artifact.CardanoProof{
					Format:               "fixture",
					ProofHex:             hex.EncodeToString([]byte("fixture-destination-proof")),
					PublicInputDigestHex: hex.EncodeToString(publicInputDigest),
				},
				Path: &artifact.PathMetadata{Account: 0, Role: 0, Index: 0},
			},
		})
	}
	return results, nil
}

func (FixtureGenerator) DestinationKeyStatus() KeyStatus {
	return KeyStatus{
		State:      "fixture",
		Ready:      true,
		KeyVersion: "fixture-destination",
		VKHash:     verifier.FixtureVKHash,
	}
}
