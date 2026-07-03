// Package sha implements SHA-512 and HMAC-SHA512 circuit gadgets for gnark
// over BLS12-381. These are the hashing core of the BIP32-Ed25519 child key
// derivation (CKD) chain: each derivation level computes two HMAC-SHA512
// values (the scalar contribution Z and the child chain code), keyed on the
// parent chain code (a witness).
//
// Implementation approach: built on gnark's std/math/uints BinaryField[U64],
// which provides 64-bit word operations (Add mod 2^64, And, Or, Xor, Not,
// Lrot, Rshift) backed by byte-level lookup tables. This mirrors the structure
// of gnark's std/permutation/sha2 (SHA-256, 32-bit) ported to 64-bit words,
// 80 rounds, and the SHA-512 constants. Message parsing is big-endian
// (PackMSB); the digest is emitted big-endian (UnpackMSB).
//
// Note on Lrot: gnark's Lrot rotates left for positive shift counts and right
// for negative ones, so ROTR(x, n) is expressed as uapi.Lrot(x, -n).
package sha

import (
	"github.com/consensys/gnark/std/math/uints"
)

// _K512 are the 80 SHA-512 round constants (first 64 bits of the fractional
// parts of the cube roots of the first 80 primes), FIPS 180-4 sec 4.2.3.
var _K512 = uints.NewU64Array([]uint64{
	0x428a2f98d728ae22, 0x7137449123ef65cd, 0xb5c0fbcfec4d3b2f, 0xe9b5dba58189dbbc,
	0x3956c25bf348b538, 0x59f111f1b605d019, 0x923f82a4af194f9b, 0xab1c5ed5da6d8118,
	0xd807aa98a3030242, 0x12835b0145706fbe, 0x243185be4ee4b28c, 0x550c7dc3d5ffb4e2,
	0x72be5d74f27b896f, 0x80deb1fe3b1696b1, 0x9bdc06a725c71235, 0xc19bf174cf692694,
	0xe49b69c19ef14ad2, 0xefbe4786384f25e3, 0x0fc19dc68b8cd5b5, 0x240ca1cc77ac9c65,
	0x2de92c6f592b0275, 0x4a7484aa6ea6e483, 0x5cb0a9dcbd41fbd4, 0x76f988da831153b5,
	0x983e5152ee66dfab, 0xa831c66d2db43210, 0xb00327c898fb213f, 0xbf597fc7beef0ee4,
	0xc6e00bf33da88fc2, 0xd5a79147930aa725, 0x06ca6351e003826f, 0x142929670a0e6e70,
	0x27b70a8546d22ffc, 0x2e1b21385c26c926, 0x4d2c6dfc5ac42aed, 0x53380d139d95b3df,
	0x650a73548baf63de, 0x766a0abb3c77b2a8, 0x81c2c92e47edaee6, 0x92722c851482353b,
	0xa2bfe8a14cf10364, 0xa81a664bbc423001, 0xc24b8b70d0f89791, 0xc76c51a30654be30,
	0xd192e819d6ef5218, 0xd69906245565a910, 0xf40e35855771202a, 0x106aa07032bbd1b8,
	0x19a4c116b8d2d0c8, 0x1e376c085141ab53, 0x2748774cdf8eeb99, 0x34b0bcb5e19b48a8,
	0x391c0cb3c5c95a63, 0x4ed8aa4ae3418acb, 0x5b9cca4f7763e373, 0x682e6ff3d6b2b8a3,
	0x748f82ee5defb2fc, 0x78a5636f43172f60, 0x84c87814a1f0ab72, 0x8cc702081a6439ec,
	0x90befffa23631e28, 0xa4506cebde82bde9, 0xbef9a3f7b2c67915, 0xc67178f2e372532b,
	0xca273eceea26619c, 0xd186b8c721c0c207, 0xeada7dd6cde0eb1e, 0xf57d4f7fee6ed178,
	0x06f067aa72176fba, 0x0a637dc5a2c898a6, 0x113f9804bef90dae, 0x1b710b35131c471b,
	0x28db77f523047d84, 0x32caab7b40c72493, 0x3c9ebe0a15c9bebc, 0x431d67c49c100d4c,
	0x4cc5d4becb3e42b6, 0x597f299cfc657e2a, 0x5fcb6fab3ad6faec, 0x6c44198c4a475817,
})

