//go:build js && wasm

package msmengine

// hfft_js.go — opt-W8: computeH's whole-vector FFT transforms on dedicated
// FFT Web Workers.
//
// computeH runs six large transforms (three iFFTs, three coset FFTs) plus a
// final coset iFFT serially on the single-threaded main wasm instance —
// ~20 s of the warm critical path at the 2^21 domain — while the MSM worker
// pool grinds the pre-dispatched W1 sections. Sharing that pool would park
// FFT jobs behind multi-second MSM shards, so W8 spawns a small pool of
// DEDICATED workers (same pinned worker.js/wasm, same init path) that only
// run __msmengineFFTTransform. The three per-vector transform chains
// (iFFT→coset FFT) are independent, so three workers pipeline them
// concurrently; the final coset iFFT ships to a worker as well.
//
// Correctness: the worker runs gnark's serial FFT via hTransformBytes —
// identical code, exact field arithmetic — so the transformed vector is
// bit-identical to the main-thread path (pinned natively by
// TestHTransformMatchesSerialFFT). Any worker failure falls back to the
// identical local serial transform; unlike the authenticated chunk paths
// this is pure compute on witness data already resident on the main thread,
// so falling back cannot cross a trust boundary.

import (
	"errors"
	"fmt"
	"sync"
	"syscall/js"
	"time"

	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

// hfftWorkerCount is the dedicated FFT pool size: one worker per independent
// computeH vector chain (a, b, c). More workers cannot help without
// intra-transform parallelism.
const hfftWorkerCount = 3

// hfftMinMSMWorkers gates opt-W8: below this MSM pool size the dedicated FFT
// workers would oversubscribe the cores the MSM shards need, while the
// main-thread FFT there is effectively free parallelism.
const hfftMinMSMWorkers = 8

// hfftTransformTimeout bounds one whole-vector transform (~3-4 s at the
// production 2^21 cardinality on a slow core; 120 s is watchdog headroom, not
// a performance expectation).
const hfftTransformTimeout = 120 * time.Second

// hfftPoolTakeTimeout bounds waiting for a free worker. Phases issue at most
// poolsize concurrent transforms, so a healthy pool hands over a worker
// immediately; only a partially drained pool makes callers wait.
const hfftPoolTakeTimeout = 15 * time.Second

// hfftPool owns the dedicated FFT workers. Lazily spawned on the first
// computeH so proofs that never reach the FFT (errors, CPU engine) pay
// nothing; reused across proofs on a prepared session.
type hfftPool struct {
	mu        sync.Mutex
	workers   []*worker
	spawnErr  error
	workerURL string
	nextID    int
	free      chan *worker
	// live counts workers still in rotation; retired (timed-out) workers are
	// terminated and never re-pooled, and when the last one drains the pool
	// marks itself failed so later transforms fail fast to the serial path
	// instead of blocking on an empty free channel.
	live int
}

func newHFFTPool(workerURL string) *hfftPool {
	return &hfftPool{workerURL: workerURL}
}

func (p *hfftPool) ensureSpawned() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.spawnErr != nil {
		return p.spawnErr
	}
	if p.workers != nil {
		return nil
	}
	g := js.Global()
	workers := make([]*worker, 0, hfftWorkerCount)
	for i := 0; i < hfftWorkerCount; i++ {
		w, err := newWorker(g, p.workerURL, 1000+i)
		if err != nil {
			terminateWorkers(workers)
			p.spawnErr = fmt.Errorf("hfft: spawn worker %d: %w", i, err)
			return p.spawnErr
		}
		workers = append(workers, w)
	}
	p.workers = workers
	p.live = len(workers)
	p.free = make(chan *worker, hfftWorkerCount)
	for _, w := range workers {
		p.free <- w
	}
	return nil
}

// retire terminates a worker whose request/reply pairing can no longer be
// trusted (timeout or crossed reply) and removes it from rotation. When the
// last worker retires the pool marks itself failed.
func (p *hfftPool) retire(w *worker) {
	terminateWorkers([]*worker{w})
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, candidate := range p.workers {
		if candidate == w {
			p.workers = append(p.workers[:i], p.workers[i+1:]...)
			break
		}
	}
	if p.live > 0 {
		p.live--
	}
	if p.live == 0 && p.spawnErr == nil {
		p.spawnErr = errors.New("hfft: all FFT workers retired")
	}
}

func (p *hfftPool) drained() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.live == 0
}

func (p *hfftPool) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	terminateWorkers(p.workers)
	p.workers = nil
	p.free = nil
	p.spawnErr = errors.New("hfft: pool closed")
}

func terminateWorkers(workers []*worker) {
	for _, w := range workers {
		if w == nil {
			continue
		}
		w.stop()
	}
}

