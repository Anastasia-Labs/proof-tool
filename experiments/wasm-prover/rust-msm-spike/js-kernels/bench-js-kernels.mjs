// bench-js-kernels.mjs — Workstream C follow-up: hand-written-wasm MSM kernels
// (wasmcurves via ffjavascript, mcl-wasm) vs the Go gnark worker kernel.
//
// Same discipline as ../bench.mjs: identical vectors minted by the Go kernel,
// byte-for-byte result equality asserted against the Go partial on every
// measured size, single-threaded kernels (our production parallelism is the
// worker pool — each worker runs one single-threaded kernel), 1.3x bar.
//
// Timing scope: the MSM call only. Wire-format conversion is EXCLUDED for the
// JS kernels (untimed, done once per vector) while the Go number excludes its
// decode too (multiexp_ms from the kernel's own telemetry) — this compares
// pure multiexp compute, the number that decides whether a kernel swap is
// worth pursuing at all. (Go's wire decode is ~5% of its kernel time.)
//
// Run (from proof-tool or the worktree root):
//   GOROOT="$(go env GOROOT)" node experiments/wasm-prover/rust-msm-spike/js-kernels/bench-js-kernels.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildBls12381 } from 'ffjavascript';

const require = createRequire(import.meta.url);
const mcl = require('mcl-wasm');
const mclInternal = require('mcl-wasm/dist/mcl.js');

