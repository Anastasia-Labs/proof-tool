import { TodoGateError } from '../runtime/common.mjs';

export const faultCases = Object.freeze([
  {
    id: 'worker-kill',
    capability: 'worker_kill_mid_shard',
    dependency: 'W1 worker dispatch/cancellation fault hook',
    accept(outcome) {
      return outcome.status === 'failed-closed' && outcome.error_class === 'worker-terminated' &&
        outcome.cpu_fallback === false && outcome.cpu_fallback_state === 'none' &&
        !outcome.hung && !outcome.partial_proof;
    },
  },
  {
    id: 'chunk-corruption',
    capability: 'corrupt_pk_chunk',
    dependency: 'fault-serving seam that flips a served PK chunk byte before W7 verify-before-cache insertion',
    accept(outcome) {
      return outcome.status === 'failed-closed' &&
        outcome.error_class === 'chunk-digest-mismatch' &&
        Number.isSafeInteger(outcome.server_hit_count) &&
        outcome.server_hit_count > 0 &&
        outcome.cpu_fallback === false &&
        outcome.cpu_fallback_state === 'none' &&
        !outcome.partial_proof &&
        !outcome.hung;
    },
  },
  {
    id: 'network-abort',
    capability: 'abort_range_fetch',
    dependency: 'fault-serving seam plus retry-count telemetry',
    accept(outcome) {
      return outcome.status === 'failed-closed' &&
        outcome.error_class === 'range-fetch-aborted' &&
        Number.isSafeInteger(outcome.retry_count) &&
        outcome.retry_count > 0 &&
        Number.isSafeInteger(outcome.retry_max) &&
        outcome.retry_max > 0 &&
        outcome.retry_count <= outcome.retry_max &&
        !outcome.hung &&
        !outcome.partial_proof &&
        outcome.cpu_fallback === false &&
        outcome.cpu_fallback_state === 'none';
    },
  },
  {
    id: 'reload-retry',
    capability: 'reload_retry',
    dependency: 'browser page reload and fresh prove seam',
    accept(outcome) {
      return outcome.status === 'recovered' && outcome.proof_stage_started === true && outcome.first_attempt_terminated === true && outcome.fresh_verified === true &&
        Number.isSafeInteger(outcome.requested_worker_count) && outcome.requested_worker_count > 0 && outcome.requested_worker_count <= 16 &&
        outcome.worker_count === outcome.requested_worker_count && persistenceAuditClean(outcome.persistence_audit) && !outcome.hung;
    },
  },
  {
    id: 'memory-pressure',
    capability: 'memory_pressure_profile',
    dependency: '4-core/8-GB limiter plus structured OOM-guidance result hook',
    accept(outcome) {
      const override = outcome.worker_count_override;
      const probe = outcome.worker_count_probe;
      const common = override?.profile === '4-core/8-GB' &&
        Number.isSafeInteger(outcome.worker_count_override?.requested) &&
        outcome.worker_count_override.requested > 0 &&
        outcome.worker_count_override.requested <= 16 &&
        probe?.engine === 'sharded' && probe?.applied === 4 &&
        outcome.cpu_fallback === false && outcome.cpu_fallback_state === 'none' &&
        !outcome.hung && !outcome.partial_proof;
      if (!common) return false;
      if (outcome.status === 'completed') {
        return outcome.within_envelope === true && outcome.verified_locally === true && outcome.worker_count === 4 &&
          override.applied === 4 && override.source === 'proof-trace';
      }
      if (outcome.status === 'failed-closed' && outcome.error_class === 'oom-guidance') {
        return outcome.worker_count === null && override.applied === null && override.source === 'unknown-no-proof';
      }
      return false;
    },
  },
]);

export function selectFaultCases(ids) {
  if (!ids || ids.length === 0 || ids.includes('all')) return [...faultCases];
  return ids.map((id) => {
    const found = faultCases.find((item) => item.id === id);
    if (!found) throw new Error(`unknown fault case ${id}`);
    return found;
  });
}

export function assertFaultCapabilities(cases, capabilities = {}) {
  const supported = new Set(capabilities.faults || []);
  for (const testCase of cases) {
    if (!supported.has(testCase.capability)) {
      throw new TodoGateError(testCase.id, testCase.dependency);
    }
  }
}

