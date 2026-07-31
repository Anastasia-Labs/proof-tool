import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const workerSource = await readFile(
  new URL("../web/worker.js", import.meta.url),
  "utf8",
);
const productionWorkerSource = await readFile(
  new URL(
    "../../../apps/ownership-proof-web/public/proof-runtime/msm-worker.js",
    import.meta.url,
  ),
  "utf8",
);
const legacyWorkerSource = await readFile(
  new URL("./fixtures/legacy-worker-no-w7.js", import.meta.url),
  "utf8",
);

function workerHarness(source = workerSource) {
  const queued = [];
  let fetchCount = 0;
  let activeFetches = 0;
  let maxActiveFetches = 0;
  let timerCount = 0;
  let tick = 0;
  const hostSetTimeout = setTimeout;
  const context = vm.createContext({
    ArrayBuffer,
    Atomics,
    Int32Array,
    SharedArrayBuffer,
    URL,
    Uint8Array,
    WebAssembly: {},
    importScripts() {},
    performance: { now: () => ++tick },
    setTimeout(callback, delay, ...args) {
      timerCount++;
      return hostSetTimeout(callback, delay, ...args);
    },
    self: {
      __msmengineVerifyChunkBytes(raw) {
        if (raw[0] === 0) return "chunk sha256 mismatch";
        if (raw[0] === 1) return "chunk blake2b256 mismatch";
        return "";
      },
    },
    async fetch() {
      fetchCount++;
      activeFetches++;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      try {
        const queuedValue = queued.shift();
        if (!queuedValue) throw new Error("unexpected fetch");
        if (queuedValue.kind === "network-error") throw queuedValue.error;
        if (queuedValue.kind === "response") {
          return queuedValue.response;
        }
        const bytes = await queuedValue;
        const copy = Uint8Array.from(bytes);
        return {
          status: 200,
          headers: { get: () => "identity" },
          async arrayBuffer() {
            return copy.buffer;
          },
        };
      } finally {
        activeFetches--;
      }
    },
  });
  vm.runInContext(source, context, { filename: "worker.js" });
  return {
    context,
    queue(bytes) {
      queued.push(bytes);
    },
    queueNetworkError(error = new Error("network unavailable")) {
      queued.push({ kind: "network-error", error });
    },
    queueHTTP(status, retryAfter = "") {
      queued.push({
        kind: "response",
        response: {
          status,
          headers: {
            get(name) {
              return name === "retry-after" ? retryAfter : "identity";
            },
          },
          body: { async cancel() {} },
          async arrayBuffer() {
            return new Uint8Array(0).buffer;
          },
        },
      });
    },
    fetchCount: () => fetchCount,
    timerCount: () => timerCount,
    maxActiveFetches: () => maxActiveFetches,
    cacheSize: () => vm.runInContext("verifiedChunkCache.size", context),
    telemetry: (enabled = false) => {
      context.testEnabled = enabled;
      return vm.runInContext("collectCandidateWorkerTelemetry(testEnabled)", context);
    },
    setGoMemStats(stats) {
      context.self.__msmengineWorkerMemStats = () => ({ ...stats });
    },
    setJSHeapUsed(bytes) {
      if (bytes === undefined) delete context.performance.memory;
      else context.performance.memory = { usedJSHeapSize: bytes };
    },
    fetchChunk: (chunk, enabled = true) => {
      context.testChunk = chunk;
      context.testEnabled = enabled;
      return vm.runInContext(
        'fetchVerifiedChunk("https://assets.example/", testChunk, testEnabled)',
        context,
      );
    },
    fetchSection: (plan, enabled = true, prefetchWindow = 2) => {
      context.testPlan = plan;
      context.testEnabled = enabled;
      context.testPrefetchWindow = prefetchWindow;
      return vm.runInContext(
        'fetchSectionPointBytes(testPlan, "A", 0, Math.floor(testPlan.sections.A.len / 96), false, testEnabled, testPrefetchWindow)',
        context,
      );
    },
    runSection: (plan, enabled = true) => {
      context.testMessage = {
        pkPlan: plan,
        section: "A",
        lo: 0,
        hi: 2,
        g2: false,
        optW7: enabled,
        pinnedDecode: true,
        scs: new ArrayBuffer(64),
      };
      return vm.runInContext("runSectionRange(testMessage)", context);
    },
    errorPayload: (code, retryable) => {
      context.testCode = code;
      context.testRetryable = retryable;
      return vm.runInContext(
        'workerErrorPayload(workerTaskError(testCode, "test failure", testRetryable, 1234))',
        context,
      );
    },
    markProgress: (requestID, messageID, completed) => {
      const progress = new SharedArrayBuffer(8);
      const view = new Int32Array(progress);
      Atomics.store(view, 0, requestID);
      context.testProgressMessage = { id: messageID, progress };
      context.testCompleted = completed;
      vm.runInContext(
        "markWorkerProgress(workerProgressState(testProgressMessage), testCompleted)",
        context,
      );
      return [Atomics.load(view, 0), Atomics.load(view, 1)];
    },
  };
}