// transform runs one whole-vector transform on a pooled worker, in place.
// The vector crosses the boundary in the audited canonical scalar format;
// the SAB is zeroed after the reply because computeH vectors are
// witness-derived.
func (p *hfftPool) transform(vec []fr.Element, params hTransformParams) error {
	if err := params.validate(len(vec)); err != nil {
		return err
	}
	if p.drained() {
		return errors.New("hfft: all FFT workers retired")
	}
	// Bounded pool take: with <= poolsize concurrent transforms a worker is
	// normally free immediately; a wait only happens while the pool is
	// partially drained, so the bound is short and the caller falls back to
	// the identical local serial path.
	var w *worker
	select {
	case w = <-p.free:
	case <-time.After(hfftPoolTakeTimeout):
		return fmt.Errorf("hfft: no FFT worker became available within %s", hfftPoolTakeTimeout)
	}
	retired := false
	defer func() {
		if retired {
			// A timed-out worker is permanently retired instead of re-pooled:
			// its eventual late reply would poison the 1-slot reply buffer for
			// the next job, and it still holds the (now orphaned) SAB, which
			// must not receive a late write-back of witness-derived data.
			p.retire(w)
			return
		}
		p.free <- w
	}()

	buf := marshalScalars(vec)
	sab := newSAB(buf)
	zeroBytes(buf)
	defer zeroSAB(sab)

	w.mu.Lock()
	defer w.mu.Unlock()
	p.mu.Lock()
	p.nextID++
	id := p.nextID
	p.mu.Unlock()

	msg := js.Global().Get("Object").New()
	msg.Set("type", "fft-transform")
	msg.Set("id", id)
	msg.Set("vec", sab)
	msg.Set("inverse", params.Inverse)
	msg.Set("coset", params.Coset)
	msg.Set("cardinality", float64(params.Cardinality))
	w.js.Call("postMessage", msg)

	// Bounded wait: a silently terminated worker (browser OOM kill without an
	// onerror event) must not hang computeH — the caller falls back to the
	// identical local serial transform.
	var reply workerReply
	select {
	case reply = <-w.replies:
	case <-time.After(hfftTransformTimeout):
		retired = true
		return fmt.Errorf("hfft: worker transform timed out after %s", hfftTransformTimeout)
	}
	if reply.err != nil {
		return fmt.Errorf("hfft: worker transform: %w", reply.err)
	}
	if reply.id != id {
		// A crossed reply means this worker's request/reply pairing can no
		// longer be trusted; retire it like a timeout.
		retired = true
		return fmt.Errorf("hfft: worker reply id %d != requested %d", reply.id, id)
	}
	out := make([]byte, len(vec)*scalarSize)
	js.CopyBytesToGo(out, js.Global().Get("Uint8Array").New(sab))
	// Decode straight into vec (no intermediate []fr.Element): this path runs
	// on the gogc=15 main instance, where a second 64 MiB transient per
	// transform would feed the GC churn W8 exists to avoid.
	for i := range vec {
		vec[i].SetBytes(out[i*scalarSize : (i+1)*scalarSize])
	}
	zeroBytes(out)
	return nil
}

// TransformHVectors implements HTransformEngine: apply the same transform to
// each vector concurrently, in place. Never leaves a vector half-done — on
// any worker failure the failing vector is (re)transformed locally with the
// identical serial code, so the call either fully succeeds or reports an
// unrecoverable validation error.
func (s *shardedMSM) TransformHVectors(vecs [][]fr.Element, inverse, coset bool, cardinality uint64) error {
	params := hTransformParams{Inverse: inverse, Coset: coset, Cardinality: cardinality}
	for _, vec := range vecs {
		if err := params.validate(len(vec)); err != nil {
			return err
		}
	}
	if s.hfft != nil {
		if err := s.hfft.ensureSpawned(); err != nil {
			EmitTrace("measure", "hfft-fallback", map[string]any{"error": err.Error()})
			s.hfft = nil
		}
	}
	started := time.Now()
	var wg sync.WaitGroup
	errs := make([]error, len(vecs))
	for i, vec := range vecs {
		wg.Add(1)
		go func(i int, vec []fr.Element) {
			defer wg.Done()
			if s.hfft != nil {
				if err := s.hfft.transform(vec, params); err == nil {
					return
				} else {
					EmitTrace("measure", "hfft-fallback", map[string]any{"error": err.Error(), "vector": i})
				}
				// The worker transforms a marshaled copy; vec is untouched on
				// failure, so the local serial retry starts from clean input.
			}
			errs[i] = hTransformVector(vec, params)
		}(i, vec)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	EmitTrace("measure", "hfft-transform", map[string]any{
		"vectors":     len(vecs),
		"inverse":     boolToFloat(inverse),
		"coset":       boolToFloat(coset),
		"cardinality": float64(cardinality),
		"wall_ms":     float64(time.Since(started).Microseconds()) / 1000,
	})
	return nil
}

// HTransformEnabled gates CurrentHTransform: the sharded engine offers the
// H-transform capability only when the dedicated FFT pool was configured.
func (s *shardedMSM) HTransformEnabled() bool { return s.hfft != nil }

func boolToFloat(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// registerHFFTKernel installs the worker-side transform entrypoint; called
// from RegisterWorkerKernel so every worker built from the pinned wasm can
// serve FFT jobs.
func registerHFFTKernel(g js.Value) {
	g.Set("__msmengineFFTTransform", js.FuncOf(func(this js.Value, args []js.Value) any {
		out, err := hTransformBytes(goBytes(args[0]), hTransformParams{
			Inverse:     args[1].Bool(),
			Coset:       args[2].Bool(),
			Cardinality: uint64(args[3].Float()),
		})
		if err != nil {
			panic(err.Error())
		}
		return jsUint8(out)
	}))
}
