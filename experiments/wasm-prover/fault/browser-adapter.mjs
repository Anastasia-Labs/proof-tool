import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function createFaultBrowserAdapter({ repoRoot, baseURL, tuning = {}, optimizationFlags = {}, workerCount = 8 }) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(path.join(repoRoot, 'apps/ownership-proof-web/node_modules/playwright'));
  const browser = await chromium.launch({ headless: true, chromiumSandbox: false });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.__faultWorkers = [];
    globalThis.Worker = class FaultObservableWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        globalThis.__faultWorkers.push(this);
      }

      postMessage(message, transfer) {
        super.postMessage(message, transfer);
        if (globalThis.__killWorkerOnNextShard && message?.type === 'msm-section-range') {
          globalThis.__killWorkerOnNextShard = false;
          setTimeout(() => {
            this.terminate();
          }, 0);
        }
      }
    };
  });
  let page;

  async function loadFreshPage({ memoryProfile = false } = {}) {
    page = await context.newPage();
    page.setDefaultTimeout(0);
    if (memoryProfile) {
      await page.addInitScript(() => {
        globalThis.__GOGC = '50';
        globalThis.__GOMEMLIMIT = '2400MiB';
        Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, get: () => 4 });
        Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => 8 });
      });
    }
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__proverLoaded === true, null, { timeout: 0 });
  }
  await loadFreshPage();

  return {
    async capabilities() {
      const runtime = await page.evaluate(() => {
        const runtimeFaults = globalThis.__wasmProverFaults?.capabilities || [];
        return { faults: ['worker_kill_mid_shard', 'reload_retry', 'memory_pressure_profile', ...runtimeFaults] };
      });
      const advertised = await page.evaluate(() => globalThis.__wasmProverCapabilities?.optimization_flags || []);
      const workerCapability = await page.evaluate(() => globalThis.__wasmProverCapabilities?.worker_count || null);
      if (workerCapability?.explicit !== true || !Number.isSafeInteger(workerCapability.max) || workerCapability.max < workerCount) {
        throw new Error(`fault runtime does not advertise explicit worker_count through ${workerCount}`);
      }
      for (const finding of Object.keys(optimizationFlags)) {
        if (!advertised.includes(finding)) throw new Error(`fault runtime does not advertise ${finding}`);
      }
      const preflight = await page.evaluate(async (runtimeTuning) => {
        const request = structuredClone(globalThis.__defaultProofRequest);
        request.tuning = { ...(request.tuning || {}), ...runtimeTuning };
        return globalThis.preflightProofAssets(JSON.stringify(request));
      }, tuning);
      if (preflight.requested_tuning?.worker_count !== workerCount) {
        throw new Error(`fault preflight requested worker_count=${preflight.requested_tuning?.worker_count}, want ${workerCount}`);
      }
      const engineProbe = await probeWorkerApplication(page, tuning);
      const appliedWorkerCount = assertAppliedEngineProbe(engineProbe, {
        worker_count: workerCount,
        opt_w7: tuning.opt_w7 === true,
        ...(Number.isSafeInteger(tuning.shard_count) && tuning.shard_count > 0 ? { shard_count: tuning.shard_count } : {}),
        ...(Number.isSafeInteger(tuning.range_fetch_concurrency) && tuning.range_fetch_concurrency > 0
          ? { range_fetch_concurrency: tuning.range_fetch_concurrency }
          : {}),
        ...(typeof tuning.pinned_decode === 'boolean' ? { pinned_decode: tuning.pinned_decode } : {}),
      });
      if (Object.keys(optimizationFlags).length > 0) {
        for (const [finding, expected] of Object.entries(optimizationFlags)) {
          if (preflight.runtime_options?.[finding] !== expected) {
            throw new Error(`fault preflight acknowledged ${finding}=${preflight.runtime_options?.[finding]}, want ${expected}`);
          }
        }
      }
      const response = await fetch(new URL('/__wasm-prover-fault/status', baseURL));
      if (response.ok) runtime.faults.push('corrupt_pk_chunk', 'abort_range_fetch');
      runtime.worker_count = workerCapability;
      runtime.requested_worker_count = preflight.requested_tuning.worker_count;
      runtime.applied_worker_count = appliedWorkerCount;
      runtime.applied_engine = engineProbe.engine;
      runtime.applied_tuning = engineProbe.applied_tuning;
      return runtime;
    },
    async runFault(testCase) {
      if (testCase.id === 'worker-kill') {
        return runWorkerKill(page, tuning);
      }
      if (testCase.id === 'chunk-corruption' || testCase.id === 'network-abort') {
        return runTransportFault(page, baseURL, testCase.id, tuning);
      }
      if (testCase.id === 'memory-pressure') {
        await page.close();
        await loadFreshPage({ memoryProfile: true });
        return runMemoryPressure(page, tuning, optimizationFlags);
      }
      if (testCase.id !== 'reload-retry') {
        return page.evaluate(async (id) => globalThis.__wasmProverFaults.run(id), testCase.id);
      }

      const initialPersistenceAudit = await page.evaluate(auditPersistence);
      const initialContextCookies = await context.cookies();
      initialPersistenceAudit.browser_context_cookie_count = initialContextCookies.length;
      const initialContextCookieDigest = digestContextCookies(initialContextCookies);
      const firstAttempt = page.evaluate(async (runtimeTuning) => {
        const request = structuredClone(globalThis.__defaultProofRequest);
        request.tuning = { ...(request.tuning || {}), ...runtimeTuning };
        globalThis.__faultStage = '';
        return globalThis.proveDestination(JSON.stringify(request), (progress) => {
          globalThis.__faultStage = progress.stage || '';
        });
      }, tuning);
      const firstTermination = firstAttempt.then(
        () => ({ terminated: false, error: 'first proof unexpectedly completed before page close' }),
        (error) => ({ terminated: true, error: error?.message || String(error) }),
      );
      await page.waitForFunction(() => /^prove(?:\b|\s|:)/i.test(globalThis.__faultStage || ''), null, { timeout: 0 });
      const proofStage = await page.evaluate(() => globalThis.__faultStage);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 });
      const termination = await firstTermination;
      await page.waitForFunction(() => globalThis.__proverLoaded === true, null, { timeout: 0 });
      const persistenceAudit = await page.evaluate(auditPersistence);
      comparePersistenceInventories(initialPersistenceAudit, persistenceAudit);
      const contextCookies = await context.cookies();
      const contextCookieDigest = digestContextCookies(contextCookies);
      const cookieText = JSON.stringify(contextCookies);
      const masterXPrv = await page.evaluate(() => globalThis.__defaultProofRequest?.master_xprv_hex || '');
      const cookieSource = persistenceAudit.sources.cookies;
      cookieSource.browser_context_cookie_count = contextCookies.length;
      cookieSource.baseline_browser_context_cookie_count = initialPersistenceAudit.browser_context_cookie_count;
      cookieSource.context_inventory_sha256 = contextCookieDigest;
      cookieSource.baseline_context_inventory_sha256 = initialContextCookieDigest;
      cookieSource.context_inventory_unchanged = contextCookieDigest === initialContextCookieDigest;
      cookieSource.context_entries_unchanged = contextCookies.length === initialPersistenceAudit.browser_context_cookie_count;
      cookieSource.marker_hits.push(...findMarkers(cookieText, 'browser-context-cookies'));
      if (masterXPrv && cookieText.includes(masterXPrv)) {
        cookieSource.marker_hits.push('browser-context-cookies:golden-master-xprv');
      }

      const fresh = await page.evaluate(async (runtimeTuning) => {
        const request = structuredClone(globalThis.__defaultProofRequest);
        request.tuning = { ...(request.tuning || {}), ...runtimeTuning };
        return globalThis.proveDestination(JSON.stringify(request), () => {});
      }, tuning);
      const requestedWorkerCount = tuning.worker_count;
      const appliedWorkerCount = actualProofWorkerCount(fresh, requestedWorkerCount);
      assertProofRuntimeOptions(fresh, optimizationFlags);
      return {
        status: 'recovered',
        proof_stage_started: /^prove(?:\b|\s|:)/i.test(proofStage),
        first_attempt_terminated: termination.terminated,
        first_attempt_error: termination.error,
        fresh_verified: fresh.verified_locally === true,
        requested_worker_count: requestedWorkerCount,
        worker_count: appliedWorkerCount,
        runtime_options: fresh.runtime_options,
        trace_runtime_options: fresh.trace.runtime_options,
        persistence_audit: persistenceAudit,
        hung: false,
      };
    },
    async abortFault() {
      await page?.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

async function runWorkerKill(page, tuning = {}) {
  await page.evaluate(() => { globalThis.__killWorkerOnNextShard = true; });
  const firstAttempt = startProof(page, tuning);
  const termination = firstAttempt.then(
    () => ({ terminated: false, error: 'proof unexpectedly completed after worker termination' }),
    (error) => ({ terminated: true, error: error?.message || String(error) }),
  );
  const outcome = await termination;
  const fallback = classifyCPUFallbackFailure(outcome.error);
  return {
    status: outcome.terminated ? 'failed-closed' : 'unsafe-completed',
    error_class: /worker-terminated|worker.*(?:error|terminated)|terminated.*worker/i.test(outcome.error)
      ? 'worker-terminated'
      : 'unexpected-worker-error',
    error: outcome.error,
    cpu_fallback: fallback.state === 'observed' ? true : fallback.state === 'none' ? false : null,
    cpu_fallback_state: fallback.state,
    hung: false,
    partial_proof: false,
  };
}

async function runTransportFault(page, baseURL, id, tuning = {}) {
  const mode = id === 'chunk-corruption' ? 'chunk-corruption' : 'network-abort';
  const arm = await fetch(new URL('/__wasm-prover-fault/arm', baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!arm.ok) throw new Error(`${id}: fault server arm returned ${arm.status}`);
  let result;
  let error = '';
  try {
    result = await startProof(page, tuning);
  } catch (caught) {
    error = caught?.message || String(caught);
  }
  const status = await fetch(new URL('/__wasm-prover-fault/status', baseURL)).then((response) => response.json());
  const expectedClass = id === 'chunk-corruption' ? 'chunk-digest-mismatch' : 'range-fetch-aborted';
  const fallback = result
    ? classifyCPUFallbackSuccess(result)
    : classifyCPUFallbackFailure(error);
  return {
    status: result ? 'unsafe-completed' : 'failed-closed',
    error_class: error.includes(expectedClass) ? expectedClass : 'unexpected-transport-error',
    error,
    retry_count: status.retry_count,
    retry_max: status.retry_max,
    cpu_fallback: fallback.state === 'observed' ? true : fallback.state === 'none' ? false : null,
    cpu_fallback_state: fallback.state,
    partial_proof: !!result,
    hung: false,
    server_hit_count: status.hit_count,
  };
}

function startProof(page, tuning = {}) {
  return page.evaluate(async (runtimeTuning) => {
    const request = structuredClone(globalThis.__defaultProofRequest);
    request.tuning = { ...(request.tuning || {}), ...runtimeTuning };
    globalThis.__faultStage = '';
    return globalThis.proveDestination(JSON.stringify(request), (progress) => {
      globalThis.__faultStage = progress.stage || '';
    });
  }, tuning);
}

async function runMemoryPressure(page, tuning = {}, optimizationFlags = {}) {
  const requestedWorkerCount = tuning.worker_count;
  const memoryTuning = {
    ...tuning,
    worker_count: 4,
    shard_count: 16,
    range_fetch_concurrency: 2,
  };
  const engineProbe = await probeWorkerApplication(page, memoryTuning);
  const probedWorkerCount = assertAppliedEngineProbe(engineProbe, {
    worker_count: 4,
    shard_count: 16,
    range_fetch_concurrency: 2,
    opt_w7: memoryTuning.opt_w7 === true,
  });
  const workerCountProbe = {
    engine: engineProbe.engine,
    applied: probedWorkerCount,
    opt_w7: engineProbe.applied_tuning.opt_w7,
  };
  try {
    const result = await startProof(page, memoryTuning);
    const appliedWorkerCount = actualProofWorkerCount(result, 4);
    assertProofRuntimeOptions(result, optimizationFlags);
    const fallback = classifyCPUFallbackSuccess(result);
    return {
      status: 'completed',
      within_envelope: result.peak_heap_gib <= 2.4,
      verified_locally: result.verified_locally === true,
      peak_heap_gib: result.peak_heap_gib,
      worker_count: appliedWorkerCount,
      worker_count_probe: workerCountProbe,
      runtime_options: result.runtime_options,
      trace_runtime_options: result.trace.runtime_options,
      worker_count_override: { profile: '4-core/8-GB', requested: requestedWorkerCount, applied: appliedWorkerCount, source: 'proof-trace' },
      profile: { hardware_concurrency: 4, device_memory_gib: 8, worker_count: 4, gomemlimit: '2400MiB', main_heap_envelope_gib: 2.4 },
      partial_proof: false,
      cpu_fallback: fallback.state === 'observed' ? true : fallback.state === 'none' ? false : null,
      cpu_fallback_state: fallback.state,
      hung: false,
    };
  } catch (error) {
    const message = error?.message || String(error);
    const fallback = classifyCPUFallbackFailure(message);
    return {
      status: 'failed-closed',
      error_class: /out of memory|memory limit|not enough memory/i.test(message) && /guidance/i.test(message)
        ? 'oom-guidance'
        : 'unexpected-memory-error',
      error: message,
      worker_count: null,
      worker_count_probe: workerCountProbe,
      worker_count_override: { profile: '4-core/8-GB', requested: requestedWorkerCount, applied: null, source: 'unknown-no-proof' },
      profile: { hardware_concurrency: 4, device_memory_gib: 8, worker_count: 4, gomemlimit: '2400MiB', main_heap_envelope_gib: 2.4 },
      partial_proof: false,
      cpu_fallback: fallback.state === 'observed' ? true : fallback.state === 'none' ? false : null,
      cpu_fallback_state: fallback.state,
      hung: false,
    };
  }
}

async function probeWorkerApplication(page, tuning) {
  return page.evaluate(async (runtimeTuning) => {
    if (typeof globalThis.probeMSMEngine !== 'function') {
      throw new Error('fault runtime does not expose probeMSMEngine');
    }
    const request = structuredClone(globalThis.__defaultProofRequest);
    request.tuning = { ...(request.tuning || {}), ...runtimeTuning };
    return globalThis.probeMSMEngine(JSON.stringify(request));
  }, tuning);
}

export function assertAppliedWorkerProbe(probe, expected) {
  return assertAppliedEngineProbe(probe, { worker_count: expected });
}

export function assertAppliedEngineProbe(probe, expected = {}) {
  const actualWorkerCount = probe?.applied_tuning?.worker_count;
  if (probe?.engine !== 'sharded' || !Number.isSafeInteger(actualWorkerCount) || actualWorkerCount !== expected.worker_count) {
    throw new Error(`fault engine probe selected ${probe?.engine || 'unknown'} worker_count=${actualWorkerCount}, want sharded/${expected.worker_count}`);
  }
  for (const [field, wanted] of Object.entries(expected)) {
    if (field === 'worker_count') continue;
    const actual = probe?.applied_tuning?.[field];
    if (actual !== wanted) {
      throw new Error(`fault engine probe applied ${field}=${String(actual)}, want ${String(wanted)}`);
    }
  }
  return actualWorkerCount;
}

export function actualProofWorkerCount(result, expected) {
  const actual = result?.trace?.worker_count;
  if (!result?.engine?.includes('-sharded-') || !Number.isSafeInteger(actual) || actual !== expected) {
    throw new Error(`fault proof selected ${result?.engine || 'unknown'} trace.worker_count=${actual}, want sharded/${expected}`);
  }
  return actual;
}

export function assertProofRuntimeOptions(result, expected = {}) {
  for (const [finding, wanted] of Object.entries(expected)) {
    const resultValue = result?.runtime_options?.[finding];
    const traceValue = result?.trace?.runtime_options?.[finding];
    if (resultValue !== wanted || traceValue !== wanted) {
      throw new Error(
        `fault proof requested runtime option ${finding}: result=${String(resultValue)} trace=${String(traceValue)}, want ${String(wanted)}`,
      );
    }
  }
  return true;
}

export function classifyCPUFallbackFailure(message) {
  const text = String(message || '');
  if (/cpu retry prove|demoting from .* to cpu|streampk-cpu/i.test(text)) {
    return { state: 'observed' };
  }
  // These are FailClosedError classes in the runtime. WithFallbackReload
  // returns them directly and cannot enter its CPU retry branch.
  if (/(?:chunk-digest-mismatch|range-fetch-aborted|worker-terminated|worker-reply-integrity|worker-partial-invalid|w7-worker-capability):/i.test(text)) {
    return { state: 'none' };
  }
  return { state: 'unknown' };
}

function classifyCPUFallbackSuccess(result) {
  const engine = String(result?.engine || '');
  if (engine.includes('-cpu-')) return { state: 'observed' };
  if (engine.includes('-sharded-')) return { state: 'none' };
  return { state: 'unknown' };
}

async function auditPersistence() {
  const safeStringify = (value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const openDatabase = (name, version) => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`open IndexedDB ${name} failed`));
  });
  const inspectCursor = (store, visit) => new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed'));
    request.onsuccess = async () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      try {
        await visit(cursor.key, cursor.value);
        cursor.continue();
      } catch (error) {
        reject(error);
      }
    };
  });
  const inspectDirectory = async (directory, prefix, visit) => {
    for await (const [name, handle] of directory.entries()) {
      const entryPath = prefix ? `${prefix}/${name}` : name;
      await visit(entryPath, handle);
      if (handle.kind === 'directory') await inspectDirectory(handle, entryPath, visit);
    }
  };
  const markerPattern = /master[_-]?xprv|mnemonic|seed phrase|private key|witness|partial proof|proof[_-]?(?:hex|bytes|artifact|state)/gi;
  const secretNeedles = [globalThis.__defaultProofRequest?.master_xprv_hex].filter(Boolean);
  const markers = (value, location) => {
    const text = typeof value === 'string' ? value : safeStringify(value);
    const hits = [];
    for (const match of text.matchAll(markerPattern)) hits.push(`${location}:${match[0]}`);
    for (const needle of secretNeedles) {
      if (text.includes(needle)) hits.push(`${location}:golden-master-xprv`);
    }
    return hits;
  };
  const bytesToHex = (value) => Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const canonicalValue = async (value, seen = new Map()) => {
    if (value === null) return ['null'];
    if (value === undefined) return ['undefined'];
    if (typeof value === 'number') return ['number', Number.isNaN(value) ? 'NaN' : String(value)];
    if (typeof value === 'bigint') return ['bigint', value.toString()];
    if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
    if (typeof value !== 'object') return [typeof value, String(value)];
    if (seen.has(value)) return ['ref', seen.get(value)];
    seen.set(value, seen.size);
    if (value instanceof ArrayBuffer) return ['ArrayBuffer', bytesToHex(new Uint8Array(value))];
    if (ArrayBuffer.isView(value)) {
      return [value.constructor?.name || 'ArrayBufferView', bytesToHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
    }
    if (value instanceof Blob) return ['Blob', value.type, bytesToHex(new Uint8Array(await value.arrayBuffer()))];
    if (value instanceof Date) return ['Date', value.toISOString()];
    if (Array.isArray(value)) return ['Array', await Promise.all(value.map((item) => canonicalValue(item, seen)))];
    if (value instanceof Map) {
      const entries = await Promise.all(Array.from(value, async ([key, item]) => [
        await canonicalValue(key, seen),
        await canonicalValue(item, seen),
      ]));
      entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return ['Map', entries];
    }
    if (value instanceof Set) {
      const entries = await Promise.all(Array.from(value, (item) => canonicalValue(item, seen)));
      entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return ['Set', entries];
    }
    const entries = [];
    for (const key of Object.keys(value).sort()) {
      entries.push([key, await canonicalValue(value[key], seen)]);
    }
    return [value.constructor?.name || 'Object', entries];
  };
  const digestValue = async (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(await canonicalValue(value)));
    return `sha256:${bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))}`;
  };
  const source = (supported = true) => ({ supported, inspected: supported, marker_hits: [], entries: 0, inventory: [] });
  const sources = {
    local_storage: source(),
    session_storage: source(),
    indexed_db: source(typeof indexedDB !== 'undefined'),
    cache_storage: source(typeof caches !== 'undefined'),
    cookies: source(),
    history_state: source(),
    window_name: source(),
    opfs: source(!!navigator.storage?.getDirectory),
  };

  for (const [name, storage] of [
    ['local_storage', localStorage],
    ['session_storage', sessionStorage],
  ]) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index) || '';
      const value = storage.getItem(key) || '';
      sources[name].entries++;
      sources[name].marker_hits.push(...markers(`${key}\n${value}`, `${name}:${key}`));
      sources[name].inventory.push(await digestValue({ key, value }));
    }
  }

  if (sources.indexed_db.supported) {
    const databases = await indexedDB.databases();
    for (const info of databases) {
      if (!info.name) continue;
      sources.indexed_db.entries++;
      sources.indexed_db.marker_hits.push(...markers(info.name, `indexed_db:${info.name}`));
      const db = await openDatabase(info.name, info.version);
      try {
        sources.indexed_db.inventory.push(await digestValue({ kind: 'database', name: info.name, version: info.version }));
        for (const storeName of db.objectStoreNames) {
          sources.indexed_db.entries++;
          sources.indexed_db.inventory.push(await digestValue({ kind: 'object-store', database: info.name, store: storeName }));
          const transaction = db.transaction(storeName, 'readonly');
          const store = transaction.objectStore(storeName);
          await inspectCursor(store, async (key, value) => {
            sources.indexed_db.entries++;
            sources.indexed_db.marker_hits.push(
              ...markers({ key, value }, `indexed_db:${info.name}/${storeName}`),
            );
            sources.indexed_db.inventory.push(await digestValue({ database: info.name, store: storeName, key, value }));
          });
        }
      } finally {
        db.close();
      }
    }
  } else {
    sources.indexed_db.unavailable_reason = 'IndexedDB API unavailable';
  }

  if (sources.cache_storage.supported) {
    for (const cacheName of await caches.keys()) {
      sources.cache_storage.entries++;
      sources.cache_storage.marker_hits.push(...markers(cacheName, `cache:${cacheName}`));
      sources.cache_storage.inventory.push(await digestValue({ kind: 'cache', cacheName }));
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        sources.cache_storage.entries++;
        sources.cache_storage.marker_hits.push(...markers(request.url, `cache:${cacheName}:url`));
        const response = await cache.match(request);
        if (response) {
          const body = new Uint8Array(await response.clone().arrayBuffer());
          sources.cache_storage.marker_hits.push(
            ...markers(new TextDecoder().decode(body), `cache:${cacheName}:body`),
          );
          sources.cache_storage.inventory.push(await digestValue({ cacheName, url: request.url, body }));
        }
      }
    }
  } else {
    sources.cache_storage.unavailable_reason = 'Cache Storage API unavailable';
  }

  sources.cookies.entries = document.cookie ? document.cookie.split(';').length : 0;
  sources.cookies.marker_hits.push(...markers(document.cookie, 'document.cookie'));
  sources.cookies.inventory.push(await digestValue(document.cookie));
  sources.history_state.entries = history.state == null ? 0 : 1;
  sources.history_state.marker_hits.push(...markers(history.state, 'history.state'));
  sources.history_state.inventory.push(await digestValue(history.state));
  sources.window_name.entries = window.name ? 1 : 0;
  sources.window_name.marker_hits.push(...markers(window.name, 'window.name'));
  sources.window_name.inventory.push(await digestValue(window.name));

  if (sources.opfs.supported) {
    await inspectDirectory(await navigator.storage.getDirectory(), '', async (entryPath, handle) => {
      sources.opfs.entries++;
      sources.opfs.marker_hits.push(...markers(entryPath, `opfs:${entryPath}`));
      sources.opfs.inventory.push(await digestValue({ kind: handle.kind, entryPath }));
      if (handle.kind === 'file') {
        const file = await handle.getFile();
        const body = new Uint8Array(await file.arrayBuffer());
        sources.opfs.marker_hits.push(...markers(new TextDecoder().decode(body), `opfs:${entryPath}:body`));
        sources.opfs.inventory.push(await digestValue({ entryPath, body }));
      }
    });
  } else {
    sources.opfs.unavailable_reason = 'Origin Private File System API unavailable';
  }

  for (const item of Object.values(sources)) {
    if (item.supported) {
      item.inventory.sort();
      item.inventory_sha256 = await digestValue(item.inventory);
    }
    delete item.inventory;
  }
  return { schema: 'wasm-prover-persistence-audit-v1', complete: true, sources };
}

function findMarkers(value, location) {
  const pattern = /master[_-]?xprv|mnemonic|seed phrase|private key|witness|partial proof|proof[_-]?(?:hex|bytes|artifact|state)/gi;
  return Array.from(String(value).matchAll(pattern), (match) => `${location}:${match[0]}`);
}

function comparePersistenceInventories(before, after) {
  for (const [name, source] of Object.entries(after.sources || {})) {
    const baseline = before.sources?.[name];
    if (!source.supported || !baseline?.supported) continue;
    source.baseline_inventory_sha256 = baseline.inventory_sha256;
    source.baseline_entries = baseline.entries;
    source.inventory_unchanged = source.inventory_sha256 === baseline.inventory_sha256;
    source.entries_unchanged = source.entries === baseline.entries;
  }
}

function digestContextCookies(cookies) {
  const canonical = cookies
    .map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({
      name, value, domain, path, expires, httpOnly, secure, sameSite,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}