function pinnedChunk() {
  return {
    index: 7,
    offset: 0,
    size: 4,
    path: "chunks/000007.bin",
    sha256: `sha256:${"a".repeat(64)}`,
    blake2b256: `blake2b256:${"b".repeat(64)}`,
  };
}

test("W7 defaults off and preserves fetch-and-verify behavior", async () => {
  const harness = workerHarness();
  const chunk = pinnedChunk();
  harness.queue([2, 2, 3, 4]);
  harness.queue([2, 2, 3, 4]);
  const first = await harness.fetchChunk(chunk, false);
  const second = await harness.fetchChunk(chunk, false);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, false);
  assert.equal(harness.fetchCount(), 2);
  assert.equal(harness.cacheSize(), 0);
  assert.equal("worker_w7_verified_cache_bytes" in harness.telemetry(false), false);
});

test("W7 never caches SHA-256 or BLAKE2b-corrupt chunks", async () => {
  const harness = workerHarness();
  const chunk = pinnedChunk();

  harness.queue([0, 2, 3, 4]);
  await assert.rejects(harness.fetchChunk(chunk), /sha256 mismatch/);
  assert.equal(harness.cacheSize(), 0);
  assert.equal(harness.fetchCount(), 1);

  harness.queue([1, 2, 3, 4]);
  await assert.rejects(harness.fetchChunk(chunk), /blake2b256 mismatch/);
  assert.equal(harness.cacheSize(), 0);
  assert.equal(harness.fetchCount(), 2);

  harness.queue([2, 2, 3, 4]);
  const verified = await harness.fetchChunk(chunk);
  assert.equal(verified.cacheHit, false);
  assert.equal(harness.cacheSize(), 1);
  assert.equal(harness.fetchCount(), 3);

  const cached = await harness.fetchChunk(chunk);
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.fetchedBytes, 0);
  assert.equal(cached.hashMS, 0);
  assert.equal(harness.fetchCount(), 3);

  const chunkB = { ...chunk, index: 8, path: "chunks/000008.bin" };
  const chunkC = { ...chunk, index: 9, path: "chunks/000009.bin" };
  harness.queue([2, 8, 8, 8]);
  await harness.fetchChunk(chunkB);
  harness.queue([2, 9, 9, 9]);
  await harness.fetchChunk(chunkC);
  assert.equal(harness.cacheSize(), 2);
  harness.queue([2, 2, 3, 4]);
  const evicted = await harness.fetchChunk(chunk);
  assert.equal(evicted.cacheHit, false);
  assert.equal(harness.fetchCount(), 6);
});

test("W7 reports fetched, hashed, and cache-hit bytes", async () => {
  const harness = workerHarness();
  const chunk = { ...pinnedChunk(), size: 192 };
  const plan = {
    base_url: "https://assets.example/",
    file_size: 192,
    sections: { A: { offset: 0, len: 192, elem_size: 96 } },
    chunks: [chunk],
  };
  harness.queue(new Uint8Array(192).fill(2));

  const first = await harness.fetchSection(plan);
  assert.deepEqual({ ...first.bytes }, {
    fetched: 192,
    hashed: 192,
    cache_hit: 0,
    used: 192,
  });
  assert.equal(first.timings.cache_hits, 0);
  assert.equal(first.timings.cache_misses, 1);
  assert.equal(first.timings.fetch_attempts, 1);
  assert.equal(harness.timerCount(), 0);

  const second = await harness.fetchSection(plan);
  assert.deepEqual({ ...second.bytes }, {
    fetched: 0,
    hashed: 0,
    cache_hit: 192,
    used: 192,
  });
  assert.equal(second.timings.hash_ms, 0);
  assert.equal(second.timings.cache_hits, 1);
  assert.equal(second.timings.cache_misses, 0);
  assert.equal(second.timings.fetch_attempts, 0);
  assert.equal(harness.fetchCount(), 1);
});

