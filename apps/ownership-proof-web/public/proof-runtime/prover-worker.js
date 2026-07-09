// prover-worker.js — dedicated classic worker hosting the Go proof orchestrator
// (proof-destination.wasm) for browser proving.
//
// The page (lib/proving/browser-wasm.ts) speaks this protocol:
//   in : { id, type:'init', wasmUrl, wasmExecUrl, gogc, gomemlimit }
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

function errorMessage(err) {
  return String(err && err.message ? err.message : err);
}

// The entrypoints resolve with already-parsed JS objects (main_js.go builds
// them via JSON.parse), but tolerate a JSON string in case that changes.
function normalizeResult(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

async function initRuntime(msg) {
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
