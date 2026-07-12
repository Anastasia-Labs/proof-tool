//go:build js && wasm

package msmengine

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

type asyncSectionHandle struct {
	state    collectionState
	g2       bool
	plan     *PKSectionPlan
	planJSON string
	section  string
	n        int
	scalars  []fr.Element
	prog     ProgressFn
	ranges   [][2]int

	mu          sync.Mutex
	pending     int
	doneScalars int
	partsG1     []bls12381.G1Jac
	partsG2     []bls12381.G2Jac
}

func (*asyncSectionHandle) SectionHandle() {}

type asyncShardTask struct {
	handle         *asyncSectionHandle
	index          int
	r              [2]int
	requestID      int
	affinityWorker int
}

type sectionScheduler struct {
	owner         *shardedMSM
	mu            sync.Mutex
	queue         []asyncShardTask
	busy          []bool
	handles       map[*asyncSectionHandle]struct{}
	cancel        chan struct{}
	terminal      error
	nextRequestID int
}

func (s *shardedMSM) scheduler() *sectionScheduler {
	s.asyncMu.Lock()
	defer s.asyncMu.Unlock()
	if s.async == nil {
		s.async = &sectionScheduler{
			owner:   s,
			busy:    make([]bool, len(s.pool.workers)),
			handles: make(map[*asyncSectionHandle]struct{}),
			cancel:  make(chan struct{}),
		}
	}
	return s.async
}

func (s *shardedMSM) DispatchG1Section(plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) (SectionHandle, error) {
	return s.dispatchSection(false, plan, section, n, scalars, prog)
}

func (s *shardedMSM) DispatchG2Section(plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) (SectionHandle, error) {
	return s.dispatchSection(true, plan, section, n, scalars, prog)
}

func (s *shardedMSM) dispatchSection(g2 bool, plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) (SectionHandle, error) {
	if plan == nil {
		return nil, fmt.Errorf("async section MSM requires a proving-key section plan")
	}
	if len(scalars) != n {
		return nil, fmt.Errorf("async section MSM %s: %d scalars vs n=%d", section, len(scalars), n)
	}
	planJSON, err := json.Marshal(plan)
	if err != nil {
		return nil, fmt.Errorf("marshal pk section plan: %w", err)
	}
	ranges := nonEmptyRanges(partitionRanges(n, s.shards))
	h := &asyncSectionHandle{
		state: newCollectionState(), g2: g2, plan: plan, planJSON: string(planJSON),
		section: section, n: n, scalars: scalars, prog: progressReporter(prog),
		ranges: ranges, pending: len(ranges),
	}
	if g2 {
		h.partsG2 = make([]bls12381.G2Jac, len(ranges))
	} else {
		h.partsG1 = make([]bls12381.G1Jac, len(ranges))
	}
	if len(ranges) == 0 {
		h.state.complete(nil)
		return h, nil
	}
	q := s.scheduler()
	q.mu.Lock()
	if q.terminal != nil {
		err := q.terminal
		q.mu.Unlock()
		return nil, err
	}
	if !asyncQueueHasCapacity(len(q.queue), q.inFlightLocked(), len(ranges), s.shards) {
		q.mu.Unlock()
		return nil, failClosed("async-msm-queue-full", fmt.Errorf("bounded async shard queue capacity %d exceeded", asyncQueueCapacity(s.shards)))
	}
	q.handles[h] = struct{}{}
	affinity := newContiguousShardAffinity(len(ranges), len(q.busy))
	for i, r := range ranges {
		q.nextRequestID++
		affinityWorker := -1
		if s.optW7 {
			affinityWorker = affinity.workerForShard(i)
		}
		q.queue = append(q.queue, asyncShardTask{
			handle: h, index: i, r: r, requestID: q.nextRequestID,
			affinityWorker: affinityWorker,
		})
	}
	EmitTrace("measure", "async-msm-queue", map[string]any{
		"section":          section,
		"queued_shards":    len(q.queue),
		"in_flight_shards": q.inFlightLocked(),
		"capacity_shards":  asyncQueueCapacity(s.shards),
	})
	q.pumpLocked()
	q.mu.Unlock()
	return h, nil
}

func (s *sectionScheduler) inFlightLocked() int {
	n := 0
	for _, busy := range s.busy {
		if busy {
			n++
		}
	}
	return n
}

// pumpLocked preserves one outstanding worker computation per worker. Each
// completion frees exactly one slot and immediately pumps the next queued
// shard, so dispatching all stages never posts an unbounded worker backlog.
func (s *sectionScheduler) pumpLocked() {
	if s.terminal != nil {
		return
	}
	if !s.owner.optW7 {
		// Preserve the pre-W7 dynamic global-FIFO scheduler byte-for-byte: the
		// next shard goes to whichever worker becomes available first.
		for workerSlot := range s.busy {
			if s.busy[workerSlot] || len(s.queue) == 0 {
				continue
			}
			task := s.queue[0]
			s.queue = s.queue[1:]
			s.busy[workerSlot] = true
			go s.run(workerSlot, task)
		}
		return
	}

	// W7 keeps each handle's adjacent shard block on one Worker. Selecting the
	// first matching task preserves FIFO order within each worker across the W1
	// multi-stage queue, while busy still enforces one outstanding job per
	// worker and queue remains the same globally bounded allocation.
	for workerSlot := range s.busy {
		if s.busy[workerSlot] || len(s.queue) == 0 {
			continue
		}
		taskIndex := -1
		for i := range s.queue {
			if s.queue[i].affinityWorker == workerSlot {
				taskIndex = i
				break
			}
		}
		if taskIndex < 0 {
			continue
		}
		task := s.queue[taskIndex]
		copy(s.queue[taskIndex:], s.queue[taskIndex+1:])
		s.queue[len(s.queue)-1] = asyncShardTask{}
		s.queue = s.queue[:len(s.queue)-1]
		s.busy[workerSlot] = true
		go s.run(workerSlot, task)
	}
}

