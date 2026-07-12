//go:build js && wasm

package msmengine

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"runtime"
	"strings"
	"sync"
	"syscall/js"
	"time"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
	"golang.org/x/crypto/blake2b"
)

// sharded_js.go implements shardedMSM: an MSMEngine that partitions each
// multi-scalar multiplication into contiguous index ranges (partitionRanges)
// and dispatches each range to a Web Worker, each worker an independent wasm
// instance running the same gnark MultiExp over its slice. The main instance
// awaits the per-worker partial Jacobians and folds them with combineG1/
// combineG2 — bit-exact with a whole-vector MSM (proven natively in
// sharded_partition_test.go). Offloading the buckets/scratch of each MSM to
// workers keeps the main wasm instance off the 4 GiB wasm32 ceiling.
//
// The exactness-critical math (partitionRanges, combineG1/2) lives in the
// build-tag-free partition.go so it is unit-tested on native Go. This file is
// the js/wasm transport: SharedArrayBuffer marshalling, the worker pool, and
// the worker-side kernel (RegisterWorkerKernel) that worker.js — and the Node
// proof harness — invoke.

// The worker message format and the pure-Go shard compute kernel
// (marshal*/unmarshal*/shardG1Bytes/shardG2Bytes) live in the build-tag-free
// serialize.go so they are validated natively (serialize_test.go). This file is
// strictly the js/wasm transport: the global kernel registration, the worker
// pool, SharedArrayBuffer marshalling, and the shardedMSM engine.

// jsUint8 wraps a Go byte slice as a fresh JS Uint8Array.
func jsUint8(b []byte) js.Value {
	a := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(a, b)
	return a
}

// goBytes copies a JS Uint8Array (or any ArrayBufferView) into a Go slice.
func goBytes(v js.Value) []byte {
	n := v.Get("byteLength").Int()
	// Normalise to a Uint8Array view so CopyBytesToGo accepts it.
	u8 := js.Global().Get("Uint8Array").New(v.Get("buffer"), v.Get("byteOffset"), n)
	b := make([]byte, n)
	js.CopyBytesToGo(b, u8)
	return b
}

// RegisterWorkerKernel installs the per-shard MSM functions on the global
// scope so the worker bootstrap (worker.js) — and the Node proof harness — can
// invoke them after instantiating this wasm module. Each takes two Uint8Arrays
// (points, scalars) and returns a Uint8Array partial, or throws on error.
//
//	globalThis.__msmengineShardG1(ptsU8, scsU8) -> partialU8 (96 bytes)
//	globalThis.__msmengineShardG2(ptsU8, scsU8) -> partialU8 (192 bytes)
//	globalThis.__msmengineShardG1Timed(ptsU8, scsU8, pinnedDecode) -> {partial,timings}
//	globalThis.__msmengineShardG2Timed(ptsU8, scsU8, pinnedDecode) -> {partial,timings}
//	globalThis.__msmengineWorkerMemStats() -> worker-local numeric heap/GC fields
//	globalThis.__msmengineCombineG1([partialU8, ...]) -> combinedU8 (96 bytes)
//	globalThis.__msmengineCombineG2([partialU8, ...]) -> combinedU8 (192 bytes)
//
// CombineG1/G2 let a driver fold partials with the production combine logic
// (used by the Node proof and as a convenience for non-Go callers).
func RegisterWorkerKernel() {
	g := js.Global()
	g.Set("__msmengineShardG1", js.FuncOf(func(this js.Value, args []js.Value) any {
		out, err := shardG1Bytes(goBytes(args[0]), goBytes(args[1]))
		if err != nil {
			panic(err.Error())
		}
		return jsUint8(out)
	}))
	g.Set("__msmengineShardG2", js.FuncOf(func(this js.Value, args []js.Value) any {
		out, err := shardG2Bytes(goBytes(args[0]), goBytes(args[1]))
		if err != nil {
			panic(err.Error())
		}
		return jsUint8(out)
	}))
	g.Set("__msmengineShardG1Timed", js.FuncOf(func(this js.Value, args []js.Value) any {
		pinnedDecode := len(args) > 2 && args[2].Bool()
		out, timings, err := shardG1BytesTimed(goBytes(args[0]), goBytes(args[1]), pinnedDecode)
		if err != nil {
			panic(err.Error())
		}
		return timedShardResultJS(out, timings)
	}))
	g.Set("__msmengineShardG2Timed", js.FuncOf(func(this js.Value, args []js.Value) any {
		pinnedDecode := len(args) > 2 && args[2].Bool()
		out, timings, err := shardG2BytesTimed(goBytes(args[0]), goBytes(args[1]), pinnedDecode)
		if err != nil {
			panic(err.Error())
		}
		return timedShardResultJS(out, timings)
	}))
	g.Set("__msmengineWorkerMemStats", js.FuncOf(func(this js.Value, args []js.Value) any {
		return workerMemStatsJS()
	}))
	g.Set("__msmengineShardSectionG1", js.FuncOf(func(this js.Value, args []js.Value) any {
		out, timings, byteCounts, err := shardSectionBytes(false, args[0].String(), args[1].String(), args[2].Int(), args[3].Int(), goBytes(args[4]))
		if err != nil {
			panic(err.Error())
		}
		return sectionResultJS(out, timings, byteCounts)
	}))
	g.Set("__msmengineShardSectionG2", js.FuncOf(func(this js.Value, args []js.Value) any {
		out, timings, byteCounts, err := shardSectionBytes(true, args[0].String(), args[1].String(), args[2].Int(), args[3].Int(), goBytes(args[4]))
		if err != nil {
			panic(err.Error())
		}
		return sectionResultJS(out, timings, byteCounts)
	}))
	g.Set("__msmengineVerifyChunkBytes", js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 3 {
			return "verify chunk bytes expects raw bytes, sha256, and blake2b256"
		}
		if err := verifyChunkDigests(goBytes(args[0]), -1, args[1].String(), args[2].String()); err != nil {
			return err.Error()
		}
		return ""
	}))
	g.Set("__msmengineCombineG1", js.FuncOf(func(this js.Value, args []js.Value) any {
		arr := args[0]
		parts := make([]bls12381.G1Jac, arr.Length())
		for i := range parts {
			jac, err := unmarshalG1Jac(goBytes(arr.Index(i)))
			if err != nil {
				panic(err.Error())
			}
			parts[i] = jac
		}
		sum := combineG1(parts)
		return jsUint8(marshalG1Jac(&sum))
	}))
	g.Set("__msmengineCombineG2", js.FuncOf(func(this js.Value, args []js.Value) any {
		arr := args[0]
		parts := make([]bls12381.G2Jac, arr.Length())
		for i := range parts {
			jac, err := unmarshalG2Jac(goBytes(arr.Index(i)))
			if err != nil {
				panic(err.Error())
			}
			parts[i] = jac
		}
		sum := combineG2(parts)
		return jsUint8(marshalG2Jac(&sum))
	}))
}

