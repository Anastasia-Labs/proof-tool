// prover-worker.js — dedicated classic worker hosting the Go proof orchestrator
// (proof-destination.wasm) for browser proving.
//
// The page (lib/proving/browser-wasm.ts) speaks this protocol:
//   in : { id, type:'init', wasmUrl, wasmExecUrl, msmWorkerWasmUrl, gogc, gomemlimit }
//   out: { id, type:'ready' } | { id, type:'error', message }
//
//   in : { id, type:'preflight', requestJson }
//   out: { id, type:'preflight-result', result } | { id, type:'error', message }
//
//   in : { id, type:'discover', requestJson }
//   out: { id, type:'progress', stage, frac, aggregate discovery measurements }
//        { id, type:'discover-result', result } | { id, type:'error', message }
//
//   in : { id, type:'prove', requestJson }
//   out: { id, type:'progress', stage, frac }   (repeated)
//        { id, type:'prove-result', result } | { id, type:'error', message }
//
// The Go orchestrator spawns the MSM shard workers (msm-worker.js) itself via
// `new Worker(artifacts.worker_js_url)`; relative worker/asset URLs resolve
// against this script's own URL, so all runtime files live in this directory.
//
// SECRETS: requestJson contains the master extended private key. It must never
// be logged or echoed back; error replies carry only a plain message string,
// progress replies carry only aggregate numeric measurements. No console
// logging in this file.
//
// Termination is handled by the page via worker.terminate(); there is no
// shutdown message.

'use strict';

let initPromise = null;
let compiledMSMWorkerModule = null;
let activeRangeFallback = null;
const nativeFetch = self.fetch.bind(self);

// The Go range reader accepts HTTP 200 by discarding bytes up to the requested
// offset. That compatibility path is catastrophic for a multi-GB proving key
// when a CDN silently ignores Range. Keep the accepted prover WASM byte-exact
// and adapt only the broken transport here: a healthy 206 is returned untouched
// with no probe, timer, retry, or extra request. After an observed 200, cancel
// it and serve subsequent ranges from the already-pinned signed chunk set.
self.fetch = rangeFallbackFetch;

function rangeFallbackContext(requestJson) {
  const request = JSON.parse(requestJson);
  const artifacts = request && typeof request === 'object' ? request.artifacts : null;
  if (!artifacts || typeof artifacts !== 'object') return null;
  const required = [
    'pk_url',
    'chunk_manifest_url',
    'chunk_manifest_sig_url',
    'chunk_manifest_public_key_hex',
  ];
  if (required.some((name) => typeof artifacts[name] !== 'string' || !artifacts[name])) return null;
  return {
    pkURL: new URL(artifacts.pk_url, self.location.href).href,
    chunkManifestURL: new URL(artifacts.chunk_manifest_url, self.location.href).href,
    chunkManifestSignatureURL: new URL(artifacts.chunk_manifest_sig_url, self.location.href).href,
    chunkManifestPublicKeyHex: artifacts.chunk_manifest_public_key_hex,
    verifiedManifest: null,
    verifiedChunks: new Map(),
    useChunks: false,
  };
}

async function withRangeFallback(requestJson, operation) {
  if (activeRangeFallback) throw new Error('prover worker request already active');
  const context = rangeFallbackContext(requestJson);
  activeRangeFallback = context;
  try {
    return await operation();
  } finally {
    if (context) context.verifiedChunks.clear();
    activeRangeFallback = null;
  }
}

function requestURL(input) {
  if (typeof input === 'string' || input instanceof URL) {
    return new URL(String(input), self.location.href).href;
  }
  return new URL(input.url, self.location.href).href;
}

function requestRange(input, init) {
  const headers = new Headers(input && typeof input === 'object' && input.headers ? input.headers : undefined);
  if (init && init.headers) {
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  }
  return headers.get('range') || '';
}

async function rangeFallbackFetch(input, init) {
  const context = activeRangeFallback;
  const url = requestURL(input);
  const range = requestRange(input, init);
  const isPKRange = !!context && url === context.pkURL && range !== '';
  if (isPKRange && context.useChunks) {
    return signedChunkRangeResponse(context, range);
  }
  const response = await nativeFetch(input, init);
  if (!isPKRange || response.status !== 200) return response;
  if (response.body && typeof response.body.cancel === 'function') {
    await response.body.cancel();
  }
  context.useChunks = true;
  return signedChunkRangeResponse(context, range);
}

