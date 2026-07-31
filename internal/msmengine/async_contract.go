package msmengine

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

const asyncQueueShardMultiplier = 16

// A terminated Web Worker does not guarantee an error event or reply. The
// inactivity lease therefore remains bounded, but authenticated worker
// progress may renew it. The absolute deadline prevents a faulty worker from
// extending a request forever. Healthy proofs finish before either timer fires.
//
//nolint:unused // used by sharded_js.go under the js && wasm build tags, which golangci-lint does not analyze
const (
	asyncWorkerInactivityTimeout = 5 * time.Minute
	asyncWorkerAbsoluteTimeout   = 20 * time.Minute
	asyncShardMaxAttempts        = 3
)

var errAsyncWaitCancelled = errors.New("asynchronous section MSM cancelled")

func waitForAsyncResult[T any](results <-chan T, cancel <-chan struct{}, timeout time.Duration) (T, error) {
	return waitForAsyncResultWithProgress(results, cancel, timeout, timeout, nil)
}

// waitForAsyncResultWithProgress waits without polling on the healthy path.
// When the inactivity timer fires, it samples progress exactly once. Strictly
// increasing progress renews the lease; otherwise the request fails closed.
// This keeps normal proof execution to the same one-timer/select shape while
// allowing a slow authenticated chunk stream to continue.
func waitForAsyncResultWithProgress[T any](
	results <-chan T,
	cancel <-chan struct{},
	inactivityTimeout time.Duration,
	absoluteTimeout time.Duration,
	progress func() uint64,
) (T, error) {
	var zero T
	if inactivityTimeout <= 0 {
		return zero, fmt.Errorf("async worker inactivity timeout must be positive")
	}
	if absoluteTimeout <= 0 {
		return zero, fmt.Errorf("async worker absolute timeout must be positive")
	}
	started := time.Now()
	var lastProgress uint64
	timer := time.NewTimer(minDuration(inactivityTimeout, absoluteTimeout))
	defer timer.Stop()
	for {
		select {
		case result := <-results:
			return result, nil
		case <-cancel:
			return zero, errAsyncWaitCancelled
		case <-timer.C:
			elapsed := time.Since(started)
			if elapsed >= absoluteTimeout {
				return zero, fmt.Errorf("worker reply exceeded absolute deadline %s", absoluteTimeout)
			}
			currentProgress := lastProgress
			if progress != nil {
				currentProgress = progress()
			}
			if currentProgress <= lastProgress {
				return zero, fmt.Errorf("worker reply made no observed progress within %s", inactivityTimeout)
			}
			lastProgress = currentProgress
			remaining := absoluteTimeout - elapsed
			timer.Reset(minDuration(inactivityTimeout, remaining))
		}
	}
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func asyncRetryBackoff(attempt, workerSlot int) time.Duration {
	if attempt < 2 {
		attempt = 2
	}
	shift := attempt - 2
	if shift > 3 {
		shift = 3
	}
	base := 250 * time.Millisecond * time.Duration(1<<shift)
	// Deterministic jitter avoids a synchronized retry wave without reading a
	// random source or adding work to successful requests.
	jitter := time.Duration((workerSlot*37+attempt*17)%101) * time.Millisecond
	return base + jitter
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
