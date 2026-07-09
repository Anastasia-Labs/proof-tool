package msmengine

import (
	"fmt"

	"github.com/consensys/gnark-crypto/ecc"
	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

// cpuMSM is the always-available MSMEngine that wraps gnark's single-thread
// MultiExp directly. It is the fallback rung of the capability ladder and the
// default engine — identical in behaviour to the pre-seam prover.
type cpuMSM struct{}

func (cpuMSM) Name() string { return "cpu" }

func (cpuMSM) Instrumentation() map[string]any {
	return map[string]any{
		"worker_count":            0,
		"shard_count":             cpuRangeChunks,
		"range_fetch_concurrency": 1,
	}
}

// MSMG1 delegates to G1Jac.MultiExp with NbTasks:1 (single-thread, matching
// the Phase-0 lever in the prove fork). The result is bit-identical to calling
// MultiExp directly, which is the correctness invariant the seam must preserve.
func (cpuMSM) MSMG1(dst *bls12381.G1Jac, points []bls12381.G1Affine, scalars []fr.Element, prog ProgressFn) error {
	prog = progressReporter(prog)
	_, err := dst.MultiExp(points, scalars, ecc.MultiExpConfig{NbTasks: 1})
	if err == nil && prog != nil {
		prog(len(scalars), len(scalars))
	}
	return err
}

// MSMG2 delegates to G2Jac.MultiExp with NbTasks:1.
func (cpuMSM) MSMG2(dst *bls12381.G2Jac, points []bls12381.G2Affine, scalars []fr.Element, prog ProgressFn) error {
	prog = progressReporter(prog)
	_, err := dst.MultiExp(points, scalars, ecc.MultiExpConfig{NbTasks: 1})
	if err == nil && prog != nil {
		prog(len(scalars), len(scalars))
	}
	return err
}

// cpuRangeChunks is how many sub-ranges cpuMSM.MSM*Ranged fetches the section
// in. >1 so the whole point-vector is never resident; the partials are group-
// summed, which is bit-exact with a whole-vector MultiExp.
const cpuRangeChunks = 4

// MSMG1Ranged fetches the section in cpuRangeChunks contiguous sub-ranges,
// runs a single-thread MultiExp on each, and group-sums the partials. Bit-
// identical to MSMG1 over the whole vector (an MSM is a group sum).
func (cpuMSM) MSMG1Ranged(dst *bls12381.G1Jac, n int, fetch FetchG1, scalars []fr.Element, prog ProgressFn) error {
	prog = progressReporter(prog)
	if len(scalars) != n {
		return fmt.Errorf("cpuMSM.MSMG1Ranged: %d scalars vs n=%d", len(scalars), n)
	}
	ranges := nonEmptyRanges(partitionRanges(n, cpuRangeChunks))
	var sum bls12381.G1Jac // zero value == point at infinity
	done := 0
	for _, r := range ranges {
		pts, err := fetch(r[0], r[1])
		if err != nil {
			return fmt.Errorf("cpuMSM.MSMG1Ranged: fetch [%d,%d): %w", r[0], r[1], err)
		}
		if len(pts) != r[1]-r[0] {
			return fmt.Errorf("cpuMSM.MSMG1Ranged: fetch [%d,%d) returned %d points, want %d", r[0], r[1], len(pts), r[1]-r[0])
		}
		var part bls12381.G1Jac
		if _, err := part.MultiExp(pts, scalars[r[0]:r[1]], ecc.MultiExpConfig{NbTasks: 1}); err != nil {
			return err
		}
		sum.AddAssign(&part)
		done += r[1] - r[0]
		if prog != nil {
			prog(done, n)
		}
	}
	*dst = sum
	if prog != nil && len(ranges) == 0 {
		prog(0, n)
	}
	return nil
}

// MSMG2Ranged is the G2 counterpart of MSMG1Ranged.
func (cpuMSM) MSMG2Ranged(dst *bls12381.G2Jac, n int, fetch FetchG2, scalars []fr.Element, prog ProgressFn) error {
	prog = progressReporter(prog)
	if len(scalars) != n {
		return fmt.Errorf("cpuMSM.MSMG2Ranged: %d scalars vs n=%d", len(scalars), n)
	}
	ranges := nonEmptyRanges(partitionRanges(n, cpuRangeChunks))
	var sum bls12381.G2Jac // zero value == point at infinity
	done := 0
	for _, r := range ranges {
		pts, err := fetch(r[0], r[1])
		if err != nil {
			return fmt.Errorf("cpuMSM.MSMG2Ranged: fetch [%d,%d): %w", r[0], r[1], err)
		}
		if len(pts) != r[1]-r[0] {
			return fmt.Errorf("cpuMSM.MSMG2Ranged: fetch [%d,%d) returned %d points, want %d", r[0], r[1], len(pts), r[1]-r[0])
		}
		var part bls12381.G2Jac
		if _, err := part.MultiExp(pts, scalars[r[0]:r[1]], ecc.MultiExpConfig{NbTasks: 1}); err != nil {
			return err
		}
		sum.AddAssign(&part)
		done += r[1] - r[0]
		if prog != nil {
			prog(done, n)
		}
	}
	*dst = sum
	if prog != nil && len(ranges) == 0 {
		prog(0, n)
	}
	return nil
}

func (cpuMSM) Close() error { return nil }