function parseByteRange(raw, fileSize) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(raw);
  if (!match) throw new Error('proving key fallback requires one bounded byte range');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= fileSize) {
    throw new Error('proving key fallback range is out of bounds');
  }
  return { start, end };
}

function decodeHex(raw, expectedBytes, label) {
  if (typeof raw !== 'string' || !new RegExp(`^[0-9a-f]{${expectedBytes * 2}}$`, 'i').test(raw)) {
    throw new Error(`${label} must be ${expectedBytes}-byte hex`);
  }
  const out = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index += 1) {
    out[index] = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function safeChunkPath(raw) {
  if (
    typeof raw !== 'string' || raw === '' || raw.startsWith('/') ||
    raw.includes('\\') || raw.includes('://') || /[?#]/.test(raw) ||
    raw.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('signed proving key chunk path is unsafe');
  }
  return raw;
}

function validateSignedChunkManifest(manifest) {
  const provingKey = manifest?.proving_key;
  const transport = manifest?.transport;
  const fileSize = Number(manifest?.coherence?.proving_key_size);
  const indexFileSize = Number(manifest?.proving_key_index?.file_size);
  const chunkSize = Number(provingKey?.chunk_size);
  const chunks = provingKey?.chunks;
  if (
    manifest?.schema !== 'proof-tool-proof-assets-chunk-manifest-v1' ||
    !Number.isSafeInteger(fileSize) || fileSize <= 0 || indexFileSize !== fileSize ||
    !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || !Array.isArray(chunks) || chunks.length === 0
  ) {
    throw new Error('signed proving key chunk manifest is incomplete');
  }
  let baseURL;
  try {
    baseURL = new URL(transport?.base_url);
  } catch {
    throw new Error('signed proving key chunk base URL is invalid');
  }
  if (!['http:', 'https:'].includes(baseURL.protocol)) {
    throw new Error('signed proving key chunk base URL must use HTTP(S)');
  }
  if (baseURL.username || baseURL.password || baseURL.search || baseURL.hash || !baseURL.pathname.endsWith('/')) {
    throw new Error('signed proving key chunk base URL must be a plain directory URL');
  }
  if (transport?.requires_https === true && baseURL.protocol !== 'https:') {
    throw new Error('signed proving key chunk transport requires HTTPS');
  }
  if (transport?.content_encoding !== 'identity') {
    throw new Error('signed proving key chunks require identity encoding');
  }
  let expectedOffset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const size = Number(chunk?.size);
    if (
      chunk?.index !== index || chunk?.offset !== expectedOffset ||
      !Number.isSafeInteger(size) || size <= 0 || size > chunkSize ||
      (index < chunks.length - 1 && size !== chunkSize) ||
      !/^sha256:[0-9a-f]{64}$/i.test(chunk?.sha256 || '') ||
      !/^blake2b256:[0-9a-f]{64}$/i.test(chunk?.blake2b256 || '')
    ) {
      throw new Error(`signed proving key chunk ${index} is not canonical`);
    }
    safeChunkPath(chunk.path);
    expectedOffset += size;
  }
  if (expectedOffset !== fileSize) throw new Error('signed proving key chunks do not cover the proving key');
  return { baseURL, chunks, fileSize };
}

function signedChunkURL(baseURL, rawPath) {
  const url = new URL(safeChunkPath(rawPath), baseURL);
  if (url.origin !== baseURL.origin || !url.pathname.startsWith(baseURL.pathname)) {
    throw new Error('signed proving key chunk path escapes its base URL');
  }
  return url.href;
}

async function verifiedChunkManifest(context) {
  if (context.verifiedManifest) return context.verifiedManifest;
  const [manifestResponse, signatureResponse] = await Promise.all([
    nativeFetch(context.chunkManifestURL, { cache: 'force-cache' }),
    nativeFetch(context.chunkManifestSignatureURL, { cache: 'force-cache' }),
  ]);
  if (manifestResponse.status !== 200 || signatureResponse.status !== 200) {
    throw new Error('fetch signed proving key chunk manifest failed');
  }
  const manifestRaw = new Uint8Array(await manifestResponse.arrayBuffer());
  const signatureRaw = (await signatureResponse.text()).trim();
  if (manifestRaw.byteLength === 0 || manifestRaw.byteLength > 8 * 1024 * 1024 || signatureRaw.length > 256) {
    throw new Error('signed proving key chunk manifest response is not bounded');
  }
  const publicKey = await crypto.subtle.importKey(
    'raw',
    decodeHex(context.chunkManifestPublicKeyHex, 32, 'chunk manifest public key'),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const signature = decodeHex(signatureRaw, 64, 'chunk manifest signature');
  if (!(await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, manifestRaw))) {
    throw new Error('signed proving key chunk manifest signature verification failed');
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestRaw));
  context.verifiedManifest = validateSignedChunkManifest(manifest);
  return context.verifiedManifest;
}

