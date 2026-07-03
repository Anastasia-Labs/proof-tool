package ckd

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"

	"proof-tool/internal/circuit/ed25519/ed"
	"proof-tool/internal/circuit/sha512/sha"
)

// CircExt is the in-circuit extended secret-key carrier for one BIP32-Ed25519 V2
// derivation state: the little-endian left/right scalar halves KL, KR and the
// 32-byte chain code CC, plus KLbits — the SINGLE canonical 256-bit
// little-endian decomposition of KL (REQ-CKD-S-03). KLbits is produced once by
// BytesToCanonBits (which pins bit255 = 0) and is the exact vector handed to
// ScalarMulBaseBits in the soft step; nothing is decomposed a second time.
//
// INVARIANT (caller-enforced for the master entry): KLbits MUST equal
// BytesToCanonBits(KL) — the canonical decomposition of the KL bytes. SoftStep
// computes A_par from KLbits while finishStep's AddKL operates on the KL bytes,
// so a CircExt whose KLbits diverged from KL would silently compute A_par on a
// different scalar than the adder uses. Child CircExts produced by finishStep
// satisfy this by construction (it derives KLbits from the same kL it returns);
// the guard is only load-bearing for the master CircExt the chain starts from.
type CircExt struct {
	KL, KR, CC [32]uints.U8
	KLbits     [256]frontend.Variable
}

// constByte builds a constant (compile-time) byte. The CKD mode/tag bytes and
// the le32(idx) suffix are Go constants, never circuit witnesses (REQ-CKD-S-01),
// so they are materialized with uints.NewU8 rather than range-checked inputs.
func constByte(b byte) uints.U8 { return uints.NewU8(b) }

// constBytes builds a slice of constant bytes (compile-time).
func constBytes(bs []byte) []uints.U8 { return uints.NewU8Array(bs) }

// concatU8 concatenates byte slices into one. The total length is fixed at
// compile time for every call site (69 bytes hardened, 37 bytes soft), so the
// HMAC pre-image length is a compile-time constant as SHA-512 padding requires.
func concatU8(parts ...[]uints.U8) []uints.U8 {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]uints.U8, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// HardenedStep derives a hardened child (tagZ=0x00, tagCC=0x01) keyed on the
// parent chain code, with HMAC data = KL_par ‖ KR_par and the 4-byte le32 index
// suffix supplied by the caller. The tag bytes stay Go constants (REQ-CKD-S-01);
// the le32 suffix is a constant (constBytes(le32(hi)) for the fixed 1852'/1815'
// levels) or a witnessed value pinned by le32Var (the account' level, with the
// hardened bit fixed at compile time). The 69-byte pre-image is:
// tag(1) ‖ KL(32) ‖ KR(32) ‖ idxLE(4).
func HardenedStep(api frontend.API, uapi *uints.BinaryField[uints.U64], bapi *uints.Bytes, p CircExt, idxLE []uints.U8) CircExt {
	msg := concatU8([]uints.U8{constByte(0x00)}, p.KL[:], p.KR[:], idxLE)
	ccm := concatU8([]uints.U8{constByte(0x01)}, p.KL[:], p.KR[:], idxLE)
	return finishStep(api, uapi, bapi, p, msg, ccm)
}

// SoftStep derives a soft child (tagZ=0x02, tagCC=0x03) keyed on the parent
// chain code, with HMAC data = A_par, the RFC-8032 compressed encoding of
// kL_par · B. A_par is computed from p.KLbits — the SAME canonical vector the
// adder produced (REQ-CKD-S-03 / F-03), not a fresh decomposition — and enters
// the HMAC pre-image through bapi.ValueOf, a range-checked byte handoff
// (REQ-CKD-F-03). The tag bytes stay Go constants (REQ-CKD-S-01); the 4-byte
// le32 index suffix is supplied by the caller (le32Var for the witnessed
// role/index levels, with the hardened bit pinned to 0). The 37-byte pre-image
// is: tag(1) ‖ A(32) ‖ idxLE(4).
//
// Requires p.KLbits == BytesToCanonBits(p.KL) (the CircExt invariant): A_par is
// computed from p.KLbits and must match the kL bytes the adder consumes.
func SoftStep(api frontend.API, uapi *uints.BinaryField[uints.U64], bapi *uints.Bytes, crv *ed.Curve, p CircExt, idxLE []uints.U8) CircExt {
	// A_par = compress(kL_par · B), with kL_par taken AS-IS from the shared
	// canonical bit vector. ScalarMulBaseBits self-enforces booleanity and
	// bit255 = 0, so the soft step never computes outside the oracle domain.
	enc := crv.Compress(crv.ScalarMulBaseBits(p.KLbits[:])) // [32]frontend.Variable
	var A [32]uints.U8
	for i := 0; i < 32; i++ {
		A[i] = bapi.ValueOf(enc[i]) // range-checked handoff into the byte API
	}
	msg := concatU8([]uints.U8{constByte(0x02)}, A[:], idxLE)
	ccm := concatU8([]uints.U8{constByte(0x03)}, A[:], idxLE)
	return finishStep(api, uapi, bapi, p, msg, ccm)
}

// finishStep computes the two HMAC-SHA512 values (Z and the child chain code),
// runs the no-mod-L adders against the parent halves carried in p, and produces
// the child CircExt with its single canonical KL decomposition.
//
//	Z  = HMAC-SHA512(CC_par, msg)        ; CC = HMAC-SHA512(CC_par, ccm)
//	KL = KL_par + 8 * le_int(Z[0:28])    (no mod L)
//	KR = (KR_par + le_int(Z[32:64])) mod 2^256
//	CC_child = CC[32:64]
func finishStep(api frontend.API, uapi *uints.BinaryField[uints.U64], bapi *uints.Bytes, p CircExt, msg, ccm []uints.U8) CircExt {
	Z := sha.HMACSHA512(uapi, bapi, p.CC[:], msg)
	CC := sha.HMACSHA512(uapi, bapi, p.CC[:], ccm)

	var zL [28]uints.U8
	copy(zL[:], Z[0:28])
	var zR [32]uints.U8
	copy(zR[:], Z[32:64])

	kL := AddKL(api, p.KL, zL)
	kR := AddKR(api, p.KR, zR)

	// THE canonical decomposition of the child KL (REQ-CKD-S-03); asserts
	// bit255 = 0 (REQ-CKD-S-04). The next step's soft branch reuses this vector.
	bits := BytesToCanonBits(api, kL)

	var cc [32]uints.U8
	copy(cc[:], CC[32:64])
	return CircExt{KL: kL, KR: kR, CC: cc, KLbits: bits}
}
