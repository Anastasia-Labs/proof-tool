// Package hash implements a generalized multi-block Blake2b circuit gadget for gnark.
// It operates on BinaryField[U64] over the BLS12-381 scalar field.
//
// The Blake2b core (IV table, sigma message schedule, and the G mixing function with
// rotations R1=32, R2=24, R3=16, R4=63) is reused from the audited scout gadget
// (e2circuit, proto/circuit/scout/blake2b/blake2b224.go), here generalized to:
//   - a compile-time-fixed but arbitrary input length (multi-block, last block padded),
//   - a parameterized output length (28 for Blake2b-224, 32 for Blake2b-256).
//
// Blake2b is little-endian throughout.
package hash

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"
	"github.com/consensys/gnark/std/rangecheck"

	csha "proof-tool/internal/circuit/sha512/sha"
	"proof-tool/internal/circuit/u64util"
)

// iv holds the Blake2b initialization vector (same as the SHA-512 IVs).
// Copied from the audited scout gadget.
var iv = [8]uint64{
	0x6a09e667f3bcc908, 0xbb67ae8584caa73b,
	0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
	0x510e527fade682d1, 0x9b05688c2b3e6c1f,
	0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
}

// sigma is the Blake2b message-permutation schedule (12 rounds x 16).
// Copied from the audited scout gadget.
var sigma = [12][16]int{
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
	{14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
	{11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
	{7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
	{9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
	{2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
	{12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
	{13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
	{6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
	{10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
	{14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
}

// Blake2b computes Blake2b-(8*outLen) of a COMPILE-TIME-fixed-length input. Reuses the
// Blake2b core (IV, sigma, G) from the audited scout gadget, generalized to multi-block
// input and a parameterized output length (28 or 32). Little-endian throughout.
func Blake2b(api frontend.API, uapi *uints.BinaryField[uints.U64], input []uints.U8, outLen int) []uints.U8 {
	rc := rangecheck.New(api)
	// Parameter block (sequential mode, no key): fanout=1, depth=1, key length=0,
	// digest length=outLen. h[0] ^= 0x01010000 ^ outLen.
	//   outLen=28 -> 0x0101001c, outLen=32 -> 0x01010020.
	const p0Base uint64 = 0x01010000
	h := [8]uints.U64{
		uapi.Xor(uints.NewU64(iv[0]), uints.NewU64(p0Base^uint64(outLen))),
		uints.NewU64(iv[1]),
		uints.NewU64(iv[2]),
		uints.NewU64(iv[3]),
		uints.NewU64(iv[4]),
		uints.NewU64(iv[5]),
		uints.NewU64(iv[6]),
		uints.NewU64(iv[7]),
	}

	inLen := len(input)
	// Number of 128-byte blocks; an empty input still hashes one padded block.
	nBlocks := (inLen + 127) / 128
	if nBlocks == 0 {
		nBlocks = 1
	}

	for mIdx := 0; mIdx < nBlocks; mIdx++ {
		// Extract 128 bytes for this block, zero-padding the tail.
		block := make([]uints.U8, 128)
		base := mIdx * 128
		for i := 0; i < 128; i++ {
			if base+i < inLen {
				block[i] = input[base+i]
			} else {
				block[i] = uints.NewU8(0)
			}
		}

		// Parse 16 little-endian U64 words.
		m := make([]uints.U64, 16)
		for i := 0; i < 16; i++ {
			m[i] = uapi.PackLSB(
				block[i*8+0], block[i*8+1], block[i*8+2], block[i*8+3],
				block[i*8+4], block[i*8+5], block[i*8+6], block[i*8+7],
			)
		}

		// Cumulative byte count processed through this block, and final-block flag.
		t := (mIdx + 1) * 128
		if t > inLen {
			t = inLen
		}
		last := mIdx == nBlocks-1

		h = compress(api, uapi, rc, h, m, uint64(t), last)
	}

	// Output: little-endian bytes of h, first outLen.
	out := make([]uints.U8, 0, 64)
	for i := 0; i < 8; i++ {
		out = append(out, uapi.UnpackLSB(h[i])...)
	}
	return out[:outLen]
}

// compress runs the standard Blake2b F compression on a single 128-byte message block
// (16 words m), with cumulative byte counter t (low 64 bits; the high word is always
// zero for the input sizes used here) and final-block flag last. Returns the updated h.
func compress(api frontend.API, uapi *uints.BinaryField[uints.U64], rc frontend.Rangechecker, h [8]uints.U64, m []uints.U64, t uint64, last bool) [8]uints.U64 {
	var v [16]uints.U64
	v[0], v[1], v[2], v[3] = h[0], h[1], h[2], h[3]
	v[4], v[5], v[6], v[7] = h[4], h[5], h[6], h[7]
	v[8] = uints.NewU64(iv[0])
	v[9] = uints.NewU64(iv[1])
	v[10] = uints.NewU64(iv[2])
	v[11] = uints.NewU64(iv[3])
	// t0 = low 64 bits of byte counter, t1 = 0 (no overflow for our sizes).
	v[12] = uapi.Xor(uints.NewU64(iv[4]), uints.NewU64(t))
	v[13] = uints.NewU64(iv[5])
	// f0 = all-ones on the final block, else 0; f1 = 0 (sequential mode).
	if last {
		v[14] = uapi.Xor(uints.NewU64(iv[6]), uints.NewU64(0xffffffffffffffff))
	} else {
		v[14] = uints.NewU64(iv[6])
	}
	v[15] = uints.NewU64(iv[7])

	for r := 0; r < 12; r++ {
		s := sigma[r]
		v = gRound(api, uapi, rc, v, m, s[0], s[1], 0, 4, 8, 12)
		v = gRound(api, uapi, rc, v, m, s[2], s[3], 1, 5, 9, 13)
		v = gRound(api, uapi, rc, v, m, s[4], s[5], 2, 6, 10, 14)
		v = gRound(api, uapi, rc, v, m, s[6], s[7], 3, 7, 11, 15)
		v = gRound(api, uapi, rc, v, m, s[8], s[9], 0, 5, 10, 15)
		v = gRound(api, uapi, rc, v, m, s[10], s[11], 1, 6, 11, 12)
		v = gRound(api, uapi, rc, v, m, s[12], s[13], 2, 7, 8, 13)
		v = gRound(api, uapi, rc, v, m, s[14], s[15], 3, 4, 9, 14)
	}

	for i := 0; i < 8; i++ {
		h[i] = uapi.Xor(h[i], v[i], v[i+8])
	}
	return h
}

// gRound applies one G function step on the work vector.
// Rotations: R1=32, R2=24, R3=16, R4=63 (right-rotations expressed as left-rotations).
// Copied from the audited scout gadget.
func gRound(api frontend.API, uapi *uints.BinaryField[uints.U64], rc frontend.Rangechecker, v [16]uints.U64, m []uints.U64, mx, my, a, b, c, d int) [16]uints.U64 {
	// a = a + b + m[mx]
	// Three U64 terms have carry hi <= 2, requiring 2 high bits.
	v[a] = csha.Add64(api, uapi, rc, 2, v[a], v[b], m[mx])
	// d = rotr(d XOR a, 32) = Lrot(d XOR a, 64-32=32)
	v[d] = u64util.RotBytes(uapi.Xor(v[d], v[a]), 32)
	// c = c + d
	// Two U64 terms have carry hi <= 1, requiring 1 high bit.
	v[c] = csha.Add64(api, uapi, rc, 1, v[c], v[d])
	// b = rotr(b XOR c, 24) = Lrot(b XOR c, 64-24=40)
	v[b] = u64util.RotBytes(uapi.Xor(v[b], v[c]), 40)
	// a = a + b + m[my]
	// Three U64 terms again have carry hi <= 2 (2 high bits).
	v[a] = csha.Add64(api, uapi, rc, 2, v[a], v[b], m[my])
	// d = rotr(d XOR a, 16) = Lrot(d XOR a, 64-16=48)
	v[d] = u64util.RotBytes(uapi.Xor(v[d], v[a]), 48)
	// c = c + d
	// Two U64 terms again have carry hi <= 1 (1 high bit).
	v[c] = csha.Add64(api, uapi, rc, 1, v[c], v[d])
	// b = rotr(b XOR c, 63) = Lrot(b XOR c, 64-63=1)
	v[b] = uapi.Lrot(uapi.Xor(v[b], v[c]), 1)
	return v
}