function hexBytes(raw) {
  return Array.from(raw, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function fetchVerifiedChunk(context, manifest, chunk) {
  if (context.verifiedChunks.has(chunk.index)) return context.verifiedChunks.get(chunk.index);
  const pending = (async () => {
    const chunkURL = signedChunkURL(manifest.baseURL, chunk.path);
    const response = await nativeFetch(chunkURL, { cache: 'force-cache' });
    if (response.status !== 200) throw new Error(`fetch proving key chunk ${chunk.index} returned ${response.status}`);
    const encoding = (response.headers.get('content-encoding') || '').trim();
    if (encoding && encoding !== 'identity') throw new Error(`proving key chunk ${chunk.index} was transformed`);
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength !== chunk.size) throw new Error(`proving key chunk ${chunk.index} size mismatch`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
    if (`sha256:${hexBytes(digest)}` !== chunk.sha256) {
      throw new Error(`proving key chunk ${chunk.index} sha256 mismatch`);
    }
    return raw;
  })();
  context.verifiedChunks.set(chunk.index, pending);
  // Small-field reads reuse chunk zero once; a one-entry cache avoids that
  // duplicate without retaining the multi-chunk infinity bitmap afterward.
  while (context.verifiedChunks.size > 1) {
    context.verifiedChunks.delete(context.verifiedChunks.keys().next().value);
  }
  try {
    return await pending;
  } catch (error) {
    if (context.verifiedChunks.get(chunk.index) === pending) context.verifiedChunks.delete(chunk.index);
    throw error;
  }
}

async function signedChunkRangeResponse(context, rawRange) {
  const manifest = await verifiedChunkManifest(context);
  const { start, end } = parseByteRange(rawRange, manifest.fileSize);
  const selected = manifest.chunks.filter((chunk) => chunk.offset <= end && chunk.offset + chunk.size > start);
  const chunkBytes = await Promise.all(selected.map((chunk) => fetchVerifiedChunk(context, manifest, chunk)));
  const output = new Uint8Array(end - start + 1);
  for (let index = 0; index < selected.length; index += 1) {
    const chunk = selected[index];
    const raw = chunkBytes[index];
    const useStart = Math.max(start, chunk.offset);
    const useEnd = Math.min(end + 1, chunk.offset + chunk.size);
    output.set(raw.subarray(useStart - chunk.offset, useEnd - chunk.offset), useStart - start);
  }
  return new Response(output, {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(output.byteLength),
      'Content-Range': `bytes ${start}-${end}/${manifest.fileSize}`,
      'Content-Type': 'application/octet-stream',
    },
  });
}

function errorMessage(err) {
  return String(err && err.message ? err.message : err);
}

// The entrypoints resolve with already-parsed JS objects (main_js.go builds
// them via JSON.parse), but tolerate a JSON string in case that changes.
function normalizeResult(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function postProgress(id, progress) {
  const p = progress && typeof progress === 'object' ? progress : {};
  self.postMessage({
    id,
    type: 'progress',
    stage: String(p.stage || ''),
    frac: finiteNumber(p.frac),
    candidates_scanned: finiteNumber(p.candidates_scanned),
    candidates_total: finiteNumber(p.candidates_total),
    candidates_per_second: finiteNumber(p.candidates_per_second),
    eta_seconds: finiteNumber(p.eta_seconds),
    matched: finiteNumber(p.matched),
    targets: finiteNumber(p.targets),
  });
}

async function compileMSMWorkerModule(url) {
  if (!url) return null;
  if (typeof WebAssembly.compileStreaming === 'function') {
    return await WebAssembly.compileStreaming(fetch(url));
  }
  return await WebAssembly.compile(await (await fetch(url)).arrayBuffer());
}

// __proofChunkReadahead(urls, concurrency) — called by the Go orchestrator
// after the signed chunk manifest is verified. Warms the HTTP cache with the
// proving-key chunks in dispatch order so the MSM workers' later
// cache:'force-cache' fetches skip the network. Bodies are read (a response
// must complete to be committed to the cache) and discarded; integrity is
// enforced by the workers' digest checks at consumption time. Fetches are
// low-priority so an in-flight readahead never starves a worker's needed-now
// chunk on the shared connection.
self.__proofChunkReadahead = (urls, concurrency) => {
  let cancelled = false;
  let next = 0;
  const runner = async () => {
    while (!cancelled && next < urls.length) {
      const url = urls[next];
      next += 1;
      try {
        const resp = await fetch(url, { cache: 'force-cache', priority: 'low' });
        if (resp.ok) await resp.arrayBuffer();
      } catch {
        // Readahead is best-effort: a failed warm-up fetch just means the
        // worker pays the network cost later, exactly as without readahead.
      }
    }
  };
  const lanes = Math.max(1, Math.min(4, concurrency | 0));
  for (let i = 0; i < lanes; i += 1) runner();
  return { cancel: () => { cancelled = true; } };
};

function installMSMWorkerInitializer(wasmURL) {
  self.__initializeMSMWorker = (worker) => {
    const init = { type: 'init', wasmURL };
    if (compiledMSMWorkerModule) init.compiledModule = compiledMSMWorkerModule;
    try {
      worker.postMessage(init);
    } catch {
      // Older engines may not clone WebAssembly.Module. They compile once per
      // nested worker but preserve the same pinned URL and verification path.
      worker.postMessage({ type: 'init', wasmURL });
    }
  };
}

async function initRuntime(msg) {
  const msmCompile = compileMSMWorkerModule(msg.msmWorkerWasmUrl).catch(() => null);
  importScripts(msg.wasmExecUrl);
  const go = new self.Go();
  go.env.GOGC = msg.gogc ? String(msg.gogc) : '50';
  go.env.GOMEMLIMIT = msg.gomemlimit ? String(msg.gomemlimit) : '3000MiB';
  let instance;
  if (typeof WebAssembly.instantiateStreaming === 'function') {
    const result = await WebAssembly.instantiateStreaming(fetch(msg.wasmUrl), go.importObject);
    instance = result.instance;
  } else {
    const bytes = await (await fetch(msg.wasmUrl)).arrayBuffer();
    const result = await WebAssembly.instantiate(bytes, go.importObject);
    instance = result.instance;
  }
  // go.run resolves only when the Go program exits; the prover parks forever,
  // so do NOT await it. proveDestination/preflightProofAssets are registered
  // during main; wait for the readiness flag it sets last.
  go.run(instance);
  while (!self.__wasmProverReady) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  compiledMSMWorkerModule = await msmCompile;
  installMSMWorkerInitializer(msg.msmWorkerWasmUrl);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  const id = msg.id;
  try {
    if (msg.type === 'init') {
      if (initPromise) throw new Error('prover worker is already initialized');
      initPromise = initRuntime(msg);
      await initPromise;
      self.postMessage({ id, type: 'ready' });
      return;
    }
    if (!initPromise) throw new Error('prover worker is not initialized (send init first)');
    await initPromise;
    if (msg.type === 'preflight') {
      const result = await withRangeFallback(
        msg.requestJson,
        () => self.preflightProofAssets(msg.requestJson),
      );
      self.postMessage({ id, type: 'preflight-result', result: normalizeResult(result) });
      return;
    }
    if (msg.type === 'discover') {
      const result = await withRangeFallback(
        msg.requestJson,
        () => self.discoverCredentialPaths(msg.requestJson, (progress) => postProgress(id, progress)),
      );
      self.postMessage({ id, type: 'discover-result', result: normalizeResult(result) });
      return;
    }
    if (msg.type === 'prove') {
      const result = await withRangeFallback(
        msg.requestJson,
        () => self.proveDestination(msg.requestJson, (progress) => postProgress(id, progress)),
      );
      self.postMessage({ id, type: 'prove-result', result: normalizeResult(result) });
      return;
    }
    throw new Error(`unknown message type ${String(msg.type)}`);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: errorMessage(err) });
  }
};
