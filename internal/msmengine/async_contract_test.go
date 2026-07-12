package msmengine

import (
	"errors"
	"sync"
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
