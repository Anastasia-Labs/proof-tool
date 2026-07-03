package hash

import (
	"github.com/consensys/gnark/std/math/uints"
)

// MerkleHash is the node hash used by the recovery circuit's Merkle tree and public-input
// binding. Behind this interface so Poseidon2 (BLS12-381) can replace Blake2b-256 later to
// drop the circuit from K=23 to K=22 without changing the Merkle/binding logic.
type MerkleHash interface {
	Hash(uapi *uints.BinaryField[uints.U64], in []uints.U8) [32]uints.U8
}

// Blake2b256 implements MerkleHash via the generalized Blake2b gadget (32-byte output).
type Blake2b256 struct{}

func (Blake2b256) Hash(uapi *uints.BinaryField[uints.U64], in []uints.U8) [32]uints.U8 {
	out := Blake2b(uapi, in, 32) // []uints.U8 length 32
	var r [32]uints.U8
	copy(r[:], out)
	return r
}
