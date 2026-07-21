package ckd

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"
)

// le32Var serializes a WITNESSED index to the 4-byte little-endian le32 suffix,
// range-checking it in-circuit (REQ-CKD-S-07). api.ToBinary(idx, 31) proves
// idx < 2^31 (the low 31 bits are the witnessed magnitude). Bit 31 of the
// serialized index — the BIP32 hardened flag — is a COMPILE-TIME constant (1 for
// hardened, 0 for soft), never witnessed, so S-01 is preserved: a prover cannot
// turn a hardened level soft or a soft level hardened. Each output byte is built
// from 8 boolean bits, hence provably in [0,256).
func le32Var(api frontend.API, idx frontend.Variable, hardened bool) [4]uints.U8 {
	bits := api.ToBinary(idx, 31) // bits[0..30]; asserts idx < 2^31
	full := make([]frontend.Variable, 32)
	copy(full, bits)
	if hardened {
		full[31] = frontend.Variable(1)
	} else {
		full[31] = frontend.Variable(0)
	}
	var out [4]uints.U8
	for k := 0; k < 4; k++ {
		out[k] = uints.U8{Val: api.FromBinary(full[8*k : 8*k+8]...)}
	}
	return out
}

// BytesToCanonBits decomposes 32 little-endian bytes into the single canonical
// 256-bit little-endian vector shared across the whole step gadget. Byte k holds
// bits 8k..8k+7 (LSB-first): canon[8k+j] is bit j of b[k].
//
// Each byte is decomposed with api.ToBinary(.,8), which boolean-constrains every
// returned bit AND binds the recomposition sum back to b[k].Val, so the bits are
// a sound, unique representation of the byte (no extra AssertIsBoolean needed).
//
// REQ-CKD-S-03: every vector produced here and consumed by ScalarMulBaseBits or
// Credential is the unique decomposition of those same KL bytes, with no second
// decomposition. Byte-only hardened intermediates need no vector. The top bit
// of every produced vector is pinned to 0 (REQ-CKD-S-04): every real Cardano V2
// scalar that reaches a bit consumer satisfies kL < 2^255.
func BytesToCanonBits(api frontend.API, b [32]uints.U8) [256]frontend.Variable {
	var canon [256]frontend.Variable
	for k := 0; k < 32; k++ {
		bits := api.ToBinary(b[k].Val, 8) // LSB-first, each bit boolean-constrained
		for j := 0; j < 8; j++ {
			canon[8*k+j] = bits[j]
		}
	}
	// REQ-CKD-S-04: pin bit 255 = 0 (the BIP32-Ed25519 / cryptoxide domain).
	api.AssertIsEqual(canon[255], 0)
	return canon
}

// CanonBitsToBytes recomposes the canonical 256-bit little-endian vector into 32
// bytes: byte k = sum_{j<8} bits[8k+j] * 2^j. It is the inverse of
// BytesToCanonBits and exists for round-trip / serialization use. The caller is
// responsible for booleanity of the input bits (BytesToCanonBits and the carry
// adder both produce boolean bits).
func CanonBitsToBytes(api frontend.API, bits [256]frontend.Variable) [32]uints.U8 {
	var out [32]uints.U8
	for k := 0; k < 32; k++ {
		out[k] = uints.U8{Val: api.FromBinary(bits[8*k : 8*k+8]...)}
	}
	return out
}

// AssertClamp asserts that kL carries the Icarus master clamp
// (kL[0] &= 0xF8; kL[31] &= 0x1F; kL[31] |= 0x40) via the canonical bit vector
// (REQ-CKD-S-06). In little-endian layout byte0 holds bits 0..7 and byte31 holds
// bits 248..255, so the clamp pins (kL[31] &= 0x1F clears bits 253,254,255;
// kL[31] |= 0x40 then sets bit 254):
//
//   - bits[0]=bits[1]=bits[2]=0   (kL[0] & 0x07 == 0,  from kL[0] &= 0xF8)
//   - bits[253]=0                 (kL[31] & 0x20 clear, from kL[31] &= 0x1F)
//   - bits[254]=1                 (kL[31] & 0x40 set,   from kL[31] |= 0x40)
//   - bits[255]=0                 (kL[31] & 0x80 clear, from kL[31] &= 0x1F)
//
// All five constraints together are an exact characterization of the Icarus
// clamp (REQ-CKD-S-06): a scalar with any of bits 0,1,2,253,255 set or bit 254
// clear is not validly clamped and must be rejected.
//
// AssertClamp is the byte-API convenience wrapper. The step/chain gadget
// decomposes the master kL exactly once and clamp-checks via AssertClampBits on
// that canonical vector, so it never incurs a second decomposition
// (REQ-CKD-S-03).
func AssertClamp(api frontend.API, kL [32]uints.U8) {
	AssertClampBits(api, BytesToCanonBits(api, kL))
}

// AssertClampBits asserts the Icarus clamp directly on an already-computed
// canonical 256-bit little-endian vector, without decomposing anything. This is
// the form the chain gadget uses for the master: it shares the one canonical
// vector (REQ-CKD-S-03) between the master bytes and clamp check. See
// AssertClamp for the bit-position derivation. The caller is
// responsible for booleanity of bits (BytesToCanonBits and the carry adder both
// produce boolean bits).
func AssertClampBits(api frontend.API, bits [256]frontend.Variable) {
	api.AssertIsEqual(bits[0], 0)
	api.AssertIsEqual(bits[1], 0)
	api.AssertIsEqual(bits[2], 0)
	api.AssertIsEqual(bits[253], 0)
	api.AssertIsEqual(bits[254], 1)
	api.AssertIsEqual(bits[255], 0)
}
