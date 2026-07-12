package sha

import (
	"math/big"

	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/bitslice"
	"github.com/consensys/gnark/std/math/uints"
)

var twoTo64 = new(big.Int).Lsh(big.NewInt(1), 64)

// NativeSum64 returns the native-field sum of byte-constrained U64 words
// without materializing the low 64 bits. Callers must eventually feed the sum
// to Materialize64 with a high-limb width justified from the number of terms.
func NativeSum64(api frontend.API, uapi *uints.BinaryField[uints.U64], words ...uints.U64) frontend.Variable {
	if len(words) == 0 {
		panic("sha: NativeSum64 requires at least one word")
	}
	values := make([]frontend.Variable, len(words))
	for i := range words {
		values[i] = uapi.ToValue(words[i])
	}
	if len(values) == 1 {
		return values[0]
	}
	return api.Add(values[0], values[1], values[2:]...)
}

// Add64 adds byte-constrained U64 words modulo 2^64. hiBits must bound the
// carry limb of their unreduced native sum at this call site.
func Add64(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	rc frontend.Rangechecker,
	hiBits int,
	words ...uints.U64,
) uints.U64 {
	return Materialize64(api, uapi, rc, NativeSum64(api, uapi, words...), hiBits)
}

// Materialize64 reduces a previously deferred native sum modulo 2^64.
//
// Soundness: Partition's outputs are intentionally unconstrained here. The
// explicit recomposition binds sum = lo + 2^64*hi; rc.Check bounds hi to the
// call-site carry width; and uapi.ValueOf(lo) both proves lo < 2^64 and gives
// its canonical byte decomposition. Every C3 caller proves a total bound of at
// most 67 bits, far below the BLS12-381 scalar field, so the recomposition
// cannot wrap the field and the (lo, hi) decomposition is unique. This lower
// bound is exactly the check skipped by WithUnconstrainedOutputs.
func Materialize64(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	rc frontend.Rangechecker,
	sum frontend.Variable,
	hiBits int,
) uints.U64 {
	if hiBits < 1 || 64+hiBits >= api.Compiler().FieldBitLen() {
		panic("sha: invalid Materialize64 high-limb width")
	}
	// gnark 0.15 needs WithNbDigits to select the bounded partition-hint path;
	// without it Partition falls back to a full scalar-bit decomposition before
	// honoring the unconstrained-output option.
	lo, hi := bitslice.Partition(
		api,
		sum,
		64,
		bitslice.WithNbDigits(64+hiBits),
		bitslice.WithUnconstrainedOutputs(),
	)
	api.AssertIsEqual(sum, api.Add(lo, api.Mul(twoTo64, hi)))
	rc.Check(hi, hiBits)
	return uapi.ValueOf(lo)
}
