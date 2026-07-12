//go:build js && wasm

package msmengine

import (
	"syscall/js"
	"testing"
)

func TestWorkerMemStatsJSExportsRealNumericFields(t *testing.T) {
	stats := jsNumberObject(workerMemStatsJS())
	required := []string{
		"worker_go_heap_alloc_bytes",
		"worker_go_heap_sys_bytes",
		"worker_go_heap_inuse_bytes",
		"worker_go_heap_released_bytes",
		"worker_go_stack_inuse_bytes",
		"worker_go_stack_sys_bytes",
		"worker_go_sys_bytes",
		"worker_go_gc_count",
	}
	for _, key := range required {
		value, ok := stats[key].(float64)
		if !ok {
			t.Fatalf("%s = %T(%v), want numeric worker-runtime field", key, stats[key], stats[key])
		}
		if value < 0 {
			t.Fatalf("%s = %v, want non-negative", key, value)
		}
	}
	for _, key := range []string{
		"worker_go_heap_alloc_bytes",
		"worker_go_heap_sys_bytes",
		"worker_go_heap_inuse_bytes",
		"worker_go_stack_inuse_bytes",
		"worker_go_stack_sys_bytes",
		"worker_go_sys_bytes",
	} {
		if stats[key].(float64) == 0 {
			t.Fatalf("%s unexpectedly reported zero from the live Go runtime", key)
		}
	}
}

func TestWorkerReplyNumericParsingOmitsUnavailableOptionalMetrics(t *testing.T) {
	object := js.Global().Get("Object").New()
	object.Set("worker_go_heap_alloc_bytes", 123)
	object.Set("worker_js_heap_used_bytes", js.Undefined())
	fields := jsNumberObject(object)
	if fields["worker_go_heap_alloc_bytes"] != float64(123) {
		t.Fatalf("heap alloc = %v, want 123", fields["worker_go_heap_alloc_bytes"])
	}
	if _, ok := fields["worker_js_heap_used_bytes"]; ok {
		t.Fatal("unavailable JS heap metric was synthesized instead of omitted")
	}
}

func TestShardTracePreservesWorkerIdentityAndNumericTelemetry(t *testing.T) {
	var got TraceEvent
	restore := SetTraceSink(func(event TraceEvent) { got = event })
	defer restore()
	emitShardTrace("MSMG1Section", "g1", 3, 7, [2]int{10, 20}, 40, map[string]any{
		"error":                          "",
		"worker_go_heap_alloc_bytes":     float64(1234),
		"worker_w7_verified_cache_bytes": float64(5678),
	})
	if got.Phase != "measure" || got.Stage != "shard" {
		t.Fatalf("trace event = %q/%q, want measure/shard", got.Phase, got.Stage)
	}
	if got.Fields["worker_id"] != 7 {
		t.Fatalf("worker_id = %v, want 7", got.Fields["worker_id"])
	}
	for key, want := range map[string]float64{
		"worker_go_heap_alloc_bytes":     1234,
		"worker_w7_verified_cache_bytes": 5678,
	} {
		value, ok := got.Fields[key].(float64)
		if !ok || value != want {
			t.Fatalf("%s = %T(%v), want numeric %v", key, got.Fields[key], got.Fields[key], want)
		}
	}
}
