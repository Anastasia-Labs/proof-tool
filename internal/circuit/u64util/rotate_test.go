package u64util

import (
	"math/bits"
	"math/rand"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
)

const rotationRandomCases = 1_000

var rotationShifts = [...]int{-8, 32, 40, 48}

type variableMarker struct {
	index int
}

func TestRotBytesPermutesTheSameVariables(t *testing.T) {
	var word uints.U64
	markers := [8]*variableMarker{}
	for i := range word {
		markers[i] = &variableMarker{index: i}
		word[i] = uints.U8{Val: markers[i]}
	}

	for _, shift := range rotationShifts {
		rotated := RotBytes(word, shift)
		byteShift := (shift/8 + len(word)) % len(word)
		for i := range word {
			got := rotated[(i+byteShift)%len(word)].Val
			if got != markers[i] {
				t.Fatalf("RotBytes shift %d replaced source byte %d: got %v, want marker %p", shift, i, got, markers[i])
			}
		}
	}
}

func TestRotBytesRejectsNonByteAlignedShift(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("RotBytes accepted a non-byte-aligned shift")
		}
	}()
	RotBytes(uints.U64{}, 1)
}

type rotationDifferentialCircuit struct {
	Input    [rotationRandomCases]uints.U64
	Expected [len(rotationShifts)][rotationRandomCases]uints.U64
}

func (c *rotationDifferentialCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	for i := 0; i < rotationRandomCases; i++ {
		for j, shift := range rotationShifts {
			got := RotBytes(c.Input[i], shift)
			oldPath := uapi.Lrot(c.Input[i], shift)
			assertU64Equal(bapi, got, oldPath)
			assertU64Equal(bapi, got, c.Expected[j][i])
		}
	}
	return nil
}

func TestRotBytesDifferential(t *testing.T) {
	assignment := randomizedRotationAssignment()
	ccs := compileRotationCircuit(t)
	if err := solveRotationCircuit(ccs, assignment); err != nil {
		t.Fatalf("solve 1,000 randomized byte-aligned rotation cases: %v", err)
	}

	// Keep all precomputed outputs fixed while corrupting one input byte. Every
	// optimized rotation must remain bound to the original constrained bytes.
	assignment.Input[0] = uints.NewU64(0x0123456789abcdee)
	if err := solveRotationCircuit(ccs, assignment); err == nil {
		t.Fatal("corrupt rotation input byte unexpectedly satisfied the differential circuit")
	}
}

func randomizedRotationAssignment() *rotationDifferentialCircuit {
	rng := rand.New(rand.NewSource(0xC5))
	assignment := &rotationDifferentialCircuit{}
	for i := 0; i < rotationRandomCases; i++ {
		value := rng.Uint64()
		if i == 0 {
			value = 0x0123456789abcdef
		}
		assignment.Input[i] = uints.NewU64(value)
		for j, shift := range rotationShifts {
			assignment.Expected[j][i] = uints.NewU64(bits.RotateLeft64(value, shift))
		}
	}
	return assignment
}

func assertU64Equal(bapi *uints.Bytes, got, want uints.U64) {
	for i := range got {
		bapi.AssertIsEqual(got[i], want[i])
	}
}

func compileRotationCircuit(t *testing.T) constraint.ConstraintSystem {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &rotationDifferentialCircuit{})
	if err != nil {
		t.Fatalf("compile rotation differential circuit: %v", err)
	}
	return ccs
}

func solveRotationCircuit(ccs constraint.ConstraintSystem, assignment frontend.Circuit) error {
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		return err
	}
	return ccs.IsSolved(witness)
}
