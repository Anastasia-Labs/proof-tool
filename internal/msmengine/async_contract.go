package msmengine

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

const asyncQueueShardMultiplier = 16

// A terminated Web Worker does not guarantee an error event or reply. Bound
// every section wait so a silently dead worker fails closed instead of leaving
// the proof parked forever. This remains below the fault-suite's external
// deadline while leaving ample headroom over measured single-shard work.
//
//nolint:unused // used by sharded_js.go under the js && wasm build tags, which golangci-lint does not analyze
const asyncWorkerReplyTimeout = 2 * time.Minute

var errAsyncWaitCancelled = errors.New("asynchronous section MSM cancelled")

func waitForAsyncResult[T any](results <-chan T, cancel <-chan struct{}, timeout time.Duration) (T, error) {
	var zero T
	if timeout <= 0 {
		return zero, fmt.Errorf("async worker reply timeout must be positive")
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case result := <-results:
		return result, nil
	case <-cancel:
		return zero, errAsyncWaitCancelled
	case <-timer.C:
		return zero, fmt.Errorf("worker reply timed out after %s", timeout)
	}
}

func asyncQueueCapacity(shards int) int {
	if shards < 1 {
		shards = 1
	}
	return shards * asyncQueueShardMultiplier
}

func asyncQueueHasCapacity(queued, inFlight, incoming, shards int) bool {
	return queued >= 0 && inFlight >= 0 && incoming >= 0 && queued+inFlight+incoming <= asyncQueueCapacity(shards)
}

func completeCollectionStates(states []*collectionState, err error) {
	for _, state := range states {
		state.complete(err)
	}
}

// collectionState enforces the single-use handle contract independently of
// the js transport. The scheduler closes done exactly once on success, worker
// failure, or cancellation.
type collectionState struct {
	mu        sync.Mutex
	done      chan struct{}
	err       error
	completed bool
	collected bool
}

func newCollectionState() collectionState {
	return collectionState{done: make(chan struct{})}
}

func (s *collectionState) complete(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.completed {
		return
	}
	s.err = err
	s.completed = true
	close(s.done)
}

func (s *collectionState) collect() error {
	s.mu.Lock()
	if s.collected {
		s.mu.Unlock()
		return failClosed("async-msm-double-collect", fmt.Errorf("section MSM handle was already collected"))
	}
	s.collected = true
	done := s.done
	s.mu.Unlock()
	<-done
	s.mu.Lock()
	err := s.err
	s.mu.Unlock()
	return err
}
