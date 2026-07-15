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
// progress replies carry only { stage, frac }. No console logging in this file.
//
// Termination is handled by the page via worker.terminate(); there is no
// shutdown message.

'use strict';

let initPromise = null;
let compiledMSMWorkerModule = null;

function errorMessage(err) {
  return String(err && err.message ? err.message : err);
}

// The entrypoints resolve with already-parsed JS objects (main_js.go builds
// them via JSON.parse), but tolerate a JSON string in case that changes.
function normalizeResult(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
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
      const result = await self.preflightProofAssets(msg.requestJson);
      self.postMessage({ id, type: 'preflight-result', result: normalizeResult(result) });
      return;
    }
    if (msg.type === 'prove') {
      const result = await self.proveDestination(msg.requestJson, (progress) => {
        const p = progress && typeof progress === 'object' ? progress : {};
        self.postMessage({ id, type: 'progress', stage: String(p.stage || ''), frac: Number(p.frac) || 0 });
      });
      self.postMessage({ id, type: 'prove-result', result: normalizeResult(result) });
      return;
    }
    throw new Error(`unknown message type ${String(msg.type)}`);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: errorMessage(err) });
  }
};
