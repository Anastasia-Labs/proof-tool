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
	"errors"
	"math/big"
	"sort"

	"github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"
	"github.com/consensys/gnark/std/rangecheck"

	"proof-tool/internal/circuit/u64util"
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

func init() {
	solver.RegisterHint(sigmaChunksHint)
}

// Permute512 applies the SHA-512 compression function to one 128-byte block,
// updating the running hash. Mirrors std/permutation/sha2.Permute but with
// 64-bit words, 80 rounds, the SHA-512 sigma rotations, and _K512.
func Permute512(api frontend.API, uapi *uints.BinaryField[uints.U64], currentHash [8]uints.U64, p [128]uints.U8) [8]uints.U64 {
	var w [80]uints.U64
	rc := rangecheck.New(api)

	// Big-endian message schedule: 16 words from the block.
	for i := 0; i < 16; i++ {
		w[i] = uapi.PackMSB(p[8*i], p[8*i+1], p[8*i+2], p[8*i+3], p[8*i+4], p[8*i+5], p[8*i+6], p[8*i+7])
	}

	// Extend to 80 words.
	for i := 16; i < 80; i++ {
		v1 := w[i-2]
		// small sigma1(x) = ROTR(x,19) ^ ROTR(x,61) ^ SHR(x,6)
		s1 := sigmaRot(api, uapi, rc, v1, []int{19, 61}, 6)
		v2 := w[i-15]
		// small sigma0(x) = ROTR(x,1) ^ ROTR(x,8) ^ SHR(x,7)
		s0 := sigmaRot(api, uapi, rc, v2, []int{1, 8}, 7)
		// Four U64 terms have carry hi <= 3, hence exactly 2 high bits.
		w[i] = Add64(api, uapi, rc, 2, s1, w[i-7], s0, w[i-16])
	}

	ih0, ih1, ih2, ih3 := currentHash[0], currentHash[1], currentHash[2], currentHash[3]
	ih4, ih5, ih6, ih7 := currentHash[4], currentHash[5], currentHash[6], currentHash[7]
	a, b, c, d, e, f, g, h := ih0, ih1, ih2, ih3, ih4, ih5, ih6, ih7

	for i := 0; i < 80; i++ {
		// big sigma1(e) = ROTR(e,14) ^ ROTR(e,18) ^ ROTR(e,41)
		// Ch(e,f,g) = g ^ (e AND (f ^ g))
		// t1 is deliberately kept as a native sum. Five U64 terms give
		// t1 < 5*2^64; no bytes are needed until e and a are materialized.
		t1 := NativeSum64(api, uapi,
			h,
			sigmaRot(api, uapi, rc, e, []int{14, 18, 41}, 0),
			choose(uapi, e, f, g),
			_K512[i],
			w[i],
		)
		// big sigma0(a) = ROTR(a,28) ^ ROTR(a,34) ^ ROTR(a,39)
		// Maj(a,b,c) = (a AND b) ^ ((a ^ b) AND c)
		// t2 is also deferred: two U64 terms give t2 < 2*2^64.
		t2 := NativeSum64(api, uapi,
			sigmaRot(api, uapi, rc, a, []int{28, 34, 39}, 0),
			majority(uapi, a, b, c),
		)

		h = g
		g = f
		f = e
		// d+t1 < 6*2^64, so the high limb is at most 5 (3 bits).
		e = Materialize64(api, uapi, rc, api.Add(uapi.ToValue(d), t1), 3)
		d = c
		c = b
		b = a
		// t1+t2 < 7*2^64, so the high limb is at most 6 (3 bits).
		a = Materialize64(api, uapi, rc, api.Add(t1, t2), 3)
	}

	// Each feed-forward is a two-U64 sum, so carry hi <= 1 (1 bit).
	return [8]uints.U64{
		Add64(api, uapi, rc, 1, ih0, a),
		Add64(api, uapi, rc, 1, ih1, b),
		Add64(api, uapi, rc, 1, ih2, c),
		Add64(api, uapi, rc, 1, ih3, d),
		Add64(api, uapi, rc, 1, ih4, e),
		Add64(api, uapi, rc, 1, ih5, f),
		Add64(api, uapi, rc, 1, ih6, g),
		Add64(api, uapi, rc, 1, ih7, h),
	}
}

type sigmaByteChunks struct {
	values  []frontend.Variable
	widths  []int
	offsets []int
}