// _seed512 are the SHA-512 initial hash values (first 64 bits of the
// fractional parts of the square roots of the first 8 primes), FIPS 180-4
// sec 5.3.5.
var _seed512 = []uint64{
	0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
	0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
}

// blockSize512 is the SHA-512 block size in bytes (1024 bits).
const blockSize512 = 128

// Permute512 applies the SHA-512 compression function to one 128-byte block,
// updating the running hash. Mirrors std/permutation/sha2.Permute but with
// 64-bit words, 80 rounds, the SHA-512 sigma rotations, and _K512.
func Permute512(uapi *uints.BinaryField[uints.U64], currentHash [8]uints.U64, p [128]uints.U8) [8]uints.U64 {
	var w [80]uints.U64

	// Big-endian message schedule: 16 words from the block.
	for i := 0; i < 16; i++ {
		w[i] = uapi.PackMSB(p[8*i], p[8*i+1], p[8*i+2], p[8*i+3], p[8*i+4], p[8*i+5], p[8*i+6], p[8*i+7])
	}

	// Extend to 80 words.
	for i := 16; i < 80; i++ {
		v1 := w[i-2]
		// small sigma1(x) = ROTR(x,19) ^ ROTR(x,61) ^ SHR(x,6)
		s1 := uapi.Xor(
			uapi.Lrot(v1, -19),
			uapi.Lrot(v1, -61),
			uapi.Rshift(v1, 6),
		)
		v2 := w[i-15]
		// small sigma0(x) = ROTR(x,1) ^ ROTR(x,8) ^ SHR(x,7)
		s0 := uapi.Xor(
			uapi.Lrot(v2, -1),
			uapi.Lrot(v2, -8),
			uapi.Rshift(v2, 7),
		)
		w[i] = uapi.Add(s1, w[i-7], s0, w[i-16])
	}

	ih0, ih1, ih2, ih3 := currentHash[0], currentHash[1], currentHash[2], currentHash[3]
	ih4, ih5, ih6, ih7 := currentHash[4], currentHash[5], currentHash[6], currentHash[7]
	a, b, c, d, e, f, g, h := ih0, ih1, ih2, ih3, ih4, ih5, ih6, ih7

	for i := 0; i < 80; i++ {
		// big sigma1(e) = ROTR(e,14) ^ ROTR(e,18) ^ ROTR(e,41)
		// Ch(e,f,g) = (e AND f) ^ (NOT e AND g)
		t1 := uapi.Add(
			h,
			uapi.Xor(
				uapi.Lrot(e, -14),
				uapi.Lrot(e, -18),
				uapi.Lrot(e, -41)),
			uapi.Xor(
				uapi.And(e, f),
				uapi.And(uapi.Not(e), g)),
			_K512[i],
			w[i],
		)
		// big sigma0(a) = ROTR(a,28) ^ ROTR(a,34) ^ ROTR(a,39)
		// Maj(a,b,c) = (a AND b) ^ (a AND c) ^ (b AND c)
		t2 := uapi.Add(
			uapi.Xor(
				uapi.Lrot(a, -28),
				uapi.Lrot(a, -34),
				uapi.Lrot(a, -39)),
			uapi.Xor(
				uapi.And(a, b),
				uapi.And(a, c),
				uapi.And(b, c)),
		)

		h = g
		g = f
		f = e
		e = uapi.Add(d, t1)
		d = c
		c = b
		b = a
		a = uapi.Add(t1, t2)
	}

	return [8]uints.U64{
		uapi.Add(ih0, a),
		uapi.Add(ih1, b),
		uapi.Add(ih2, c),
		uapi.Add(ih3, d),
		uapi.Add(ih4, e),
		uapi.Add(ih5, f),
		uapi.Add(ih6, g),
		uapi.Add(ih7, h),
	}
}

