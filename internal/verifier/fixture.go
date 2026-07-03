package verifier

import (
	"context"
	"errors"
	"math/big"

	"github.com/consensys/gnark/backend/groth16"
)

const FixtureVKHash = "blake2b256:fixture-verifier"

type FixtureVerifier struct{}

func (FixtureVerifier) VKHash() string {
	return FixtureVKHash
}

func (FixtureVerifier) VerifyProof(context.Context, groth16.Proof, *big.Int) error {
	return errors.New("fixture verifier requires encoded proof verification")
}

func (FixtureVerifier) VerifyEncodedProof(_ context.Context, encodedProof string, _ *big.Int) error {
	if encodedProof != "fixture-proof" {
		return errors.New("fixture proof mismatch")
	}
	return nil
}