// workerMemStatsJS snapshots the Go runtime that owns the actual MSM kernel.
// Every Web Worker instantiates a separate msmworker.wasm, so these values are
// worker-local rather than main-prover heap estimates. Field names are stable
// trace keys consumed by the W4 matrix aggregator; all values remain numeric.
func workerMemStatsJS() js.Value {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	out := js.Global().Get("Object").New()
	out.Set("worker_go_heap_alloc_bytes", m.HeapAlloc)
	out.Set("worker_go_heap_sys_bytes", m.HeapSys)
	out.Set("worker_go_heap_inuse_bytes", m.HeapInuse)
	out.Set("worker_go_heap_released_bytes", m.HeapReleased)
	out.Set("worker_go_stack_inuse_bytes", m.StackInuse)
	out.Set("worker_go_stack_sys_bytes", m.StackSys)
	out.Set("worker_go_sys_bytes", m.Sys)
	out.Set("worker_go_gc_count", m.NumGC)
	return out
}

func sectionResultJS(partial []byte, timings map[string]float64, byteCounts map[string]int64) js.Value {
	out := js.Global().Get("Object").New()
	out.Set("partial", jsUint8(partial))
	t := js.Global().Get("Object").New()
	for k, v := range timings {
		t.Set(k, v)
	}
	out.Set("timings", t)
	b := js.Global().Get("Object").New()
	for k, v := range byteCounts {
		b.Set(k, v)
	}
	out.Set("bytes", b)
	return out
}

func timedShardResultJS(partial []byte, timings shardTimings) js.Value {
	out := js.Global().Get("Object").New()
	out.Set("partial", jsUint8(partial))
	t := js.Global().Get("Object").New()
	for k, v := range timings.fields() {
		t.Set(k, v)
	}
	t.Set("nonzero_scalars", timings.NonzeroScalars)
	if timings.PinnedDecode {
		t.Set("pinned_decode", 1)
	} else {
		t.Set("pinned_decode", 0)
	}
	out.Set("timings", t)
	return out
}

func shardSectionBytes(g2 bool, planJSON, section string, lo, hi int, scalarBytes []byte) ([]byte, map[string]float64, map[string]int64, error) {
	totalStart := time.Now()
	var plan PKSectionPlan
	if err := json.Unmarshal([]byte(planJSON), &plan); err != nil {
		return nil, nil, nil, fmt.Errorf("parse pk section plan: %w", err)
	}
	fetchStart := time.Now()
	pointsRaw, fetchedBytes, usedBytes, hashMS, sliceMS, err := fetchSectionPointBytes(&plan, section, lo, hi, g2)
	fetchMS := elapsedMS(fetchStart) - hashMS - sliceMS
	if fetchMS < 0 {
		fetchMS = 0
	}
	if err != nil {
		return nil, nil, nil, err
	}
	computeStart := time.Now()
	var partial []byte
	var kernelTimings shardTimings
	if g2 {
		partial, kernelTimings, err = shardG2BytesTimed(pointsRaw, scalarBytes, true)
	} else {
		partial, kernelTimings, err = shardG1BytesTimed(pointsRaw, scalarBytes, true)
	}
	computeMS := elapsedMS(computeStart)
	if err != nil {
		return nil, nil, nil, err
	}
	timings := map[string]float64{
		"fetch_ms":   fetchMS,
		"hash_ms":    hashMS,
		"slice_ms":   sliceMS,
		"compute_ms": computeMS,
		"total_ms":   elapsedMS(totalStart),
	}
	for k, v := range kernelTimings.fields() {
		timings[k] = v
	}
	return partial, timings, map[string]int64{
		"fetched": fetchedBytes,
		"used":    usedBytes,
	}, nil
}

func fetchSectionPointBytes(plan *PKSectionPlan, sectionName string, lo, hi int, g2 bool) ([]byte, int64, int64, float64, float64, error) {
	if plan == nil {
		return nil, 0, 0, 0, 0, fmt.Errorf("pk section plan is required")
	}
	sec, ok := plan.Sections[sectionName]
	if !ok {
		return nil, 0, 0, 0, 0, fmt.Errorf("section %q not found in pk section plan", sectionName)
	}
	wantElemSize := bls12381.SizeOfG1AffineUncompressed
	if g2 {
		wantElemSize = bls12381.SizeOfG2AffineUncompressed
	}
	if sec.ElemSize != wantElemSize {
		return nil, 0, 0, 0, 0, fmt.Errorf("section %q elem_size %d, want %d", sectionName, sec.ElemSize, wantElemSize)
	}
	totalPoints := int(sec.Len) / sec.ElemSize
	if lo < 0 || hi < lo || hi > totalPoints {
		return nil, 0, 0, 0, 0, fmt.Errorf("section range %q [%d,%d) out of bounds (len=%d)", sectionName, lo, hi, totalPoints)
	}
	start := sec.Offset + int64(lo)*int64(sec.ElemSize)
	end := sec.Offset + int64(hi)*int64(sec.ElemSize)
	if start < 0 || end < start || end > plan.FileSize {
		return nil, 0, 0, 0, 0, fmt.Errorf("section range %q bytes [%d,%d) out of bounds (file_size=%d)", sectionName, start, end, plan.FileSize)
	}
	pointsRaw := make([]byte, end-start)
	var fetchedBytes, hashMS, sliceMS float64
	for _, chunk := range plan.Chunks {
		chunkStart := chunk.Offset
		chunkEnd := chunk.Offset + chunk.Size
		if chunkEnd <= start || chunkStart >= end {
			continue
		}
		chunkRaw, fetchBytes, oneHashMS, err := fetchVerifiedChunk(plan.BaseURL, chunk)
		fetchedBytes += float64(fetchBytes)
		hashMS += oneHashMS
		if err != nil {
			return nil, 0, 0, 0, 0, err
		}
		useStart := maxInt64(start, chunkStart)
		useEnd := minInt64(end, chunkEnd)
		sliceStart := useStart - chunkStart
		dstStart := useStart - start
		sliceStarted := time.Now()
		copy(pointsRaw[dstStart:dstStart+(useEnd-useStart)], chunkRaw[sliceStart:sliceStart+(useEnd-useStart)])
		sliceMS += elapsedMS(sliceStarted)
	}
	if int64(len(pointsRaw)) != end-start {
		return nil, 0, 0, 0, 0, fmt.Errorf("assembled point bytes length %d, want %d", len(pointsRaw), end-start)
	}
	return pointsRaw, int64(fetchedBytes), int64(len(pointsRaw)), hashMS, sliceMS, nil
}

