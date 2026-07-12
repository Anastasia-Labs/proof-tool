// Package u64util contains repo-local helpers for gnark uints.U64 words.
package u64util

import "github.com/consensys/gnark/std/math/uints"

// RotBytes rotates a 64-bit word left by a byte-aligned shift. It is a free
// circuit operation: the result contains the exact same constrained U8
// variables as word, only at permuted indexes. It must not call ValueOf or
// otherwise range-check those variables again.
func RotBytes(word uints.U64, shift int) uints.U64 {
	if shift%8 != 0 {
		panic("u64util.RotBytes: shift is not byte-aligned")
	}

	byteShift := (shift / 8) % len(word)
	if byteShift < 0 {
		byteShift += len(word)
	}

	var rotated uints.U64
	for i := range word {
		rotated[(i+byteShift)%len(word)] = word[i]
	}
	return rotated
}
