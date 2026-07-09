// Package msmengine is a forwarding shim. The real package moved to
// proof-tool/internal/msmengine, but the hand-patched vendored gnark tree
// (vendor/github.com/consensys/gnark/backend/groth16/bls12-381/prove.go,
// applied from experiments/wasm-prover/patches/prove-stream.patch) still
// imports this path, and the vendor tree must not be modified by hand.
//
// This shim re-exports, via type aliases and forwarders, exactly the
// identifiers the vendored patch uses, so the vendored code and the moved
// package share one implementation and one piece of engine state. Delete this
// package once the gnark patch is repointed at proof-tool/internal/msmengine
// (or moved to a reviewed fork).
//
// Do not add new uses of this import path; import
// proof-tool/internal/msmengine instead.
package msmengine

import "proof-tool/internal/msmengine"

// PKSectionPlan aliases the moved type; identical type identity keeps the
// vendored ProveStream signatures compatible with production callers.
type PKSectionPlan = msmengine.PKSectionPlan

// PKSectionEngine aliases the moved interface so type assertions in the
// vendored code match engines registered through the moved package.
type PKSectionEngine = msmengine.PKSectionEngine

// Current forwards to the moved package's engine selection state.
func Current() msmengine.MSMEngine { return msmengine.Current() }

// TraceStage forwards to the moved package's trace hook.
func TraceStage(stage string, fields map[string]any) func(map[string]any) {
	return msmengine.TraceStage(stage, fields)
}
