package ed

import (
	"math/big"
	"math/rand"
	"testing"

	"filippo.io/edwards25519"
	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/emulated"
)

const scalarMulRandomCases = 16

var ed25519Order = func() *big.Int {
	order := new(big.Int).Lsh(big.NewInt(1), 252)
	return order.Add(order, mustBig("27742317777372353535851937790883648493"))
}()

type scalarMulBaseDifferentialCircuit struct {
	Bits      [256]frontend.Variable
	ExpectedX emulated.Element[Ed25519Fp]
	ExpectedY emulated.Element[Ed25519Fp]
}

func (c *scalarMulBaseDifferentialCircuit) Define(api frontend.API) error {
	curve, err := NewCurve(api)
	if err != nil {
		return err
	}
	got := curve.ScalarMulBaseBits(c.Bits[:])
	curve.f.AssertIsEqual(got.X, &c.ExpectedX)
	curve.f.AssertIsEqual(got.Y, &c.ExpectedY)
	return nil
}

func TestScalarMulBaseBitsRandomizedDifferential(t *testing.T) {
	ccs := compileScalarMulCircuit(t)
	scalars := []*big.Int{
		big.NewInt(0),
		big.NewInt(1),
		big.NewInt(2),
		big.NewInt(15),
		big.NewInt(16),
		big.NewInt(127),
		big.NewInt(128),
		new(big.Int).Sub(new(big.Int).Set(ed25519Order), big.NewInt(1)),
		new(big.Int).Set(ed25519Order),
		new(big.Int).Add(new(big.Int).Set(ed25519Order), big.NewInt(1)),
		new(big.Int).Lsh(big.NewInt(1), 254),
		new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(1)),
	}

	rng := rand.New(rand.NewSource(0xED25519))
	for range scalarMulRandomCases {
		scalar := new(big.Int)
		for limb := 0; limb < 4; limb++ {
			word := new(big.Int).SetUint64(rng.Uint64())
			word.Lsh(word, uint(64*limb))
			scalar.Or(scalar, word)
		}
		scalar.SetBit(scalar, 255, 0)
		scalars = append(scalars, scalar)
	}

	for i, scalar := range scalars {
		assignment := scalarMulAssignment(t, scalar)
		if err := solveScalarMul(ccs, assignment); err != nil {
			t.Fatalf("case %d scalar %x does not match native Edwards25519: %v", i, scalar, err)
		}
	}

	corrupt := scalarMulAssignment(t, scalars[len(scalars)-1])
	x, _ := nativeScalarBaseCoordinates(t, scalars[len(scalars)-1])
	corrupt.ExpectedX = emulated.ValueOf[Ed25519Fp](new(big.Int).Add(x, big.NewInt(1)))
	if err := solveScalarMul(ccs, corrupt); err == nil {
		t.Fatal("corrupt native x-coordinate unexpectedly satisfied scalar multiplication")
	}

	// F2 remains part of the public gadget contract even though seven-bit
	// windows only consume the lower 255 scalar bits.
	highBit := new(big.Int).Lsh(big.NewInt(1), 255)
	if err := solveScalarMul(ccs, scalarMulAssignment(t, highBit)); err == nil {
		t.Fatal("scalar with bit 255 set unexpectedly satisfied the Cardano scalar domain")
	}
}

func compileScalarMulCircuit(t *testing.T) constraint.ConstraintSystem {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &scalarMulBaseDifferentialCircuit{})
	if err != nil {
		t.Fatalf("compile fixed-base scalar multiplication: %v", err)
	}
	return ccs
}

func scalarMulAssignment(t *testing.T, scalar *big.Int) *scalarMulBaseDifferentialCircuit {
	t.Helper()
	x, y := nativeScalarBaseCoordinates(t, scalar)
	assignment := &scalarMulBaseDifferentialCircuit{
		ExpectedX: emulated.ValueOf[Ed25519Fp](x),
		ExpectedY: emulated.ValueOf[Ed25519Fp](y),
	}
	for i := range assignment.Bits {
		assignment.Bits[i] = scalar.Bit(i)
	}
	return assignment
}

func nativeScalarBaseCoordinates(t *testing.T, scalar *big.Int) (*big.Int, *big.Int) {
	t.Helper()
	reduced := new(big.Int).Mod(new(big.Int).Set(scalar), ed25519Order)
	scalarBytes := littleEndian32(reduced)
	nativeScalar, err := new(edwards25519.Scalar).SetCanonicalBytes(scalarBytes[:])
	if err != nil {
		t.Fatalf("construct canonical native scalar: %v", err)
	}
	point := new(edwards25519.Point).ScalarBaseMult(nativeScalar)
	xProjective, yProjective, zProjective, _ := point.ExtendedCoordinates()
	zInverse := zProjective.Invert(zProjective)
	xAffine := xProjective.Multiply(xProjective, zInverse)
	yAffine := yProjective.Multiply(yProjective, zInverse)
	return littleEndianInt(xAffine.Bytes()), littleEndianInt(yAffine.Bytes())
}

func littleEndian32(value *big.Int) [32]byte {
	var out [32]byte
	bytes := value.Bytes()
	for i := range bytes {
		out[i] = bytes[len(bytes)-1-i]
	}
	return out
}

func littleEndianInt(value []byte) *big.Int {
	reversed := make([]byte, len(value))
	for i := range value {
		reversed[len(value)-1-i] = value[i]
	}
	return new(big.Int).SetBytes(reversed)
}

func solveScalarMul(ccs constraint.ConstraintSystem, assignment frontend.Circuit) error {
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		return err
	}
	return ccs.IsSolved(witness)
}