// sigmaRot computes XOR(ROTR(word, rotations...)) and, when rightShift is
// nonzero, XORs SHR(word, rightShift). Every rotation/shift amount is a Go
// constant. The required byte cut positions are derived from those constants;
// callers do not supply or trust a separate cut table.
//
// Each input byte is independently decomposed once into the union of those
// cut positions. Every chunk is range-checked to its exact width and the
// complete 8-bit recomposition is asserted. Rotated/shifted bytes are then
// complete linear recompositions of disjoint chunks whose widths sum to eight.
// A call derives fresh chunks for its word: chunks are never shared across
// distinct SHA-512 words.
func sigmaRot(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	rc frontend.Rangechecker,
	word uints.U64,
	rotations []int,
	rightShift int,
) uints.U64 {
	if len(rotations) == 0 {
		panic("sha: sigmaRot requires at least one rotation")
	}
	cuts := sigmaCutPositions(rotations, rightShift)
	widths := widthsFromCuts(cuts)
	var chunks [8]sigmaByteChunks
	for i := range word {
		chunks[i] = decomposeSigmaByte(api, uapi, rc, word[i], widths)
	}

	terms := make([]uints.U64, 0, len(rotations)+1)
	for _, rotation := range rotations {
		terms = append(terms, rotateRightFromSigmaChunks(api, word, chunks, rotation))
	}
	if rightShift > 0 {
		terms = append(terms, shiftRightFromSigmaChunks(api, chunks, rightShift))
	}
	return uapi.Xor(terms...)
}

// sigmaCutPositions recomputes the within-byte cut for every non-byte-aligned
// ROTR/SHR operation. ROTR n and SHR n both split their source bytes at n mod
// 8; byte-aligned operations are permutations/truncations and need no cut.
func sigmaCutPositions(rotations []int, rightShift int) []int {
	seen := make(map[int]struct{}, len(rotations)+1)
	for _, rotation := range rotations {
		if rotation <= 0 || rotation >= 64 {
			panic("sha: sigma rotation must be in [1,63]")
		}
		if cut := rotation % 8; cut != 0 {
			seen[cut] = struct{}{}
		}
	}
	if rightShift < 0 || rightShift >= 64 {
		panic("sha: sigma right shift must be in [0,63]")
	}
	if cut := rightShift % 8; rightShift > 0 && cut != 0 {
		seen[cut] = struct{}{}
	}
	cuts := make([]int, 0, len(seen))
	for cut := range seen {
		cuts = append(cuts, cut)
	}
	sort.Ints(cuts)
	return cuts
}

func widthsFromCuts(cuts []int) []int {
	widths := make([]int, 0, len(cuts)+1)
	previous := 0
	for _, cut := range cuts {
		if cut <= previous || cut >= 8 {
			panic("sha: invalid sigma cut positions")
		}
		widths = append(widths, cut-previous)
		previous = cut
	}
	widths = append(widths, 8-previous)
	return widths
}

func decomposeSigmaByte(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	rc frontend.Rangechecker,
	input uints.U8,
	widths []int,
) sigmaByteChunks {
	inputValue := uapi.Value(input)
	hintInputs := make([]frontend.Variable, 1+len(widths))
	hintInputs[0] = inputValue
	for i, width := range widths {
		hintInputs[i+1] = width
	}
	values, err := api.Compiler().NewHint(sigmaChunksHint, len(widths), hintInputs...)
	if err != nil {
		panic(err)
	}

	offsets := make([]int, len(widths))
	recomposition := frontend.Variable(0)
	offset := 0
	for i, width := range widths {
		if width < 1 || offset+width > 8 {
			panic("sha: invalid sigma chunk width")
		}
		offsets[i] = offset
		rc.Check(values[i], width)
		recomposition = api.Add(recomposition, api.Mul(1<<offset, values[i]))
		offset += width
	}
	if offset != 8 {
		panic("sha: sigma chunk widths do not cover one byte")
	}
	api.AssertIsEqual(inputValue, recomposition)
	return sigmaByteChunks{values: values, widths: widths, offsets: offsets}
}

func rotateRightFromSigmaChunks(api frontend.API, word uints.U64, chunks [8]sigmaByteChunks, rotation int) uints.U64 {
	byteShift, bitShift := rotation/8, rotation%8
	if bitShift == 0 {
		return u64util.RotBytes(word, -rotation)
	}
	var out uints.U64
	for i := range out {
		source := (i + byteShift) % len(out)
		next := (source + 1) % len(out)
		_, upper := sigmaByteAtCut(api, chunks[source], bitShift)
		lower, _ := sigmaByteAtCut(api, chunks[next], bitShift)
		out[i] = uints.U8{Val: api.Add(upper, api.Mul(1<<(8-bitShift), lower))}
	}
	return out
}

