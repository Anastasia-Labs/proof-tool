// bench.mjs — Workstream C phase 0 go/no-go: arkworks-wasm vs gnark-Go-wasm
// G1 MSM on the exact worker wire format.
//
// Correctness gate: the Rust kernel's 96-byte result must equal the Go
// kernel's shardG1 partial BYTE-FOR-BYTE on every measured vector (an MSM is
// an exact group sum, so any divergence is a serialization or math bug).
//
// Run (from proof-tool):
//   GOOS=js GOARCH=wasm go build -mod=vendor -o experiments/wasm-prover/web/msmworker.wasm ./cmd/msmworker
//   (cd experiments/wasm-prover/rust-msm-spike && cargo build --release --target wasm32-unknown-unknown
//    RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown --target-dir target-simd)
//   GOROOT="$(go env GOROOT)" node experiments/wasm-prover/rust-msm-spike/bench.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goWasmPath = process.env.MSMWORKER_WASM || path.resolve(__dirname, '../web/msmworker.wasm');
const rustPortablePath = path.resolve(__dirname, 'target/wasm32-unknown-unknown/release/rust_msm_spike.wasm');
const rustSimdPath = path.resolve(__dirname, 'target-simd/wasm32-unknown-unknown/release/rust_msm_spike.wasm');
const wasmExec = process.env.WASM_EXEC_JS ||
  (process.env.GOROOT ? path.join(process.env.GOROOT, 'lib/wasm/wasm_exec.js') : '');
if (!wasmExec) throw new Error('set GOROOT or WASM_EXEC_JS');

const PT = 96;
const SC = 32;
const BASE_POINTS = 4096;         // minted by the Go kernel (valid subgroup points)
const SIZES = [16384, 131072, 524288];
const REPS = { 16384: 7, 131072: 5, 524288: 3 };

async function loadGoKernel() {
  vm.runInThisContext(readFileSync(wasmExec, 'utf8'));
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiate(readFileSync(goWasmPath), go.importObject);
  go.run(instance);
  while (!globalThis.__msmengineReady) await new Promise((r) => setTimeout(r, 0));
}

async function loadRustKernel(file) {
  const { instance } = await WebAssembly.instantiate(readFileSync(file), {});
  return instance.exports;
}

// Tile BASE_POINTS valid points up to n and mint fresh sub-r scalars (top
// byte zeroed => always < r, always canonical; ~never zero, matching the
// ~95% nonzero production profile).
function makeVector(basePts, n) {
  const pts = new Uint8Array(n * PT);
  for (let i = 0; i < n; i++) pts.set(basePts.subarray((i % BASE_POINTS) * PT, (i % BASE_POINTS + 1) * PT), i * PT);
  const scs = new Uint8Array(n * SC);
  for (let i = 0; i < scs.length; i++) scs[i] = (Math.random() * 256) | 0;
  for (let i = 0; i < n; i++) scs[i * SC] = 0;
  return { pts, scs };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function runRust(exports, pts, scs, n) {
  const ptsPtr = exports.rmsm_alloc(pts.byteLength);
  const scsPtr = exports.rmsm_alloc(scs.byteLength);
  const outPtr = exports.rmsm_alloc(PT);
  new Uint8Array(exports.memory.buffer, ptsPtr, pts.byteLength).set(pts);
  new Uint8Array(exports.memory.buffer, scsPtr, scs.byteLength).set(scs);
  const t0 = performance.now();
  const rc = exports.rmsm_msm_g1(ptsPtr, scsPtr, n, outPtr);
  const ms = performance.now() - t0;
  assert.equal(rc, 0, `rust kernel rc=${rc}`);
  const out = new Uint8Array(exports.memory.buffer, outPtr, PT).slice();
  const t1 = performance.now();
  const decoded = exports.rmsm_decode_g1(ptsPtr, scsPtr, n);
  const decodeMs = performance.now() - t1;
  assert.equal(decoded, 2 * n);
  return { out, ms, decodeMs };
}

async function main() {
  await loadGoKernel();
  console.log('minting', BASE_POINTS, 'base points via Go kernel...');
  const base = globalThis.__msmengineTestRandomG1(BASE_POINTS);
  const basePts = new Uint8Array(base.pts);

  const kernels = [
    ['rust-portable', await loadRustKernel(rustPortablePath)],
    ['rust-simd128', await loadRustKernel(rustSimdPath)],
  ];

  console.log('\n  n        kernel          decode_ms  multiexp_ms  total_ms   vs go');
  for (const n of SIZES) {
    const reps = REPS[n];
    const goTotals = [], goDecodes = [], goMultiexps = [];
    let goOut = null;
    const vec = makeVector(basePts, n);
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now();
      const res = globalThis.__msmengineShardG1Timed(vec.pts, vec.scs, true);
      goTotals.push(performance.now() - t0);
      goDecodes.push(res.timings.point_decode_ms + res.timings.scalar_decode_ms);
      goMultiexps.push(res.timings.multiexp_ms);
      goOut = new Uint8Array(res.partial);
    }
    const goTotal = median(goTotals);
    console.log(`  ${String(n).padEnd(8)} ${'go-gnark'.padEnd(15)} ${median(goDecodes).toFixed(0).padStart(9)}  ${median(goMultiexps).toFixed(0).padStart(11)}  ${goTotal.toFixed(0).padStart(8)}   1.00x`);

    for (const [name, exports] of kernels) {
      const totals = [], decodes = [];
      let out = null;
      for (let r = 0; r < reps; r++) {
        const res = runRust(exports, vec.pts, vec.scs, n);
        totals.push(res.ms);
        decodes.push(res.decodeMs);
        out = res.out;
      }
      assert.deepEqual(out, goOut, `${name} n=${n}: result differs from Go kernel`);
      const total = median(totals);
      console.log(`  ${String(n).padEnd(8)} ${name.padEnd(15)} ${median(decodes).toFixed(0).padStart(9)}  ${(total - median(decodes)).toFixed(0).padStart(11)}  ${total.toFixed(0).padStart(8)}   ${(goTotal / total).toFixed(2)}x  (bit-exact ✓)`);
    }
    console.log('');
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
