// Package msmengine provides a pluggable multi-scalar multiplication seam for
// the gnark Groth16 prover. The compute* closures in the vendored prove fork
// call msmengine.Current() instead of calling dst.MultiExp directly, making the
// MSM implementation swappable at runtime without touching the prove pipeline.
//
// The default engine is cpuMSM, which delegates to gnark's single-thread
// MultiExp (NbTasks:1) — identical to the pre-seam behaviour. Future engines
// (shardedMSM for Web Worker parallelism, gpuMSM for WebGPU) satisfy the same
// interface and are selected by msmengine.SetCurrent before proving begins.
package msmengine

import (
	"sync"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

// ProgressFn is an optional progress callback. done and total are both
// expressed in number of scalars processed; engines that run in a single
// batch fire it once with done == total == len(scalars).
type ProgressFn func(done, total int)

// ProgressEvent is emitted when the active engine makes progress on an MSM
// call. Call is 1-based within the currently installed sink.
type ProgressEvent struct {
	Call  uint64
	Label string
	Done  int
	Total int
}

// ProgressSink receives engine progress events when an MSM method is called
// without an explicit ProgressFn.
type ProgressSink func(ProgressEvent)

// TraceEvent records a proof-stage boundary or measurement emitted below the
// WASM entrypoint. The entrypoint owns timestamps and heap snapshots.
type TraceEvent struct {
	Phase  string
	Stage  string
	Fields map[string]any
}

type TraceSink func(TraceEvent)

// FetchG1/FetchG2 fetch the points of a proving-key section in the half-open
// index range [lo,hi). They let an engine pull each shard's points on demand
// (from an HTTP range request, say) so the caller never materializes the whole
// point-vector. The returned slice MUST have exactly hi-lo points; the engine
// owns it and may retain it only for the duration of one shard.
type (
	FetchG1 func(lo, hi int) ([]bls12381.G1Affine, error)
	FetchG2 func(lo, hi int) ([]bls12381.G2Affine, error)
)

type PKSection struct {
	Name     string `json:"name"`
	Offset   int64  `json:"offset"`
	Len      int64  `json:"len"`
	ElemSize int    `json:"elem_size"`
}

type PKChunkPin struct {
	Index      int    `json:"index"`
	Offset     int64  `json:"offset"`
	Size       int64  `json:"size"`
	Path       string `json:"path"`
	SHA256     string `json:"sha256"`
	Blake2b256 string `json:"blake2b256"`
}

type PKSectionPlan struct {
	AssetID      string               `json:"asset_id"`
	BaseURL      string               `json:"base_url"`
	FileSize     int64                `json:"file_size"`
	ChunkSize    int64                `json:"chunk_size"`
	Sections     map[string]PKSection `json:"sections"`
	Chunks       []PKChunkPin         `json:"chunks"`
	ManifestHash string               `json:"manifest_hash,omitempty"`
	VKHash       string               `json:"vk_hash,omitempty"`
}

// MSMEngine abstracts where multi-scalar multiplications run (CPU, web-worker
// pool, WebGPU, etc.). Implementations MUST produce a result bit-identical to
// gnark's single-thread MultiExp for the same points and scalars.
type MSMEngine interface {
	// Name returns a short human-readable identifier (e.g. "cpu", "sharded").
	Name() string

	// MSMG1 computes dst = Σ scalars[i]·points[i] over BLS12-381 G1.
	// dst is overwritten; points and scalars are read-only.
	// If prog is non-nil it is called at least once on completion.
	MSMG1(dst *bls12381.G1Jac, points []bls12381.G1Affine, scalars []fr.Element, prog ProgressFn) error

	// MSMG2 computes dst = Σ scalars[i]·points[i] over BLS12-381 G2.
	// dst is overwritten; points and scalars are read-only.
	// If prog is non-nil it is called at least once on completion.
	MSMG2(dst *bls12381.G2Jac, points []bls12381.G2Affine, scalars []fr.Element, prog ProgressFn) error

	// MSMG1Ranged computes dst = Σ_{i<n} scalars[i]·points[i] over G1 WITHOUT the
	// caller supplying the points: the engine pulls each sub-range [lo,hi) via
	// fetch, so the whole point-vector is never resident at once. len(scalars)
	// MUST equal n. The result is bit-identical to MSMG1 over the full vector
	// (an MSM is a group sum, so partitioning and summing partials is exact).
	MSMG1Ranged(dst *bls12381.G1Jac, n int, fetch FetchG1, scalars []fr.Element, prog ProgressFn) error

	// MSMG2Ranged is the G2 counterpart of MSMG1Ranged.
	MSMG2Ranged(dst *bls12381.G2Jac, n int, fetch FetchG2, scalars []fr.Element, prog ProgressFn) error

	// Close releases any resources held by the engine (worker pools, GPU
	// contexts, etc.). cpuMSM is a no-op.
	Close() error
}

type PKSectionEngine interface {
	MSMG1Section(dst *bls12381.G1Jac, plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) error
	MSMG2Section(dst *bls12381.G2Jac, plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) error
}

type InstrumentedEngine interface {
	Instrumentation() map[string]any
}

// currentMu guards current so that concurrent reads (prover goroutines calling
// Current()) and writes (tests or runtime calling SetCurrent()) are data-race
// free. On single-threaded wasm the locking is a no-op; on native targets it
// prevents -race failures when a test swaps the engine while provers run.
var (
	currentMu sync.RWMutex
	current   MSMEngine = cpuMSM{}

	progressMu   sync.Mutex
	progressSink ProgressSink
	progressSeq  uint64

	traceMu   sync.Mutex
	traceSink TraceSink
)

// Current returns the active MSMEngine. Called by the vendored prove fork's
// compute* closures on every prove invocation.
func Current() MSMEngine {
	currentMu.RLock()
	e := current
	currentMu.RUnlock()
	return e
}

// SetCurrent replaces the active MSMEngine. Call this before ProveStream to
// select a faster engine (e.g. shardedMSM). The caller is responsible for
// calling Close() on the replaced engine if needed.
func SetCurrent(e MSMEngine) {
	currentMu.Lock()
	current = e
	currentMu.Unlock()
}

// SetProgressSink installs a process-global fallback progress sink for MSM
// calls that do not pass their own ProgressFn. It returns a restore function.
func SetProgressSink(sink ProgressSink) func() {
	progressMu.Lock()
	prevSink, prevSeq := progressSink, progressSeq
	progressSink = sink
	progressSeq = 0
	progressMu.Unlock()

	return func() {
		progressMu.Lock()
		progressSink, progressSeq = prevSink, prevSeq
		progressMu.Unlock()
	}
}

func SetTraceSink(sink TraceSink) func() {
	traceMu.Lock()
	prevSink := traceSink
	traceSink = sink
	traceMu.Unlock()

	return func() {
		traceMu.Lock()
		traceSink = prevSink
		traceMu.Unlock()
	}
}

func EmitTrace(phase, stage string, fields map[string]any) {
	traceMu.Lock()
	sink := traceSink
	traceMu.Unlock()
	if sink != nil {
		sink(TraceEvent{Phase: phase, Stage: stage, Fields: fields})
	}
}

func TraceStage(stage string, fields map[string]any) func(map[string]any) {
	EmitTrace("start", stage, fields)
	return func(endFields map[string]any) {
		EmitTrace("end", stage, endFields)
	}
}

func progressReporter(prog ProgressFn) ProgressFn {
	if prog != nil {
		return prog
	}
	progressMu.Lock()
	sink := progressSink
	if sink == nil {
		progressMu.Unlock()
		return nil
	}
	progressSeq++
	call := progressSeq
	progressMu.Unlock()

	return func(done, total int) {
		sink(ProgressEvent{Call: call, Done: done, Total: total})
	}
}