func (s *sectionScheduler) run(workerSlot int, task asyncShardTask) {
	h := task.handle
	w := s.owner.pool.workers[workerSlot]
	totalStart := time.Now()
	scalarStart := time.Now()
	scsBuf := marshalScalars(h.scalars[task.r[0]:task.r[1]])
	scalarMS := elapsedMS(scalarStart)
	w.mu.Lock()
	sabStart := time.Now()
	scsSab := newSAB(scsBuf)
	zeroBytes(scsBuf)
	sabMS := elapsedMS(sabStart)
	workerStart := time.Now()
	reply := w.postSectionAndWaitLockedCancelable(task.requestID, h.g2, h.planJSON, h.section, task.r, scsSab, s.owner.pinnedDecode, s.owner.optW7, s.cancel)
	zeroSAB(scsSab)
	workerMS := elapsedMS(workerStart)
	w.mu.Unlock()
	fields := map[string]any{
		"section": h.section, "worker_owned_fetch": true, "point_bytes_from_main": 0,
		"scalar_bytes": len(scsBuf), "scalar_marshal_ms": scalarMS, "sab_copy_ms": sabMS,
		"worker_turnaround_ms": workerMS, "worker_compute_ms": reply.computeMS,
		"total_ms": elapsedMS(totalStart), "error": errorString(reply.err), "async_dispatch": true,
	}
	addTraceFields(fields, reply.timings)
	addByteTraceFields(fields, reply.bytes)
	group, op := "g1", "DispatchG1Section"
	if h.g2 {
		group, op = "g2", "DispatchG2Section"
	}
	emitShardTrace(op, group, task.index, w.id, task.r, h.n, fields)
	if reply.err != nil {
		s.fail(workerSlot, reply.err)
		return
	}
	if h.g2 {
		jac, err := unmarshalG2Jac(reply.partial)
		if err != nil {
			s.fail(workerSlot, workerPartialIntegrityError(err))
			return
		}
		h.mu.Lock()
		h.partsG2[task.index] = jac
		h.mu.Unlock()
	} else {
		jac, err := unmarshalG1Jac(reply.partial)
		if err != nil {
			s.fail(workerSlot, workerPartialIntegrityError(err))
			return
		}
		h.mu.Lock()
		h.partsG1[task.index] = jac
		h.mu.Unlock()
	}
	s.complete(workerSlot, task)
}

func (s *sectionScheduler) complete(workerSlot int, task asyncShardTask) {
	h := task.handle
	h.mu.Lock()
	h.pending--
	h.doneScalars += task.r[1] - task.r[0]
	doneScalars := h.doneScalars
	completed := h.pending == 0
	h.mu.Unlock()
	if h.prog != nil {
		h.prog(doneScalars, h.n)
	}
	if completed {
		h.state.complete(nil)
	}
	s.mu.Lock()
	s.busy[workerSlot] = false
	s.pumpLocked()
	s.mu.Unlock()
}

func (s *sectionScheduler) fail(workerSlot int, cause error) {
	if cause == nil {
		cause = errors.New("asynchronous section MSM failed")
	}
	s.mu.Lock()
	if s.terminal != nil {
		s.mu.Unlock()
		return
	}
	s.terminal = cause
	close(s.cancel)
	s.queue = nil
	states := make([]*collectionState, 0, len(s.handles))
	for h := range s.handles {
		states = append(states, &h.state)
	}
	completeCollectionStates(states, cause)
	s.handles = make(map[*asyncSectionHandle]struct{})
	for i := range s.busy {
		s.busy[i] = false
	}
	s.mu.Unlock()
	// A failed worker cannot be reused safely. Terminate the entire shared pool;
	// cancel-aware waits on the remaining workers unblock without hanging.
	s.owner.pool.close()
}

func (s *sectionScheduler) forget(h *asyncSectionHandle) {
	s.mu.Lock()
	delete(s.handles, h)
	s.mu.Unlock()
}

func (s *shardedMSM) CollectG1Section(dst *bls12381.G1Jac, handle SectionHandle) error {
	h, ok := handle.(*asyncSectionHandle)
	if !ok || h.g2 {
		return failClosed("async-msm-handle-group", fmt.Errorf("G1 collect received incompatible handle"))
	}
	if err := h.state.collect(); err != nil {
		return err
	}
	h.mu.Lock()
	parts := append([]bls12381.G1Jac(nil), h.partsG1...)
	h.partsG1 = nil
	h.scalars = nil
	h.plan = nil
	h.mu.Unlock()
	*dst = combineG1(parts)
	s.scheduler().forget(h)
	return nil
}

func (s *shardedMSM) CollectG2Section(dst *bls12381.G2Jac, handle SectionHandle) error {
	h, ok := handle.(*asyncSectionHandle)
	if !ok || !h.g2 {
		return failClosed("async-msm-handle-group", fmt.Errorf("G2 collect received incompatible handle"))
	}
	if err := h.state.collect(); err != nil {
		return err
	}
	h.mu.Lock()
	parts := append([]bls12381.G2Jac(nil), h.partsG2...)
	h.partsG2 = nil
	h.scalars = nil
	h.plan = nil
	h.mu.Unlock()
	*dst = combineG2(parts)
	s.scheduler().forget(h)
	return nil
}

func (s *shardedMSM) CancelOutstanding(cause error) {
	s.asyncMu.Lock()
	q := s.async
	s.asyncMu.Unlock()
	if q == nil {
		return
	}
	q.fail(-1, failClosed("async-msm-cancelled", cause))
}