// padSHA512 applies SHA-512 padding (FIPS 180-4 sec 5.1.2) to a message whose
// length is known at circuit-compile time. It appends 0x80, zero bytes so the
// length is congruent to 112 mod 128, then a 16-byte big-endian bit length
// (the high 8 bytes are always zero for the message sizes used here). The
// returned slice length is a multiple of 128.
func padSHA512(input []uints.U8) []uints.U8 {
	bytesLen := len(input)
	zeroPadLen := 111 - bytesLen%blockSize512
	if zeroPadLen < 0 {
		zeroPadLen += blockSize512
	}

	buf := make([]uints.U8, 0, bytesLen+1+zeroPadLen+16)
	buf = append(buf, input...)
	buf = append(buf, uints.NewU8(0x80))
	for i := 0; i < zeroPadLen; i++ {
		buf = append(buf, uints.NewU8(0x00))
	}
	// 128-bit big-endian length in bits. High 8 bytes are zero (messages are
	// far below 2^64 bits); low 8 bytes carry the bit length.
	bitLen := uint64(8 * bytesLen)
	var lenbuf [16]uint8
	for i := 0; i < 8; i++ {
		lenbuf[8+i] = uint8(bitLen >> (8 * (7 - uint(i))))
	}
	buf = append(buf, uints.NewU8Array(lenbuf[:])...)
	return buf
}

// Sum512 computes the SHA-512 digest of input (a witness/constant byte slice
// whose length is fixed at compile time) and returns 64 output bytes.
func Sum512(uapi *uints.BinaryField[uints.U64], input []uints.U8) [64]uints.U8 {
	padded := padSHA512(input)

	var h [8]uints.U64
	for i := range h {
		h[i] = uints.NewU64(_seed512[i])
	}

	var block [128]uints.U8
	for i := 0; i < len(padded)/blockSize512; i++ {
		copy(block[:], padded[i*blockSize512:(i+1)*blockSize512])
		h = Permute512(uapi, h, block)
	}

	var out [64]uints.U8
	for i := 0; i < 8; i++ {
		bs := uapi.UnpackMSB(h[i])
		copy(out[i*8:(i+1)*8], bs)
	}
	return out
}

// HMACSHA512 computes HMAC-SHA512(key, msg) in-circuit:
//
//	HMAC(K, m) = SHA512((K0 ^ opad) || SHA512((K0 ^ ipad) || m))
//
// where K0 is the key processed to exactly B=128 bytes: if len(key) > B the key
// is first hashed with SHA-512 (yielding 64 bytes) and then zero-padded to B;
// otherwise it is zero-padded to B. The key is treated as a circuit witness, so
// the (K0 ^ pad) terms are computed in-circuit and nothing is hoisted as a
// constant. This costs 4 SHA-512 compressions for the short-key / short-message
// case (2 inner + 2 outer) plus 1 more compression when the key-prehash path is
// taken. Key and message lengths must be known at compile time.
func HMACSHA512(uapi *uints.BinaryField[uints.U64], bapi *uints.Bytes, key, msg []uints.U8) [64]uints.U8 {
	// Derive K0: B bytes.
	k0 := make([]uints.U8, blockSize512)
	if len(key) > blockSize512 {
		kh := Sum512(uapi, key) // 64 bytes
		copy(k0, kh[:])
		for i := 64; i < blockSize512; i++ {
			k0[i] = uints.NewU8(0x00)
		}
	} else {
		copy(k0, key)
		for i := len(key); i < blockSize512; i++ {
			k0[i] = uints.NewU8(0x00)
		}
	}

	ipad := uints.NewU8(0x36)
	opad := uints.NewU8(0x5c)

	// inner = (K0 ^ ipad) || msg
	inner := make([]uints.U8, 0, blockSize512+len(msg))
	for i := 0; i < blockSize512; i++ {
		inner = append(inner, bapi.Xor(k0[i], ipad))
	}
	inner = append(inner, msg...)
	innerHash := Sum512(uapi, inner)

	// outer = (K0 ^ opad) || innerHash
	outer := make([]uints.U8, 0, blockSize512+64)
	for i := 0; i < blockSize512; i++ {
		outer = append(outer, bapi.Xor(k0[i], opad))
	}
	outer = append(outer, innerHash[:]...)
	return Sum512(uapi, outer)
}
