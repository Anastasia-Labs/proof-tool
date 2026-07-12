// worker.js — the candidate per-shard MSM kernel bootstrap for the browser.
//
// Spawned by msmengine's shardedMSM (internal/msmengine/sharded_js.go) as
// `new Worker(worker_js_url)`. This candidate mirrors the signed production
// Worker while runtime findings are still behind default-false flags.
//
// Message contract (must match sharded_js.go):
//   in : { id, g2:bool, pts:SharedArrayBuffer, scs:SharedArrayBuffer, pinnedDecode:bool }
//   out: { id, partial:Uint8Array, compute_ms, timings }   on success
//        { id, error:string }                              on failure
//
// Worker-owned proving-key fetch tasks use:
//   in : { type:'msm-section-range', id, g2, pkPlan, section, lo, hi, scs, pinnedDecode, optW7 }
//   out: { id, partial:Uint8Array, compute_ms, timings, bytes }
//
// An optional first message { type:'init', wasmURL, gogc, gomemlimit } overrides
// the kernel wasm URL and per-worker Go runtime tuning. Query-string tuning is
// used otherwise, matching the signed production Worker.

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

// opt-W7: each Web Worker is an isolated realm, so this two-entry LRU is
// naturally per-worker. Entries are inserted only after both pinned digests
// verify. The key binds the URL and every chunk identity/pin field so a later
// proof or asset version cannot reuse bytes under different authentication.
const VERIFIED_CHUNK_CACHE_LIMIT = 2;
const verifiedChunkCache = new Map();

function verifiedChunkCacheKey(baseURL, chunk) {
  return JSON.stringify([
    resolveChunkURL(baseURL, chunk.path),
    chunk.index,
    chunk.offset,
    chunk.size,
    chunk.sha256,
    chunk.blake2b256,
  ]);
}

function cachedVerifiedChunk(key, chunk) {
  const entry = verifiedChunkCache.get(key);
  if (!entry || entry.verified !== true || entry.raw.byteLength !== chunk.size) return null;
  verifiedChunkCache.delete(key);
  verifiedChunkCache.set(key, entry);
  return entry.raw;
}

function insertVerifiedChunk(key, raw) {
  verifiedChunkCache.delete(key);
  verifiedChunkCache.set(key, { raw, verified: true });
  while (verifiedChunkCache.size > VERIFIED_CHUNK_CACHE_LIMIT) {
    verifiedChunkCache.delete(verifiedChunkCache.keys().next().value);
  }
}

function verifiedChunkCacheBytes() {
  let bytes = 0;
  for (const entry of verifiedChunkCache.values()) {
    if (entry && entry.verified === true && entry.raw instanceof Uint8Array) {
      bytes += entry.raw.byteLength;
    }
  }
  return bytes;
}

// Collect telemetry only after a successful kernel call. Go heap fields come
// from this Worker's msmworker.wasm instance, not the main prover runtime. The
// browser JS heap metric is optional and therefore omitted when unavailable;
// absence must never be encoded as a misleading zero. W7 cache residency is
// reported only when W7 is active and counts verified entries exclusively.
function collectCandidateWorkerTelemetry(optW7 = false) {
  const telemetry = {};
  if (typeof self.__msmengineWorkerMemStats === 'function') {
    copyTimingFields(telemetry, self.__msmengineWorkerMemStats());
  }
  const jsHeapUsed = globalThis.performance?.memory?.usedJSHeapSize;
  if (typeof jsHeapUsed === 'number' && Number.isFinite(jsHeapUsed) && jsHeapUsed >= 0) {
    telemetry.worker_js_heap_used_bytes = jsHeapUsed;
  }
  if (optW7) {
    telemetry.worker_w7_verified_cache_bytes = verifiedChunkCacheBytes();
  }
  return telemetry;
}

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

async function fetchVerifiedChunk(baseURL, chunk, optW7 = false) {
  const cacheKey = optW7 ? verifiedChunkCacheKey(baseURL, chunk) : '';
  if (optW7) {
    const cached = cachedVerifiedChunk(cacheKey, chunk);
    if (cached) {
      return { raw: cached, fetchMS: 0, hashMS: 0, fetchedBytes: 0, cacheHit: true, cacheMiss: false };
    }
  }
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
  // Verify-before-cache is the W7 security boundary. No error path above can
  // populate the LRU, so corrupt bytes are fetched and rejected again.
  if (optW7) insertVerifiedChunk(cacheKey, raw);
  return { raw, fetchMS, hashMS, fetchedBytes: raw.byteLength, cacheHit: false, cacheMiss: optW7 };
}

async function fetchSectionPointBytes(plan, sectionName, lo, hi, g2, optW7 = false) {
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
  // This Worker-originated field is the runtime capability acknowledgement.
  // Legacy/signed production Workers omit it and are rejected by the main
  // runtime before their partial can be used when optW7 was requested.
  const timings = {
    fetch_ms: 0,
    hash_ms: 0,
    slice_ms: 0,
    cache_hits: 0,
    cache_misses: 0,
    w7_applied: optW7 ? 1 : 0,
  };
  const bytes = { fetched: 0, hashed: 0, cache_hit: 0, used: pointsRaw.byteLength };
  for (const chunk of plan.chunks || []) {
    const chunkStart = chunk.offset;
    const chunkEnd = chunk.offset + chunk.size;
    if (chunkEnd <= start || chunkStart >= end) continue;
    const { raw, fetchMS, hashMS, fetchedBytes, cacheHit, cacheMiss } = await fetchVerifiedChunk(plan.base_url, chunk, optW7);
    timings.fetch_ms += fetchMS;
    timings.hash_ms += hashMS;
    timings.cache_hits += cacheHit ? 1 : 0;
    timings.cache_misses += cacheMiss ? 1 : 0;
    bytes.fetched += fetchedBytes;
    bytes.hashed += cacheHit ? 0 : raw.byteLength;
    bytes.cache_hit += cacheHit ? raw.byteLength : 0;
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
  const { pointsRaw, timings, bytes } = await fetchSectionPointBytes(plan, msg.section, msg.lo, msg.hi, msg.g2, msg.optW7 === true);
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
  copyTimingFields(timings, collectCandidateWorkerTelemetry(msg.optW7 === true));
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
    copyTimingFields(timings, collectCandidateWorkerTelemetry(false));
    // partial is backed by a plain ArrayBuffer (not the shared input), so it is
    // transferable — hand ownership to the main thread to avoid a copy.
    self.postMessage({ id, partial, compute_ms: timings.compute_ms || computeMS, timings }, [partial.buffer]);
  } catch (err) {
    self.postMessage({ id: msg && msg.id, error: String(err && err.message ? err.message : err) });
  }
};
