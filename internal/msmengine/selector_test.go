package msmengine

import (
	"errors"
	"testing"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

// TestSelectLadder verifies the capability ladder:
//   - SharedMem && Workers > 1 → "sharded" tier
//   - empty Probe (no capabilities) → "cpu" fallback
//
// On native builds Select returns a stubShardedMSM (Name()=="sharded") for the
// sharded tier, confirming the ladder decision without the js/wasm transport.
func TestSelectLadder(t *testing.T) {
	if got := Select(Probe{SharedMem: true, Workers: 8}).Name(); got != "sharded" {
		t.Fatalf("Select(SharedMem+Workers=8).Name() = %q, want %q", got, "sharded")
	}
	if got := Select(Probe{}).Name(); got != "cpu" {
		t.Fatalf("Select(Probe{}).Name() = %q, want %q", got, "cpu")
	}
}

// failingEngine is an MSMEngine whose MSM methods always return an error.
// Used to exercise WithFallback's demotion path without doing real math.
type failingEngine struct{}

func (failingEngine) Name() string { return "failing" }
func (failingEngine) MSMG1(_ *bls12381.G1Jac, _ []bls12381.G1Affine, _ []fr.Element, _ ProgressFn) error {
	return errors.New("failingEngine: MSMG1 always fails")
}
func (failingEngine) MSMG2(_ *bls12381.G2Jac, _ []bls12381.G2Affine, _ []fr.Element, _ ProgressFn) error {
	return errors.New("failingEngine: MSMG2 always fails")
}
func (failingEngine) MSMG1Ranged(_ *bls12381.G1Jac, _ int, _ FetchG1, _ []fr.Element, _ ProgressFn) error {
	return errors.New("failingEngine: MSMG1Ranged always fails")
}
func (failingEngine) MSMG2Ranged(_ *bls12381.G2Jac, _ int, _ FetchG2, _ []fr.Element, _ ProgressFn) error {
	return errors.New("failingEngine: MSMG2Ranged always fails")
}
func (failingEngine) Close() error { return nil }

// TestWithFallbackDemotesOnError verifies that when the primary engine returns
// an error the fallback retries with cpuMSM{} and the retry's nil error is
// returned (not the original error). The final value of used must be "cpu".
func TestWithFallbackDemotesOnError(t *testing.T) {
	used := ""
	err := WithFallback(failingEngine{}, func(e MSMEngine) error {
		used = e.Name()
		if _, ok := e.(failingEngine); ok {
			return errors.New("boom")
		}
		return nil
	})
	if err != nil || used != "cpu" {
		t.Fatalf("want demote to cpu with nil err, got used=%s err=%v", used, err)
	}
}
