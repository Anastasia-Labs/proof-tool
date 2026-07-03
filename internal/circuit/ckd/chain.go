package ckd

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"

	"proof-tool/internal/circuit/ed25519/ed"
)

// DeriveChain composes the five BIP32-Ed25519 V2 steps of the CIP-1852 path
// m/1852'/1815'/account'/role/index into the leaf extended secret key, returning
// the leaf CircExt whose KLbits is the leaf's single canonical decomposition
// (REQ-CKD-F-07).
//
// The master is taken as BYTES (kL, kR, cc) rather than as a caller-supplied
// CircExt: DeriveChain builds the master's KLbits here, from masterKL, with a
// single canonical decomposition. The master only parents hardened steps, which
// consume kL/kR as bytes; its KLbits is used solely by AssertClampBits. Building
// those bits from masterKL (whose recomposition BytesToCanonBits constrains)
// binds the clamp assertion to the very kL bytes the first hardened HMAC
// pre-image consumes — so a caller cannot present clamp-satisfying bits beside
// unclamped kL bytes. AssertClampBits enforces the Icarus master clamp on that
// vector exactly once (REQ-CKD-S-06). (For child entries the CircExt KLbits↔KL
// invariant is instead guaranteed by finishStep's construction.)
//
// The 1852' and 1815' purpose/coin-type levels are fixed by CIP-1852, so their
// le32 suffixes are compile-time constants (constBytes(le32(... | 0x80000000)));
// only account', role and index are WITNESSED (REQ-CKD-F-04). le32Var pins each
// witnessed index < 2^31 and fixes the hardened mode bit at compile time
// (REQ-CKD-S-07): account' keeps the hardened bit set, role/index keep it clear.
// role is additionally constrained to {0,1,2} (SPEC 3.3). The two soft hops
// (role, index) share ONE *ed.Curve (passed in, constructed once by the caller)
// so the chain builds the ed25519 base-multiply context only a single time.
func DeriveChain(api frontend.API, uapi *uints.BinaryField[uints.U64], bapi *uints.Bytes, crv *ed.Curve,
	masterKL, masterKR, masterCC [32]uints.U8, account, role, index frontend.Variable) CircExt {
	mbits := BytesToCanonBits(api, masterKL) // single canonical decomposition of the master kL
	AssertClampBits(api, mbits)              // Icarus master clamp asserted once (REQ-CKD-S-06)
	master := CircExt{KL: masterKL, KR: masterKR, CC: masterCC, KLbits: mbits}

	// 1852' and 1815' are fixed by CIP-1852 (compile-time constants).
	c1852 := constBytes(le32(1852 | 0x8000_0000))
	c1815 := constBytes(le32(1815 | 0x8000_0000))
	x := HardenedStep(api, uapi, bapi, master, c1852)
	x = HardenedStep(api, uapi, bapi, x, c1815)
	// account' witnessed (low 31 bits), hardened bit pinned constant (REQ-CKD-S-07).
	acc := le32Var(api, account, true)
	x = HardenedStep(api, uapi, bapi, x, acc[:])
	// role in {0,1,2} (SPEC 3.3); address_index < 2^31. Both soft.
	api.AssertIsEqual(api.Mul(role, api.Sub(role, 1), api.Sub(role, 2)), 0)
	roleLE := le32Var(api, role, false)
	idxLE := le32Var(api, index, false)
	x = SoftStep(api, uapi, bapi, crv, x, roleLE[:])
	x = SoftStep(api, uapi, bapi, crv, x, idxLE[:])
	return x // x.KLbits is the leaf canonical vector (REQ-CKD-F-07)
}
