package uintsopt

import (
	"math/rand"
	"strings"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
)

const differentialCases = 1_000

var differentialInputs = makeDifferentialInputs()

type byteOperationDifferentialCircuit struct {
	A, B                    [differentialCases]uints.U8
	Xor, And, Or, XorWithFF [differentialCases]uints.U8
}

func (c *byteOperationDifferentialCircuit) Define(api frontend.API) error {
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	for i, input := range differentialInputs {
		constantA, constantB := uints.NewU8(input.a), uints.NewU8(input.b)

		constantXor := bapi.Xor(constantA, constantB)
		constantAnd := bapi.And(constantA, constantB)
		constantOr := bapi.Or(constantA, constantB)
		constantXorWithFF := bapi.Xor(constantA, constantB, uints.NewU8(0xff))

		witnessXor := bapi.Xor(c.A[i], c.B[i])
		witnessAnd := bapi.And(c.A[i], c.B[i])
		witnessOr := bapi.Or(c.A[i], c.B[i])
		witnessXorWithFF := bapi.Xor(c.A[i], c.B[i], uints.NewU8(0xff))

		for _, equality := range [][2]uints.U8{
			{constantXor, witnessXor},
			{constantAnd, witnessAnd},
			{constantOr, witnessOr},
			{constantXorWithFF, witnessXorWithFF},
			{witnessXor, c.Xor[i]},
			{witnessAnd, c.And[i]},
			{witnessOr, c.Or[i]},
			{witnessXorWithFF, c.XorWithFF[i]},
		} {
			bapi.AssertIsEqual(equality[0], equality[1])
		}
	}
	return nil
}

type constantEdgeCircuit struct{}

func (*constantEdgeCircuit) Define(api frontend.API) error {
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	checks := [][2]uints.U8{
		{bapi.Xor(), uints.NewU8(0)},
		{bapi.And(), uints.NewU8(0)},
		{bapi.Or(), uints.NewU8(0)},
		{bapi.Xor(uints.NewU8(0xff)), uints.NewU8(0xff)},
		{bapi.And(uints.NewU8(0xff)), uints.NewU8(0xff)},
		{bapi.Or(uints.NewU8(0xff)), uints.NewU8(0xff)},
		{bapi.Xor(uints.NewU8(0), uints.NewU8(0xff)), uints.NewU8(0xff)},
		{bapi.And(uints.NewU8(0), uints.NewU8(0xff)), uints.NewU8(0)},
		{bapi.Or(uints.NewU8(0), uints.NewU8(0xff)), uints.NewU8(0xff)},
		{bapi.Xor(uints.NewU8(0xaa), uints.NewU8(0x55), uints.NewU8(0xff)), uints.NewU8(0)},
		{bapi.And(uints.NewU8(0xff), uints.NewU8(0x0f), uints.NewU8(0xf3)), uints.NewU8(0x03)},
		{bapi.Or(uints.NewU8(0x80), uints.NewU8(0x08), uints.NewU8(0x01)), uints.NewU8(0x89)},
	}
	for _, check := range checks {
		bapi.AssertIsEqual(check[0], check[1])
	}
	return nil
}

func TestC8ConstantFoldMatchesLookupTablesAndByteReferences(t *testing.T) {
	ccs := compile(t, &byteOperationDifferentialCircuit{})
	assignment := differentialAssignment()
	if err := solve(ccs, assignment); err != nil {
		t.Fatalf("solve 1,000 constant-vs-lookup byte-operation cases: %v", err)
	}

	// Keep every expected result fixed while corrupting one witness byte. The
	// mixed/nonconstant lookup path must remain constrained after C8.
	assignment.A[0] = uints.NewU8(differentialInputs[0].a ^ 1)
	if err := solve(ccs, assignment); err == nil {
		t.Fatal("corrupt nonconstant byte unexpectedly satisfied C8 differential circuit")
	}
}

func TestC8ConstantOnlyEdgesNeedNoLookupConstraints(t *testing.T) {
	ccs := compile(t, &constantEdgeCircuit{})
	if got := ccs.GetNbConstraints(); got != 0 {
		t.Fatalf("constant-only byte operations emitted %d constraints, want 0", got)
	}
	if err := solve(ccs, &constantEdgeCircuit{}); err != nil {
		t.Fatalf("solve constant-only edge circuit: %v", err)
	}
}

type constantPrefixMixedCircuit struct {
	Input        uints.U8
	Xor, And, Or uints.U8
}