test("candidate and production workers retry only the affected chunk", async () => {
  for (const source of [workerSource, productionWorkerSource]) {
    const harness = workerHarness(source);
    const chunk = pinnedChunk();
    harness.queueNetworkError();
    harness.queue([2, 2, 3, 4]);

    const result = await harness.fetchChunk(chunk, true);

    assert.equal(result.attempts, 2);
    assert.equal(harness.fetchCount(), 2);
    assert.equal(harness.timerCount(), 1);
    assert.equal(harness.cacheSize(), 1);
    assert.equal(result.cacheHit, false);
  }
});

test("a retryable HTTP response is retried, while a terminal status is not", async () => {
  const recovered = workerHarness();
  recovered.queueHTTP(503);
  recovered.queue([2, 2, 3, 4]);
  const result = await recovered.fetchChunk(pinnedChunk(), false);
  assert.equal(result.attempts, 2);
  assert.equal(recovered.fetchCount(), 2);
  assert.equal(recovered.timerCount(), 1);

  const terminal = workerHarness();
  terminal.queueHTTP(404);
  await assert.rejects(
    terminal.fetchChunk(pinnedChunk(), false),
    (error) => error?.workerCode === "chunk-fetch-http" && error?.retryable === false,
  );
  assert.equal(terminal.fetchCount(), 1);
});

test("persistent network failure remains bounded at the chunk retry budget", async () => {
  const harness = workerHarness();
  harness.queueNetworkError();
  harness.queueNetworkError();
  await assert.rejects(
    harness.fetchChunk(pinnedChunk(), false),
    (error) => error?.workerCode === "chunk-fetch-network" && error?.retryable === true,
  );
  assert.equal(harness.fetchCount(), 2);
  assert.equal(harness.timerCount(), 1);
  assert.equal(harness.cacheSize(), 0);
});

test("candidate worker telemetry reports Go heap, optional JS heap, and verified W7 cache bytes", async () => {
  const harness = workerHarness();
  harness.setGoMemStats({
    worker_go_heap_alloc_bytes: 101,
    worker_go_heap_sys_bytes: 202,
    worker_go_heap_inuse_bytes: 303,
    worker_go_heap_released_bytes: 4,
    worker_go_stack_inuse_bytes: 505,
    worker_go_stack_sys_bytes: 606,
    worker_go_sys_bytes: 707,
    worker_go_gc_count: 8,
  });
  harness.setJSHeapUsed(909);
  const chunk = pinnedChunk();
  harness.queue([2, 2, 3, 4]);
  await harness.fetchChunk(chunk, true);
  assert.deepEqual({ ...harness.telemetry(true) }, {
    worker_go_heap_alloc_bytes: 101,
    worker_go_heap_sys_bytes: 202,
    worker_go_heap_inuse_bytes: 303,
    worker_go_heap_released_bytes: 4,
    worker_go_stack_inuse_bytes: 505,
    worker_go_stack_sys_bytes: 606,
    worker_go_sys_bytes: 707,
    worker_go_gc_count: 8,
    worker_js_heap_used_bytes: 909,
    worker_w7_verified_cache_bytes: 4,
  });
});

test("unavailable JS heap telemetry stays absent instead of becoming zero", () => {
  const harness = workerHarness();
  harness.setGoMemStats({ worker_go_heap_alloc_bytes: 123 });
  harness.setJSHeapUsed(undefined);
  const telemetry = harness.telemetry(true);
  assert.equal(telemetry.worker_go_heap_alloc_bytes, 123);
  assert.equal(telemetry.worker_w7_verified_cache_bytes, 0);
  assert.equal("worker_js_heap_used_bytes" in telemetry, false);
});

