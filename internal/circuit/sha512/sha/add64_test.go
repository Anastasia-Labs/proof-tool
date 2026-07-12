package sha

import (
	"fmt"
	"math/big"
	"math/rand"
	"runtime"
	"sync"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/constraint"
	csolver "github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/bitslice"
	"github.com/consensys/gnark/std/math/uints"
	"github.com/consensys/gnark/std/rangecheck"
)

const (
	add64RandomCases  = 1_000
	add64SolveWorkers = 8
)

type add64DifferentialCircuit struct {
	Words          [8]uints.U64
	ExpectedPrefix [4]uints.U64
	ExpectedE      uints.U64
	ExpectedA      uints.U64
}

func (c *add64DifferentialCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	rc := rangecheck.New(api)

	// Exercise every direct C3 arity/width class against gnark's prior Add
	// path and an independently precomputed Go uint64 result.
	prefixSpecs := []struct {
		arity  int
		hiBits int
	}{
		{arity: 2, hiBits: 1},
		{arity: 3, hiBits: 2},
		{arity: 4, hiBits: 2},
		{arity: 7, hiBits: 3},
	}
	for i, spec := range prefixSpecs {
		got := Add64(api, uapi, rc, spec.hiBits, c.Words[:spec.arity]...)
		oldPath := uapi.Add(c.Words[:spec.arity]...)
		assertU64Equal(bapi, got, oldPath)
		assertU64Equal(bapi, got, c.ExpectedPrefix[i])
	}

	// Mirror the SHA-512 round's deferred t1/t2 shape. The native sums are not
	// materialized independently; only e=d+t1 and a=t1+t2 become U64 bytes.
	t1 := NativeSum64(api, uapi, c.Words[0:5]...)
	t2 := NativeSum64(api, uapi, c.Words[5:7]...)
	e := Materialize64(api, uapi, rc, api.Add(uapi.ToValue(c.Words[7]), t1), 3)
	a := Materialize64(api, uapi, rc, api.Add(t1, t2), 3)
	oldT1 := uapi.Add(c.Words[0:5]...)
	oldT2 := uapi.Add(c.Words[5:7]...)
	assertU64Equal(bapi, e, uapi.Add(c.Words[7], oldT1))
	assertU64Equal(bapi, a, uapi.Add(oldT1, oldT2))
	assertU64Equal(bapi, e, c.ExpectedE)
	assertU64Equal(bapi, a, c.ExpectedA)
	return nil
}

func TestAdd64RandomizedVectorDifferentialAndCorruption(t *testing.T) {
	ccs := compileCircuit(t, &add64DifferentialCircuit{})
	assignments := randomizedAdd64Assignments()
	if err := solveAdd64Batch(ccs, assignments, add64SolveWorkers); err != nil {
		t.Fatalf("solve %d randomized/vector add64 differentials: %v", len(assignments), err)
	}

	// Keep every expected result fixed and corrupt one load-bearing input bit.
	corruptInput := *assignments[4]
	corruptInput.Words[0] = uints.NewU64(wordValue(assignments[4].Words[0]) ^ 1)
	if err := solveCircuit(ccs, &corruptInput); err == nil {
		t.Fatal("corrupt add64 input bit unexpectedly preserved all expected sums")
	}

	// Isolate the C3 partition from the old uapi.Add oracle before overriding
	// the globally identified partition hint. Otherwise corruption of an old
	// path partition could reject independently and mask a missing C3 check.
	partitionHint := bitslice.GetHints()[0]
	partitionHintID := csolver.GetHintID(partitionHint)
	hintCCS := compileCircuit(t, &add64HintCorruptionCircuit{})
	hintAssignment := &add64HintCorruptionCircuit{
		Words:    [2]uints.U64{uints.NewU64(^uint64(0)), uints.NewU64(9)},
		Expected: uints.NewU64(8),
	}
	witness, err := frontend.NewWitness(hintAssignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		t.Fatalf("build add64 corruption witness: %v", err)
	}
	// Partition's hint outputs are (hi, lo). Corrupt each output independently;
	// recomposition plus the explicit bounds must reject.
	if err := hintCCS.IsSolved(witness, csolver.OverrideHint(partitionHintID, corruptPartitionLowHint)); err == nil {
		t.Fatal("corrupt add64 low-limb hint unexpectedly satisfied recomposition")
	}
	if err := hintCCS.IsSolved(witness, csolver.OverrideHint(partitionHintID, corruptPartitionHighHint)); err == nil {
		t.Fatal("corrupt add64 high-limb hint unexpectedly satisfied recomposition")
	}
}

