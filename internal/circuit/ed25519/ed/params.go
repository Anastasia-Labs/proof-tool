// Package ed implements an EMULATED Ed25519 fixed-base scalar multiplication
// gadget for gnark, targeting proofs over BLS12-381. gnark's stdlib has no
// twisted-Edwards-over-2^255-19 support (native twistededwards is for the
// curve embedded in the BLS12-381 scalar field; sw_emulated is Weierstrass
// only), so the base field, the group law and the scalar multiplication are
// all built here on top of std/math/emulated.
//
// The gadget computes A = s*B where B is the Ed25519 basepoint and s is a
// 256-bit scalar supplied as little-endian bits and used AS-IS, with NO
// reduction mod the group order L. This matches the BIP32-Ed25519 V2
// convention for leaf / soft-parent scalars in Cardano (Icarus) derivation.
package ed

import (
	"math/big"

	"github.com/consensys/gnark/std/math/emulated"
)

// Ed25519Fp parametrizes the Ed25519 base field Fp = 2^255 - 19 for
// std/math/emulated. Four 64-bit limbs hold the 255-bit modulus.
type Ed25519Fp struct{}

func (Ed25519Fp) NbLimbs() uint     { return 4 }
func (Ed25519Fp) BitsPerLimb() uint { return 64 }
func (Ed25519Fp) IsPrime() bool     { return true }

func (Ed25519Fp) Modulus() *big.Int {
	// 2^255 - 19
	p := new(big.Int).Lsh(big.NewInt(1), 255)
	p.Sub(p, big.NewInt(19))
	return p
}

// compile-time assertion that Ed25519Fp satisfies the emulated.FieldParams
// interface.
var _ emulated.FieldParams = Ed25519Fp{}

// ---------------------------------------------------------------------------
// Curve constants (all reduced mod p).
// ---------------------------------------------------------------------------

func mustBig(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("ed: bad big.Int constant " + s)
	}
	return v
}

// P is the Ed25519 base field modulus 2^255-19.
var P = Ed25519Fp{}.Modulus()

// D is the twisted-Edwards d = -121665/121666 mod p.
var D = mustBig("37095705934669439343138083508754565189542113879843219016388785533085940283555")

// Bx, By are the affine coordinates of the Ed25519 basepoint B.
var (
	Bx = mustBig("15112221349535400772501151409588531511454012693041857206046113283949847762202")
	By = mustBig("46316835694926478169428394003475163141307993866256225615783033603165251855960")
)
