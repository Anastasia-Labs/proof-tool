package verifier

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/consensys/gnark/backend/groth16"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/prover"
)

type ProofVerifier interface {
	VKHash() string
	VerifyProof(ctx context.Context, proof groth16.Proof, publicInput *big.Int) error
}

type EncodedProofVerifier interface {
	VerifyEncodedProof(ctx context.Context, encodedProof string, publicInput *big.Int) error
}

type BundleVerifier struct {
	bundle *prover.OwnershipBundle
}

func LoadBundleVerifier(keysDir string) (*BundleVerifier, error) {
	bundle, err := prover.LoadOwnershipVerifier(keysDir)
	if err != nil {
		return nil, err
	}
	return &BundleVerifier{bundle: bundle}, nil
}

func (v *BundleVerifier) VKHash() string {
	return v.bundle.Manifest.VKHash
}

func (v *BundleVerifier) VerifyProof(_ context.Context, proof groth16.Proof, publicInput *big.Int) error {
	return prover.VerifyProof(v.bundle.VerifyingKey, proof, &ownership.Circuit{Pub: publicInput})
}

type VerifyRequest struct {
	Artifact                 artifact.ProofArtifact `json:"artifact"`
	ExpectedTargetCredential string                 `json:"expected_target_credential,omitempty"`
}

type VerifyResponse struct {
	Verified         bool   `json:"verified"`
	Reason           string `json:"reason,omitempty"`
	CircuitID        string `json:"circuit_id"`
	VKHash           string `json:"vk_hash"`
	TargetCredential string `json:"target_credential,omitempty"`
	PublicInput      string `json:"public_input,omitempty"`
}

func VerifyArtifact(ctx context.Context, req VerifyRequest, proofVerifier ProofVerifier) VerifyResponse {
	if proofVerifier == nil {
		return failed("verifier is not configured")
	}

	proofArtifact := artifact.BackendProofArtifact(req.Artifact)
	if proofArtifact.Schema != artifact.ProofSchema {
		return failed(fmt.Sprintf("artifact schema %q is not supported", proofArtifact.Schema))
	}
	if proofArtifact.CircuitID != ownership.CircuitID {
		return failed(fmt.Sprintf("artifact circuit id %q is not supported", proofArtifact.CircuitID))
	}

	target, err := ownership.DecodeCredentialHex(proofArtifact.TargetCredential)
	if err != nil {
		return failed(err.Error())
	}
	targetHex := hex.EncodeToString(target)
	if strings.TrimSpace(req.ExpectedTargetCredential) != "" {
		expected, err := ownership.DecodeCredentialHex(req.ExpectedTargetCredential)
		if err != nil {
			return failed("expected target credential is invalid")
		}
		if subtle.ConstantTimeCompare(target, expected) != 1 {
			return failedWithPublic("artifact target credential does not match expected target credential", proofVerifier.VKHash(), targetHex, "")
		}
	}

	publicInput, err := ownership.PublicInputForCredential(target)
	if err != nil {
		return failed(err.Error())
	}
	publicInputHex := ownership.PublicInputHex(publicInput)
	if proofArtifact.PublicInput != publicInputHex {
		return failedWithPublic("artifact public input does not match recomputed target credential", proofVerifier.VKHash(), targetHex, publicInputHex)
	}
	if proofArtifact.VKHash != proofVerifier.VKHash() {
		return failedWithPublic("artifact verifying key hash does not match pinned verifier key", proofVerifier.VKHash(), targetHex, publicInputHex)
	}

	if encodedVerifier, ok := proofVerifier.(EncodedProofVerifier); ok {
		if err := encodedVerifier.VerifyEncodedProof(ctx, proofArtifact.Proof, publicInput); err != nil {
			return failedWithPublic("proof did not verify", proofVerifier.VKHash(), targetHex, publicInputHex)
		}
		return VerifyResponse{
			Verified:         true,
			CircuitID:        ownership.CircuitID,
			VKHash:           proofVerifier.VKHash(),
			TargetCredential: targetHex,
			PublicInput:      publicInputHex,
		}
	}

	proof, err := prover.UnmarshalProof(proofArtifact.Proof)
	if err != nil {
		return failedWithPublic("artifact proof is malformed", proofVerifier.VKHash(), targetHex, publicInputHex)
	}
	if err := proofVerifier.VerifyProof(ctx, proof, publicInput); err != nil {
		return failedWithPublic("proof did not verify", proofVerifier.VKHash(), targetHex, publicInputHex)
	}

	return VerifyResponse{
		Verified:         true,
		CircuitID:        ownership.CircuitID,
		VKHash:           proofVerifier.VKHash(),
		TargetCredential: targetHex,
		PublicInput:      publicInputHex,
	}
}

func failed(reason string) VerifyResponse {
	return VerifyResponse{
		Verified:  false,
		Reason:    reason,
		CircuitID: ownership.CircuitID,
	}
}

func failedWithPublic(reason, vkHash, targetCredential, publicInput string) VerifyResponse {
	return VerifyResponse{
		Verified:         false,
		Reason:           reason,
		CircuitID:        ownership.CircuitID,
		VKHash:           vkHash,
		TargetCredential: targetCredential,
		PublicInput:      publicInput,
	}
}