export async function runFaultCases(cases, adapter, { deadlineMs = 180_000, workerCount } = {}) {
  if (!adapter || typeof adapter.capabilities !== 'function' || typeof adapter.runFault !== 'function') {
    throw new Error('fault adapter must provide capabilities() and runFault(testCase)');
  }
  const capabilities = await adapter.capabilities();
  assertFaultCapabilities(cases, capabilities);
  if (workerCount !== undefined) assertFaultWorkerCount(capabilities, workerCount);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('deadlineMs must be a positive integer');
  const outcomes = [];
  for (const testCase of cases) {
    const outcome = await runFaultWithDeadline(testCase, adapter, deadlineMs);
    if (!testCase.accept(outcome)) {
      throw new Error(`${testCase.id}: unsafe or unexpected outcome ${JSON.stringify(outcome)}`);
    }
    outcomes.push({ case: testCase.id, ok: true, outcome });
  }
  return { schema: 'wasm-prover-fault-report-v1', ok: true, capabilities, outcomes };
}

export function validateFaultWorkerCount(workerCount) {
  if (!Number.isSafeInteger(workerCount) || workerCount <= 0 || workerCount > 16) {
    throw new Error('workers must be a positive integer no greater than 16');
  }
  return workerCount;
}

export function assertFaultWorkerCount(capabilities, workerCount) {
  validateFaultWorkerCount(workerCount);
  const support = capabilities?.worker_count;
  if (support?.explicit !== true || !Number.isSafeInteger(support.max) || support.max < workerCount) {
    throw new TodoGateError('fault-worker-count', `runtime explicit worker_count capability through ${workerCount}`);
  }
  if (capabilities.applied_worker_count !== workerCount) {
    throw new Error(`fault engine probe applied worker_count=${capabilities.applied_worker_count}, want ${workerCount}`);
  }
}

export function persistenceAuditClean(audit) {
  if (audit?.schema !== 'wasm-prover-persistence-audit-v1' || audit.complete !== true) return false;
  const required = [
    'local_storage',
    'session_storage',
    'indexed_db',
    'cache_storage',
    'cookies',
    'history_state',
    'window_name',
    'opfs',
  ];
  for (const name of required) {
    const source = audit.sources?.[name];
    if (!source || !Array.isArray(source.marker_hits) || source.marker_hits.length !== 0) return false;
    if (source.supported === false) {
      if (typeof source.unavailable_reason !== 'string' || source.unavailable_reason.length === 0) return false;
    } else if (source.inspected !== true) {
      return false;
    } else if (
      !/^sha256:[0-9a-f]{64}$/i.test(source.inventory_sha256 || '') ||
      !/^sha256:[0-9a-f]{64}$/i.test(source.baseline_inventory_sha256 || '') ||
      !Number.isSafeInteger(source.entries) || source.entries < 0 ||
      !Number.isSafeInteger(source.baseline_entries) || source.baseline_entries < 0 ||
      source.inventory_unchanged !== true ||
      source.entries_unchanged !== true
    ) {
      return false;
    }
  }
  const cookies = audit.sources.cookies;
  if (
    !/^sha256:[0-9a-f]{64}$/i.test(cookies.context_inventory_sha256 || '') ||
    !/^sha256:[0-9a-f]{64}$/i.test(cookies.baseline_context_inventory_sha256 || '') ||
    !Number.isSafeInteger(cookies.browser_context_cookie_count) ||
    !Number.isSafeInteger(cookies.baseline_browser_context_cookie_count) ||
    cookies.context_inventory_unchanged !== true ||
    cookies.context_entries_unchanged !== true
  ) {
    return false;
  }
  return true;
}

async function runFaultWithDeadline(testCase, adapter, deadlineMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${testCase.id}: external deadline ${deadlineMs}ms exceeded; abort requested; hung=true`));
      try {
        const cleanup = Promise.resolve(adapter.abortFault?.(testCase)).catch(() => {});
        const cleanupLimit = new Promise((resolve) => setTimeout(resolve, Math.min(5_000, deadlineMs)));
        void Promise.race([cleanup, cleanupLimit]);
      } catch {
        // The deadline result must not depend on cleanup succeeding.
      }
    }, deadlineMs);
  });
  try {
    return await Promise.race([adapter.runFault(testCase), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
