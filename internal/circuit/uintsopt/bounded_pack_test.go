package uintsopt

import (
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
)

type boundedPackCircuit struct {
	Low, Middle, High frontend.Variable
	Expected          frontend.Variable
}

func (c *boundedPackCircuit) Define(api frontend.API) error {
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	parts := []frontend.Variable{c.Low, c.Middle, c.High}
	widths := []int{3, 2, 3}
	packed := bapi.PackLSBConstrained(parts, widths)
	// Repacking the same exact-width components exercises proof reuse. The
	// returned byte carries its proven bound without another external check.
	repacked := bapi.PackLSBConstrained(parts, widths)
	bapi.AssertIsEqual(packed, repacked)
	api.AssertIsEqual(bapi.Value(packed), c.Expected)
	return nil
}

func TestPackLSBConstrainedProvesEveryComponentBound(t *testing.T) {
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &boundedPackCircuit{})
	if err != nil {
		t.Fatalf("compile bounded byte packer: %v", err)
	}
	valid := &boundedPackCircuit{Low: 5, Middle: 2, High: 7, Expected: 245}
	if err := solve(ccs, valid); err != nil {
		t.Fatalf("solve valid bounded byte packing: %v", err)
	}

	tests := []struct {
		name       string
		assignment *boundedPackCircuit
	}{
		{name: "low exceeds three bits", assignment: &boundedPackCircuit{Low: 8, Middle: 2, High: 7, Expected: 248}},
		{name: "middle exceeds two bits", assignment: &boundedPackCircuit{Low: 5, Middle: 4, High: 7, Expected: 261}},
		{name: "high exceeds three bits", assignment: &boundedPackCircuit{Low: 5, Middle: 2, High: 8, Expected: 277}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := solve(ccs, test.assignment); err == nil {
				t.Fatal("out-of-range component unexpectedly satisfied bounded byte packing")
			}
		})
	}
}

type boundedPackWidthCacheCircuit struct {
	Value frontend.Variable
}

func (c *boundedPackWidthCacheCircuit) Define(api frontend.API) error {
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	_ = bapi.PackLSBConstrained([]frontend.Variable{c.Value, 0}, []int{4, 4})
	_ = bapi.PackLSBConstrained([]frontend.Variable{c.Value, 0}, []int{3, 5})
	return nil
}

func TestPackLSBConstrainedCacheIncludesExactWidth(t *testing.T) {
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &boundedPackWidthCacheCircuit{})
	if err != nil {
		t.Fatalf("compile exact-width cache circuit: %v", err)
	}
	if err := solve(ccs, &boundedPackWidthCacheCircuit{Value: 7}); err != nil {
		t.Fatalf("solve value valid at both cached widths: %v", err)
	}
	if err := solve(ccs, &boundedPackWidthCacheCircuit{Value: 8}); err == nil {
		t.Fatal("four-bit proof unexpectedly suppressed the required three-bit check")
	}
}
