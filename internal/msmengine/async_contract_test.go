package msmengine

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestAsyncQueueCapacityIsBoundedByShardCount(t *testing.T) {
	for _, shards := range []int{0, 1, 8, 32} {
		got := asyncQueueCapacity(shards)
		if got < 1 || got > max(1, shards)*asyncQueueShardMultiplier {
			t.Fatalf("asyncQueueCapacity(%d) = %d", shards, got)
		}
	}
	if !asyncQueueHasCapacity(100, 8, 404, 32) {
		t.Fatal("queue should accept work exactly at its 512-shard capacity")
	}
	if asyncQueueHasCapacity(100, 8, 405, 32) {
		t.Fatal("queue accepted work beyond its 512-shard capacity")
	}
}

func TestCancellationUnblocksEveryOutstandingHandle(t *testing.T) {
	states := []*collectionState{}
	results := make(chan error, 6)
	for range 6 {
		state := newCollectionState()
		states = append(states, &state)
		go func() { results <- state.collect() }()
	}
	want := failClosed("worker-terminated", errors.New("worker killed with queued jobs"))
	completeCollectionStates(states, want)
	for range states {
		if got := <-results; !errors.Is(got, want) {
			t.Fatalf("collect error = %v, want %v", got, want)
		}
	}
}

func TestCollectionStateRejectsDoubleCollection(t *testing.T) {
	state := newCollectionState()
	state.complete(nil)
	if err := state.collect(); err != nil {
		t.Fatalf("first collect: %v", err)
	}
	var target *FailClosedError
	if err := state.collect(); !errors.As(err, &target) || target.Class != "async-msm-double-collect" {
		t.Fatalf("second collect = %v, want async-msm-double-collect", err)
	}
}

func TestCollectionStateCancellationUnblocksCollector(t *testing.T) {
	state := newCollectionState()
	want := failClosed("worker-terminated", errors.New("worker killed"))
	result := make(chan error, 1)
	go func() { result <- state.collect() }()
	state.complete(want)
	if got := <-result; !errors.Is(got, want) {
		t.Fatalf("collect error = %v, want %v", got, want)
	}
	// Completion is idempotent under races between a worker error and pool-wide
	// cancellation; only the first terminal cause is retained.
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() { defer wg.Done(); state.complete(errors.New("late")) }()
	}
	wg.Wait()
}

func TestAsyncWorkerWaitReturnsReply(t *testing.T) {
	replies := make(chan int, 1)
	replies <- 7
	got, err := waitForAsyncResult(replies, nil, time.Second)
	if err != nil || got != 7 {
		t.Fatalf("wait result = (%d, %v), want (7, nil)", got, err)
	}
}

func TestAsyncWorkerWaitCancels(t *testing.T) {
	replies := make(chan int)
	cancel := make(chan struct{})
	close(cancel)
	if _, err := waitForAsyncResult(replies, cancel, time.Second); !errors.Is(err, errAsyncWaitCancelled) {
		t.Fatalf("cancel wait = %v, want errAsyncWaitCancelled", err)
	}
}

func TestAsyncWorkerWaitTimesOut(t *testing.T) {
	replies := make(chan int)
	started := time.Now()
	if _, err := waitForAsyncResult(replies, nil, 10*time.Millisecond); err == nil {
		t.Fatal("silent worker unexpectedly completed without a reply")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("worker watchdog took %s, want a bounded timeout", elapsed)
	}
}

func TestAsyncWorkerProgressRenewsInactivityLease(t *testing.T) {
	replies := make(chan int, 1)
	var progress atomic.Uint64
	go func() {
		time.Sleep(12 * time.Millisecond)
		progress.Store(1)
		time.Sleep(14 * time.Millisecond)
		replies <- 9
	}()
	got, err := waitForAsyncResultWithProgress(
		replies,
		nil,
		20*time.Millisecond,
		100*time.Millisecond,
		progress.Load,
	)
	if err != nil || got != 9 {
		t.Fatalf("progress-aware wait = (%d, %v), want (9, nil)", got, err)
	}
}

func TestAsyncWorkerProgressBeforeWaitStillRenewsLease(t *testing.T) {
	replies := make(chan int, 1)
	var progress atomic.Uint64
	progress.Store(1)
	go func() {
		time.Sleep(25 * time.Millisecond)
		replies <- 11
	}()
	got, err := waitForAsyncResultWithProgress(
		replies,
		nil,
		20*time.Millisecond,
		100*time.Millisecond,
		progress.Load,
	)
	if err != nil || got != 11 {
		t.Fatalf("pre-wait progress = (%d, %v), want (11, nil)", got, err)
	}
}

func TestAsyncWorkerAbsoluteDeadlineCannotBeRenewedForever(t *testing.T) {
	replies := make(chan int)
	var progress atomic.Uint64
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				progress.Add(1)
			}
		}
	}()
	started := time.Now()
	_, err := waitForAsyncResultWithProgress(
		replies,
		nil,
		15*time.Millisecond,
		45*time.Millisecond,
		progress.Load,
	)
	close(stop)
	if err == nil || !strings.Contains(err.Error(), "absolute deadline") {
		t.Fatalf("absolute wait error = %v, want absolute deadline", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("absolute watchdog took %s, want bounded completion", elapsed)
	}
}

func TestAsyncRetryBackoffIsBoundedAndStaggered(t *testing.T) {
	first := asyncRetryBackoff(2, 0)
	second := asyncRetryBackoff(3, 0)
	otherWorker := asyncRetryBackoff(2, 1)
	if first < 250*time.Millisecond || second <= first {
		t.Fatalf("retry backoff did not increase: first=%s second=%s", first, second)
	}
	if otherWorker == first {
		t.Fatalf("worker jitter did not stagger retries: both=%s", first)
	}
	if got := asyncRetryBackoff(99, 99); got > 3*time.Second {
		t.Fatalf("retry backoff %s exceeds bounded maximum", got)
	}
}
