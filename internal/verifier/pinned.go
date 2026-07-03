package verifier

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"math/big"

	"github.com/consensys/gnark/backend/groth16"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/prover"
)

const PinnedVKHash = "blake2b256:0bd2f0fd3e3f1f3a671ca9f5fa92be04771a19f5dab5d09bfdcfae8ca6ce9731"

const pinnedVKBase64 = "jy7XbB5zwUPpjDcdxicWGDAnRjXY1mTkRSP5rd2kJ1nOY7lS7YCQ/26qfOQwakA5rV1kvmWbCvDTM2NabY1Mpa42Spw4gB5FrEmBiLnPOPpUOXxQ17Mx+xxeR5lOuCvCjNSXIpSaElOsxkrBM/gNwl1Rc450Eern68stqUmqnxYZalHTJoSDct092StrJyEnAuut8GnkMXfVSOE+M+8w0YU/HW9Q9eEECE0N+QuyDudFrGImUHYfnxB1k58u5W8biEWKRZtaP0GUr5rUVMrJjWXt6h3iQZMXJ7KItBe+/5+uBGBe22cN1y42kQDKFrnbDngZI0H3O377jy5UEJBReRnNzFPOvSgIrQeUb8NXCLzo1Bh3GrXNuwftXHOg6lYcpRjmv/7T7Z96sv4Ht/jzdhDwj6FCeZx5eA7UxNoyWA+Wwor+pV9hpOMRIY/tiE4vr5yfC9CnXvJ1934pzBpX4xpqPt6d6hbRhrbYZIbBK4us3Vfg/K9w5QAA6YmqoqZzBuzIQ69PlpeAdsWPVrtVrG2jB0C+c4QIduglMi8OBMvmyWjslqBxDEdOWZRrYkFfAAAAA6wStiZ2yddTjrCA5irxz5qD9gKVaftkcKOrXvE/XsSqG4dSvd1JMgJXW3wTRTmeoaZGJP/UVlCLux1L0b2b6fU9YzG1qbNn4mTy3RWALy1xxp8kwH+ARls6PMNOuz+ZY5PUimbo+6ydrmzNb89Atih26zYhmvdbCWd88IW/9EIzZmMcu+7i3H+KAhADaRi+UwAAAAEAAAAAAAAAAblaG5xhTx1/8HBtPZBOgdUnJtBPJYftS6HKzCXhViwYhxrrFstX4Ar0aiYp2/jPYAD8YUJ81PBYE2GBmVs5VmClcy/NHmtvI0WM0KZNyOrlH19nmPYCUbJZrDbxPiubX7EWXmuOHM8P2qD1XwgJvaCJp4zuVhME2B8kYPa4iPqhwchhg5Gh5tY5ISaYIu9rlxYIQ7q0wy7fy6KUcEny9klZGtrrgmvz2rP7h01FTpEZ8F7PW5rCaSEcUC69Yw7CKQ=="

type PinnedVerifier struct {
	vk groth16.VerifyingKey
}

func LoadPinnedVerifier() (*PinnedVerifier, error) {
	raw, err := base64.StdEncoding.DecodeString(pinnedVKBase64)
	if err != nil {
		return nil, fmt.Errorf("decode pinned verifying key: %w", err)
	}
	hash := vkHash(raw)
	if hash != PinnedVKHash {
		return nil, fmt.Errorf("pinned verifying key hash %s, want %s", hash, PinnedVKHash)
	}
	vk, err := prover.ReadVK(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("read pinned verifying key: %w", err)
	}
	return &PinnedVerifier{vk: vk}, nil
}

func (v *PinnedVerifier) VKHash() string {
	return PinnedVKHash
}

func (v *PinnedVerifier) VerifyProof(_ context.Context, proof groth16.Proof, publicInput *big.Int) error {
	return prover.VerifyProof(v.vk, proof, &ownership.Circuit{Pub: publicInput})
}

func vkHash(raw []byte) string {
	h := blake2b.Sum256(raw)
	return "blake2b256:" + hex.EncodeToString(h[:])
}
