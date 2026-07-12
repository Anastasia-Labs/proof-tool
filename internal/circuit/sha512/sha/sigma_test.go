package sha

import (
	"math/big"
	"math/bits"
	"math/rand"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
	"github.com/consensys/gnark/std/rangecheck"
)

const sigmaRandomCases = 1_000

func TestSigmaCutPositionsDerivedFromOperations(t *testing.T) {
	tests := []struct {
		name       string
		rotations  []int
		rightShift int
		wantCuts   []int
		wantWidths []int
	}{
		{name: "Sigma1", rotations: []int{14, 18, 41}, wantCuts: []int{1, 2, 6}, wantWidths: []int{1, 1, 4, 2}},
		{name: "Sigma0", rotations: []int{28, 34, 39}, wantCuts: []int{2, 4, 7}, wantWidths: []int{2, 2, 3, 1}},
		{name: "sigma0", rotations: []int{1, 8}, rightShift: 7, wantCuts: []int{1, 7}, wantWidths: []int{1, 6, 1}},
		{name: "sigma1", rotations: []int{19, 61}, rightShift: 6, wantCuts: []int{3, 5, 6}, wantWidths: []int{3, 2, 1, 2}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cuts := sigmaCutPositions(test.rotations, test.rightShift)
			assertIntsEqual(t, cuts, test.wantCuts)
			assertIntsEqual(t, widthsFromCuts(cuts), test.wantWidths)
		})
	}
}

type sigmaDifferentialCircuit struct {
	Words                          [sigmaRandomCases]uints.U64
	ExpectedBig1, ExpectedBig0     [sigmaRandomCases]uints.U64
	ExpectedSmall0, ExpectedSmall1 [sigmaRandomCases]uints.U64
}

func (c *sigmaDifferentialCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	rc := rangecheck.New(api)
	for i := range c.Words {
		gotBig1 := sigmaRot(api, uapi, rc, c.Words[i], []int{14, 18, 41}, 0)
		legacyBig1 := uapi.Xor(
			uapi.Lrot(c.Words[i], -14),
			uapi.Lrot(c.Words[i], -18),
			uapi.Lrot(c.Words[i], -41),
		)
		gotBig0 := sigmaRot(api, uapi, rc, c.Words[i], []int{28, 34, 39}, 0)
		legacyBig0 := uapi.Xor(
			uapi.Lrot(c.Words[i], -28),
			uapi.Lrot(c.Words[i], -34),
			uapi.Lrot(c.Words[i], -39),
		)
		gotSmall0 := sigmaRot(api, uapi, rc, c.Words[i], []int{1, 8}, 7)
		legacySmall0 := uapi.Xor(
			uapi.Lrot(c.Words[i], -1),
			uapi.Lrot(c.Words[i], -8),
			uapi.Rshift(c.Words[i], 7),
		)
		gotSmall1 := sigmaRot(api, uapi, rc, c.Words[i], []int{19, 61}, 6)
		legacySmall1 := uapi.Xor(
			uapi.Lrot(c.Words[i], -19),
			uapi.Lrot(c.Words[i], -61),
			uapi.Rshift(c.Words[i], 6),
		)
		uapi.AssertEq(gotBig1, legacyBig1)
		uapi.AssertEq(gotBig1, c.ExpectedBig1[i])
		uapi.AssertEq(gotBig0, legacyBig0)
		uapi.AssertEq(gotBig0, c.ExpectedBig0[i])
		uapi.AssertEq(gotSmall0, legacySmall0)
		uapi.AssertEq(gotSmall0, c.ExpectedSmall0[i])
		uapi.AssertEq(gotSmall1, legacySmall1)
		uapi.AssertEq(gotSmall1, c.ExpectedSmall1[i])
	}
	return nil
}

func TestSigmaRotFusedMatchesLegacyAndReference(t *testing.T) {
	assignment := sigmaAssignment()
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &sigmaDifferentialCircuit{})
	if err != nil {
		t.Fatalf("compile fused sigma differential: %v", err)
	}
	if err := solveCircuit(ccs, assignment); err != nil {
		t.Fatalf("solve %d fused/legacy/reference cases for all SHA-512 sigmas: %v", sigmaRandomCases, err)
	}

	assignment.Words[0] = uints.NewU64(1)
	if err := solveCircuit(ccs, assignment); err == nil {
		t.Fatal("corrupt sigma input unexpectedly preserved the reference outputs")
	}
}

