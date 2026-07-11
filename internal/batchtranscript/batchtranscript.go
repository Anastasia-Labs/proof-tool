// Package batchtranscript implements the versioned, statement-bound reclaim
// batch transcript. It accepts only the bytes already committed by the V2
// redeemer; statement authentication remains the validator's responsibility.
package batchtranscript

import (
	"fmt"
	"math/big"

	"github.com/consensys/gnark-crypto/ecc"
	"golang.org/x/crypto/blake2b"
)

const (
	DomainV2  = "ROOT-OWNERSHIP-POK-BATCH-v2"
	VKHashLen = 32
	ProofLen  = 336
	DigestLen = 32
	MaxSlots  = 65535
)

// VKHash returns the canonical BLAKE2b-256 digest of a serialized Cardano
// verifier key. Callers must compare it to their pinned manifest value before
// using it to finalize a script or construct a transaction.
func VKHash(verifierKey []byte) [VKHashLen]byte {
	return blake2b.Sum256(verifierKey)
}

// BuildV2 emits exactly domain_v2 || vk_hash || count_u16_be(n) ||
// concat(proof_i || public_input_digest_i). It rejects every ambiguous slot
// shape before emitting transcript bytes.
func BuildV2(vkHash []byte, proofs, publicInputDigests [][]byte) ([]byte, error) {
	if len(vkHash) != VKHashLen {
		return nil, fmt.Errorf("verifier key hash is %d bytes, want %d", len(vkHash), VKHashLen)
	}
	if len(proofs) != len(publicInputDigests) {
		return nil, fmt.Errorf("proof/digest list lengths differ: %d proofs, %d digests", len(proofs), len(publicInputDigests))
	}
	if len(proofs) > MaxSlots {
		return nil, fmt.Errorf("batch has %d slots, maximum is %d", len(proofs), MaxSlots)
	}

	capacity := len(DomainV2) + VKHashLen + 2 + len(proofs)*(ProofLen+DigestLen)
	transcript := make([]byte, 0, capacity)
	transcript = append(transcript, DomainV2...)
	transcript = append(transcript, vkHash...)
	transcript = append(transcript, byte(len(proofs)>>8), byte(len(proofs)))
	for i := range proofs {
		if len(proofs[i]) != ProofLen {
			return nil, fmt.Errorf("proof %d is %d bytes, want %d", i, len(proofs[i]), ProofLen)
		}
		if len(publicInputDigests[i]) != DigestLen {
			return nil, fmt.Errorf("public input digest %d is %d bytes, want %d", i, len(publicInputDigests[i]), DigestLen)
		}
		transcript = append(transcript, proofs[i]...)
		transcript = append(transcript, publicInputDigests[i]...)
	}
	return transcript, nil
}

// ChallengeV2 applies the existing nonzero scalar reduction to a complete V2
// transcript. It deliberately does not frame or append any caller input.
func ChallengeV2(transcript []byte) *big.Int {
	return challenge(transcript)
}

// MergeChallengeV2 derives the optional suffix-separated second challenge
// from the very same complete V2 transcript.
func MergeChallengeV2(transcript []byte) *big.Int {
	withSuffix := make([]byte, 0, len(transcript)+1)
	withSuffix = append(withSuffix, transcript...)
	withSuffix = append(withSuffix, 0x01)
	return challenge(withSuffix)
}

func challenge(input []byte) *big.Int {
	digest := blake2b.Sum256(input)
	order := ecc.BLS12_381.ScalarField()
	upper := new(big.Int).Sub(order, big.NewInt(1))
	result := new(big.Int).SetBytes(digest[:])
	result.Mod(result, upper)
	return result.Add(result, big.NewInt(1))
}