// mcl-wasm caches HEAP32 once at init; emscripten memory growth (which can
// happen mid-mulVec) detaches it. Emscripten keeps mod.HEAP32 fresh on every
// growth, so replace the cached export with a live getter.
function mclInstallLiveHeap() {
  // This emscripten build does not refresh mod.HEAP32 on growth either, so
  // rebuild the view from the live memory buffer whenever it detaches.
  let heap32 = null;
  let heap8 = null;
  const live = () => {
    const buf = mclInternal.mod.wasmMemory.buffer;
    if (heap32 === null || heap32.buffer !== buf) {
      heap32 = new Int32Array(buf);
      heap8 = new Uint8Array(buf);
    }
  };
  Object.defineProperty(mclInternal, 'HEAP32', { get: () => { live(); return heap32; } });
  Object.defineProperty(mclInternal, 'HEAP8', { get: () => { live(); return heap8; } });
  // The string/serialize wrappers use exports.mod.HEAP8/HEAP32 (emscripten
  // Module views, also not refreshed on growth in this build) — replace the
  // own properties with the same live getters.
  let heapU8 = null;
  const liveU8 = () => {
    const buf = mclInternal.mod.wasmMemory.buffer;
    if (heapU8 === null || heapU8.buffer !== buf) heapU8 = new Uint8Array(buf);
    return heapU8;
  };
  for (const [name, getter] of [
    ['HEAP8', () => { live(); return heap8; }],
    ['HEAPU8', liveU8],
    ['HEAP32', () => { live(); return heap32; }],
  ]) {
    delete mclInternal.mod[name];
    Object.defineProperty(mclInternal.mod, name, { get: getter, configurable: true });
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Default to the main checkout's built kernel so the gitignored wasm doesn't
// need rebuilding inside a fresh worktree.
const goWasmPath = process.env.MSMWORKER_WASM ||
  '/home/gumbo/playground/proof-zk-recovery/proof-tool/experiments/wasm-prover/web/msmworker.wasm';
const wasmExec = process.env.WASM_EXEC_JS ||
  (process.env.GOROOT ? path.join(process.env.GOROOT, 'lib/wasm/wasm_exec.js') : '');
if (!wasmExec) throw new Error('set GOROOT or WASM_EXEC_JS');

const PT = 96;
const SC = 32;
const BASE_POINTS = 4096;
const SIZES = process.env.SIZES ? process.env.SIZES.split(',').map(Number) : [16384, 131072];
const REPS = { 16384: 7, 131072: 5, 524288: 3 };

async function loadGoKernel() {
  vm.runInThisContext(readFileSync(wasmExec, 'utf8'));
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiate(readFileSync(goWasmPath), go.importObject);
  go.run(instance);
  while (!globalThis.__msmengineReady) await new Promise((r) => setTimeout(r, 0));
}

function makeVector(basePts, n) {
  const pts = new Uint8Array(n * PT);
  for (let i = 0; i < n; i++) pts.set(basePts.subarray((i % BASE_POINTS) * PT, (i % BASE_POINTS + 1) * PT), i * PT);
  const scs = new Uint8Array(n * SC);
  for (let i = 0; i < scs.length; i++) scs[i] = (Math.random() * 256) | 0;
  for (let i = 0; i < n; i++) scs[i * SC] = 0;
  return { pts, scs };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const beToBigInt = (bytes) => BigInt('0x' + Buffer.from(bytes).toString('hex'));
function bigIntToBe(v, len) {
  const hex = v.toString(16).padStart(len * 2, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

// ---- ffjavascript / wasmcurves --------------------------------------------

async function benchFfjavascript(curve, vec, n, reps) {
  const G1 = curve.G1;
  // Wire (ZCash uncompressed, flags 000 for our non-infinity points) -> LEM.
  // Verify the format assumption on point 0 via round-trip before batching.
  const one = new Uint8Array(PT);
  one.set(vec.pts.subarray(0, PT));
  const lemOne = G1.F.n8 * 3 ? null : null; // (placeholder to keep linters quiet)
  const p0 = G1.fromRprUncompressed(one, 0);
  const rt = new Uint8Array(PT);
  G1.toRprUncompressed(rt, 0, p0);
  assert.deepEqual(rt, one, 'ffjavascript uncompressed rpr does not round-trip our wire bytes');

  const basesLEM = await G1.batchUtoLEM(vec.pts);
  // Scalars: our wire is 32B big-endian; ffjavascript wants little-endian.
  const scalarsLE = new Uint8Array(n * SC);
  for (let i = 0; i < n; i++) {
    for (let b = 0; b < SC; b++) scalarsLE[i * SC + b] = vec.scs[i * SC + (SC - 1 - b)];
  }
  const times = [];
  let res = null;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    res = await G1.multiExpAffine(basesLEM, scalarsLE);
    times.push(performance.now() - t0);
  }
  const affine = G1.toAffine(res);
  const out = new Uint8Array(PT);
  G1.toRprUncompressed(out, 0, affine);
  return { ms: median(times), out };
}

// ---- mcl-wasm ---------------------------------------------------------------

function mclPointFromWire(raw) {
  const x = beToBigInt(raw.subarray(0, 48));
  const y = beToBigInt(raw.subarray(48, 96));
  const g = new mcl.G1();
  g.setStr(`1 ${x.toString(10)} ${y.toString(10)}`, 10);
  return g;
}

function benchMcl(vec, n, reps) {
  const points = new Array(n);
  const scalars = new Array(n);
  // Conversion is untimed: reuse BASE_POINTS parsed points for the tiling.
  const baseParsed = [];
  for (let i = 0; i < Math.min(BASE_POINTS, n); i++) baseParsed.push(mclPointFromWire(vec.pts.subarray(i * PT, (i + 1) * PT)));
  for (let i = 0; i < n; i++) points[i] = baseParsed[i % baseParsed.length];
  for (let i = 0; i < n; i++) {
    const fr = new mcl.Fr();
    fr.setBigEndianMod(vec.scs.subarray(i * SC, (i + 1) * SC));
    scalars[i] = fr;
  }
  // mcl-wasm's fixed wasm memory cannot hold >~8k points in one mulVec call;
  // chunk and sum partials (the adds are negligible: n/CHUNK extra G1 adds).
  const CHUNK = 4096;
  const times = [];
  let res = null;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    let acc = null;
    for (let lo = 0; lo < n; lo += CHUNK) {
      const hi = Math.min(n, lo + CHUNK);
      const part = mcl.mulVec(points.slice(lo, hi), scalars.slice(lo, hi));
      acc = acc === null ? part : mcl.add(acc, part);
    }
    res = acc;
    times.push(performance.now() - t0);
  }
  return { ms: median(times), res };
}

// Compare in mcl-space: getStr on post-growth instances is unreliable in this
// emscripten build, but isEqual and the setStr input path are solid.
function mclEqualsWire(res, wire) {
  const expected = mclPointFromWire(wire);
  return res.isEqual(expected);
}

// ---- main -------------------------------------------------------------------

async function main() {
  await loadGoKernel();
  await mcl.init(mcl.BLS12_381);
  mclInstallLiveHeap();
  const curve = await buildBls12381(true); // singleThread: one kernel per worker is the production shape

  console.log('minting', BASE_POINTS, 'base points via Go kernel...');
  const base = globalThis.__msmengineTestRandomG1(BASE_POINTS);
  const basePts = new Uint8Array(base.pts);

  console.log('\n  n        kernel          multiexp_ms   vs go (multiexp)');
  for (const n of SIZES) {
    const reps = REPS[n];
    const vec = makeVector(basePts, n);

    const goMultiexps = [];
    let goOut = null;
    for (let r = 0; r < reps; r++) {
      const res = globalThis.__msmengineShardG1Timed(vec.pts, vec.scs, true);
      goMultiexps.push(res.timings.multiexp_ms);
      goOut = new Uint8Array(res.partial);
    }
    const goMs = median(goMultiexps);
    console.log(`  ${String(n).padEnd(8)} ${'go-gnark'.padEnd(15)} ${goMs.toFixed(0).padStart(11)}   1.00x`);

    const ff = await benchFfjavascript(curve, vec, n, reps);
    assert.deepEqual(ff.out, goOut, `wasmcurves n=${n}: result differs from Go kernel`);
    console.log(`  ${String(n).padEnd(8)} ${'wasmcurves'.padEnd(15)} ${ff.ms.toFixed(0).padStart(11)}   ${(goMs / ff.ms).toFixed(2)}x  (bit-exact ✓)`);

    if (process.env.SKIP_MCL !== '1') {
    const mc = benchMcl(vec, n, reps);
    assert.ok(mclEqualsWire(mc.res, goOut), `mcl-wasm n=${n}: result differs from Go kernel`);
    console.log(`  ${String(n).padEnd(8)} ${'mcl-wasm'.padEnd(15)} ${mc.ms.toFixed(0).padStart(11)}   ${(goMs / mc.ms).toFixed(2)}x  (bit-exact ✓)`);
    }
    console.log('');
  }
  await curve.terminate?.();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
