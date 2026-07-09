// msm-worker.js — the per-shard MSM kernel bootstrap for the browser (production).
//
// Spawned by msmengine's shardedMSM (internal/msmengine/sharded_js.go) as
// `new Worker(worker_js_url)`, where worker_js_url comes from the prove
// request's artifacts and is hash-pinned in the signed chunk manifest under
// the asset key "worker.js". Each instance loads wasm_exec.js from its own
// directory and instantiates the msmworker kernel wasm, which registers
// self.__msmengineShardG1 / __msmengineShardG2 (and friends) on the worker's
// global scope. The main wasm instance posts one shard at a time over a
// SharedArrayBuffer; this worker runs the gnark MultiExp over its slice and
// posts the partial Jacobian back.
//
// Message contract (must match sharded_js.go):
//   in : { id, g2:bool, pts:SharedArrayBuffer, scs:SharedArrayBuffer, pinnedDecode:bool }
//   out: { id, partial:Uint8Array, compute_ms, timings }   on success
//        { id, error:string }                              on failure
//
// Worker-owned proving-key fetch tasks use:
//   in : { type:'msm-section-range', id, g2, pkPlan, section, lo, hi, scs, pinnedDecode }
//   out: { id, partial:Uint8Array, compute_ms, timings, bytes }
//
// An optional first message { type:'init', wasmURL, gogc, gomemlimit } overrides
// the kernel wasm URL (default 'msmworker.wasm', resolved against this script's
// own URL) and the Go runtime tuning. sharded_js.go does NOT send an init
// message, so in production the tuning is read from this script's own URL query
// string (the spawner controls the URL): msm-worker.js?gogc=50&gomemlimit=512MiB
// Defaults: GOGC=50, GOMEMLIMIT=512MiB (per-worker; each worker is its own wasm
// instance whose live heap peaks well under 100 MiB — shard point slices are
// ~15 MiB at production shard counts plus decode/bucket scratch — so 512MiB is
// generous headroom without letting 8 workers balloon).
//
// Tuning values are restricted to a conservative charset; anything else falls
// back to the default. This file's bytes are pinned in the chunk manifest, so
// its content must stay deterministic (no build-time interpolation).

let wasmURL = 'msmworker.wasm';
let readyPromise = null;

const TUNING_VALUE = /^[A-Za-z0-9.]+$/;

function tuningFromLocation(name, fallback) {
  try {
    const raw = new URL(self.location.href).searchParams.get(name);
    if (raw && TUNING_VALUE.test(raw)) return raw;
  } catch (err) {
    // fall through to the default
  }
  return fallback;
}

let gogc = tuningFromLocation('gogc', '50');
let gomemlimit = tuningFromLocation('gomemlimit', '512MiB');

function startKernel() {
  readyPromise = (async () => {
    importScripts('wasm_exec.js');
    const go = new Go();
    go.env.GOGC = gogc;
    go.env.GOMEMLIMIT = gomemlimit;
    let instance;
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      const result = await WebAssembly.instantiateStreaming(fetch(wasmURL), go.importObject);
      instance = result.instance;
    } else {
      const bytes = await (await fetch(wasmURL)).arrayBuffer();
      const result = await WebAssembly.instantiate(bytes, go.importObject);
      instance = result.instance;
    }
    // go.run resolves only when the kernel's main returns (it blocks forever),
    // so we do NOT await it; the registered functions are installed
    // synchronously during main before it parks. Wait for the ready flag.
    go.run(instance);
    while (!self.__msmengineReady) {
      await new Promise((r) => setTimeout(r, 0));
    }
  })();
  return readyPromise;
}

function resolveChunkURL(baseURL, relPath) {
  if (!baseURL) throw new Error('pk section plan base_url is required');
  if (!relPath || relPath.includes('\\') || relPath.includes('://') || /[?#]/.test(relPath)) {
    throw new Error(`unsafe chunk path ${relPath}`);
  }
  const parts = relPath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`unsafe chunk path ${relPath}`);
  }
  const base = new URL(baseURL);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('pk section plan base_url must use http or https');
  }
  return new URL(relPath, base).href;
}

async function fetchVerifiedChunk(baseURL, chunk) {
  const fetchStarted = performance.now();
  const response = await fetch(resolveChunkURL(baseURL, chunk.path), { cache: 'force-cache' });
  const raw = new Uint8Array(await response.arrayBuffer());
  const fetchMS = performance.now() - fetchStarted;
  if (response.status !== 200) {
    throw new Error(`fetch chunk ${chunk.index} returned status ${response.status}`);
  }
  const encoding = (response.headers.get('content-encoding') || '').trim();
  if (encoding && encoding !== 'identity') {
    throw new Error(`chunk ${chunk.index} content-encoding ${encoding}, want identity`);
  }
  if (raw.byteLength !== chunk.size) {
    throw new Error(`chunk ${chunk.index} size ${raw.byteLength}, want ${chunk.size}`);
  }
  const hashStarted = performance.now();
  const digestError = self.__msmengineVerifyChunkBytes(raw, chunk.sha256, chunk.blake2b256);
  if (digestError) throw new Error(digestError);
  const hashMS = performance.now() - hashStarted;
  return { raw, fetchMS, hashMS };
}

