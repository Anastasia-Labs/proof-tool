package msmengine

import (
	"math/big"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

// randomG2Vec returns n on-curve G2 points (random multiples of the generator)
// and n random scalars.
func randomG2Vec(t *testing.T, n int) ([]bls12381.G2Affine, []fr.Element) {
	t.Helper()
	pts := make([]bls12381.G2Affine, n)
	scs := make([]fr.Element, n)
	_, g2Gen, _, _ := bls12381.Generators()
	for i := range pts {
		var ptSc fr.Element
		if _, err := ptSc.SetRandom(); err != nil {
			t.Fatalf("randomG2Vec: SetRandom point scalar: %v", err)
		}
		var b big.Int
		ptSc.BigInt(&b)
		var jac bls12381.G2Jac
		jac.ScalarMultiplication(&g2Gen, &b)
		pts[i].FromJacobian(&jac)
		if _, err := scs[i].SetRandom(); err != nil {
			t.Fatalf("randomG2Vec: SetRandom scalar: %v", err)
		}
	}
	return pts, scs
}

// TestCPUMSMG1RangedMatchesWhole proves the ranged G1 path (points pulled in
// sub-ranges and group-summed) is bit-identical to a whole-vector MultiExp, for
// a count that does NOT divide evenly into cpuRangeChunks (exercises the
// remainder shard + combine).
func TestCPUMSMG1RangedMatchesWhole(t *testing.T) {
	const n = 1003 // not a multiple of cpuRangeChunks
	pts, scs := randomG1Vec(t, n)

	var want bls12381.G1Jac
	if _, err := want.MultiExp(pts, scs, ecc.MultiExpConfig{NbTasks: 1}); err != nil {
		t.Fatal(err)
	}

	fetch := func(lo, hi int) ([]bls12381.G1Affine, error) { return pts[lo:hi], nil }
	var got bls12381.G1Jac
	if err := (cpuMSM{}).MSMG1Ranged(&got, n, fetch, scs, nil); err != nil {
		t.Fatal(err)
	}
	if !got.Equal(&want) {
		t.Fatal("cpuMSM.MSMG1Ranged != whole-vector MultiExp")
	}
}

// TestCPUMSMG2RangedMatchesWhole is the G2 counterpart.
func TestCPUMSMG2RangedMatchesWhole(t *testing.T) {
	const n = 777
	pts, scs := randomG2Vec(t, n)

	var want bls12381.G2Jac
	if _, err := want.MultiExp(pts, scs, ecc.MultiExpConfig{NbTasks: 1}); err != nil {
		t.Fatal(err)
	}

	fetch := func(lo, hi int) ([]bls12381.G2Affine, error) { return pts[lo:hi], nil }
	var got bls12381.G2Jac
	if err := (cpuMSM{}).MSMG2Ranged(&got, n, fetch, scs, nil); err != nil {
		t.Fatal(err)
	}
	if !got.Equal(&want) {
		t.Fatal("cpuMSM.MSMG2Ranged != whole-vector MultiExp")
	}
}

// TestCPUMSMRangedEmpty checks n==0 yields the point at infinity (zero-value
// Jacobian) and fires progress once.
func TestCPUMSMRangedEmpty(t *testing.T) {
	fired := false
	prog := func(done, total int) { fired = true }
	var got bls12381.G1Jac
	if err := (cpuMSM{}).MSMG1Ranged(&got, 0, func(lo, hi int) ([]bls12381.G1Affine, error) {
		return nil, nil
	}, nil, prog); err != nil {
		t.Fatal(err)
	}
	var inf bls12381.G1Jac // zero value == infinity
	if !got.Equal(&inf) {
		t.Fatal("empty ranged MSM != infinity")
	}
	if !fired {
		t.Fatal("progress not fired on empty MSM")
	}
}

// TestCPUMSMRangedFetchLenMismatch rejects a fetch that returns the wrong number
// of points for the requested range (a defensive guard against an out-of-spec
// source). Without it a short fetch would silently corrupt the MSM.
func TestCPUMSMRangedFetchLenMismatch(t *testing.T) {
	const n = 100
	pts, scs := randomG1Vec(t, n)
	bad := func(lo, hi int) ([]bls12381.G1Affine, error) { return pts[lo : hi-1], nil } // one short
	var got bls12381.G1Jac
	if err := (cpuMSM{}).MSMG1Ranged(&got, n, bad, scs, nil); err == nil {
		t.Fatal("expected error for short fetch, got nil")
	}
}

// TestCPUMSMG1RangedProgressMonotone verifies progress climbs to n.
func TestCPUMSMG1RangedProgressMonotone(t *testing.T) {
	const n = 500
	pts, scs := randomG1Vec(t, n)
	var lastDone, lastTotal int
	prog := func(done, total int) { lastDone, lastTotal = done, total }
	var got bls12381.G1Jac
	if err := (cpuMSM{}).MSMG1Ranged(&got, n, func(lo, hi int) ([]bls12381.G1Affine, error) {
		return pts[lo:hi], nil
	}, scs, prog); err != nil {
		t.Fatal(err)
	}
	if lastDone != n || lastTotal != n {
		t.Fatalf("final progress = %d/%d, want %d/%d", lastDone, lastTotal, n, n)
	}
}
