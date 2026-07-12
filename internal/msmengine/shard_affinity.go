package msmengine

// contiguousShardAffinity splits ordered shard indexes into balanced,
// contiguous worker blocks. W7 uses this to keep neighboring section ranges in
// the same Web Worker so its verified two-entry chunk LRU can reuse the shared
// boundary chunk. Workers receive either floor(shards/workers) or one more
// shard; workers beyond the shard count remain idle.
type contiguousShardAffinity struct {
	byWorker      [][]int
	workerByShard []int
}

func newContiguousShardAffinity(shardCount, workerCount int) contiguousShardAffinity {
	if shardCount <= 0 || workerCount <= 0 {
		return contiguousShardAffinity{}
	}

	activeWorkers := min(shardCount, workerCount)
	affinity := contiguousShardAffinity{
		byWorker:      make([][]int, workerCount),
		workerByShard: make([]int, shardCount),
	}
	base := shardCount / activeWorkers
	extra := shardCount % activeWorkers
	nextShard := 0
	for workerSlot := 0; workerSlot < activeWorkers; workerSlot++ {
		blockSize := base
		if workerSlot < extra {
			blockSize++
		}
		block := make([]int, blockSize)
		for i := range block {
			shard := nextShard + i
			block[i] = shard
			affinity.workerByShard[shard] = workerSlot
		}
		affinity.byWorker[workerSlot] = block
		nextShard += blockSize
	}
	return affinity
}

func (a contiguousShardAffinity) workerForShard(shard int) int {
	return a.workerByShard[shard]
}