func shiftRightFromSigmaChunks(api frontend.API, chunks [8]sigmaByteChunks, shift int) uints.U64 {
	byteShift, bitShift := shift/8, shift%8
	var out uints.U64
	for i := range out {
		source := i + byteShift
		if source >= len(out) {
			out[i] = uints.NewU8(0)
			continue
		}
		if bitShift == 0 {
			_, upper := sigmaByteAtCut(api, chunks[source], 0)
			out[i] = uints.U8{Val: upper}
			continue
		}
		_, upper := sigmaByteAtCut(api, chunks[source], bitShift)
		value := upper
		if source+1 < len(out) {
			lower, _ := sigmaByteAtCut(api, chunks[source+1], bitShift)
			value = api.Add(value, api.Mul(1<<(8-bitShift), lower))
		}
		out[i] = uints.U8{Val: value}
	}
	return out
}

func sigmaByteAtCut(api frontend.API, chunks sigmaByteChunks, cut int) (lower, upper frontend.Variable) {
	if cut < 0 || cut > 8 {
		panic("sha: sigma byte cut outside [0,8]")
	}
	lower, upper = 0, 0
	for i, value := range chunks.values {
		start := chunks.offsets[i]
		end := start + chunks.widths[i]
		switch {
		case end <= cut:
			lower = api.Add(lower, api.Mul(1<<start, value))
		case start >= cut:
			upper = api.Add(upper, api.Mul(1<<(start-cut), value))
		default:
			panic("sha: requested sigma cut was not decomposed")
		}
	}
	return lower, upper
}

// sigmaChunksHint decomposes one byte into little-endian chunks whose widths
// are supplied as compile-time constants. Its outputs are untrusted witnesses;
// decomposeSigmaByte independently range-checks every output and binds their
// complete recomposition to the input byte.
func sigmaChunksHint(_ *big.Int, inputs, outputs []*big.Int) error {
	if len(inputs) != len(outputs)+1 || len(outputs) == 0 {
		return errors.New("sigmaChunksHint: expected byte plus one width per output")
	}
	value := new(big.Int).Set(inputs[0])
	totalWidth := 0
	for i := range outputs {
		width := int(inputs[i+1].Int64())
		if width < 1 || totalWidth+width > 8 {
			return errors.New("sigmaChunksHint: invalid chunk widths")
		}
		mask := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), uint(width)), big.NewInt(1))
		outputs[i].And(value, mask)
		value.Rsh(value, uint(width))
		totalWidth += width
	}
	if totalWidth != 8 {
		return errors.New("sigmaChunksHint: chunk widths do not cover one byte")
	}
	return nil
}

// choose and majority use algebraically equivalent forms of the FIPS 180-4
// SHA-512 round functions that each remove one byte-table lookup per round.
func choose(uapi *uints.BinaryField[uints.U64], e, f, g uints.U64) uints.U64 {
	return uapi.Xor(g, uapi.And(e, uapi.Xor(f, g)))
}

