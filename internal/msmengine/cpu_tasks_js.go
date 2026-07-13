//go:build js && wasm

package msmengine

// cpuNbTasks preserves the Phase-0 single-thread lever on js/wasm: the WASM
// runtime has one OS thread, and the sharded worker fan-out is the intended
// parallelism seam there.
const cpuNbTasks = 1
