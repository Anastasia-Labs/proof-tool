//go:build !(js && wasm)

package msmengine

import "testing"

// TestSelectLadder verifies the capability ladder through the native sharded
// stub. The js/wasm variant has a separate test with an installed fake Worker;
// without one, the production selector correctly falls back to CPU.
func TestSelectLadder(t *testing.T) {
	if got := Select(Probe{SharedMem: true, Workers: 8}).Name(); got != "sharded" {
		t.Fatalf("Select(SharedMem+Workers=8).Name() = %q, want %q", got, "sharded")
	}
	if got := Select(Probe{}).Name(); got != "cpu" {
		t.Fatalf("Select(Probe{}).Name() = %q, want %q", got, "cpu")
	}
}

func TestW7OptionIsIndependentAndDefaultsOff(t *testing.T) {
	assertW7OptionIsIndependentAndDefaultsOff(t, Probe{SharedMem: true, Workers: 8})
}

func assertW7OptionIsIndependentAndDefaultsOff(t *testing.T, probe Probe) {
	t.Helper()
	baseEngine := SelectWithOptions(probe, Options{ShardCount: 32})
	w7Engine := SelectWithOptions(probe, Options{ShardCount: 32, OptW7: true})
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
