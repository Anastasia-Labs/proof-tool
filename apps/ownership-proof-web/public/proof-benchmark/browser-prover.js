const $ = (id) => document.getElementById(id);

const defaultRequest = {
  ...structuredClone(globalThis.__benchmarkPrivateRequest || {}),
  artifacts: {
    manifest_url: '/proof-assets/manifest.json',
    manifest_sig_url: '/proof-assets/manifest.sig',
    manifest_public_key_hex: 'e20b0fb38fb6dc0a66284a8f3a6e8d05bf55b8e966d86f53b77d284b524463d6',
    ccs_url: '/proof-assets/ownership-destination.ccs',
    ccs_blake2b256: 'blake2b256:54da79a38f83d47447cd613bb41d16ef0a19e3c29b0b1a3267d0a1c16aeb577e',
    vk_url: '/proof-assets/ownership.vk',
    pk_url: '/proof-assets/ownership.pk',
    pk_index_url: '/proof-assets/ownership.pk.idx.json',
    chunk_manifest_url: '/proof-assets/chunk-manifest.json',
    chunk_manifest_sig_url: '/proof-assets/chunk-manifest.sig',
    chunk_manifest_public_key_hex: 'e20b0fb38fb6dc0a66284a8f3a6e8d05bf55b8e966d86f53b77d284b524463d6',
    deployment_manifest_url: '/proof-assets/reclaim-deployment.json',
    proof_wasm_url: '/proof-destination.wasm',
    worker_js_url: '/worker.js',
    msm_worker_wasm_url: '/msmworker.wasm',
  },
};

function setStage(stage, frac = 0) {
  $('stage').textContent = stage;
  $('bar').value = frac;
}

function showCaps() {
  const iso = !!globalThis.crossOriginIsolated;
  const workers = navigator.hardwareConcurrency || 0;
  const engine = iso && workers > 1 ? 'streampk-sharded-groth16' : 'streampk-cpu-groth16';
  $('caps').innerHTML =
    `crossOriginIsolated=<span class="${iso ? 'ok' : 'bad'}">${iso}</span> · ` +
    `hardwareConcurrency=${workers} · engine=${engine}`;
}

function buildBrowserBenchmarkMatrix({ includeUnsafeOverSharding = false } = {}) {
  const cases = [];
  cases.push({ name: 'browser-wasm-cpu-streaming', tuning: { force_cpu: true } });
  const shardMultipliers = includeUnsafeOverSharding ? [1, 2, 4] : [1];
  for (const worker_count of [2, 4, 8, 16]) {
    for (const range_fetch_concurrency of [1, 2, 4, 8]) {
      for (const shard_multiplier of shardMultipliers) {
        cases.push({
          name: `browser-wasm-sharded-w${worker_count}-rf${range_fetch_concurrency}-s${shard_multiplier}x`,
          tuning: { worker_count, range_fetch_concurrency, shard_multiplier },
        });
      }
    }
  }
  return cases;
}

function buildSectionPlanFromManifest(manifest, baseURL) {
  const sections = {};
  for (const section of manifest.proving_key_index.sections) {
    sections[section.name] = {
      name: section.name,
      offset: section.offset,
      len: section.len,
      elem_size: section.elem_size,
    };
  }
  return {
    asset_id: manifest.proving_key.chunks_root_blake2b256,
    base_url: baseURL,
    file_size: manifest.coherence.proving_key_size,
    chunk_size: manifest.proving_key.chunk_size,
    sections,
    chunks: manifest.proving_key.chunks,
    manifest_hash: '',
    vk_hash: manifest.coherence.vk_hash,
  };
}

async function pointBytesFromChunks(manifest, baseURL, sectionName, lo, hi) {
  const section = manifest.proving_key_index.sections.find((entry) => entry.name === sectionName);
  if (!section) throw new Error(`section ${sectionName} not found`);
  const start = section.offset + lo * section.elem_size;
  const end = section.offset + hi * section.elem_size;
  const out = new Uint8Array(end - start);
  for (const chunk of manifest.proving_key.chunks) {
    const chunkStart = chunk.offset;
    const chunkEnd = chunk.offset + chunk.size;
    if (chunkEnd <= start || chunkStart >= end) continue;
    const response = await fetch(new URL(chunk.path, baseURL));
    if (!response.ok) throw new Error(`fetch ${chunk.path} returned ${response.status}`);
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength !== chunk.size) {
      throw new Error(`chunk ${chunk.index} size ${raw.byteLength}, want ${chunk.size}`);
    }
    const useStart = Math.max(start, chunkStart);
    const useEnd = Math.min(end, chunkEnd);
    out.set(raw.subarray(useStart - chunkStart, useEnd - chunkStart), useStart - start);
  }
  return out;
}

function makeTestScalars(n) {
  const out = new Uint8Array(n * 32);
  for (let i = 0; i < n; i++) {
    const v = i + 1;
    const off = i * 32;
    out[off + 28] = (v >>> 24) & 0xff;
    out[off + 29] = (v >>> 16) & 0xff;
    out[off + 30] = (v >>> 8) & 0xff;
    out[off + 31] = v & 0xff;
  }
  return out;
}

function equalBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function workerCall(worker, message, timeoutMS = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker request ${message.id || message.type} timed out`)), timeoutMS);
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (message.type === 'init' && data.type === 'ready') {
        clearTimeout(timer);
        resolve(data);
        return;
      }
      if (message.type !== 'init' && data.id === message.id) {
        clearTimeout(timer);
        if (data.error) {
          reject(new Error(data.error));
          return;
        }
        resolve(data);
      }
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message || 'worker error'));
    };
    worker.postMessage(message);
  });
}

async function runWorkerOwnedSectionCheck({ section = 'A', n = 128, baseURL = '/proof-assets/' } = {}) {
  const manifest = await (await fetch('/proof-assets/chunk-manifest.json')).json();
  const resolvedBaseURL = new URL(baseURL, location.href).href;
  const plan = buildSectionPlanFromManifest(manifest, resolvedBaseURL);
  const points = await pointBytesFromChunks(manifest, resolvedBaseURL, section, 0, n);
  const scalars = makeTestScalars(n);
  const worker = new Worker('/worker.js');
  try {
    await workerCall(worker, { type: 'init', wasmURL: '/msmworker.wasm' });
    const direct = await workerCall(worker, {
      id: 1,
      g2: false,
      pts: points.buffer.slice(0),
      scs: scalars.buffer.slice(0),
    });
    const fromSection = await workerCall(worker, {
      type: 'msm-section-range',
      id: 2,
      g2: false,
      pkPlan: JSON.stringify(plan),
      section,
      lo: 0,
      hi: n,
      scs: scalars.buffer.slice(0),
    });
    const exact = equalBytes(new Uint8Array(direct.partial), new Uint8Array(fromSection.partial));

    const tampered = structuredClone(plan);
    const firstOffset = tampered.sections[section].offset;
    const chunk = tampered.chunks.find((entry) => entry.offset <= firstOffset && entry.offset + entry.size > firstOffset);
    chunk.blake2b256 = `blake2b256:${'00'.repeat(32)}`;
    let tamperRejected = false;
    let tamperError = '';
    try {
      await workerCall(worker, {
        type: 'msm-section-range',
        id: 3,
        g2: false,
        pkPlan: JSON.stringify(tampered),
        section,
        lo: 0,
        hi: n,
        scs: scalars.buffer.slice(0),
      });
    } catch (error) {
      tamperError = error && error.message ? error.message : String(error);
      tamperRejected = /blake2b256 mismatch/.test(tamperError);
    }

    return {
      ok: exact && tamperRejected,
      section,
      n,
      bit_exact: exact,
      tamper_rejected: tamperRejected,
      tamper_error: tamperError,
      timings: fromSection.timings || {},
      bytes: fromSection.bytes || {},
    };
  } finally {
    worker.terminate();
  }
}

async function runBrowserBenchmarkMatrix(cases = buildBrowserBenchmarkMatrix()) {
  const base = JSON.parse($('request').value);
  const results = [];
  for (const testCase of cases) {
    const req = structuredClone(base);
    req.tuning = { ...(req.tuning || {}), ...(testCase.tuning || {}) };
    setStage(`bench ${testCase.name}`, 0);
    const started = performance.now();
    const result = await globalThis.proveDestination(JSON.stringify(req), (progress) => {
      setStage(`${testCase.name}: ${progress.stage}`, progress.frac);
    });
    results.push({
      name: testCase.name,
      tuning: req.tuning,
      wall_seconds: result.wall_seconds || (performance.now() - started) / 1000,
      peak_heap_gib: result.peak_heap_gib,
      engine: result.engine,
      verified_locally: result.verified_locally,
      trace: result.trace,
    });
    $('result').textContent = JSON.stringify(results, null, 2);
  }
  globalThis.__matrixResults = results;
  setStage('bench done', 1);
  return results;
}

async function loadWasm() {
  const go = new Go();
  go.env.GOMEMLIMIT = globalThis.__GOMEMLIMIT || '3200MiB';
  go.env.GOGC = globalThis.__GOGC || '15';
  const response = await fetch('/proof-runtime/proof-destination.wasm');
  const { instance } = await WebAssembly.instantiateStreaming(response, go.importObject);
  go.run(instance);
  while (!globalThis.__wasmProverReady) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function onProve() {
  $('prove').disabled = true;
  $('result').textContent = '';
  setStage('starting', 0);
  const started = performance.now();
  try {
    const result = await globalThis.proveDestination($('request').value, (progress) => {
      setStage(progress.stage, progress.frac);
    });
    result.wall_seconds = result.wall_seconds || (performance.now() - started) / 1000;
    $('result').textContent = JSON.stringify(result, null, 2);
    globalThis.__proveResult = result;
    globalThis.__proofTrace = result.trace;
    setStage('done', 1);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    $('result').textContent = message;
    globalThis.__proveError = message;
    setStage('error', 0);
  } finally {
    $('prove').disabled = false;
  }
}

showCaps();
globalThis.__defaultProofRequest = defaultRequest;
globalThis.__buildBrowserBenchmarkMatrix = buildBrowserBenchmarkMatrix;
globalThis.__runBrowserBenchmarkMatrix = runBrowserBenchmarkMatrix;
globalThis.__runWorkerOwnedSectionCheck = runWorkerOwnedSectionCheck;
$('request').value = JSON.stringify({
  private_inputs_injected_locally: Boolean(defaultRequest.master_xprv_hex),
  artifacts: defaultRequest.artifacts,
}, null, 2);
setStage('loading wasm', 0);
try {
  await loadWasm();
  globalThis.__proverLoaded = true;
  setStage('ready', 0);
  $('prove').disabled = false;
  $('prove').addEventListener('click', onProve);
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  $('result').textContent = message;
  globalThis.__proveError = message;
  setStage('load-error', 0);
}
