import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';
import vm from 'node:vm';

import { qualifyWorkerTelemetry } from '../runtime/common.mjs';

const wasm = process.env.MSMWORKER_WASM;
const wasmExec = process.env.WASM_EXEC_JS || path.join(process.env.GOROOT || '', 'lib/wasm/wasm_exec.js');
const pointCount = 128;
const workerCount = 2;
const shardCount = 4;
const pointSize = 96;
const scalarSize = 32;

if (!wasm || !wasmExec) {
  throw new Error('MSMWORKER_WASM and GOROOT or WASM_EXEC_JS are required');
}

async function loadKernel() {
  vm.runInThisContext(readFileSync(wasmExec, 'utf8'));
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiate(readFileSync(wasm), go.importObject);
  go.run(instance);
  while (!globalThis.__msmengineReady) await new Promise((resolve) => setTimeout(resolve, 0));
}

function partition(total, count) {
  const base = Math.floor(total / count);
  const ranges = [];
  let lo = 0;
  for (let index = 0; index < count; index++) {
    const hi = index === count - 1 ? total : lo + base;
    if (hi > lo) ranges.push([lo, hi]);
    lo = hi;
  }
  return ranges;
}

function makeWorker(workerID, points, scalars) {
  const worker = new Worker(new URL('./js-wasm-worker-telemetry-worker.mjs', import.meta.url), {
    workerData: { wasm, wasmExec, workerID, points, scalars, pointSize, scalarSize },
  });
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.type === 'ready') return resolve();
      if (message.type === 'init-error') return reject(new Error(message.error));
      const request = pending.get(message.id);
      if (!request) return reject(new Error(`unexpected worker reply ${message.id}`));
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message);
    });
    worker.once('error', reject);
  });
  return {
    ready,
    terminate: () => worker.terminate(),
    run(id, lo, hi) {
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, lo, hi });
      });
    },
  };
}

function assertRealMemStats(fields) {
  for (const key of [
    'worker_go_heap_alloc_bytes',
    'worker_go_heap_sys_bytes',
    'worker_go_heap_inuse_bytes',
    'worker_go_stack_inuse_bytes',
    'worker_go_stack_sys_bytes',
    'worker_go_sys_bytes',
  ]) {
    assert.equal(typeof fields[key], 'number', `${key} must be numeric`);
    assert.ok(Number.isFinite(fields[key]) && fields[key] > 0, `${key} must be positive`);
  }
  for (const key of ['worker_go_heap_released_bytes', 'worker_go_gc_count']) {
    assert.equal(typeof fields[key], 'number', `${key} must be numeric`);
    assert.ok(Number.isFinite(fields[key]) && fields[key] >= 0, `${key} must be non-negative`);
  }
}

async function main() {
  await loadKernel();
  const vector = globalThis.__msmengineTestRandomG1(pointCount);
  const points = new SharedArrayBuffer(vector.pts.byteLength);
  const scalars = new SharedArrayBuffer(vector.scs.byteLength);
  new Uint8Array(points).set(vector.pts);
  new Uint8Array(scalars).set(vector.scs);
  const reference = new Uint8Array(globalThis.__msmengineShardG1(vector.pts, vector.scs));
  const workers = Array.from({ length: workerCount }, (_, id) => makeWorker(id, points, scalars));
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    const results = await Promise.all(
      partition(pointCount, shardCount).map(([lo, hi], id) => workers[id % workers.length].run(id, lo, hi)),
    );
    for (const result of results) assertRealMemStats(result.timings);
    const telemetry = qualifyWorkerTelemetry({
      events: results.map((result) => ({
        phase: 'measure',
        stage: 'shard',
        fields: {
          operation: 'MSMG1Section',
          worker_id: result.worker_id,
          error: '',
          ...result.timings,
        },
      })),
    }, { expectedWorkerCount: workerCount });
    assert.equal(telemetry.successful_shards, shardCount);
    assert.deepEqual(telemetry.workers.map((worker) => worker.worker_id), [0, 1]);
    assert.deepEqual(telemetry.workers.map((worker) => worker.successful_shards), [2, 2]);
    assert.equal(telemetry.qualification.verified, true);
    const combined = new Uint8Array(globalThis.__msmengineCombineG1(results.map((result) => result.partial)));
    assert.deepEqual(combined, reference);
    console.log(`PASS: real JS/WASM worker telemetry ${JSON.stringify(telemetry)}`);
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
