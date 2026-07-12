package msmengine

import (
	"errors"
	"slices"
	"testing"
)

func TestW7ContiguousShardAffinityCoversUnevenRatios(t *testing.T) {
	tests := []struct {
		shards  int
		workers int
		want    [][]int
	}{
		{shards: 10, workers: 3, want: [][]int{{0, 1, 2, 3}, {4, 5, 6}, {7, 8, 9}}},
		{shards: 9, workers: 4, want: [][]int{{0, 1, 2}, {3, 4}, {5, 6}, {7, 8}}},
		{shards: 3, workers: 8, want: [][]int{{0}, {1}, {2}, nil, nil, nil, nil, nil}},
		{shards: 1, workers: 1, want: [][]int{{0}}},
	}
	for _, test := range tests {
		affinity := newContiguousShardAffinity(test.shards, test.workers)
		if !slices.EqualFunc(affinity.byWorker, test.want, slices.Equal[[]int]) {
			t.Fatalf("affinity(%d shards, %d workers) = %v, want %v", test.shards, test.workers, affinity.byWorker, test.want)
		}
		seen := make([]bool, test.shards)
		for workerSlot, block := range affinity.byWorker {
			for i, shard := range block {
				if seen[shard] {
					t.Fatalf("shard %d assigned more than once", shard)
				}
				seen[shard] = true
				if affinity.workerForShard(shard) != workerSlot {
					t.Fatalf("shard %d reverse mapping = %d, want %d", shard, affinity.workerForShard(shard), workerSlot)
				}
				if i > 0 && block[i-1]+1 != shard {
					t.Fatalf("worker %d block is not contiguous: %v", workerSlot, block)
				}
			}
		}
		for shard, ok := range seen {
			if !ok {
				t.Fatalf("shard %d was not assigned", shard)
			}
		}
	}
}

func TestW7SyncAffinityKeepsCombineOrderIndependent(t *testing.T) {
	const shards, workers = 10, 3
	affinity := newContiguousShardAffinity(shards, workers)
	parts := make([]int, shards)
	positions := make([]int, workers)
	completed := 0
	// Deliberately complete worker turns in reverse order. This models the sync
	// result channel receiving partials in a different order from shard order.
	for completed < shards {
		for workerSlot := workers - 1; workerSlot >= 0; workerSlot-- {
			if positions[workerSlot] == len(affinity.byWorker[workerSlot]) {
				continue
			}
			shard := affinity.byWorker[workerSlot][positions[workerSlot]]
			positions[workerSlot]++
			parts[shard] = shard + 1
			completed++
		}
	}
	for shard, part := range parts {
		if part != shard+1 {
			t.Fatalf("combined partial %d = %d, want %d", shard, part, shard+1)
		}
	}
}

func TestW7AsyncAffinityPreservesWorkerFIFOAcrossStages(t *testing.T) {
	const shards, workers, stages = 10, 3, 4
	type task struct {
		stage  int
		shard  int
		worker int
	}
	queue := make([]task, 0, shards*stages)
	for stage := 0; stage < stages; stage++ {
		affinity := newContiguousShardAffinity(shards, workers)
		for shard := 0; shard < shards; shard++ {
			queue = append(queue, task{stage: stage, shard: shard, worker: affinity.workerForShard(shard)})
		}
	}
	for workerSlot := 0; workerSlot < workers; workerSlot++ {
		lastStage, lastShard := -1, -1
		for _, task := range queue {
			if task.worker != workerSlot {
				continue
			}
			if task.stage == lastStage && task.shard != lastShard+1 {
				t.Fatalf("worker %d lost adjacent FIFO order in stage %d: shard %d followed %d", workerSlot, task.stage, lastShard, task.shard)
			}
			if task.stage < lastStage {
				t.Fatalf("worker %d stage order regressed from %d to %d", workerSlot, lastStage, task.stage)
			}
			lastStage, lastShard = task.stage, task.shard
		}
	}
	if !asyncQueueHasCapacity(0, workers, len(queue), shards) {
		t.Fatal("W1 queue rejected the bounded affinity workload")
	}
}

func TestW7AffinityFailureCancelsEveryQueuedStage(t *testing.T) {
	affinity := newContiguousShardAffinity(10, 3)
	if len(affinity.byWorker[1]) == 0 {
		t.Fatal("failure test worker unexpectedly owns no shards")
	}
	states := make([]*collectionState, 4)
	for i := range states {
		state := newCollectionState()
		states[i] = &state
	}
	want := failClosed("worker-terminated", errors.New("affinity worker failed"))
	completeCollectionStates(states, want)
	for stage := range states {
		if err := states[stage].collect(); !errors.Is(err, want) {
			t.Fatalf("stage %d collect error = %v, want worker failure", stage, err)
		}
	}
}

func TestW7AffinityMateriallyImprovesBoundaryChunkReuse(t *testing.T) {
	const shards, workers, chunkBytes = 32, 8, 8 << 20
	const points, g1PointBytes = 1_000_003, 96
	ranges := nonEmptyRanges(partitionRanges(points, shards))
	// Model the real 8 MiB proving-key chunks and 96-byte uncompressed G1
	// records. Adjacent partitionRanges overlap the same authenticated chunk at
	// their byte boundary; distant interleaved shards do not.
	shardChunks := make([][]int, len(ranges))
	for shard, r := range ranges {
		start := r[0] * g1PointBytes
		end := r[1] * g1PointBytes
		for chunk := start / chunkBytes; chunk*chunkBytes < end; chunk++ {
			shardChunks[shard] = append(shardChunks[shard], chunk)
		}
	}

	interleavedWorkers := make([]int, len(ranges))
	for shard := range interleavedWorkers {
		interleavedWorkers[shard] = shard % workers
	}
	affinity := newContiguousShardAffinity(len(ranges), workers)
	baselineHits, baselineFetched := simulateTwoEntryWorkerCaches(interleavedWorkers, shardChunks, workers, chunkBytes)
	w7Hits, w7Fetched := simulateTwoEntryWorkerCaches(affinity.workerByShard, shardChunks, workers, chunkBytes)

	if w7Hits < baselineHits+workers*2 {
		t.Fatalf("W7 cache hits %d are not materially above baseline %d", w7Hits, baselineHits)
	}
	if w7Fetched*4 > baselineFetched*3 {
		t.Fatalf("W7 fetched %d bytes, want at least 25%% below baseline %d", w7Fetched, baselineFetched)
	}
	t.Logf("8 MiB chunk model: hits %d -> %d; fetched bytes %d -> %d", baselineHits, w7Hits, baselineFetched, w7Fetched)
}

func simulateTwoEntryWorkerCaches(workerByShard []int, shardChunks [][]int, workers, chunkBytes int) (hits, fetched int) {
	caches := make([][]int, workers)
	for shard, workerSlot := range workerByShard {
		for _, chunk := range shardChunks[shard] {
			cache := caches[workerSlot]
			hit := slices.Index(cache, chunk)
			if hit >= 0 {
				hits++
				cache = append(append(cache[:hit], cache[hit+1:]...), chunk)
			} else {
				fetched += chunkBytes
				cache = append(cache, chunk)
				if len(cache) > 2 {
					cache = cache[len(cache)-2:]
				}
			}
			caches[workerSlot] = cache
		}
	}
	return hits, fetched
}
