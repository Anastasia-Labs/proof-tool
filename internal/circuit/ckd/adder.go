package ckd

import (
	"errors"
	"math/big"

	"github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"
	"github.com/consensys/gnark/std/rangecheck"
)

// This file implements the no-mod-L byte-limb adders that compute the child
// scalar halves of one BIP32-Ed25519 V2 derivation step:
//
//	kL_child = kL_par + 8 * le_int(Z[0:28])          (AddKL, NO mod L)
//	kR_child = (kR_par + le_int(Z[32:64])) mod 2^256 (AddKR, ripple mod 2^256)
//
// The gnark scalar field is BLS12-381 (~2^255), so a 256-bit sum cannot be added
// as a single field element without risking a wrap. Both adders therefore work
// one byte limb at a time with an explicit carry, and at every column:
//
//   - the exact carry relation v == lo + 256*carry is asserted,
//   - the output byte lo is range-checked to 8 bits (REQ-CKD-S-02),
//   - the carry is range-checked to its exact small width.
//
// Crucially there is NO reduction mod the Ed25519 group order L anywhere. The
// per-byte exact-carry plus 8-bit range-check pins the unique integer result, so
// an `s` vs `s+L` alias cannot satisfy the constraints (REQ-CKD-S-05): the output
// is the exact integer, not a residue class. AddKL additionally asserts the final
// carry is zero (the result is < 2^256); AddKR discards the final carry (mod
// 2^256). These adders are the soundness core of audit/03 condition ii
// (REQ-CKD-S-02 / REQ-CKD-F-05 / REQ-CKD-F-06): a dropped carry or a missing
// range-check is exactly the forgery surface this design exists to close.

func init() {
	// Register the split hint so the adders are usable by a real prover (Groth16
	// / PLONK), not just the test.IsSolved engine which calls hints directly.
	solver.RegisterHint(splitByteHint)
}

// splitByteHint is the (sound-by-binding) hint that decomposes a column sum v
// into its low byte and carry: outputs[0] = v mod 256, outputs[1] = v div 256.
// The hint value is NOT trusted on its own; splitByte binds it with the exact
// relation v == lo + 256*carry and range-checks both parts, which uniquely pins
// (lo, carry) regardless of what the hint returns.
func splitByteHint(_ *big.Int, inputs []*big.Int, outputs []*big.Int) error {
	if len(inputs) != 1 || len(outputs) != 2 {
		return errors.New("splitByteHint: expects 1 input, 2 outputs")
	}
	v := inputs[0]
	outputs[0].And(v, big.NewInt(0xff)) // lo = v mod 256
	outputs[1].Rsh(v, 8)                // carry = v div 256
	return nil
}

// splitByte splits the column sum v into (lo, carry) where lo is the output byte
// and carry feeds the next column. carryBits is the exact width of the carry for
// this adder (4 for AddKL, 1 for AddKR). The hint supplies witnesses; the
// asserted relation v == lo + 256*carry together with the two range checks makes
// the split sound and unique: lo ∈ [0,256) and carry ∈ [0,2^carryBits) leave
// exactly one (lo, carry) satisfying v == lo + 256*carry. Each column sum v is a
// small value (≤ ~2310 for AddKL, ≤ 511 for AddKR), far below the BLS12-381 field
// modulus, so no field wrap can occur.
func splitByte(api frontend.API, rc frontend.Rangechecker, v frontend.Variable, carryBits int) (lo, carry frontend.Variable) {
	out, err := api.Compiler().NewHint(splitByteHint, 2, v)
	if err != nil {
		panic(err)
	}
	lo, carry = out[0], out[1]
	api.AssertIsEqual(v, api.Add(lo, api.Mul(carry, 256))) // exact carry relation
	rc.Check(lo, 8)                                        // output byte ∈ [0,255] (REQ-CKD-S-02)
	rc.Check(carry, carryBits)                             // carry exact width
	return lo, carry
}

// AddKL computes the child left scalar half kL_child = kL_par + 8*le_int(zL),
// with NO reduction mod L, as 32 little-endian output bytes. zL is the first 28
// bytes of the HMAC output Z (Z[0:28]); the multiply-by-8 is fused into the
// limb-wise add. Every output byte is range-checked to 8 bits and every carry to
// 4 bits (the column maximum is 255 + 8*255 + carry ≤ 2310, so carry ≤ 9 < 2^4).
// The final carry is asserted zero: the result is < 2^256, no overflow past 32
// bytes. When a later soft/credential consumer needs bits, pinning bit 255 = 0
// is performed by that state's canonical BytesToCanonBits decomposition
// (REQ-CKD-S-04); byte-only hardened intermediates need no such decomposition.
func AddKL(api frontend.API, kLpar [32]uints.U8, zL [28]uints.U8) [32]uints.U8 {
	rc := rangecheck.New(api)
	carry := frontend.Variable(0)
	var out [32]uints.U8
	for k := 0; k < 32; k++ {
		z := frontend.Variable(0)
		if k < 28 {
			z = zL[k].Val
		}
		// v = kLpar[k] + 8*zL[k] + carry  (≤ 255 + 2040 + 9)
		v := api.Add(kLpar[k].Val, api.Mul(z, 8), carry)
		lo, c := splitByte(api, rc, v, 4)
		out[k] = uints.U8{Val: lo}
		carry = c
	}
	// No overflow past 2^256: the result fits in 32 bytes (no mod L, exact int).
	api.AssertIsEqual(carry, 0)
	return out
}

// AddKR computes the child right scalar half kR_child = (kR_par + le_int(zR))
// mod 2^256, as 32 little-endian output bytes. zR is Z[32:64]. This is a plain
// ripple-carry add: each column sum is ≤ 255 + 255 + 1 = 511, so the carry is
// boolean (range-checked to 1 bit). The final carry is DISCARDED, which realizes
// the mod 2^256 reduction (matching ref.go deriveChild's kR_child).
func AddKR(api frontend.API, kRpar [32]uints.U8, zR [32]uints.U8) [32]uints.U8 {
	rc := rangecheck.New(api)
	carry := frontend.Variable(0)
	var out [32]uints.U8
	for k := 0; k < 32; k++ {
		// v = kRpar[k] + zR[k] + carry  (≤ 511)
		v := api.Add(kRpar[k].Val, zR[k].Val, carry)
		lo, c := splitByte(api, rc, v, 1)
		out[k] = uints.U8{Val: lo}
		carry = c
	}
	// Discard the final carry: this is the mod 2^256 reduction. Do NOT assert it.
	_ = carry
	return out
}