type add64HintCorruptionCircuit struct {
	Words    [2]uints.U64
	Expected uints.U64
}

func (c *add64HintCorruptionCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	got := Add64(api, uapi, rangecheck.New(api), 1, c.Words[:]...)
	assertU64Equal(bapi, got, c.Expected)
	return nil
}

type underboundedAdd64Circuit struct {
	Words    [5]uints.U64
	Expected uints.U64
}

func (c *underboundedAdd64Circuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	// Five maximal U64s carry hi=4, which cannot fit in this deliberately
	// under-declared 2-bit limb. This negative guards the per-site width audit.
	got := Add64(api, uapi, rangecheck.New(api), 2, c.Words[:]...)
	assertU64Equal(bapi, got, c.Expected)
	return nil
}

func TestAdd64RejectsUnderboundedHighLimb(t *testing.T) {
	assignment := &underboundedAdd64Circuit{Expected: uints.NewU64(^uint64(0) - 4)}
	for i := range assignment.Words {
		assignment.Words[i] = uints.NewU64(^uint64(0))
	}
	ccs := compileCircuit(t, &underboundedAdd64Circuit{})
	if err := solveCircuit(ccs, assignment); err == nil {
		t.Fatal("five-word sum with hi=4 unexpectedly fit a 2-bit high limb")
	}
}

func randomizedAdd64Assignments() []*add64DifferentialCircuit {
	rng := rand.New(rand.NewSource(0xC3))
	assignments := make([]*add64DifferentialCircuit, add64RandomCases)
	vectors := [][8]uint64{
		{},
		{^uint64(0), ^uint64(0), ^uint64(0), ^uint64(0), ^uint64(0), ^uint64(0), ^uint64(0), ^uint64(0)},
		{^uint64(0), 1},
		{0xaaaaaaaaaaaaaaaa, 0x5555555555555555, 0x8000000000000000, 0x7fffffffffffffff, 1, ^uint64(0), 2, 3},
	}
	for i := range assignments {
		var words [8]uint64
		if i < len(vectors) {
			words = vectors[i]
		} else {
			for j := range words {
				words[j] = rng.Uint64()
			}
		}
		assignment := &add64DifferentialCircuit{}
		for j := range words {
			assignment.Words[j] = uints.NewU64(words[j])
		}
		for j, arity := range []int{2, 3, 4, 7} {
			assignment.ExpectedPrefix[j] = uints.NewU64(sum64(words[:arity]))
		}
		assignment.ExpectedE = uints.NewU64(words[7] + sum64(words[:5]))
		assignment.ExpectedA = uints.NewU64(sum64(words[:7]))
		assignments[i] = assignment
	}
	return assignments
}

func sum64(words []uint64) uint64 {
	var sum uint64
	for _, word := range words {
		sum += word
	}
	return sum
}

func wordValue(word uints.U64) uint64 {
	var value uint64
	for i := range word {
		byteValue, ok := word[i].Val.(uint8)
		if !ok {
			panic("add64 test word is not a constant uint8 assignment")
		}
		value |= uint64(byteValue) << (8 * i)
	}
	return value
}

func corruptPartitionLowHint(field *big.Int, inputs, outputs []*big.Int) error {
	if err := bitslice.GetHints()[0](field, inputs, outputs); err != nil {
		return err
	}
	outputs[1].Add(outputs[1], big.NewInt(1)).Mod(outputs[1], field)
	return nil
}

func corruptPartitionHighHint(field *big.Int, inputs, outputs []*big.Int) error {
	if err := bitslice.GetHints()[0](field, inputs, outputs); err != nil {
		return err
	}
	outputs[0].Add(outputs[0], big.NewInt(1)).Mod(outputs[0], field)
	return nil
}

func solveAdd64Batch(ccs constraint.ConstraintSystem, assignments []*add64DifferentialCircuit, workers int) error {
	if workers < 1 {
		workers = 1
	}
	if available := runtime.GOMAXPROCS(0); workers > available {
		workers = available
	}
	jobs := make(chan int)
	errs := make(chan error, len(assignments))
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				witness, err := frontend.NewWitness(assignments[index], ecc.BLS12_381.ScalarField())
				if err == nil {
					err = ccs.IsSolved(witness, csolver.WithNbTasks(1))
				}
				if err != nil {
					errs <- fmt.Errorf("case %d: %w", index, err)
				}
			}
		}()
	}
	for index := range assignments {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	close(errs)
	for err := range errs {
		return err
	}
	return nil
}
