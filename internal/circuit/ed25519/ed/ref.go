package ed

import "math/big"

// RefPoint is an affine twisted-Edwards point over Fp, used for out-of-circuit
// reference computation (precomputed windowed tables and test cross-checks).
type RefPoint struct {
	X, Y *big.Int
}

func modp(v *big.Int) *big.Int {
	r := new(big.Int).Mod(v, P)
	if r.Sign() < 0 {
		r.Add(r, P)
	}
	return r
}

func fpMul(a, b *big.Int) *big.Int { return modp(new(big.Int).Mul(a, b)) }
func fpAdd(a, b *big.Int) *big.Int { return modp(new(big.Int).Add(a, b)) }
func fpSub(a, b *big.Int) *big.Int { return modp(new(big.Int).Sub(a, b)) }
func fpInv(a *big.Int) *big.Int    { return new(big.Int).ModInverse(modp(a), P) }

// RefIdentity returns the twisted-Edwards neutral element (0, 1).
func RefIdentity() RefPoint {
	return RefPoint{X: big.NewInt(0), Y: big.NewInt(1)}
}

// RefBase returns the Ed25519 basepoint B.
func RefBase() RefPoint {
	return RefPoint{X: new(big.Int).Set(Bx), Y: new(big.Int).Set(By)}
}

// RefAdd is the complete/unified twisted-Edwards addition for a = -1:
//
//	x3 = (x1*y2 + y1*x2) / (1 + d*x1*x2*y1*y2)
//	y3 = (y1*y2 + x1*x2) / (1 - d*x1*x2*y1*y2)
//
// It is the exact out-of-circuit analogue of (*Curve).Add and is unified
// (handles doubling and the identity).
func RefAdd(p, q RefPoint) RefPoint {
	a := fpMul(p.X, q.Y)
	b := fpMul(p.Y, q.X)
	c := fpMul(p.X, q.X)
	dd := fpMul(p.Y, q.Y)
	e := fpMul(D, fpMul(c, dd))
	one := big.NewInt(1)
	xnum := fpAdd(a, b)
	xden := fpAdd(one, e)
	ynum := fpAdd(dd, c)
	yden := fpSub(one, e)
	return RefPoint{
		X: fpMul(xnum, fpInv(xden)),
		Y: fpMul(ynum, fpInv(yden)),
	}
}

// RefScalarMul computes s*P by left-to-right double-and-add over the bits of s
// (s used as-is, full integer value, no reduction mod L).
func RefScalarMul(s *big.Int, p RefPoint) RefPoint {
	acc := RefIdentity()
	for i := s.BitLen() - 1; i >= 0; i-- {
		acc = RefAdd(acc, acc)
		if s.Bit(i) == 1 {
			acc = RefAdd(acc, p)
		}
	}
	return acc
}

// RefScalarMulBase computes s*B.
func RefScalarMulBase(s *big.Int) RefPoint { return RefScalarMul(s, RefBase()) }

// RefCompress encodes an affine point in RFC-8032 form: 32 little-endian bytes
// of y, with the LSB of x stored in the most-significant bit of the last byte.
func RefCompress(p RefPoint) [32]byte {
	y := modp(p.Y)
	var out [32]byte
	yb := y.Bytes() // big-endian
	// little-endian fill
	for i := 0; i < len(yb); i++ {
		out[i] = yb[len(yb)-1-i]
	}
	if modp(p.X).Bit(0) == 1 {
		out[31] |= 0x80
	}
	return out
}
