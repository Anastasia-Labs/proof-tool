package uintsopt

import (
	"fmt"
	"math/big"
	"math/rand"
	"strings"
	"testing"

	csolver "github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"
)

const mergedXorAndDifferentialCases = 1_000

type mergedXorAndInput struct{ a, b, c uint8 }

var mergedXorAndInputs = makeMergedXorAndInputs()

type mergedXorAndDifferentialCircuit struct {
	A, B, C                [mergedXorAndDifferentialCases]uints.U8
	Xor, And               [mergedXorAndDifferentialCases]uints.U8
	XorThenAnd, AndThenXor [mergedXorAndDifferentialCases]uints.U8
}

func (c *mergedXorAndDifferentialCircuit) Define(api frontend.API) error {
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	for i := range mergedXorAndInputs {
		xor := bapi.Xor(c.A[i], c.B[i])
		and := bapi.And(c.A[i], c.B[i])
		bapi.AssertIsEqual(xor, c.Xor[i])
		bapi.AssertIsEqual(and, c.And[i])
		// Exercise transitions between the production XOR and AND tables.
		bapi.AssertIsEqual(bapi.And(xor, c.C[i]), c.XorThenAnd[i])
		bapi.AssertIsEqual(bapi.Xor(and, c.C[i]), c.AndThenXor[i])
	}
	return nil
}

func TestC6DeferredSeparateXorAndTablesMatchByteReferencesAndTransitions(t *testing.T) {
	ccs := compile(t, &mergedXorAndDifferentialCircuit{})
	assignment := mergedXorAndAssignment()
	if err := solve(ccs, assignment); err != nil {
		t.Fatalf("solve 1,000 separate XOR/AND differential and transition cases: %v", err)
	}

	for _, testCase := range []struct {
		name    string
		corrupt func(*mergedXorAndDifferentialCircuit)
	}{
		{name: "xor", corrupt: func(a *mergedXorAndDifferentialCircuit) { a.Xor[17] = uints.NewU8(byteValue(a.Xor[17]) ^ 1) }},
		{name: "and", corrupt: func(a *mergedXorAndDifferentialCircuit) { a.And[29] = uints.NewU8(byteValue(a.And[29]) ^ 1) }},
		{name: "xor-to-and", corrupt: func(a *mergedXorAndDifferentialCircuit) {
			a.XorThenAnd[43] = uints.NewU8(byteValue(a.XorThenAnd[43]) ^ 1)
		}},
		{name: "and-to-xor", corrupt: func(a *mergedXorAndDifferentialCircuit) {
			a.AndThenXor[71] = uints.NewU8(byteValue(a.AndThenXor[71]) ^ 1)
		}},
	} {
		t.Run("rejects-corrupt-"+testCase.name, func(t *testing.T) {
			corrupt := mergedXorAndAssignment()
			testCase.corrupt(corrupt)
			if err := solve(ccs, corrupt); err == nil {
				t.Fatalf("corrupt %s result unexpectedly satisfied separate XOR/AND circuit", testCase.name)
			}
		})
	}
}

type c6SeparateTablesAliasCircuit struct{ A, B uints.U8 }

func (c *c6SeparateTablesAliasCircuit) Define(api frontend.API) error {
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	// Discard both results so this test exercises the production lookup
	// boundary itself, without output assertions masking a packing alias.
	_ = bapi.Xor(c.A, c.B)
	_ = bapi.And(c.A, c.B)
	return nil
}

func TestC6RejectedMultiReturnAliasCannotCrossSeparateProductionTables(t *testing.T) {
	xorHint := findByteHint(t, ".xorHint")
	andHint := findByteHint(t, ".andHint")
	ccs := compile(t, &c6SeparateTablesAliasCircuit{})
	assignment := &c6SeparateTablesAliasCircuit{
		A: uints.NewU8(0xa5),
		B: uints.NewU8(0x3c),
	}
	witness, err := frontend.NewWitness(assignment, ccs.Field())
	if err != nil {
		t.Fatalf("build witness: %v", err)
	}
	if err := ccs.IsSolved(witness); err != nil {
		t.Fatalf("honest separate XOR/AND lookups failed: %v", err)
	}

	corruptXor := func(field *big.Int, inputs, outputs []*big.Int) error {
		if len(outputs) != 1 {
			return fmt.Errorf("production XOR hint has %d returns, want exactly one", len(outputs))
		}
		if err := xorHint(field, inputs, outputs); err != nil {
			return err
		}
		outputs[0].Add(outputs[0], big.NewInt(256)).Mod(outputs[0], field)
		return nil
	}
	corruptAnd := func(field *big.Int, inputs, outputs []*big.Int) error {
		if len(outputs) != 1 {
			return fmt.Errorf("production AND hint has %d returns, want exactly one", len(outputs))
		}
		if err := andHint(field, inputs, outputs); err != nil {
			return err
		}
		outputs[0].Sub(outputs[0], big.NewInt(1)).Mod(outputs[0], field)
		return nil
	}
	if err := ccs.IsSolved(
		witness,
		csolver.OverrideHint(csolver.GetHintID(xorHint), corruptXor),
		csolver.OverrideHint(csolver.GetHintID(andHint), corruptAnd),
	); err == nil {
		t.Fatal("coordinated xor+=256/and-=1 override unexpectedly crossed separate production tables")
	}
}

func findByteHint(t *testing.T, suffix string) csolver.Hint {
	t.Helper()
	for _, hint := range uints.GetHints() {
		if strings.HasSuffix(csolver.GetHintName(hint), suffix) {
			return hint
		}
	}
	t.Fatalf("uints %s hint is not registered", suffix)
	return nil
}

func makeMergedXorAndInputs() [mergedXorAndDifferentialCases]mergedXorAndInput {
	rng := rand.New(rand.NewSource(0xC6))
	var inputs [mergedXorAndDifferentialCases]mergedXorAndInput
	edges := [...]mergedXorAndInput{
		{0, 0, 0},
		{0, 0xff, 0x55},
		{0xff, 0, 0xaa},
		{0xff, 0xff, 0xff},
	}
	copy(inputs[:], edges[:])
	for i := len(edges); i < len(inputs); i++ {
		inputs[i] = mergedXorAndInput{
			a: uint8(rng.Uint32()),
			b: uint8(rng.Uint32()),
			c: uint8(rng.Uint32()),
		}
	}
	return inputs
}

func mergedXorAndAssignment() *mergedXorAndDifferentialCircuit {
	assignment := &mergedXorAndDifferentialCircuit{}
	for i, input := range mergedXorAndInputs {
		assignment.A[i] = uints.NewU8(input.a)
		assignment.B[i] = uints.NewU8(input.b)
		assignment.C[i] = uints.NewU8(input.c)
		assignment.Xor[i] = uints.NewU8(input.a ^ input.b)
		assignment.And[i] = uints.NewU8(input.a & input.b)
		assignment.XorThenAnd[i] = uints.NewU8((input.a ^ input.b) & input.c)
		assignment.AndThenXor[i] = uints.NewU8((input.a & input.b) ^ input.c)
	}
	return assignment
}

func byteValue(value uints.U8) uint8 {
	return value.Val.(uint8)
}