func fetchVerifiedChunk(baseURL string, chunk PKChunkPin) ([]byte, int64, float64, error) {
	chunkURL, err := resolveChunkURL(baseURL, chunk.Path)
	if err != nil {
		return nil, 0, 0, err
	}
	resp, err := http.Get(chunkURL)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("fetch chunk %d: %w", chunk.Index, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, 0, 0, fmt.Errorf("fetch chunk %d returned status %d", chunk.Index, resp.StatusCode)
	}
	if enc := strings.TrimSpace(resp.Header.Get("Content-Encoding")); enc != "" && enc != "identity" {
		return nil, 0, 0, fmt.Errorf("chunk %d content-encoding %q, want identity", chunk.Index, enc)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, chunk.Size+1))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("read chunk %d: %w", chunk.Index, err)
	}
	if int64(len(raw)) != chunk.Size {
		return nil, 0, 0, fmt.Errorf("chunk %d size %d, want %d", chunk.Index, len(raw), chunk.Size)
	}
	hashStart := time.Now()
	if err := verifyChunkDigests(raw, chunk.Index, chunk.SHA256, chunk.Blake2b256); err != nil {
		return nil, 0, 0, err
	}
	return raw, int64(len(raw)), elapsedMS(hashStart), nil
}

func verifyChunkDigests(raw []byte, index int, wantSHA256, wantBlake2b256 string) error {
	sha := sha256.Sum256(raw)
	blake, err := blake2b.New256(nil)
	if err != nil {
		return fmt.Errorf("create blake2b digest: %w", err)
	}
	if _, err := blake.Write(raw); err != nil {
		return err
	}
	shaHex := "sha256:" + hex.EncodeToString(sha[:])
	blakeHex := "blake2b256:" + hex.EncodeToString(blake.Sum(nil))
	label := "chunk"
	if index >= 0 {
		label = fmt.Sprintf("chunk %d", index)
	}
	if shaHex != wantSHA256 {
		return fmt.Errorf("%s sha256 mismatch: manifest %s, file %s", label, wantSHA256, shaHex)
	}
	if blakeHex != wantBlake2b256 {
		return fmt.Errorf("%s blake2b256 mismatch: manifest %s, file %s", label, wantBlake2b256, blakeHex)
	}
	return nil
}