test("every successful candidate section shard carries worker telemetry", async () => {
  const harness = workerHarness();
  harness.setGoMemStats({
    worker_go_heap_alloc_bytes: 321,
    worker_go_heap_sys_bytes: 654,
  });
  harness.context.self.__msmengineShardG1Timed = () => ({
    partial: new Uint8Array(96),
    timings: { kernel_ms: 7 },
  });
  const plan = {
    base_url: "https://assets.example/",
    file_size: 192,
    sections: { A: { offset: 0, len: 192, elem_size: 96 } },
    chunks: [{ ...pinnedChunk(), size: 192 }],
  };
  harness.queue(new Uint8Array(192).fill(2));
  const result = await harness.runSection(plan, true);
  assert.equal(result.timings.worker_go_heap_alloc_bytes, 321);
  assert.equal(result.timings.worker_go_heap_sys_bytes, 654);
  assert.equal(result.timings.worker_w7_verified_cache_bytes, 192);
  assert.equal("worker_js_heap_used_bytes" in result.timings, false);
});

test("W7 qualification rejects the legacy production Worker false-pass shape", async () => {
  const plan = {
    base_url: "https://assets.example/",
    file_size: 192,
    sections: { A: { offset: 0, len: 192, elem_size: 96 } },
    chunks: [{ ...pinnedChunk(), size: 192 }],
  };

  const candidate = workerHarness();
  candidate.queue(new Uint8Array(192).fill(2));
  const candidateResult = await candidate.fetchSection(plan, true);
  assert.equal(candidateResult.timings.w7_applied, 1);

  const legacy = workerHarness(legacyWorkerSource);
  legacy.queue(new Uint8Array(192).fill(2));
  const legacyResult = await legacy.fetchSection(plan, true);
  assert.equal(legacyResult.timings.w7_applied, undefined);
  assert.throws(
    () => {
      if (legacyResult.timings.w7_applied !== 1) {
        throw new Error("opt_w7 requested but Worker did not acknowledge w7_applied=1");
      }
    },
    /did not acknowledge/,
  );
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("chunk prefetch window bounds concurrent verified requests", async () => {
  const harness = workerHarness();
  const waits = Array.from({ length: 4 }, () => deferred());
  for (const wait of waits) harness.queue(wait.promise);
  const plan = {
    base_url: "https://assets.example/",
    file_size: 384,
    sections: { A: { offset: 0, len: 384, elem_size: 96 } },
    chunks: Array.from({ length: 4 }, (_, index) => ({
      ...pinnedChunk(),
      index,
      offset: index * 96,
      size: 96,
      path: "chunks/" + index + ".bin",
    })),
  };
  const pending = harness.fetchSection(plan, true, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fetchCount(), 2);
  waits[0].resolve(new Uint8Array(96).fill(2));
  waits[1].resolve(new Uint8Array(96).fill(2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fetchCount(), 4);
  waits[2].resolve(new Uint8Array(96).fill(2));
  waits[3].resolve(new Uint8Array(96).fill(2));
  const result = await pending;
  assert.equal(harness.maxActiveFetches(), 2);
  assert.equal(result.timings.fetch_requests, 4);
  assert.equal(result.timings.cache_misses, 4);
});

test("worker failures carry structured retry authority", () => {
  const harness = workerHarness();
  const retryable = harness.errorPayload("chunk-fetch-network", true);
  assert.deepEqual({ ...retryable }, {
    message: "test failure",
    code: "chunk-fetch-network",
    retryable: true,
    retryAfterMS: 1234,
  });
  const terminal = harness.errorPayload("chunk-integrity", false);
  assert.equal(terminal.code, "chunk-integrity");
  assert.equal(terminal.retryable, false);
});

test("a rejected fetch is a structured retryable network failure", async () => {
  const harness = workerHarness();
  await assert.rejects(
    harness.fetchChunk(pinnedChunk(), false),
    (error) => error?.workerCode === "chunk-fetch-network" && error?.retryable === true,
  );
});

test("progress counter advances only for its current request generation", () => {
  const harness = workerHarness();
  assert.deepEqual(harness.markProgress(41, 42, 3), [41, 0]);
  assert.deepEqual(harness.markProgress(42, 42, 3), [42, 3]);
});
