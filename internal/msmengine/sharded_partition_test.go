package msmengine

import (
	"math/big"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

// TestPartitionRangesContiguousCover verifies partitionRanges produces
// contiguous, non-overlapping [lo,hi) ranges that exactly cover [0,n), with
// the last range absorbing the remainder, and no empty range while n>=workers.
func TestPartitionRangesContiguousCover(t *testing.T) {
	cases := []struct{ n, workers int }{
		{10000, 7}, {10000, 8}, {10000, 1}, {9, 9}, {100, 3}, {1, 1}, {5, 4},
	}
	for _, c := range cases {
		ranges := partitionRanges(c.n, c.workers)
		if len(ranges) != c.workers {
			t.Fatalf("n=%d workers=%d: got %d ranges, want %d", c.n, c.workers, len(ranges), c.workers)
		}
		// Contiguous, covering [0,n).
		if ranges[0][0] != 0 {
			t.Fatalf("n=%d workers=%d: first range starts at %d, want 0", c.n, c.workers, ranges[0][0])
		}
		if ranges[len(ranges)-1][1] != c.n {
			t.Fatalf("n=%d workers=%d: last range ends at %d, want %d", c.n, c.workers, ranges[len(ranges)-1][1], c.n)
		}
		for i, r := range ranges {
			if r[0] > r[1] {
				t.Fatalf("n=%d workers=%d: range %d=[%d,%d) inverted", c.n, c.workers, i, r[0], r[1])
			}
			if i > 0 && r[0] != ranges[i-1][1] {
				t.Fatalf("n=%d workers=%d: range %d not contiguous with %d", c.n, c.workers, i, i-1)
			}
			// No empty range unless n < workers.
			if c.n >= c.workers && r[0] == r[1] {
				t.Fatalf("n=%d workers=%d: range %d empty but n>=workers", c.n, c.workers, i)
			}
		}
	}
}

// TestPartitionCombineEqualsWhole is the exactness-critical test: partitioning a
// real point/scalar vector into uneven shards, running a single-thread MultiExp
// per shard, then combineG1 of the partials, must be BIT-EXACT equal to a
// single-thread MultiExp over the whole vector. (An MSM is Sum scalar_i*point_i;
// partition-and-add is associative/commutative over the group, so exact.)
func TestPartitionCombineEqualsWhole(t *testing.T) {
	pts, scs := randomG1Vec(t, 10000)
	var whole bls12381.G1Jac
	if _, err := whole.MultiExp(pts, scs, ecc.MultiExpConfig{NbTasks: 1}); err != nil {
		t.Fatal(err)
	}
	ranges := partitionRanges(len(pts), 7) // 7 uneven shards
	var parts []bls12381.G1Jac
	for _, r := range ranges {
		var p bls12381.G1Jac
		if _, err := p.MultiExp(pts[r[0]:r[1]], scs[r[0]:r[1]], ecc.MultiExpConfig{NbTasks: 1}); err != nil {
			t.Fatal(err)
		}
		parts = append(parts, p)
	}
	got := combineG1(parts)
	if !got.Equal(&whole) {
		t.Fatal("partition+combine G1 != whole MSM")
	}
}

// TestPartitionCombineEqualsWholeG2 is the G2 counterpart (the G2.B vector is the
// largest MSM in the prove and the one that OOMs the single-thread js prover).
func TestPartitionCombineEqualsWholeG2(t *testing.T) {
	n := 4096
	pts := make([]bls12381.G2Affine, n)
	scs := make([]fr.Element, n)
	_, g2Gen, _, _ := bls12381.Generators()
	for i := range pts {
		var ptSc fr.Element
		if _, err := ptSc.SetRandom(); err != nil {
			t.Fatal(err)
		}
		var bigPtSc big.Int
		ptSc.BigInt(&bigPtSc)
		var jac bls12381.G2Jac
		jac.ScalarMultiplication(&g2Gen, &bigPtSc)
		pts[i].FromJacobian(&jac)
		if _, err := scs[i].SetRandom(); err != nil {
			t.Fatal(err)
		}
	}

	var whole bls12381.G2Jac
	if _, err := whole.MultiExp(pts, scs, ecc.MultiExpConfig{NbTasks: 1}); err != nil {
		t.Fatal(err)
	}
	ranges := partitionRanges(len(pts), 5) // 5 uneven shards
	var parts []bls12381.G2Jac
	for _, r := range ranges {
		var p bls12381.G2Jac
		if _, err := p.MultiExp(pts[r[0]:r[1]], scs[r[0]:r[1]], ecc.MultiExpConfig{NbTasks: 1}); err != nil {
			t.Fatal(err)
		}
		parts = append(parts, p)
	}
	got := combineG2(parts)
	if !got.Equal(&whole) {
		t.Fatal("partition+combine G2 != whole MSM")
	}
}

// TestCombineEmptyIsInfinity verifies combineG1/combineG2 of no partials is the
// group identity (point at infinity, Z==0), the additive zero for AddAssign.
// It also round-trips the infinity Jacobian through marshalG1Jac→unmarshalG1Jac
// to confirm the serialisation layer handles the identity point correctly.
func TestCombineEmptyIsInfinity(t *testing.T) {
	g1 := combineG1(nil)
	if !g1.Z.IsZero() {
		t.Fatal("combineG1(nil) is not the point at infinity")
	}
	// Serialise the infinity G1 Jacobian and deserialise it; the result must
	// still be the identity (Z==0).
	buf := marshalG1Jac(&g1)
	jacRt, err := unmarshalG1Jac(buf)
	if err != nil || !jacRt.Z.IsZero() {
		t.Fatal("infinity round-trip failed")
	}
	g2 := combineG2(nil)
	if !g2.Z.IsZero() {
		t.Fatal("combineG2(nil) is not the point at infinity")
	}
}