func resolveChunkURL(baseURL, relPath string) (string, error) {
	if strings.TrimSpace(baseURL) == "" {
		return "", fmt.Errorf("pk section plan base_url is required")
	}
	if relPath == "" || strings.Contains(relPath, "\\") || strings.Contains(relPath, "://") || strings.ContainsAny(relPath, "?#") {
		return "", fmt.Errorf("unsafe chunk path %q", relPath)
	}
	clean := path.Clean(relPath)
	if clean != relPath || strings.HasPrefix(clean, "../") || strings.Contains(clean, "/../") {
		return "", fmt.Errorf("unsafe chunk path %q", relPath)
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	if base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("pk section plan base_url must be absolute")
	}
	ref, err := url.Parse(relPath)
	if err != nil {
		return "", err
	}
	return base.ResolveReference(ref).String(), nil
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// ---- the main-instance engine: worker pool + shardedMSM ----

// defaultWorkerCap bounds the worker count regardless of hardwareConcurrency;
// each worker is a full wasm instance with its own MSM scratch, so more than a
// modest handful yields diminishing returns and rising memory.
const defaultWorkerCap = 8

// rangeFetchConcurrency bounds how many shards of a ranged MSM are mid-fetch
// (holding a Go-side point slice in the main instance) at once. It MUST be below
// the shard count (≤ defaultWorkerCap) for the bound to bind — otherwise every
// shard fetches at once and the whole vector is briefly resident, defeating the
// memory lever. The slot is released after the SAB copy (which moves the bytes
// to JS memory, off the wasm heap) and BEFORE the worker compute, so all workers
// still run concurrently; only the fetch phase is throttled.
const rangeFetchConcurrency = 4

// worker is one Web Worker plus a channel keyed by request id for its replies.
type worker struct {
	js      js.Value // the Worker object
	onMsg   js.Func
	onErr   js.Func
	id      int
	mu      sync.Mutex
	replies chan workerReply
}

type workerReply struct {
	id        int
	partial   []byte
	err       error
	computeMS float64
	timings   map[string]any
	bytes     map[string]any
}

// workerPool owns the Web Workers and round-robins shards across them.
type workerPool struct {
	workers   []*worker
	closeOnce sync.Once
}

// shardedMSM dispatches each MSM across a workerPool. It satisfies MSMEngine.
type shardedMSM struct {
	workers               int
	shards                int
	rangeFetchConcurrency int
	pinnedDecode          bool
	optW7                 bool
	pool                  *workerPool
	asyncMu               sync.Mutex
	async                 *sectionScheduler
}

// NewSharded constructs a shardedMSM with up to `cap` workers (clamped to
// navigator.hardwareConcurrency and defaultWorkerCap). workerURL is the URL of
// worker.js. It returns an error if Web Workers or SharedArrayBuffer are
// unavailable, so the selector can fall back to cpuMSM.
func NewSharded(workerURL string, cap int) (*shardedMSM, error) {
	return NewShardedWithOptions(workerURL, cap, Options{})
}

func NewShardedWithOptions(workerURL string, cap int, opts Options) (*shardedMSM, error) {
	g := js.Global()
	if g.Get("Worker").IsUndefined() {
		return nil, errors.New("shardedMSM: Web Workers unavailable")
	}
	if g.Get("SharedArrayBuffer").IsUndefined() {
		return nil, errors.New("shardedMSM: SharedArrayBuffer unavailable (needs COOP/COEP)")
	}
	n := workerCount(cap)
	if opts.WorkerCount > defaultWorkerCap {
		n = opts.WorkerCount
	}
	shards := opts.ShardCount
	if shards <= 0 {
		shards = n
	}
	concurrency := opts.RangeFetchConcurrency
	if concurrency <= 0 {
		concurrency = rangeFetchConcurrency
	}
	if concurrency > shards {
		concurrency = shards
	}
	if concurrency < 1 {
		concurrency = 1
	}
	pool := &workerPool{}
	for i := 0; i < n; i++ {
		w, err := newWorker(g, workerURL, i)
		if err != nil {
			pool.close()
			return nil, err
		}
		pool.workers = append(pool.workers, w)
	}
	return &shardedMSM{workers: n, shards: shards, rangeFetchConcurrency: concurrency, pinnedDecode: opts.PinnedDecode, optW7: opts.OptW7, pool: pool}, nil
}

// newWorker spawns one Web Worker from workerURL and wires its onmessage/onerror
// handlers to feed the per-worker reply channel. Each worker instantiates the
// same wasm module (the worker kernel) and answers one shard at a time.
func newWorker(g js.Value, workerURL string, id int) (*worker, error) {
	jsWorker := g.Get("Worker").New(workerURL)
	w := &worker{
		js:      jsWorker,
		id:      id,
		replies: make(chan workerReply, 1),
	}
	w.onMsg = js.FuncOf(func(this js.Value, args []js.Value) any {
		data := args[0].Get("data")
		if errv := data.Get("error"); !errv.IsUndefined() && !errv.IsNull() {
			select {
			case w.replies <- workerReply{id: data.Get("id").Int(), err: errors.New(errv.String())}:
			default:
			}
			return nil
		}
		reply := workerReply{
			id:        data.Get("id").Int(),
			partial:   goBytes(data.Get("partial")),
			computeMS: jsFloat(data.Get("compute_ms")),
			timings:   jsNumberObject(data.Get("timings")),
			bytes:     jsNumberObject(data.Get("bytes")),
		}
		select {
		case w.replies <- reply:
		default:
		}
		return nil
	})
	w.onErr = js.FuncOf(func(this js.Value, args []js.Value) any {
		msg := "worker error"
		if len(args) > 0 {
			if m := args[0].Get("message"); !m.IsUndefined() {
				msg = m.String()
			}
		}
		select {
		case w.replies <- workerReply{err: errors.New(msg)}:
		default:
		}
		return nil
	})
	jsWorker.Set("onmessage", w.onMsg)
	jsWorker.Set("onerror", w.onErr)
	return w, nil
}

// workerCount returns min(navigator.hardwareConcurrency, cap, defaultWorkerCap),
// at least 1.
func workerCount(cap int) int {
	hw := 0
	if nav := js.Global().Get("navigator"); !nav.IsUndefined() {
		if hc := nav.Get("hardwareConcurrency"); !hc.IsUndefined() {
			hw = hc.Int()
		}
	}
	n := hw
	if n <= 0 {
		n = 1
	}
	if cap > 0 && cap < n {
		n = cap
	}
	if n > defaultWorkerCap {
		n = defaultWorkerCap
	}
	return n
}

func (s *shardedMSM) Name() string { return "sharded" }

func (s *shardedMSM) Instrumentation() map[string]any {
	return map[string]any{
		"worker_count":            s.workers,
		"shard_count":             s.shards,
		"range_fetch_concurrency": s.rangeFetchConcurrency,
		"pinned_decode":           s.pinnedDecode,
		"opt_w7":                  s.optW7,
		"async_queue_capacity":    asyncQueueCapacity(s.shards),
	}
}

func (s *shardedMSM) Close() error {
	s.CancelOutstanding(errors.New("shardedMSM closed"))
	if s.pool != nil {
		s.pool.close()
	}
	return nil
}

func (p *workerPool) close() {
	p.closeOnce.Do(func() {
		for _, w := range p.workers {
			if w == nil {
				continue
			}
			if !w.js.IsUndefined() {
				w.js.Call("terminate")
			}
			w.onMsg.Release()
			w.onErr.Release()
		}
	})
}

// MSMG1 partitions points/scalars into one shard per worker, dispatches all
// shards concurrently (one goroutine per shard, each parks on its worker's reply
// channel while the JS event loop delivers results in parallel), collects the
// partial Jacobians, and combines them.
func (s *shardedMSM) MSMG1(dst *bls12381.G1Jac, points []bls12381.G1Affine, scalars []fr.Element, prog ProgressFn) error {
	prog = progressReporter(prog)
	if len(points) != len(scalars) {
		return fmt.Errorf("shardedMSM.MSMG1: %d points vs %d scalars", len(points), len(scalars))
	}
	ranges := nonEmptyRanges(partitionRanges(len(points), s.shards))
	if len(ranges) == 0 {
		*dst = combineG1(nil)
		if prog != nil {
			prog(0, 0)
		}
		return nil
	}
	type g1res struct {
		idx int
		r   [2]int
		jac bls12381.G1Jac
		err error
	}
	ch := make(chan g1res, len(ranges))
	for i, r := range ranges {
		i, r := i, r
		go func() {
			totalStart := time.Now()
			marshalStart := time.Now()
			ptsBuf := marshalG1Points(points[r[0]:r[1]])
			scsBuf := marshalScalars(scalars[r[0]:r[1]])
			marshalMS := elapsedMS(marshalStart)
			w := s.pool.workers[i%len(s.pool.workers)]
			queueStart := time.Now()
			w.mu.Lock()
			queueMS := elapsedMS(queueStart)
			sabStart := time.Now()
			ptsSab := newSAB(ptsBuf)
			scsSab := newSAB(scsBuf)
			zeroBytes(scsBuf)
			sabMS := elapsedMS(sabStart)
			workerStart := time.Now()
			partial, computeMS, timings, err := w.postAndWaitLocked(i, false, ptsSab, scsSab, s.pinnedDecode)
			zeroSAB(scsSab)
			workerMS := elapsedMS(workerStart)
			w.mu.Unlock()
			fields := map[string]any{
				"marshal_ms":           marshalMS,
				"sab_copy_ms":          sabMS,
				"queue_wait_ms":        queueMS,
				"worker_turnaround_ms": workerMS,
				"worker_compute_ms":    computeMS,
				"total_ms":             elapsedMS(totalStart),
				"error":                errorString(err),
			}
			addTraceFields(fields, timings)
			emitShardTrace("MSMG1", "g1", i, w.id, r, len(points), fields)
			if err != nil {
				ch <- g1res{idx: i, r: r, err: err}
				return
			}
			jac, err := unmarshalG1Jac(partial)
			if err != nil {
				err = workerPartialIntegrityError(err)
			}
			ch <- g1res{idx: i, r: r, jac: jac, err: err}
		}()
	}
	parts := make([]bls12381.G1Jac, len(ranges))
	total := len(scalars)
	done := 0
	var firstErr error
	for range ranges {
		res := <-ch
		if res.err != nil && firstErr == nil {
			firstErr = res.err
		}
		parts[res.idx] = res.jac
		done += res.r[1] - res.r[0]
		if prog != nil {
			prog(done, total)
		}
	}
	if firstErr != nil {
		return firstErr
	}
	*dst = combineG1(parts)
	return nil
}

// MSMG2 is the G2 counterpart of MSMG1: all shards are dispatched concurrently.
func (s *shardedMSM) MSMG2(dst *bls12381.G2Jac, points []bls12381.G2Affine, scalars []fr.Element, prog ProgressFn) error {
	prog = progressReporter(prog)
	if len(points) != len(scalars) {
		return fmt.Errorf("shardedMSM.MSMG2: %d points vs %d scalars", len(points), len(scalars))
	}
	ranges := nonEmptyRanges(partitionRanges(len(points), s.shards))
	if len(ranges) == 0 {
		*dst = combineG2(nil)
		if prog != nil {
			prog(0, 0)
		}
		return nil
	}
	type g2res struct {
		idx int
		r   [2]int
		jac bls12381.G2Jac
		err error
	}
	ch := make(chan g2res, len(ranges))
	for i, r := range ranges {
		i, r := i, r
		go func() {
			totalStart := time.Now()
			marshalStart := time.Now()
			ptsBuf := marshalG2Points(points[r[0]:r[1]])
			scsBuf := marshalScalars(scalars[r[0]:r[1]])
			marshalMS := elapsedMS(marshalStart)
			w := s.pool.workers[i%len(s.pool.workers)]
			queueStart := time.Now()
			w.mu.Lock()
			queueMS := elapsedMS(queueStart)
			sabStart := time.Now()
			ptsSab := newSAB(ptsBuf)
			scsSab := newSAB(scsBuf)
			zeroBytes(scsBuf)
			sabMS := elapsedMS(sabStart)
			workerStart := time.Now()
			partial, computeMS, timings, err := w.postAndWaitLocked(i, true, ptsSab, scsSab, s.pinnedDecode)
			zeroSAB(scsSab)
			workerMS := elapsedMS(workerStart)
			w.mu.Unlock()
			fields := map[string]any{
				"marshal_ms":           marshalMS,
				"sab_copy_ms":          sabMS,
				"queue_wait_ms":        queueMS,
				"worker_turnaround_ms": workerMS,
				"worker_compute_ms":    computeMS,
				"total_ms":             elapsedMS(totalStart),
				"error":                errorString(err),
			}
			addTraceFields(fields, timings)
			emitShardTrace("MSMG2", "g2", i, w.id, r, len(points), fields)
			if err != nil {
				ch <- g2res{idx: i, r: r, err: err}
				return
			}
			jac, err := unmarshalG2Jac(partial)
			if err != nil {
				err = workerPartialIntegrityError(err)
			}
			ch <- g2res{idx: i, r: r, jac: jac, err: err}
		}()
	}
	parts := make([]bls12381.G2Jac, len(ranges))
	total := len(scalars)
	done := 0
	var firstErr error
	for range ranges {
		res := <-ch
		if res.err != nil && firstErr == nil {
			firstErr = res.err
		}
		parts[res.idx] = res.jac
		done += res.r[1] - res.r[0]
		if prog != nil {
			prog(done, total)
		}
	}
	if firstErr != nil {
		return firstErr
	}
	*dst = combineG2(parts)
	return nil
}

// MSMG1Ranged is the memory-lever variant of MSMG1: it does NOT receive the
// point-vector. Instead it partitions [0,n) per worker and fetches each shard's
// points via fetch(lo,hi) right before dispatch. The fetch + SharedArrayBuffer
// copy run sequentially in this goroutine, so at most one shard's points are
// resident in the MAIN instance's Go heap at a time; once copied into the SAB
// (JS memory, OUTSIDE the main wasm linear memory) the Go slice is freed. The
// worker compute still runs concurrently. Net: the full point-vector never
// materializes in the main instance, keeping it off the 4 GiB ceiling, while
// the result stays bit-identical to a whole-vector MSM.
func (s *shardedMSM) MSMG1Ranged(dst *bls12381.G1Jac, n int, fetch FetchG1, scalars []fr.Element, prog ProgressFn) error {
	prog = progressReporter(prog)
	if len(scalars) != n {
		return fmt.Errorf("shardedMSM.MSMG1Ranged: %d scalars vs n=%d", len(scalars), n)
	}
	ranges := nonEmptyRanges(partitionRanges(n, s.shards))
	if len(ranges) == 0 {
		*dst = combineG1(nil)
		if prog != nil {
			prog(0, 0)
		}
		return nil
	}
	type g1res struct {
		idx int
		r   [2]int
		jac bls12381.G1Jac
		err error
	}
	ch := make(chan g1res, len(ranges))
	sem := make(chan struct{}, s.rangeFetchConcurrency)
	for i, r := range ranges {
		i, r := i, r
		go func() {
			totalStart := time.Now()
			w := s.pool.workers[i%len(s.pool.workers)]
			queueStart := time.Now()
			w.mu.Lock()
			queueMS := elapsedMS(queueStart)
			defer w.mu.Unlock()
			// Fetch + marshal + SAB-copy under the semaphore, so at most
			// rangeFetchConcurrency shards hold a Go-side point slice at once. The
			// slot is released (defer, so it covers a marshal/SAB OOM panic too)
			// before the worker compute, leaving all workers free to run in
			// parallel; the points' bytes now live in the SAB (JS memory).
			var fetchMS, marshalMS, sabMS float64
			ptsSab, scsSab, ferr := func() (js.Value, js.Value, error) {
				sem <- struct{}{}
				defer func() { <-sem }()
				fetchStart := time.Now()
				pts, err := fetch(r[0], r[1])
				fetchMS = elapsedMS(fetchStart)
				if err != nil {
					return js.Undefined(), js.Undefined(), fmt.Errorf("shardedMSM.MSMG1Ranged: fetch [%d,%d): %w", r[0], r[1], err)
				}
				if len(pts) != r[1]-r[0] {
					return js.Undefined(), js.Undefined(), fmt.Errorf("shardedMSM.MSMG1Ranged: fetch [%d,%d) returned %d points, want %d", r[0], r[1], len(pts), r[1]-r[0])
				}
				marshalStart := time.Now()
				ptsBuf := marshalG1Points(pts)
				scsBuf := marshalScalars(scalars[r[0]:r[1]])
				marshalMS = elapsedMS(marshalStart)
				sabStart := time.Now()
				ptsSab := newSAB(ptsBuf)
				scsSab := newSAB(scsBuf)
				zeroBytes(scsBuf)
				sabMS = elapsedMS(sabStart)
				return ptsSab, scsSab, nil
			}()
			if ferr != nil {
				emitShardTrace("MSMG1Ranged", "g1", i, w.id, r, n, map[string]any{
					"fetch_ms":      fetchMS,
					"marshal_ms":    marshalMS,
					"sab_copy_ms":   sabMS,
					"queue_wait_ms": queueMS,
					"total_ms":      elapsedMS(totalStart),
					"error":         ferr.Error(),
				})
				ch <- g1res{idx: i, r: r, err: ferr}
				return
			}
			workerStart := time.Now()
			partial, computeMS, timings, err := w.postAndWaitLocked(i, false, ptsSab, scsSab, s.pinnedDecode)
			zeroSAB(scsSab)
			workerMS := elapsedMS(workerStart)
			fields := map[string]any{
				"fetch_ms":             fetchMS,
				"marshal_ms":           marshalMS,
				"sab_copy_ms":          sabMS,
				"queue_wait_ms":        queueMS,
				"worker_turnaround_ms": workerMS,
				"worker_compute_ms":    computeMS,
				"total_ms":             elapsedMS(totalStart),
				"error":                errorString(err),
			}
			addTraceFields(fields, timings)
			emitShardTrace("MSMG1Ranged", "g1", i, w.id, r, n, fields)
			if err != nil {
				ch <- g1res{idx: i, r: r, err: err}
				return
			}
			jac, err := unmarshalG1Jac(partial)
			if err != nil {
				err = workerPartialIntegrityError(err)
			}
			ch <- g1res{idx: i, r: r, jac: jac, err: err}
		}()
	}
	parts := make([]bls12381.G1Jac, len(ranges))
	done := 0
	var firstErr error
	for range ranges {
		res := <-ch
		if res.err != nil && firstErr == nil {
			firstErr = res.err
		}
		parts[res.idx] = res.jac
		done += res.r[1] - res.r[0]
		if prog != nil {
			prog(done, n)
		}
	}
	if firstErr != nil {
		return firstErr
	}
	*dst = combineG1(parts)
	return nil
}

// MSMG2Ranged is the G2 counterpart of MSMG1Ranged (e.g. the 3.06M-point G2.B
// section — the single biggest vector, ~588 MB whole, that drove the peak).
func (s *shardedMSM) MSMG2Ranged(dst *bls12381.G2Jac, n int, fetch FetchG2, scalars []fr.Element, prog ProgressFn) error {
	prog = progressReporter(prog)
	if len(scalars) != n {
		return fmt.Errorf("shardedMSM.MSMG2Ranged: %d scalars vs n=%d", len(scalars), n)
	}
	ranges := nonEmptyRanges(partitionRanges(n, s.shards))
	if len(ranges) == 0 {
		*dst = combineG2(nil)
		if prog != nil {
			prog(0, 0)
		}
		return nil
	}
	type g2res struct {
		idx int
		r   [2]int
		jac bls12381.G2Jac
		err error
	}
	ch := make(chan g2res, len(ranges))
	sem := make(chan struct{}, s.rangeFetchConcurrency)
	for i, r := range ranges {
		i, r := i, r
		go func() {
			totalStart := time.Now()
			w := s.pool.workers[i%len(s.pool.workers)]
			queueStart := time.Now()
			w.mu.Lock()
			queueMS := elapsedMS(queueStart)
			defer w.mu.Unlock()
			var fetchMS, marshalMS, sabMS float64
			ptsSab, scsSab, ferr := func() (js.Value, js.Value, error) {
				sem <- struct{}{}
				defer func() { <-sem }()
				fetchStart := time.Now()
				pts, err := fetch(r[0], r[1])
				fetchMS = elapsedMS(fetchStart)
				if err != nil {
					return js.Undefined(), js.Undefined(), fmt.Errorf("shardedMSM.MSMG2Ranged: fetch [%d,%d): %w", r[0], r[1], err)
				}
				if len(pts) != r[1]-r[0] {
					return js.Undefined(), js.Undefined(), fmt.Errorf("shardedMSM.MSMG2Ranged: fetch [%d,%d) returned %d points, want %d", r[0], r[1], len(pts), r[1]-r[0])
				}
				marshalStart := time.Now()
				ptsBuf := marshalG2Points(pts)
				scsBuf := marshalScalars(scalars[r[0]:r[1]])
				marshalMS = elapsedMS(marshalStart)
				sabStart := time.Now()
				ptsSab := newSAB(ptsBuf)
				scsSab := newSAB(scsBuf)
				zeroBytes(scsBuf)
				sabMS = elapsedMS(sabStart)
				return ptsSab, scsSab, nil
			}()
			if ferr != nil {
				emitShardTrace("MSMG2Ranged", "g2", i, w.id, r, n, map[string]any{
					"fetch_ms":      fetchMS,
					"marshal_ms":    marshalMS,
					"sab_copy_ms":   sabMS,
					"queue_wait_ms": queueMS,
					"total_ms":      elapsedMS(totalStart),
					"error":         ferr.Error(),
				})
				ch <- g2res{idx: i, r: r, err: ferr}
				return
			}
			workerStart := time.Now()
			partial, computeMS, timings, err := w.postAndWaitLocked(i, true, ptsSab, scsSab, s.pinnedDecode)
			zeroSAB(scsSab)
			workerMS := elapsedMS(workerStart)
			fields := map[string]any{
				"fetch_ms":             fetchMS,
				"marshal_ms":           marshalMS,
				"sab_copy_ms":          sabMS,
				"queue_wait_ms":        queueMS,
				"worker_turnaround_ms": workerMS,
				"worker_compute_ms":    computeMS,
				"total_ms":             elapsedMS(totalStart),
				"error":                errorString(err),
			}
			addTraceFields(fields, timings)
			emitShardTrace("MSMG2Ranged", "g2", i, w.id, r, n, fields)
			if err != nil {
				ch <- g2res{idx: i, r: r, err: err}
				return
			}
			jac, err := unmarshalG2Jac(partial)
			if err != nil {
				err = workerPartialIntegrityError(err)
			}
			ch <- g2res{idx: i, r: r, jac: jac, err: err}
		}()
	}
	parts := make([]bls12381.G2Jac, len(ranges))
	done := 0
	var firstErr error
	for range ranges {
		res := <-ch
		if res.err != nil && firstErr == nil {
			firstErr = res.err
		}
		parts[res.idx] = res.jac
		done += res.r[1] - res.r[0]
		if prog != nil {
			prog(done, n)
		}
	}
	if firstErr != nil {
		return firstErr
	}
	*dst = combineG2(parts)
	return nil
}

func (s *shardedMSM) MSMG1Section(dst *bls12381.G1Jac, plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) error {
	prog = progressReporter(prog)
	if len(scalars) != n {
		return fmt.Errorf("shardedMSM.MSMG1Section: %d scalars vs n=%d", len(scalars), n)
	}
	ranges := nonEmptyRanges(partitionRanges(n, s.shards))
	if len(ranges) == 0 {
		*dst = combineG1(nil)
		if prog != nil {
			prog(0, 0)
		}
		return nil
	}
	planJSON, err := json.Marshal(plan)
	if err != nil {
		return fmt.Errorf("marshal pk section plan: %w", err)
	}
	type g1res struct {
		idx        int
		workerSlot int
		r          [2]int
		jac        bls12381.G1Jac
		err        error
	}
	ch := make(chan g1res, len(ranges))
	launch := func(workerSlot, idx int) {
		r := ranges[idx]
		w := s.pool.workers[workerSlot]
		go func() {
			totalStart := time.Now()
			scalarStart := time.Now()
			scsBuf := marshalScalars(scalars[r[0]:r[1]])
			scalarMS := elapsedMS(scalarStart)
			queueStart := time.Now()
			w.mu.Lock()
			queueMS := elapsedMS(queueStart)
			sabStart := time.Now()
			scsSab := newSAB(scsBuf)
			zeroBytes(scsBuf)
			sabMS := elapsedMS(sabStart)
			workerStart := time.Now()
			reply := w.postSectionAndWaitLocked(idx, false, string(planJSON), section, r, scsSab, s.pinnedDecode, s.optW7)
			zeroSAB(scsSab)
			workerMS := elapsedMS(workerStart)
			w.mu.Unlock()
			fields := map[string]any{
				"section":               section,
				"worker_owned_fetch":    true,
				"point_bytes_from_main": 0,
				"scalar_bytes":          len(scsBuf),
				"scalar_marshal_ms":     scalarMS,
				"sab_copy_ms":           sabMS,
				"queue_wait_ms":         queueMS,
				"worker_turnaround_ms":  workerMS,
				"worker_compute_ms":     reply.computeMS,
				"total_ms":              elapsedMS(totalStart),
				"error":                 errorString(reply.err),
			}
			addTraceFields(fields, reply.timings)
			addByteTraceFields(fields, reply.bytes)
			emitShardTrace("MSMG1Section", "g1", idx, w.id, r, n, fields)
			if reply.err != nil {
				ch <- g1res{idx: idx, workerSlot: workerSlot, r: r, err: reply.err}
				return
			}
			jac, err := unmarshalG1Jac(reply.partial)
			if err != nil {
				err = workerPartialIntegrityError(err)
			}
			ch <- g1res{idx: idx, workerSlot: workerSlot, r: r, jac: jac, err: err}
		}()
	}
	next := 0
	var affinity contiguousShardAffinity
	var affinityNext []int
	resultsExpected := len(ranges)
	if s.optW7 {
		affinity = newContiguousShardAffinity(len(ranges), len(s.pool.workers))
		affinityNext = make([]int, len(s.pool.workers))
		resultsExpected = 0
		for workerSlot, shards := range affinity.byWorker {
			if len(shards) == 0 {
				continue
			}
			launch(workerSlot, shards[0])
			affinityNext[workerSlot] = 1
			resultsExpected++
		}
	} else {
		initial := len(s.pool.workers)
		if initial > len(ranges) {
			initial = len(ranges)
		}
		for ; next < initial; next++ {
			launch(next, next)
		}
	}
	parts := make([]bls12381.G1Jac, len(ranges))
	done := 0
	var firstErr error
	for received := 0; received < resultsExpected; received++ {
		res := <-ch
		if res.err != nil && firstErr == nil {
			firstErr = res.err
		}
		parts[res.idx] = res.jac
		done += res.r[1] - res.r[0]
		if prog != nil {
			prog(done, n)
		}
		if s.optW7 {
			// A failed Worker or invalid partial terminates W7 scheduling for this
			// section. Drain only already-launched turns, then fail closed; never
			// reuse the failed affinity slot for its remaining shard block.
			if firstErr == nil {
				workerShards := affinity.byWorker[res.workerSlot]
				if affinityNext[res.workerSlot] < len(workerShards) {
					launch(res.workerSlot, workerShards[affinityNext[res.workerSlot]])
					affinityNext[res.workerSlot]++
					resultsExpected++
				}
			}
		} else if next < len(ranges) {
			launch(res.workerSlot, next)
			next++
		}
	}
	if firstErr != nil {
		return firstErr
	}
	combineStart := time.Now()
	*dst = combineG1(parts)
	EmitTrace("measure", "msm-section-combine", map[string]any{
		"operation":    "MSMG1Section",
		"group":        "g1",
		"section":      section,
		"partials":     len(parts),
		"total_points": n,
		"combine_ms":   elapsedMS(combineStart),
	})
	return nil
}

func (s *shardedMSM) MSMG2Section(dst *bls12381.G2Jac, plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) error {
	prog = progressReporter(prog)
	if len(scalars) != n {
		return fmt.Errorf("shardedMSM.MSMG2Section: %d scalars vs n=%d", len(scalars), n)
	}
	ranges := nonEmptyRanges(partitionRanges(n, s.shards))
	if len(ranges) == 0 {
		*dst = combineG2(nil)
		if prog != nil {
			prog(0, 0)
		}
		return nil
	}
	planJSON, err := json.Marshal(plan)
	if err != nil {
		return fmt.Errorf("marshal pk section plan: %w", err)
	}
	type g2res struct {
		idx        int
		workerSlot int
		r          [2]int
		jac        bls12381.G2Jac
		err        error
	}
	ch := make(chan g2res, len(ranges))
	launch := func(workerSlot, idx int) {
		r := ranges[idx]
		w := s.pool.workers[workerSlot]
		go func() {
			totalStart := time.Now()
			scalarStart := time.Now()
			scsBuf := marshalScalars(scalars[r[0]:r[1]])
			scalarMS := elapsedMS(scalarStart)
			queueStart := time.Now()
			w.mu.Lock()
			queueMS := elapsedMS(queueStart)
			sabStart := time.Now()
			scsSab := newSAB(scsBuf)
			zeroBytes(scsBuf)
			sabMS := elapsedMS(sabStart)
			workerStart := time.Now()
			reply := w.postSectionAndWaitLocked(idx, true, string(planJSON), section, r, scsSab, s.pinnedDecode, s.optW7)
			zeroSAB(scsSab)
			workerMS := elapsedMS(workerStart)
			w.mu.Unlock()
			fields := map[string]any{
				"section":               section,
				"worker_owned_fetch":    true,
				"point_bytes_from_main": 0,
				"scalar_bytes":          len(scsBuf),
				"scalar_marshal_ms":     scalarMS,
				"sab_copy_ms":           sabMS,
				"queue_wait_ms":         queueMS,
				"worker_turnaround_ms":  workerMS,
				"worker_compute_ms":     reply.computeMS,
				"total_ms":              elapsedMS(totalStart),
				"error":                 errorString(reply.err),
			}
			addTraceFields(fields, reply.timings)
			addByteTraceFields(fields, reply.bytes)
			emitShardTrace("MSMG2Section", "g2", idx, w.id, r, n, fields)
			if reply.err != nil {
				ch <- g2res{idx: idx, workerSlot: workerSlot, r: r, err: reply.err}
				return
			}
			jac, err := unmarshalG2Jac(reply.partial)
			if err != nil {
				err = workerPartialIntegrityError(err)
			}
			ch <- g2res{idx: idx, workerSlot: workerSlot, r: r, jac: jac, err: err}
		}()
	}
	next := 0
	var affinity contiguousShardAffinity
	var affinityNext []int
	resultsExpected := len(ranges)
	if s.optW7 {
		affinity = newContiguousShardAffinity(len(ranges), len(s.pool.workers))
		affinityNext = make([]int, len(s.pool.workers))
		resultsExpected = 0
		for workerSlot, shards := range affinity.byWorker {
			if len(shards) == 0 {
				continue
			}
			launch(workerSlot, shards[0])
			affinityNext[workerSlot] = 1
			resultsExpected++
		}
	} else {
		initial := len(s.pool.workers)
		if initial > len(ranges) {
			initial = len(ranges)
		}
		for ; next < initial; next++ {
			launch(next, next)
		}
	}
	parts := make([]bls12381.G2Jac, len(ranges))
	done := 0
	var firstErr error
	for received := 0; received < resultsExpected; received++ {
		res := <-ch
		if res.err != nil && firstErr == nil {
			firstErr = res.err
		}
		parts[res.idx] = res.jac
		done += res.r[1] - res.r[0]
		if prog != nil {
			prog(done, n)
		}
		if s.optW7 {
			// Match the G1 fail-closed rule: after any Worker error, launch no
			// additional affinity-owned shards and drain only in-flight turns.
			if firstErr == nil {
				workerShards := affinity.byWorker[res.workerSlot]
				if affinityNext[res.workerSlot] < len(workerShards) {
					launch(res.workerSlot, workerShards[affinityNext[res.workerSlot]])
					affinityNext[res.workerSlot]++
					resultsExpected++
				}
			}
		} else if next < len(ranges) {
			launch(res.workerSlot, next)
			next++
		}
	}
	if firstErr != nil {
		return firstErr
	}
	combineStart := time.Now()
	*dst = combineG2(parts)
	EmitTrace("measure", "msm-section-combine", map[string]any{
		"operation":    "MSMG2Section",
		"group":        "g2",
		"section":      section,
		"partials":     len(parts),
		"total_points": n,
		"combine_ms":   elapsedMS(combineStart),
	})
	return nil
}

// dispatch posts one shard to this worker over a SharedArrayBuffer and blocks
// until the worker posts back its partial (or an error). Blocking parks the Go
// goroutine; the JS event loop runs the worker's onmessage, which feeds the
// reply channel and resumes us.
func (w *worker) dispatch(id int, g2 bool, ptsBuf, scsBuf []byte) ([]byte, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	scsSab := newSAB(scsBuf)
	zeroBytes(scsBuf)
	partial, _, _, err := w.postAndWaitLocked(id, g2, newSAB(ptsBuf), scsSab, false)
	zeroSAB(scsSab)
	return partial, err
}

// postAndWait posts pre-built SharedArrayBuffers to this worker and blocks until
// its reply. Splitting this out of dispatch lets the ranged path build the SABs
// in the caller goroutine (sequentially, so only one shard's point bytes are
// being copied at a time) and then hand them off for concurrent compute.
func (w *worker) postAndWaitLocked(id int, g2 bool, ptsSab, scsSab js.Value, pinnedDecode bool) ([]byte, float64, map[string]any, error) {
	msg := js.Global().Get("Object").New()
	msg.Set("id", id)
	msg.Set("g2", g2)
	msg.Set("pts", ptsSab)
	msg.Set("scs", scsSab)
	msg.Set("pinnedDecode", pinnedDecode)
	w.js.Call("postMessage", msg)
	reply := <-w.replies
	if reply.err != nil {
		return nil, reply.computeMS, reply.timings, reply.err
	}
	// Guard against a stale/crossed reply (e.g. an async onerror, whose reply
	// carries a zero id): each worker answers exactly one shard per MSM call, so
	// a non-matching id means the partial does not belong to this shard.
	if reply.id != id {
		return nil, reply.computeMS, reply.timings, workerReplyIntegrityError(id, reply.id)
	}
	return reply.partial, reply.computeMS, reply.timings, nil
}

func (w *worker) postSectionAndWaitLocked(id int, g2 bool, planJSON string, section string, r [2]int, scsSab js.Value, pinnedDecode, optW7 bool) workerReply {
	return w.postSectionAndWaitLockedCancelable(id, g2, planJSON, section, r, scsSab, pinnedDecode, optW7, nil)
}

func (w *worker) postSectionAndWaitLockedCancelable(id int, g2 bool, planJSON string, section string, r [2]int, scsSab js.Value, pinnedDecode, optW7 bool, cancel <-chan struct{}) workerReply {
	msg := js.Global().Get("Object").New()
	msg.Set("type", "msm-section-range")
	msg.Set("id", id)
	msg.Set("g2", g2)
	msg.Set("pkPlan", planJSON)
	msg.Set("section", section)
	msg.Set("lo", r[0])
	msg.Set("hi", r[1])
	msg.Set("scs", scsSab)
	msg.Set("pinnedDecode", pinnedDecode)
	msg.Set("optW7", optW7)
	w.js.Call("postMessage", msg)
	reply, waitErr := waitForAsyncResult(w.replies, cancel, asyncWorkerReplyTimeout)
	if waitErr != nil {
		if errors.Is(waitErr, errAsyncWaitCancelled) {
			return workerReply{err: failClosed("async-msm-cancelled", waitErr)}
		}
		return workerReply{err: failClosed("worker-terminated", waitErr)}
	}
	if reply.err != nil {
		reply.err = classifySectionWorkerError(reply.err)
		return reply
	}
	if reply.id != id {
		reply.err = workerReplyIntegrityError(id, reply.id)
		return reply
	}
	if err := validateW7WorkerAcknowledgement(optW7, reply.timings); err != nil {
		reply.err = err
		return reply
	}
	return reply
}

// newSAB copies b into a freshly allocated SharedArrayBuffer-backed Uint8Array
// and returns the SharedArrayBuffer (shared, so no transfer list needed).
func newSAB(b []byte) js.Value {
	sab := js.Global().Get("SharedArrayBuffer").New(len(b))
	view := js.Global().Get("Uint8Array").New(sab)
	js.CopyBytesToJS(view, b)
	return sab
}

func zeroBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

func zeroSAB(sab js.Value) {
	if sab.IsUndefined() || sab.IsNull() {
		return
	}
	js.Global().Get("Uint8Array").New(sab).Call("fill", 0)
}

func emitShardTrace(op, group string, shard, workerID int, r [2]int, totalPoints int, fields map[string]any) {
	out := map[string]any{
		"operation":    op,
		"group":        group,
		"shard_index":  shard,
		"worker_id":    workerID,
		"range_lo":     r[0],
		"range_hi":     r[1],
		"point_count":  r[1] - r[0],
		"total_points": totalPoints,
	}
	for k, v := range fields {
		out[k] = v
	}
	EmitTrace("measure", "shard", out)
}

func elapsedMS(start time.Time) float64 {
	return float64(time.Since(start).Microseconds()) / 1000
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func addTraceFields(dst map[string]any, src map[string]any) {
	for k, v := range src {
		dst[k] = v
	}
}

func addByteTraceFields(dst map[string]any, src map[string]any) {
	for k, v := range src {
		dst["range_bytes_"+k] = v
	}
}

func jsFloat(v js.Value) float64 {
	if v.IsUndefined() || v.IsNull() {
		return 0
	}
	return v.Float()
}

func jsNumberObject(v js.Value) map[string]any {
	if v.IsUndefined() || v.IsNull() {
		return nil
	}
	keys := js.Global().Get("Object").Call("keys", v)
	out := make(map[string]any, keys.Length())
	for i := 0; i < keys.Length(); i++ {
		key := keys.Index(i).String()
		value := v.Get(key)
		if value.IsUndefined() || value.IsNull() {
			continue
		}
		out[key] = value.Float()
	}
	return out
}