async function fetchSectionPointBytes(plan, sectionName, lo, hi, g2) {
  if (!plan || typeof plan !== 'object') throw new Error('pk section plan is required');
  const section = plan.sections && plan.sections[sectionName];
  if (!section) throw new Error(`section ${sectionName} not found in pk section plan`);
  const wantElemSize = g2 ? 192 : 96;
  if (section.elem_size !== wantElemSize) {
    throw new Error(`section ${sectionName} elem_size ${section.elem_size}, want ${wantElemSize}`);
  }
  const totalPoints = Math.floor(section.len / section.elem_size);
  if (lo < 0 || hi < lo || hi > totalPoints) {
    throw new Error(`section range ${sectionName} [${lo},${hi}) out of bounds (len=${totalPoints})`);
  }
  const start = section.offset + lo * section.elem_size;
  const end = section.offset + hi * section.elem_size;
  if (start < 0 || end < start || end > plan.file_size) {
    throw new Error(`section range ${sectionName} bytes [${start},${end}) out of bounds (file_size=${plan.file_size})`);
  }
  const pointsRaw = new Uint8Array(end - start);
  const timings = { fetch_ms: 0, hash_ms: 0, slice_ms: 0 };
  const bytes = { fetched: 0, used: pointsRaw.byteLength };
  for (const chunk of plan.chunks || []) {
    const chunkStart = chunk.offset;
    const chunkEnd = chunk.offset + chunk.size;
    if (chunkEnd <= start || chunkStart >= end) continue;
    const { raw, fetchMS, hashMS } = await fetchVerifiedChunk(plan.base_url, chunk);
    timings.fetch_ms += fetchMS;
    timings.hash_ms += hashMS;
    bytes.fetched += raw.byteLength;
    const useStart = Math.max(start, chunkStart);
    const useEnd = Math.min(end, chunkEnd);
    const sliceStarted = performance.now();
    pointsRaw.set(raw.subarray(useStart - chunkStart, useEnd - chunkStart), useStart - start);
    timings.slice_ms += performance.now() - sliceStarted;
  }
  return { pointsRaw, timings, bytes };
}

function runKernel(g2, pointsRaw, scsU8, pinnedDecode) {
  const timed = g2 ? self.__msmengineShardG2Timed : self.__msmengineShardG1Timed;
  if (typeof timed === 'function') {
    const result = timed(pointsRaw, scsU8, !!pinnedDecode);
    return {
      partial: result.partial,
      timings: result.timings || {},
    };
  }
  const legacy = g2 ? self.__msmengineShardG2 : self.__msmengineShardG1;
  return {
    partial: legacy(pointsRaw, scsU8),
    timings: {},
  };
}

function copyTimingFields(dst, src) {
  for (const [key, value] of Object.entries(src || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      dst[key] = value;
    }
  }
}

async function runSectionRange(msg) {
  const plan = typeof msg.pkPlan === 'string' ? JSON.parse(msg.pkPlan) : msg.pkPlan;
  const { pointsRaw, timings, bytes } = await fetchSectionPointBytes(plan, msg.section, msg.lo, msg.hi, msg.g2);
  const scsU8 = new Uint8Array(msg.scs);
  const computeStarted = performance.now();
  let partial;
  try {
    const result = runKernel(msg.g2, pointsRaw, scsU8, msg.pinnedDecode);
    partial = result.partial;
    copyTimingFields(timings, result.timings);
  } finally {
    scsU8.fill(0);
  }
  timings.compute_ms = performance.now() - computeStarted;
  if (typeof timings.kernel_ms === 'number') {
    timings.compute_ms = timings.kernel_ms;
  }
  timings.total_ms = timings.fetch_ms + timings.hash_ms + timings.slice_ms + timings.compute_ms;
  return { partial, timings, bytes };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg && msg.type === 'init') {
    if (msg.wasmURL) wasmURL = msg.wasmURL;
    if (msg.gogc && TUNING_VALUE.test(String(msg.gogc))) gogc = String(msg.gogc);
    if (msg.gomemlimit && TUNING_VALUE.test(String(msg.gomemlimit))) gomemlimit = String(msg.gomemlimit);
    try {
      await startKernel();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'init-error', error: String(err && err.message ? err.message : err) });
    }
    return;
  }
  try {
    if (!readyPromise) startKernel();
    await readyPromise;
    if (msg && msg.type === 'msm-section-range') {
      const { partial, timings, bytes } = await runSectionRange(msg);
      self.postMessage({ id: msg.id, partial, compute_ms: timings.compute_ms || 0, timings, bytes }, [partial.buffer]);
      return;
    }
    const { id, g2, pts, scs } = msg;
    const ptsU8 = new Uint8Array(pts);
    const scsU8 = new Uint8Array(scs);
    const computeStarted = performance.now();
    let partial;
    let timings = {};
    try {
      const result = runKernel(g2, ptsU8, scsU8, msg.pinnedDecode);
      partial = result.partial; // Uint8Array (96 G1 / 192 G2 bytes)
      timings = result.timings || {};
    } finally {
      scsU8.fill(0);
    }
    const computeMS = performance.now() - computeStarted;
    if (typeof timings.kernel_ms === 'number') {
      timings.compute_ms = timings.kernel_ms;
    } else {
      timings.compute_ms = computeMS;
    }
    // partial is backed by a plain ArrayBuffer (not the shared input), so it is
    // transferable — hand ownership to the main thread to avoid a copy.
    self.postMessage({ id, partial, compute_ms: timings.compute_ms || computeMS, timings }, [partial.buffer]);
  } catch (err) {
    self.postMessage({ id: msg && msg.id, error: String(err && err.message ? err.message : err) });
  }
};
