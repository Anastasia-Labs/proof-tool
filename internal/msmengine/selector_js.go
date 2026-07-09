//go:build js && wasm

package msmengine

// makeShardedEngine returns a real shardedMSM on js/wasm builds.
// worker.js is expected to be co-located with (served alongside) the main wasm binary.
// If NewSharded fails (e.g. SharedArrayBuffer not actually available at
// construction time) we fall back to cpuMSM so Select degrades gracefully.
func makeShardedEngine(workers int) MSMEngine {
	return makeShardedEngineWithOptions(workers, Options{})
}

func makeShardedEngineWithOptions(workers int, opts Options) MSMEngine {
	workerURL := opts.WorkerURL
	if workerURL == "" {
		workerURL = "worker.js"
	}
	s, err := NewShardedWithOptions(workerURL, workers, opts)
	if err != nil {
		return cpuMSM{}
	}
	return s
}
