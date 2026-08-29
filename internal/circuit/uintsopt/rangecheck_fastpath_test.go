package uintsopt

import (
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/rangecheck"
)

var singleLimbWidths = [...]int{2, 3, 4, 5, 6, 7, 8}

type singleLimbRangecheckCircuit struct {
	Values [len(singleLimbWidths)]frontend.Variable
}

func (c *singleLimbRangecheckCircuit) Define(api frontend.API) error {
	checker := rangecheck.New(api, rangecheck.WithBaseLength(8))
	for i, width := range singleLimbWidths {
		checker.Check(c.Values[i], width)
	}
	return nil
}

func TestSingleLimbRangecheckFastPathKeepsExactBounds(t *testing.T) {
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &singleLimbRangecheckCircuit{})
	if err != nil {
		t.Fatalf("compile single-limb range-check circuit: %v", err)
	}

	// One 8-bit table, 13 lookup queries (two for each partial-width value and
	// one for the full byte), and the lookup argument's final equality. A
	// single-limb fast path must not emit seven redundant hint recompositions.
	const wantConstraints = 271
	if got := ccs.GetNbConstraints(); got != wantConstraints {
		t.Fatalf("single-limb range-check constraints = %d, want %d", got, wantConstraints)
	}

	valid := &singleLimbRangecheckCircuit{}
	for i, width := range singleLimbWidths {
		valid.Values[i] = (1 << width) - 1
	}
	if err := solveSingleLimbRangecheck(ccs, valid); err != nil {
		t.Fatalf("maximum in-range values do not solve: %v", err)
	}

	for i, width := range singleLimbWidths {
		invalid := *valid
		invalid.Values[i] = 1 << width
		if err := solveSingleLimbRangecheck(ccs, &invalid); err == nil {
			t.Errorf("%d-bit range check accepted boundary value %d", width, 1<<width)
		}
	}
}

func solveSingleLimbRangecheck(ccs constraint.ConstraintSystem, assignment frontend.Circuit) error {
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		return err
	}
	return ccs.IsSolved(witness)
}