func majority(uapi *uints.BinaryField[uints.U64], a, b, c uints.U64) uints.U64 {
	return uapi.Xor(uapi.And(a, b), uapi.And(uapi.Xor(a, b), c))
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
func Sum512(api frontend.API, uapi *uints.BinaryField[uints.U64], input []uints.U8) [64]uints.U8 {
	padded := padSHA512(input)

	var h [8]uints.U64
	for i := range h {
		h[i] = uints.NewU64(_seed512[i])
	}

	var block [128]uints.U8
	for i := 0; i < len(padded)/blockSize512; i++ {
		copy(block[:], padded[i*blockSize512:(i+1)*blockSize512])
		h = Permute512(api, uapi, h, block)
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
func HMACSHA512(api frontend.API, uapi *uints.BinaryField[uints.U64], bapi *uints.Bytes, key, msg []uints.U8) [64]uints.U8 {
	// Derive K0: B bytes.
	k0 := make([]uints.U8, blockSize512)
	if len(key) > blockSize512 {
		kh := Sum512(api, uapi, key) // 64 bytes
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
	innerHash := Sum512(api, uapi, inner)

	// outer = (K0 ^ opad) || innerHash
	outer := make([]uints.U8, 0, blockSize512+64)
	for i := 0; i < blockSize512; i++ {
		outer = append(outer, bapi.Xor(k0[i], opad))
	}
	outer = append(outer, innerHash[:]...)
	return Sum512(api, uapi, outer)
}

// HMACSHA512Pair computes two HMAC-SHA512 values under one key while sharing
// the key-dependent ipad and opad compression states. It is equivalent to two
// independent HMACSHA512 calls, but the first 128-byte compression of each
// inner and outer hash is performed once.
//
// The messages may have different compile-time lengths. In the CKD call sites
// they are paired at 69 bytes (hardened) or 37 bytes (soft), so the inner hash
// length fields encode 128+69 and 128+37 bytes respectively. Both outer hashes
// encode the full 128+64-byte length. The public generic HMACSHA512 path above
// remains available and unchanged for unpaired callers.
func HMACSHA512Pair(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	bapi *uints.Bytes,
	key, msg1, msg2 []uints.U8,
) ([64]uints.U8, [64]uints.U8) {
	ipadBlock, opadBlock := hmacSHA512KeyBlocks(api, uapi, bapi, key)

	innerState := Permute512(api, uapi, sha512InitialState(), ipadBlock)
	inner1 := sum512AfterPrefix(api, uapi, innerState, blockSize512, msg1)
	inner2 := sum512AfterPrefix(api, uapi, innerState, blockSize512, msg2)

	outerState := Permute512(api, uapi, sha512InitialState(), opadBlock)
	mac1 := sum512AfterPrefix(api, uapi, outerState, blockSize512, inner1[:])
	mac2 := sum512AfterPrefix(api, uapi, outerState, blockSize512, inner2[:])
	return mac1, mac2
}

func hmacSHA512KeyBlocks(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	bapi *uints.Bytes,
	key []uints.U8,
) ([128]uints.U8, [128]uints.U8) {
	k0 := make([]uints.U8, blockSize512)
	if len(key) > blockSize512 {
		kh := Sum512(api, uapi, key)
		copy(k0, kh[:])
		for i := 64; i < blockSize512; i++ {
			k0[i] = uints.NewU8(0)
		}
	} else {
		copy(k0, key)
		for i := len(key); i < blockSize512; i++ {
			k0[i] = uints.NewU8(0)
		}
	}

	var ipadBlock, opadBlock [128]uints.U8
	ipad, opad := uints.NewU8(0x36), uints.NewU8(0x5c)
	for i := range k0 {
		ipadBlock[i] = bapi.Xor(k0[i], ipad)
		opadBlock[i] = bapi.Xor(k0[i], opad)
	}
	return ipadBlock, opadBlock
}

func sha512InitialState() [8]uints.U64 {
	var state [8]uints.U64
	for i := range state {
		state[i] = uints.NewU64(_seed512[i])
	}
	return state
}

// sum512AfterPrefix finishes SHA-512 after prefixBytes have already been
// compressed into state. prefixBytes must end on a block boundary. Padding is
// generated from the full prefix+suffix length, never from the suffix alone.
func sum512AfterPrefix(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	state [8]uints.U64,
	prefixBytes int,
	suffix []uints.U8,
) [64]uints.U8 {
	paddedSuffix := padSHA512AfterPrefix(prefixBytes, suffix)
	var block [128]uints.U8
	for i := 0; i < len(paddedSuffix)/blockSize512; i++ {
		copy(block[:], paddedSuffix[i*blockSize512:(i+1)*blockSize512])
		state = Permute512(api, uapi, state, block)
	}
	var out [64]uints.U8
	for i := range state {
		copy(out[i*8:(i+1)*8], uapi.UnpackMSB(state[i]))
	}
	return out
}

func padSHA512AfterPrefix(prefixBytes int, suffix []uints.U8) []uints.U8 {
	if prefixBytes < 0 || prefixBytes%blockSize512 != 0 {
		panic("SHA-512 prefix must be a non-negative whole number of blocks")
	}
	totalBytes := prefixBytes + len(suffix)
	zeroPadLen := 111 - totalBytes%blockSize512
	if zeroPadLen < 0 {
		zeroPadLen += blockSize512
	}
	buf := make([]uints.U8, 0, len(suffix)+1+zeroPadLen+16)
	buf = append(buf, suffix...)
	buf = append(buf, uints.NewU8(0x80))
	for i := 0; i < zeroPadLen; i++ {
		buf = append(buf, uints.NewU8(0))
	}
	bitLen := uint64(8 * totalBytes)
	var lenbuf [16]uint8
	for i := 0; i < 8; i++ {
		lenbuf[8+i] = uint8(bitLen >> (8 * (7 - uint(i))))
	}
	buf = append(buf, uints.NewU8Array(lenbuf[:])...)
	return buf
}
