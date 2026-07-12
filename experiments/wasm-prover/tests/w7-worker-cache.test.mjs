import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const workerSource = await readFile(
  new URL("../web/worker.js", import.meta.url),
  "utf8",
);
const legacyWorkerSource = await readFile(
  new URL("./fixtures/legacy-worker-no-w7.js", import.meta.url),
  "utf8",
);

function workerHarness(source = workerSource) {
  const queued = [];
  let fetchCount = 0;
  let tick = 0;
  const context = vm.createContext({
    URL,
    Uint8Array,
    WebAssembly: {},
    importScripts() {},
    performance: { now: () => ++tick },
    setTimeout,
    self: {
      __msmengineVerifyChunkBytes(raw) {
        if (raw[0] === 0) return "chunk sha256 mismatch";
        if (raw[0] === 1) return "chunk blake2b256 mismatch";
        return "";
      },
    },
    async fetch() {
      fetchCount++;
      const bytes = queued.shift();
      if (!bytes) throw new Error("unexpected fetch");
      const copy = Uint8Array.from(bytes);
      return {
        status: 200,
        headers: { get: () => "identity" },
        async arrayBuffer() {
          return copy.buffer;
        },
      };
    },
  });
  vm.runInContext(source, context, { filename: "worker.js" });
  return {
    context,
    queue(bytes) {
      queued.push(bytes);
    },
    fetchCount: () => fetchCount,
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
    fetchSection: (plan, enabled = true) => {
      context.testPlan = plan;
      context.testEnabled = enabled;
      return vm.runInContext(
        'fetchSectionPointBytes(testPlan, "A", 0, 2, false, testEnabled)',
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
  assert.equal(harness.fetchCount(), 1);
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