func (c *constantPrefixMixedCircuit) Define(api frontend.API) error {
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	// The first query in each variadic operation folds to a Go uint8 constant;
	// the next query must consume that constant together with a real witness
	// through the original lookup path.
	bapi.AssertIsEqual(
		bapi.Xor(uints.NewU8(0xaa), uints.NewU8(0x55), c.Input),
		c.Xor,
	)
	bapi.AssertIsEqual(
		bapi.And(uints.NewU8(0xf3), uints.NewU8(0x0f), c.Input),
		c.And,
	)
	bapi.AssertIsEqual(
		bapi.Or(uints.NewU8(0x80), uints.NewU8(0x08), c.Input),
		c.Or,
	)
	return nil
}

func TestC8ConstantPrefixFeedsTheNonconstantLookupPath(t *testing.T) {
	ccs := compile(t, &constantPrefixMixedCircuit{})
	assignment := &constantPrefixMixedCircuit{
		Input: uints.NewU8(0x0f),
		Xor:   uints.NewU8(0xf0), // (0xaa xor 0x55) xor 0x0f
		And:   uints.NewU8(0x03), // (0xf3 and 0x0f) and 0x0f
		Or:    uints.NewU8(0x8f), // (0x80 or 0x08) or 0x0f
	}
	if err := solve(ccs, assignment); err != nil {
		t.Fatalf("solve constant-prefix to witness lookup transition: %v", err)
	}

	assignment.Input = uints.NewU8(0x0e)
	if err := solve(ccs, assignment); err == nil {
		t.Fatal("corrupt witness unexpectedly satisfied constant-prefix lookup circuit")
	}
}

type negativeConstantCircuit struct{}
type tooWideConstantCircuit struct{}

func (*negativeConstantCircuit) Define(api frontend.API) error {
	return defineInvalidConstant(api, -1)
}

func (*tooWideConstantCircuit) Define(api frontend.API) error {
	return defineInvalidConstant(api, 256)
}

func defineInvalidConstant(api frontend.API, value frontend.Variable) error {
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	_ = bapi.Xor(uints.U8{Val: value}, uints.NewU8(0))
	return nil
}

func TestC8InvalidConstantsRetainPreFoldWidthRejection(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		value   frontend.Variable
		circuit frontend.Circuit
	}{
		{name: "negative", value: -1, circuit: &negativeConstantCircuit{}},
		{name: "too-wide", value: 256, circuit: &tooWideConstantCircuit{}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := frontend.Compile(
				ecc.BLS12_381.ScalarField(),
				r1cs.NewBuilder,
				testCase.circuit,
			)
			if err == nil {
				t.Fatalf("constant %v unexpectedly bypassed U8 width enforcement", testCase.value)
			}
			if !strings.Contains(err.Error(), "is too large for U8") {
				t.Fatalf("constant %v rejection = %v, want pre-fold U8 width error", testCase.value, err)
			}
		})
	}
}

type bytePair struct{ a, b uint8 }

func makeDifferentialInputs() [differentialCases]bytePair {
	rng := rand.New(rand.NewSource(0xC8))
	var inputs [differentialCases]bytePair
	edges := [...]bytePair{{0, 0}, {0, 0xff}, {0xff, 0}, {0xff, 0xff}}
	copy(inputs[:], edges[:])
	for i := len(edges); i < len(inputs); i++ {
		inputs[i] = bytePair{a: uint8(rng.Uint32()), b: uint8(rng.Uint32())}
	}
	return inputs
}

func differentialAssignment() *byteOperationDifferentialCircuit {
	assignment := &byteOperationDifferentialCircuit{}
	for i, input := range differentialInputs {
		assignment.A[i] = uints.NewU8(input.a)
		assignment.B[i] = uints.NewU8(input.b)
		assignment.Xor[i] = uints.NewU8(input.a ^ input.b)
		assignment.And[i] = uints.NewU8(input.a & input.b)
		assignment.Or[i] = uints.NewU8(input.a | input.b)
		assignment.XorWithFF[i] = uints.NewU8(input.a ^ input.b ^ 0xff)
	}
	return assignment
}

func compile(t *testing.T, circuit frontend.Circuit) constraint.ConstraintSystem {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, circuit)
	if err != nil {
		t.Fatalf("compile circuit: %v", err)
	}
	return ccs
}

func solve(ccs constraint.ConstraintSystem, assignment frontend.Circuit) error {
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		return err
	}
	return ccs.IsSolved(witness)
}
