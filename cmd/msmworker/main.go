//go:build js && wasm

// Command msmworker is the per-worker MSM kernel wasm. Each Web Worker (browser,
// via experiments/wasm-prover/web/worker.js) or Node worker_thread (the proof
// harness experiments/wasm-prover/web/node-msm-check) instantiates this module, which registers the
// shard/combine functions on the global scope and then blocks. The host posts a
// shard's points+scalars (over a SharedArrayBuffer) and invokes
// __msmengineShardG1 / __msmengineShardG2 to get back the partial Jacobian.
//
// This is the standalone kernel; the full webprove entrypoint (Task 6) calls the
// same msmengine.RegisterWorkerKernel so its own workers share this contract.
//
// It also installs __msmengineTestRandomG1, used only by the Node correctness
// harness to mint a valid BLS12-381 test vector (random subgroup points +
// scalars) in the same wire format the shard kernel consumes — generating valid
// curve points in pure JS is impractical, so the harness asks the kernel.
package main

import (
	"crypto/rand"
	"math/big"
	"syscall/js"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"

	"proof-tool/internal/msmengine"
)

func main() {
	msmengine.RegisterWorkerKernel()
	registerTestVectorGen()
	// Signal readiness so the host knows the kernel functions are installed,
	// then keep the instance alive so they remain callable for the worker's
	// lifetime.
	js.Global().Set("__msmengineReady", true)
	select {}
}

// registerTestVectorGen installs __msmengineTestRandomG1(n) -> {pts, scs}, where
// pts is n uncompressed G1 affine points (96 bytes each) and scs is n big-endian
// scalars (32 bytes each) — the exact wire format msmengine's shard kernel reads.
// Points are random multiples of the G1 generator, hence valid subgroup points.
func registerTestVectorGen() {
	js.Global().Set("__msmengineTestRandomG1", js.FuncOf(func(this js.Value, args []js.Value) any {
		n := args[0].Int()
		const ptSz = bls12381.SizeOfG1AffineUncompressed
		const scSz = fr.Bytes
		pts := make([]byte, n*ptSz)
		scs := make([]byte, n*scSz)
		var buf [32]byte
		for i := 0; i < n; i++ {
			rand.Read(buf[:])
			var k big.Int
			k.SetBytes(buf[:])
			var jac bls12381.G1Jac
			jac.ScalarMultiplicationBase(&k)
			var aff bls12381.G1Affine
			aff.FromJacobian(&jac)
			ab := aff.RawBytes()
			copy(pts[i*ptSz:], ab[:])

			rand.Read(buf[:])
			var s fr.Element
			s.SetBytes(buf[:])
			sb := s.Bytes()
			copy(scs[i*scSz:], sb[:])
		}
		ptsU8 := js.Global().Get("Uint8Array").New(len(pts))
		js.CopyBytesToJS(ptsU8, pts)
		scsU8 := js.Global().Get("Uint8Array").New(len(scs))
		js.CopyBytesToJS(scsU8, scs)
		out := js.Global().Get("Object").New()
		out.Set("pts", ptsU8)
		out.Set("scs", scsU8)
		return out
	}))
}
