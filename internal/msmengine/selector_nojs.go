//go:build !(js && wasm)

package msmengine

import (
	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

// makeShardedEngine returns a stubShardedMSM on native (non-js/wasm) builds.
// The stub reports Name()=="sharded" so TestSelectLadder can verify the ladder
// decision natively without importing the js-only transport in sharded_js.go.
// Any call to MSMG1/MSMG2 panics — the stub must never actually run MSMs.
func makeShardedEngine(workers int) MSMEngine {
	return makeShardedEngineWithOptions(workers, Options{})
}

func makeShardedEngineWithOptions(workers int, opts Options) MSMEngine {
	shards := opts.ShardCount
	if shards <= 0 {
		shards = workers
	}
	concurrency := opts.RangeFetchConcurrency
	if concurrency <= 0 {
		concurrency = 1
	}
	return stubShardedMSM{workers: workers, shards: shards, rangeFetchConcurrency: concurrency, optW7: opts.OptW7}
}

// stubShardedMSM is the native-build stand-in for shardedMSM. It satisfies
// MSMEngine and reports the "sharded" tier so the selector's ladder logic is
// testable without the js/wasm transport. MSM methods panic because the stub
// is never expected to be used for real computation on native builds.
type stubShardedMSM struct {
	workers               int
	shards                int
	rangeFetchConcurrency int
	optW7                 bool
}

func (s stubShardedMSM) Name() string { return "sharded" }

func (s stubShardedMSM) Instrumentation() map[string]any {
	return map[string]any{
		"worker_count":            s.workers,
		"shard_count":             s.shards,
		"range_fetch_concurrency": s.rangeFetchConcurrency,
		"pinned_decode":           false,
		"opt_w7":                  s.optW7,
	}
}

func (s stubShardedMSM) MSMG1(_ *bls12381.G1Jac, _ []bls12381.G1Affine, _ []fr.Element, _ ProgressFn) error {
	panic("stubShardedMSM: MSMG1 called on native build — use cpuMSM for native MSM")
}

func (s stubShardedMSM) MSMG2(_ *bls12381.G2Jac, _ []bls12381.G2Affine, _ []fr.Element, _ ProgressFn) error {
	panic("stubShardedMSM: MSMG2 called on native build — use cpuMSM for native MSM")
}

func (s stubShardedMSM) MSMG1Ranged(_ *bls12381.G1Jac, _ int, _ FetchG1, _ []fr.Element, _ ProgressFn) error {
	panic("stubShardedMSM: MSMG1Ranged called on native build — use cpuMSM for native MSM")
}

func (s stubShardedMSM) MSMG2Ranged(_ *bls12381.G2Jac, _ int, _ FetchG2, _ []fr.Element, _ ProgressFn) error {
	panic("stubShardedMSM: MSMG2Ranged called on native build — use cpuMSM for native MSM")
}

func (s stubShardedMSM) Close() error { return nil }
