//go:build !(js && wasm)

package msmengine

import "runtime"

// cpuNbTasks lets native builds use every core inside a single MultiExp. The
// MSM result is the same group element regardless of task count (an MSM is a
// group sum; only the internal addition order changes), so the emitted proof
// bytes are unaffected. The single-thread Phase-0 lever only ever mattered for
// the js/wasm build, which keeps NbTasks=1 via its own build-tagged constant.
var cpuNbTasks = runtime.NumCPU()
