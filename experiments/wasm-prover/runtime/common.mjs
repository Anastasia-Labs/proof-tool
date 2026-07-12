export class TodoGateError extends Error {
  constructor(gate, dependency, detail = '') {
    super(`TODO_UNSUPPORTED ${gate}: requires ${dependency}${detail ? ` (${detail})` : ''}`);
    this.name = 'TodoGateError';
    this.code = 'TODO_UNSUPPORTED';
    this.gate = gate;
    this.dependency = dependency;
  }
}

export function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableObject(item)]),
  );
}

export function equalJSON(left, right) {
  return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right));
}

export function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export const requiredWorkerGoTelemetryFields = Object.freeze([
  'worker_go_heap_alloc_bytes',
  'worker_go_heap_sys_bytes',
  'worker_go_heap_inuse_bytes',
  'worker_go_heap_released_bytes',
  'worker_go_stack_inuse_bytes',
  'worker_go_stack_sys_bytes',
  'worker_go_sys_bytes',
  'worker_go_gc_count',
]);

export const workerTelemetryFields = Object.freeze([
  ...requiredWorkerGoTelemetryFields,
  'worker_js_heap_used_bytes',
  'worker_w7_verified_cache_bytes',
]);

const sectionShardOperations = new Set(['MSMG1Section', 'MSMG2Section']);

// Fail closed before a guarded benchmark can qualify stale or partially staged
// Worker assets. Every successful section shard must carry the worker-local Go
// runtime snapshot, and the samples must cover exactly the workers selected by
// the engine. Browser JS heap reporting remains optional. W7 cache residency is
// mandatory only when the runtime acknowledged W7 as enabled.
export function qualifyWorkerTelemetry(
  trace,
  { expectedWorkerCount, requireW7Cache = false } = {},
) {
  if (!Number.isSafeInteger(expectedWorkerCount) || expectedWorkerCount <= 0) {
    throw new Error('worker telemetry expectedWorkerCount must be a positive safe integer');
  }
  const requiredFields = requireW7Cache
    ? [...requiredWorkerGoTelemetryFields, 'worker_w7_verified_cache_bytes']
    : requiredWorkerGoTelemetryFields;
  const observedWorkers = new Set();
  let successfulSectionShards = 0;
  for (const event of trace?.events || []) {
    if (event?.phase !== 'measure' || event?.stage !== 'shard') continue;
    const fields = event.fields;
    if (!fields || !sectionShardOperations.has(fields.operation)) continue;
    if (typeof fields.error === 'string' && fields.error.length > 0) continue;
    const workerID = fields.worker_id;
    if (
      !Number.isSafeInteger(workerID) ||
      workerID < 0 ||
      workerID >= expectedWorkerCount
    ) {
      throw new Error(
        `worker telemetry observed unexpected worker_id=${String(workerID)}, want 0..${expectedWorkerCount - 1}`,
      );
    }
    for (const key of requiredFields) {
      const value = fields[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(
          `worker telemetry worker_id=${workerID} operation=${fields.operation} missing valid ${key}`,
        );
      }
    }
    observedWorkers.add(workerID);
    successfulSectionShards++;
  }
  const missingWorkers = [];
  for (let workerID = 0; workerID < expectedWorkerCount; workerID++) {
    if (!observedWorkers.has(workerID)) missingWorkers.push(workerID);
  }
  if (missingWorkers.length > 0) {
    throw new Error(
      `worker telemetry missing successful section-shard samples for worker_id=${missingWorkers.join(',')}`,
    );
  }
  return {
    ...aggregateWorkerTelemetry(trace),
    qualification: {
      verified: true,
      expected_worker_count: expectedWorkerCount,
      successful_section_shards: successfulSectionShards,
      required_fields: [...requiredFields],
    },
  };
}

// Aggregate successful shard samples independently per worker. Optional fields
// remain absent when no worker reported them; in particular, unavailable JS
// heap telemetry must not become a false zero in a W4 matrix comparison.
export function aggregateWorkerTelemetry(trace) {
  const workers = new Map();
  let successfulShards = 0;
  for (const event of trace?.events || []) {
    if (event?.phase !== 'measure' || event?.stage !== 'shard') continue;
    const fields = event.fields;
    if (!fields || (typeof fields.error === 'string' && fields.error.length > 0)) continue;
    const workerID = fields.worker_id;
    if (!Number.isSafeInteger(workerID) || workerID < 0) continue;
    let worker = workers.get(workerID);
    if (!worker) {
      worker = { worker_id: workerID, successful_shards: 0, maxima: {} };
      workers.set(workerID, worker);
    }
    worker.successful_shards++;
    successfulShards++;
    for (const key of workerTelemetryFields) {
      const value = fields[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
      if (!(key in worker.maxima) || value > worker.maxima[key]) {
        worker.maxima[key] = value;
      }
    }
  }
  const perWorker = [...workers.values()].sort((left, right) => left.worker_id - right.worker_id);
  const maxima = {};
  for (const worker of perWorker) {
    for (const [key, value] of Object.entries(worker.maxima)) {
      if (!(key in maxima) || value > maxima[key]) maxima[key] = value;
    }
  }
  return {
    schema: 'wasm-worker-telemetry-v1',
    successful_shards: successfulShards,
    workers: perWorker,
    maxima,
  };
}
