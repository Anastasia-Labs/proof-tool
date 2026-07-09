package msmengine

import (
	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
)

// partitionRanges splits the index interval [0,n) into `workers` contiguous,
// non-overlapping [lo,hi) ranges that exactly cover [0,n). Each of the first
// workers-1 ranges has size n/workers; the last range absorbs the remainder
// (so it is the largest, by at most workers-1 elements). The result always has
// exactly `workers` entries. A range is empty only when n < workers (more
// shards than elements) — in production workers is tiny (<= hardware threads)
// versus n in the millions, so this never happens for the big MSMs.
//
// This is the exactness-critical partition: because an MSM is
// Sum_i scalar_i * point_i and group addition is associative/commutative,
// summing the per-range partial MSMs reproduces the whole-vector MSM bit-for-bit
// (see combineG1/combineG2 and the native TestPartitionCombineEqualsWhole).
func partitionRanges(n, workers int) [][2]int {
	if workers < 1 {
		workers = 1
	}
	ranges := make([][2]int, workers)
	if n < 0 {
		n = 0
	}
	base := n / workers
	lo := 0
	for w := 0; w < workers; w++ {
		hi := lo + base
		if w == workers-1 {
			hi = n // last shard absorbs the remainder
		}
		if hi > n {
			hi = n
		}
		ranges[w] = [2]int{lo, hi}
		lo = hi
	}
	return ranges
}

// combineG1 folds partial G1 MSM results into their group sum. The zero-value
// G1Jac is the point at infinity (Z == 0), the additive identity for AddAssign,
// so an empty slice yields infinity. Folding is exact: it is ordinary group
// addition of the partial multi-exponentiations.
func combineG1(parts []bls12381.G1Jac) bls12381.G1Jac {
	var sum bls12381.G1Jac // zero value == point at infinity
	for i := range parts {
		sum.AddAssign(&parts[i])
	}
	return sum
}

// combineG2 is the G2 counterpart of combineG1.
func combineG2(parts []bls12381.G2Jac) bls12381.G2Jac {
	var sum bls12381.G2Jac // zero value == point at infinity
	for i := range parts {
		sum.AddAssign(&parts[i])
	}
	return sum
}

// nonEmptyRanges drops empty [k,k) shards (present only when there are more
// shards than elements). Shared by cpuMSM (native) and shardedMSM (js/wasm).
func nonEmptyRanges(ranges [][2]int) [][2]int {
	out := ranges[:0]
	for _, r := range ranges {
		if r[1] > r[0] {
			out = append(out, r)
		}
	}
	return out
}
