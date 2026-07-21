package msmengine

import (
	"errors"
	"fmt"
	"log"
)

// Probe describes the runtime capabilities available for engine selection.
// The webprove entrypoint assembles a Probe from navigator.gpu,
// crossOriginIsolated, and navigator.hardwareConcurrency before calling Select.
type Probe struct {
	WebGPU    bool // navigator.gpu is present (Phase 3 – not yet wired)
	SharedMem bool // crossOriginIsolated && SharedArrayBuffer available
	Workers   int  // navigator.hardwareConcurrency (0 means unknown)
}

type Options struct {
	ForceCPU              bool
	WorkerCount           int
	ShardCount            int
	RangeFetchConcurrency int
	ChunkPrefetchWindow   int
	WorkerURL             string
	PinnedDecode          bool
	OptW7                 bool
	OptW8                 bool
}

// Select returns the highest-available MSMEngine given capability probe p.
// Ladder (highest → lowest):
//
//  1. WebGPU (Phase 3 stub — always falls through until gpuMSM is implemented)
//  2. shardedMSM: when p.SharedMem && p.Workers > 1
//  3. cpuMSM: always available (single-thread MultiExp, bit-identical baseline)
//
// On native (non-js/wasm) builds the sharded branch returns a stubShardedMSM
// so that TestSelectLadder can verify the ladder decision without the js
// transport. The real shardedMSM is wired via makeShardedEngineWithOptions in
// selector_js.go (js && wasm only).
func Select(p Probe) MSMEngine {
	return SelectWithOptions(p, Options{})
}

func SelectWithOptions(p Probe, opts Options) MSMEngine {
	// Phase 3 stub: WebGPU branch intentionally left unimplemented.
	// if p.WebGPU { return makeGPUEngine() }

	if opts.ForceCPU {
		return cpuMSM{}
	}
	if opts.WorkerCount > 0 {
		p.Workers = opts.WorkerCount
	}
	if p.SharedMem && p.Workers > 1 {
		return makeShardedEngineWithOptions(p.Workers, opts)
	}
	return cpuMSM{}
}

// WithFallback runs run(primary). If run returns a non-nil error it logs the
// demotion and retries exactly once with cpuMSM{}. Proving is idempotent given
// the same witness and proving key, so the single-thread retry is safe.
// If the retry also fails, both attempt errors are returned to the caller.
func WithFallback(primary MSMEngine, run func(MSMEngine) error) error {
	return WithFallbackReload(primary, nil, run)
}

// WithFallbackReload runs beforeRetry after a retryable primary failure and
// before the CPU retry. It preserves the primary error alongside reload or
// retry errors. W3 uses this seam to reopen a hash-pinned CCS instead of
// reusing state that may already have been released after Solve.
func WithFallbackReload(primary MSMEngine, beforeRetry func() error, run func(MSMEngine) error) error {
	primaryErr := run(primary)
	if primaryErr == nil {
		return nil
	}
	var failClosedErr *FailClosedError
	if errors.As(primaryErr, &failClosedErr) {
		return primaryErr
	}
	log.Printf("msmengine: demoting from %q to cpu after error: %v", primary.Name(), primaryErr)
	if beforeRetry != nil {
		if reloadErr := beforeRetry(); reloadErr != nil {
			return errors.Join(
				fmt.Errorf("primary %s prove: %w", primary.Name(), primaryErr),
				fmt.Errorf("prepare cpu retry: %w", reloadErr),
			)
		}
	}
	if retryErr := run(cpuMSM{}); retryErr != nil {
		return errors.Join(
			fmt.Errorf("primary %s prove: %w", primary.Name(), primaryErr),
			fmt.Errorf("cpu retry prove: %w", retryErr),
		)
	}
	return nil
}