type sigmaByteDecompositionCircuit struct {
	Input  frontend.Variable
	widths []int
}

func (c *sigmaByteDecompositionCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	input := uapi.ByteValueOf(c.Input)
	_ = decomposeSigmaByte(api, uapi, rangecheck.New(api), input, c.widths)
	return nil
}

func TestSigmaChunkHintRejectsEachOneSidedCorruption(t *testing.T) {
	corruptions := []solver.Hint{corruptSigmaChunk0, corruptSigmaChunk1, corruptSigmaChunk2, corruptSigmaChunk3}
	tests := []struct {
		name   string
		widths []int
	}{
		{name: "Sigma1", widths: []int{1, 1, 4, 2}},
		{name: "Sigma0", widths: []int{2, 2, 3, 1}},
		{name: "sigma0", widths: []int{1, 6, 1}},
		{name: "sigma1", widths: []int{3, 2, 1, 2}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &sigmaByteDecompositionCircuit{widths: test.widths})
			if err != nil {
				t.Fatalf("compile sigma chunk decomposition: %v", err)
			}
			witness, err := frontend.NewWitness(&sigmaByteDecompositionCircuit{Input: 0x5a}, ecc.BLS12_381.ScalarField())
			if err != nil {
				t.Fatalf("build sigma chunk witness: %v", err)
			}
			for index, corruption := range corruptions[:len(test.widths)] {
				if err := ccs.IsSolved(witness, solver.OverrideHint(solver.GetHintID(sigmaChunksHint), corruption)); err == nil {
					t.Fatalf("one-sided corruption of chunk %d unexpectedly satisfied recomposition/range constraints", index)
				}
			}
		})
	}
}

func sigmaAssignment() *sigmaDifferentialCircuit {
	rng := rand.New(rand.NewSource(0xC1))
	assignment := &sigmaDifferentialCircuit{}
	for i := range assignment.Words {
		word := rng.Uint64()
		switch {
		case i == 0:
			word = 0
		case i == 1:
			word = ^uint64(0)
		case i >= 2 && i < 66:
			word = uint64(1) << (i - 2)
		}
		assignment.Words[i] = uints.NewU64(word)
		assignment.ExpectedBig1[i] = uints.NewU64(bits.RotateLeft64(word, -14) ^ bits.RotateLeft64(word, -18) ^ bits.RotateLeft64(word, -41))
		assignment.ExpectedBig0[i] = uints.NewU64(bits.RotateLeft64(word, -28) ^ bits.RotateLeft64(word, -34) ^ bits.RotateLeft64(word, -39))
		assignment.ExpectedSmall0[i] = uints.NewU64(bits.RotateLeft64(word, -1) ^ bits.RotateLeft64(word, -8) ^ (word >> 7))
		assignment.ExpectedSmall1[i] = uints.NewU64(bits.RotateLeft64(word, -19) ^ bits.RotateLeft64(word, -61) ^ (word >> 6))
	}
	return assignment
}

func corruptSigmaChunk0(field *big.Int, inputs, outputs []*big.Int) error {
	return corruptSigmaChunk(field, inputs, outputs, 0)
}

func corruptSigmaChunk1(field *big.Int, inputs, outputs []*big.Int) error {
	return corruptSigmaChunk(field, inputs, outputs, 1)
}

func corruptSigmaChunk2(field *big.Int, inputs, outputs []*big.Int) error {
	return corruptSigmaChunk(field, inputs, outputs, 2)
}

func corruptSigmaChunk3(field *big.Int, inputs, outputs []*big.Int) error {
	return corruptSigmaChunk(field, inputs, outputs, 3)
}

func corruptSigmaChunk(field *big.Int, inputs, outputs []*big.Int, index int) error {
	if err := sigmaChunksHint(field, inputs, outputs); err != nil {
		return err
	}
	outputs[index].Add(outputs[index], big.NewInt(1)).Mod(outputs[index], field)
	return nil
}

func assertIntsEqual(t *testing.T, got, want []int) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("length = %d, want %d (%v vs %v)", len(got), len(want), got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("index %d = %d, want %d (%v vs %v)", i, got[i], want[i], got, want)
		}
	}
}
