package ed

import (
	"math/big"

	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/emulated"
)

// Point is an affine twisted-Edwards point with coordinates in the emulated
// Ed25519 base field. Every coordinate is an emulated.Element, so its limbs are
// range-constrained to BitsPerLimb by the emulated package on every use.
type Point struct {
	X, Y *emulated.Element[Ed25519Fp]
}

// Curve bundles the emulated base field together with the cached curve
// parameter d, and exposes the twisted-Edwards group law and fixed-base scalar
// multiplication.
type Curve struct {
	api frontend.API
	f   *emulated.Field[Ed25519Fp]
	d   *emulated.Element[Ed25519Fp]
}

// NewCurve constructs the Ed25519 emulated-curve helper over the given native
// API (expected to be BLS12-381's scalar field).
func NewCurve(api frontend.API) (*Curve, error) {
	f, err := emulated.NewField[Ed25519Fp](api)
	if err != nil {
		return nil, err
	}
	return &Curve{
		api: api,
		f:   f,
		d:   f.NewElement(D),
	}, nil
}

// Identity returns the neutral element (0, 1) as constant emulated elements.
func (c *Curve) Identity() *Point {
	return &Point{
		X: c.f.NewElement(big.NewInt(0)),
		Y: c.f.NewElement(big.NewInt(1)),
	}
}

// Add returns p+q using the complete/unified twisted-Edwards addition law for
// a = -1. The law is complete on Ed25519 (a is a square, d is a non-square),
// so it is correct for equal inputs (doubling) and for the identity, with no
// exceptional cases.
//
//	x3 = (x1*y2 + y1*x2) / (1 + d*x1*x2*y1*y2)
//	y3 = (y1*y2 + x1*x2) / (1 - d*x1*x2*y1*y2)
func (c *Curve) Add(p, q *Point) *Point {
	f := c.f
	a := f.Mul(p.X, q.Y)
	b := f.Mul(p.Y, q.X)
	cc := f.Mul(p.X, q.X)
	dd := f.Mul(p.Y, q.Y)
	e := f.Mul(c.d, f.Mul(cc, dd)) // d * (x1*x2) * (y1*y2)
	one := f.One()
	xnum := f.Add(a, b)
	xden := f.Add(one, e)
	ynum := f.Add(dd, cc)
	yden := f.Sub(one, e)
	return &Point{
		X: f.Div(xnum, xden),
		Y: f.Div(ynum, yden),
	}
}

const (
	windowBits = 4                // 4-bit windows
	windowSize = 1 << windowBits  // 16 table entries per window
	numWindows = 256 / windowBits // 64 windows covering all 256 bits
)

// windowTable holds, for one 4-bit window j, the precomputed multiples
// k * (2^(4j) * B) for k = 0..15, with entry 0 = identity.
type windowTable struct {
	xs []*emulated.Element[Ed25519Fp]
	ys []*emulated.Element[Ed25519Fp]
}

// buildTables precomputes the 64 windowed tables of constant base multiples.
// All values are computed out of circuit with the big.Int reference and become
// circuit constants, which is sound because the base B is fixed.
func (c *Curve) buildTables() []windowTable {
	tables := make([]windowTable, numWindows)
	for j := 0; j < numWindows; j++ {
		// base_j = 2^(4j) * B
		shift := new(big.Int).Lsh(big.NewInt(1), uint(windowBits*j))
		baseJ := RefScalarMulBase(shift)

		t := windowTable{
			xs: make([]*emulated.Element[Ed25519Fp], windowSize),
			ys: make([]*emulated.Element[Ed25519Fp], windowSize),
		}
		acc := RefIdentity()
		for k := 0; k < windowSize; k++ {
			// entry k = k * base_j (k=0 -> identity)
			t.xs[k] = c.f.NewElement(new(big.Int).Set(acc.X))
			t.ys[k] = c.f.NewElement(new(big.Int).Set(acc.Y))
			acc = RefAdd(acc, baseJ)
		}
		tables[j] = t
	}
	return tables
}

// ScalarMulBaseBits computes A = s*B, where s is given as exactly 256
// little-endian bits used AS-IS (no reduction mod L). It uses a windowed
// fixed-base method: 64 four-bit windows, each selecting a precomputed
// constant multiple of B and adding it to the accumulator.
//
// This function self-enforces two soundness preconditions:
//   - Every bit is boolean-constrained (F1: sound even if the caller omits
//     AssertIsBoolean, which is required for downstream consumers of the same
//     bit-vector, e.g. the no-mod-L carry adder in audit/03 cond 2).
//   - bits[255] == 0 (F2: pins the Cardano/BIP32-Ed25519 domain; the
//     cryptoxide / ed25519-bip32 oracle is only defined for s < 2^255, and the
//     master clamp guarantees bit 255 = 0 for all real Cardano leaf/parent
//     scalars per audit/03 cond iv).
func (c *Curve) ScalarMulBaseBits(bits []frontend.Variable) *Point {
	if len(bits) != 256 {
		panic("ed: ScalarMulBaseBits expects exactly 256 bits")
	}

	// F1: enforce booleanity of every scalar bit inside the gadget so that
	// the gadget is sound regardless of whether the caller remembered to call
	// AssertIsBoolean.
	for _, b := range bits {
		c.api.AssertIsBoolean(b)
	}

	// F2: pin the BIP32-Ed25519 domain: the cryptoxide oracle (and the Cardano
	// ledger) require s < 2^255 (bit 255 = 0). The master clamp guarantees this
	// for all real Cardano leaf/soft-parent scalars; we enforce it in-circuit so
	// the gadget never silently computes outside the oracle's domain.
	c.api.AssertIsEqual(bits[255], 0)

	tables := c.buildTables()

	var acc *Point
	for j := 0; j < numWindows; j++ {
		// window value sel = b0 + 2 b1 + 4 b2 + 8 b3
		b0 := bits[4*j+0]
		b1 := bits[4*j+1]
		b2 := bits[4*j+2]
		b3 := bits[4*j+3]
		sel := c.api.Add(
			b0,
			c.api.Mul(b1, 2),
			c.api.Mul(b2, 4),
			c.api.Mul(b3, 8),
		)
		selX := c.f.Mux(sel, tables[j].xs...)
		selY := c.f.Mux(sel, tables[j].ys...)
		sp := &Point{X: selX, Y: selY}
		if acc == nil {
			acc = sp
		} else {
			acc = c.Add(acc, sp)
		}
	}
	return acc
}

// Compress encodes a point in canonical RFC-8032 form and returns 32
// little-endian byte variables. It enforces y < p (canonical) via
// ToBitsCanonical, and places the sign bit (LSB of canonical x) in the top bit
// of the last byte. The output bytes can feed directly into the Blake2b-224
// credential gadget.
func (c *Curve) Compress(p *Point) [32]frontend.Variable {
	f := c.f
	yBits := f.ToBitsCanonical(p.Y) // 255 bits, enforces 0 <= y < p
	xBits := f.ToBitsCanonical(p.X) // canonical x; bit 0 is the sign
	sign := xBits[0]

	var encBits [256]frontend.Variable
	for i := 0; i < 255; i++ {
		encBits[i] = yBits[i]
	}
	encBits[255] = sign

	var out [32]frontend.Variable
	for i := 0; i < 32; i++ {
		acc := frontend.Variable(0)
		for b := 0; b < 8; b++ {
			acc = c.api.Add(acc, c.api.Mul(encBits[8*i+b], 1<<uint(b)))
		}
		out[i] = acc
	}
	return out
}
