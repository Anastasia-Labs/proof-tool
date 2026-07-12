//go:build js && wasm

package msmengine

import (
	"syscall/js"
	"testing"
)

func TestSelectFallsBackToCPUWithoutWorkerRuntime(t *testing.T) {
	global := js.Global()
	previousWorker := global.Get("Worker")
	global.Set("Worker", js.Undefined())
	defer global.Set("Worker", previousWorker)

	if got := Select(Probe{SharedMem: true, Workers: 8}).Name(); got != "cpu" {
		t.Fatalf("Select without Worker runtime = %q, want %q", got, "cpu")
	}
	if got := Select(Probe{}).Name(); got != "cpu" {
		t.Fatalf("Select(Probe{}).Name() = %q, want %q", got, "cpu")
	}
}

func TestJSW7OptionIsIndependentAndDefaultsOff(t *testing.T) {
	restore := installSelectorTestWorkerRuntime()
	defer restore()

	probe := Probe{SharedMem: true, Workers: 8}
	baseEngine := SelectWithOptions(probe, Options{ShardCount: 32})
	w7Engine := SelectWithOptions(probe, Options{ShardCount: 32, OptW7: true})
	defer baseEngine.Close()
	defer w7Engine.Close()
	if baseEngine.Name() != "sharded" || w7Engine.Name() != "sharded" {
		t.Fatalf("fake Worker runtime selected (%q, %q), want sharded engines", baseEngine.Name(), w7Engine.Name())
	}
	base := baseEngine.(InstrumentedEngine).Instrumentation()
	w7 := w7Engine.(InstrumentedEngine).Instrumentation()
	if base["opt_w7"] != false {
		t.Fatalf("zero-value opt_w7 = %v, want false", base["opt_w7"])
	}
	if w7["opt_w7"] != true {
		t.Fatalf("enabled opt_w7 = %v, want true", w7["opt_w7"])
	}
	for _, key := range []string{"worker_count", "shard_count", "range_fetch_concurrency", "pinned_decode"} {
		if base[key] != w7[key] {
			t.Fatalf("W7 changed independent option %s: base=%v w7=%v", key, base[key], w7[key])
		}
	}
}

func installSelectorTestWorkerRuntime() func() {
	global := js.Global()
	previousWorker := global.Get("Worker")
	previousSharedArrayBuffer := global.Get("SharedArrayBuffer")
	postMessage := js.FuncOf(func(js.Value, []js.Value) any { return nil })
	terminate := js.FuncOf(func(js.Value, []js.Value) any { return nil })
	worker := js.FuncOf(func(js.Value, []js.Value) any {
		object := global.Get("Object").New()
		object.Set("postMessage", postMessage)
		object.Set("terminate", terminate)
		return object
	})
	global.Set("Worker", worker)
	if previousSharedArrayBuffer.IsUndefined() {
		global.Set("SharedArrayBuffer", global.Get("Object"))
	}
	return func() {
		global.Set("Worker", previousWorker)
		global.Set("SharedArrayBuffer", previousSharedArrayBuffer)
		worker.Release()
		postMessage.Release()
		terminate.Release()
	}
}
