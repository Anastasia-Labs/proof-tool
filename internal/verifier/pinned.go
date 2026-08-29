package verifier

import (
	"context"
	"errors"
	"math/big"

	"github.com/consensys/gnark/backend/groth16"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/prover"
)

// PinnedVKHash records the retired ownership-v1 verifier identity for audit
// logs. LoadPinnedVerifier deliberately refuses to construct a verifier for
// it because its circuit was compiled with a gnark version affected by
// GHSA-3mvx-pp85-pm65.
const PinnedVKHash = "blake2b256:e896ad2b9bceac9abe80de7a4ec91a9e41a55582b9b58fe3797bc203662b7c03"

type PinnedVerifier struct {
	vk groth16.VerifyingKey
}

func LoadPinnedVerifier() (*PinnedVerifier, error) {
	return nil, errors.New("pinned ownership-v1 verifier retired: it was compiled with a gnark version affected by GHSA-3mvx-pp85-pm65")
}

func (v *PinnedVerifier) VKHash() string {
	return PinnedVKHash
}

func (v *PinnedVerifier) VerifyProof(_ context.Context, proof groth16.Proof, publicInput *big.Int) error {
	return prover.VerifyProof(v.vk, proof, &ownership.Circuit{Pub: publicInput})
}
