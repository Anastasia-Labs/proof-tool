package sha

import (
	"encoding/binary"
	"fmt"
	"math/rand"
	"runtime"
	"sync"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/constraint"
	csolver "github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
)

const (
	hmacPairRandomCases  = 1_000
	hmacPairSolveWorkers = 8
)

func TestHMACSHA512PairFullLengthPadding(t *testing.T) {
	tests := []struct {
		name        string
		suffixBytes int
		wantBitLen  uint64
	}{
		{name: "hardened-inner-128-plus-69", suffixBytes: 69, wantBitLen: (128 + 69) * 8},
		{name: "soft-inner-128-plus-37", suffixBytes: 37, wantBitLen: (128 + 37) * 8},
		{name: "outer-128-plus-64", suffixBytes: 64, wantBitLen: (128 + 64) * 8},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			suffix := make([]uints.U8, test.suffixBytes)
			for i := range suffix {
				suffix[i] = uints.NewU8(uint8(i))
			}
			padded := padSHA512AfterPrefix(blockSize512, suffix)
			if len(padded) != blockSize512 {
				t.Fatalf("padded suffix length = %d, want one 128-byte block", len(padded))
			}
			if got := constantU8(t, padded[test.suffixBytes]); got != 0x80 {
				t.Fatalf("padding marker = 0x%02x, want 0x80", got)
			}
			var encodedLength [16]byte
			for i := range encodedLength {
				encodedLength[i] = constantU8(t, padded[len(padded)-16+i])
			}
			if got := binary.BigEndian.Uint64(encodedLength[:8]); got != 0 {
				t.Fatalf("high 64 bits of SHA-512 length = %d, want 0", got)
			}
			if got := binary.BigEndian.Uint64(encodedLength[8:]); got != test.wantBitLen {
				t.Fatalf("encoded full bit length = %d, want %d", got, test.wantBitLen)
			}
		})
	}
}

type hmacPairRandomCircuit struct {
	Key                  [32]uints.U8
	Message1, Message2   [37]uints.U8
	Expected1, Expected2 [64]uints.U8
}

func (c *hmacPairRandomCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	mac1, mac2 := HMACSHA512Pair(api, uapi, bapi, c.Key[:], c.Message1[:], c.Message2[:])
	assertBytesEqual(bapi, mac1[:], c.Expected1[:])
	assertBytesEqual(bapi, mac2[:], c.Expected2[:])
	return nil
}

func TestHMACSHA512PairMatchesIndependentHMACRandomized(t *testing.T) {
	rng := rand.New(rand.NewSource(0xC0))
	assignments := make([]*hmacPairRandomCircuit, hmacPairRandomCases)
	for i := range assignments {
		assignment := &hmacPairRandomCircuit{}
		key := randomBytes(rng, len(assignment.Key))
		message1 := randomBytes(rng, len(assignment.Message1))
		message2 := randomBytes(rng, len(assignment.Message2))
		switch i {
		case 0:
			clear(key)
			clear(message1)
			clear(message2)
		case 1:
			fillBytes(key, 0xff)
			fillBytes(message1, 0xff)
			clear(message2)
		case 2:
			clear(key)
			fillBytes(message1, 0xff)
			fillBytes(message2, 0xff)
		}
		expected1 := RefHMACSHA512(key, message1)
		expected2 := RefHMACSHA512(key, message2)
		setU8s(assignment.Key[:], key)
		setU8s(assignment.Message1[:], message1)
		setU8s(assignment.Message2[:], message2)
		setU8s(assignment.Expected1[:], expected1)
		setU8s(assignment.Expected2[:], expected2)
		assignments[i] = assignment
	}

	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &hmacPairRandomCircuit{})
	if err != nil {
		t.Fatalf("compile randomized paired HMAC circuit: %v", err)
	}
	if err := solveHMACPairBatch(ccs, assignments, hmacPairSolveWorkers); err != nil {
		t.Fatalf("solve %d randomized paired/independent HMAC cases: %v", hmacPairRandomCases, err)
	}

	// Corrupt each expected output independently. The untouched output remains
	// valid, so these reject cases prove neither pair branch can be ignored.
	firstCorrupt := cloneHMACPairAssignment(assignments[17])
	firstCorrupt.Expected1[0] = uints.NewU8(constantU8(t, firstCorrupt.Expected1[0]) ^ 1)
	if err := solveCircuit(ccs, firstCorrupt); err == nil {
		t.Fatal("one-sided corruption of first paired HMAC output unexpectedly satisfied the circuit")
	}
	secondCorrupt := cloneHMACPairAssignment(assignments[29])
	secondCorrupt.Expected2[0] = uints.NewU8(constantU8(t, secondCorrupt.Expected2[0]) ^ 1)
	if err := solveCircuit(ccs, secondCorrupt); err == nil {
		t.Fatal("one-sided corruption of second paired HMAC output unexpectedly satisfied the circuit")
	}
}

func solveHMACPairBatch(ccs constraint.ConstraintSystem, assignments []*hmacPairRandomCircuit, workers int) error {
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

func randomBytes(rng *rand.Rand, length int) []byte {
	value := make([]byte, length)
	_, _ = rng.Read(value)
	return value
}

func fillBytes(value []byte, fill byte) {
	for i := range value {
		value[i] = fill
	}
}

func cloneHMACPairAssignment(source *hmacPairRandomCircuit) *hmacPairRandomCircuit {
	clone := *source
	return &clone
}

func constantU8(t *testing.T, value uints.U8) uint8 {
	t.Helper()
	constant, ok := value.Val.(uint8)
	if !ok {
		t.Fatalf("U8 value %T is not a uint8 constant", value.Val)
	}
	return constant
}
