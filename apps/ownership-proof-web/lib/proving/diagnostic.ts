import type { ProverPreflightResult, ProverProveResult } from "./types";

type RawTraceEvent = {
  phase?: unknown;
  stage?: unknown;
  at_ms?: unknown;
  fields?: unknown;
};

type RawProofTrace = {
  worker_count?: unknown;
  shard_count?: unknown;
  range_fetch_concurrency?: unknown;
  chunk_prefetch_window?: unknown;
  events?: unknown;
};

export type BrowserCalibrationSummary = {
  attemptedWorkerCounts: number[];
  appliedWorkerCount: number;
  durationMs: number;
  reason: string;
};

export type BrowserDiagnosticHostSignals = {
  hardwareConcurrency: number | null;
  deviceMemoryGiB: number | null;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  wasmStreaming: boolean;
  online: boolean | null;
  calibration: BrowserCalibrationSummary | null;
};

export type BrowserProvingDiagnostic = {
  schema: "browser-proving-diagnostic-v1";
  generated_at: string;
  lifecycle: {
    initialization_ms: number;
    preflight_ms: number;
    prepared_session_reused: boolean;
    prepared_session_age_ms: number;
    proof_count: number;
    proof_wall_ms: number;
  };
  ccs: {
    fetch_ms: number;
    decode_ms: number;
    hash_ms: number;
    bytes_fetched: number;
    browser_prefetch_ms: number;
    browser_prefetch_bytes: number;
  };
  applied: {
    worker_count: number;
    shard_count: number;
    range_fetch_concurrency: number;
    chunk_prefetch_window: number;
  };
  workers: Array<{
    worker_id: number;
    requests: number;
    cache_hits: number;
    cache_misses: number;
    bytes_fetched: number;
    bytes_from_cache: number;
    bytes_used: number;
    fetch_ms: number;
    hash_ms: number;
    decode_ms: number;
    kernel_ms: number;
    queue_ms: number;
  }>;
  pk: {
    requests: number;
    cache_hits: number;
    cache_misses: number;
    bytes_fetched: number;
    bytes_from_cache: number;
    bytes_used: number;
  };
  stages: {
    solve_ms: number;
    compute_h_fft_ms: number;
    verification_ms: number;
  };
  page: {
    visibility: Array<{ at_ms: number; state: string }>;
  };
  host: BrowserDiagnosticHostSignals;
};

const FORBIDDEN_DIAGNOSTIC_TEXT =
  /(?:recovery[ _-]?phrase|mnemonic|seed[ _-]?words?|xprv|master[ _-]?key|scalar|credential[ _-]?path|request[ _-]?json|target[ _-]?credential|destination[ _-]?address|proof[ _-]?request)/iu;

let lastDiagnostic: BrowserProvingDiagnostic | null = null;

export class BrowserProvingDiagnosticCollector {
  private readonly startedAt = now();
  private readonly host: BrowserDiagnosticHostSignals;
  private readonly visibility: Array<{ at_ms: number; state: string }> = [];
  private initializationMS = 0;
  private preflightMS = 0;
  private preflight: ProverPreflightResult | null = null;
  private preparedSessionReused = false;
  private preparedSessionAgeMS = 0;
  private readonly results: ProverProveResult[] = [];
  private stopped = false;
  private readonly onVisibilityChange = () => this.captureVisibility();

  constructor(host: BrowserDiagnosticHostSignals) {
    this.host = host;
    this.captureVisibility();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  recordInitialization(durationMS: number): void {
    this.initializationMS = finite(durationMS);
  }

  recordPreflight(durationMS: number, result: ProverPreflightResult): void {
    this.preflightMS = finite(durationMS);
    this.preflight = result;
  }

  recordPreparedSessionReuse(ageMS: number): void {
    this.preparedSessionReused = true;
    this.preparedSessionAgeMS = finite(ageMS);
  }

  addProof(result: ProverProveResult): void {
    this.results.push(result);
  }

  finish(): BrowserProvingDiagnostic {
    if (!this.stopped && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.stopped = true;
    const diagnostic = buildDiagnostic({
      initializationMS: this.initializationMS,
      preflightMS: this.preflightMS,
      preflight: this.preflight,
      preparedSessionReused: this.preparedSessionReused,
      preparedSessionAgeMS: this.preparedSessionAgeMS,
      results: this.results,
      visibility: this.visibility,
      host: this.host,
    });
    assertDiagnosticIsRedacted(diagnostic);
    lastDiagnostic = diagnostic;
    return diagnostic;
  }

  private captureVisibility(): void {
    const state =
      typeof document === "undefined" || typeof document.visibilityState !== "string"
        ? "unavailable"
        : document.visibilityState;
    const sample = { at_ms: Math.round(now() - this.startedAt), state };
    if (this.visibility.at(-1)?.state !== state) {
      this.visibility.push(sample);
    }
  }
}

export function browserDiagnosticHostSignals(
  calibration: BrowserCalibrationSummary | null,
): BrowserDiagnosticHostSignals {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const deviceMemory = (nav as (Navigator & { deviceMemory?: number }) | null)?.deviceMemory;
  return {
    hardwareConcurrency: nav && Number.isFinite(nav.hardwareConcurrency) ? Math.floor(nav.hardwareConcurrency) : null,
    deviceMemoryGiB: typeof deviceMemory === "number" && Number.isFinite(deviceMemory) ? deviceMemory : null,
    crossOriginIsolated: typeof globalThis.crossOriginIsolated === "boolean" && globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    wasmStreaming: typeof WebAssembly !== "undefined" && typeof WebAssembly.instantiateStreaming === "function",
    online: nav && typeof nav.onLine === "boolean" ? nav.onLine : null,
    calibration,
  };
}

export function hasBrowserProvingDiagnostic(): boolean {
  return lastDiagnostic !== null;
}

export function getLastBrowserProvingDiagnostic(): BrowserProvingDiagnostic | null {
  return lastDiagnostic ? structuredClone(lastDiagnostic) : null;
}

export function downloadLastBrowserProvingDiagnostic(): boolean {
  if (!lastDiagnostic || typeof document === "undefined") {
    return false;
  }
  assertDiagnosticIsRedacted(lastDiagnostic);
  const blob = new Blob([`${JSON.stringify(lastDiagnostic, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `browser-proving-diagnostic-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

export function clearBrowserProvingDiagnosticForTest(): void {
  lastDiagnostic = null;
}

function buildDiagnostic(input: {
  initializationMS: number;
  preflightMS: number;
  preflight: ProverPreflightResult | null;
  preparedSessionReused: boolean;
  preparedSessionAgeMS: number;
  results: ProverProveResult[];
  visibility: Array<{ at_ms: number; state: string }>;
  host: BrowserDiagnosticHostSignals;
}): BrowserProvingDiagnostic {
  const workers = new Map<number, BrowserProvingDiagnostic["workers"][number]>();
  let solveMS = 0;
  let computeHMS = 0;
  let verificationMS = 0;
  let proofWallMS = 0;
  let applied = appliedTuning(input.preflight?.applied_tuning);

  for (const result of input.results) {
    proofWallMS += finite(result.wall_seconds) * 1000;
    const trace = asTrace(result.trace);
    applied = mergeApplied(applied, {
      worker_count: numberField(trace, "worker_count"),
      shard_count: numberField(trace, "shard_count"),
      range_fetch_concurrency: numberField(trace, "range_fetch_concurrency"),
      chunk_prefetch_window: numberField(trace, "chunk_prefetch_window"),
    });
    const events = traceEvents(trace);
    solveMS += stageDuration(events, "solver");
    computeHMS += stageDuration(events, "computeH / FFT");
    verificationMS += stageDuration(events, "verify");
    for (const event of events) {
      if (event.stage !== "shard") {
        continue;
      }
      const fields = record(event.fields);
      const workerID = integer(fields.worker_id);
      if (workerID === null || workerID < 0) {
        continue;
      }
      const worker = workers.get(workerID) ?? {
        worker_id: workerID,
        requests: 0,
        cache_hits: 0,
        cache_misses: 0,
        bytes_fetched: 0,
        bytes_from_cache: 0,
        bytes_used: 0,
        fetch_ms: 0,
        hash_ms: 0,
        decode_ms: 0,
        kernel_ms: 0,
        queue_ms: 0,
      };
      worker.requests += finite(fields.fetch_requests);
      worker.cache_hits += finite(fields.cache_hits);
      worker.cache_misses += finite(fields.cache_misses);
      worker.bytes_fetched += finite(fields.range_bytes_fetched);
      worker.bytes_from_cache += finite(fields.range_bytes_cache_hit);
      worker.bytes_used += finite(fields.range_bytes_used);
      worker.fetch_ms += finite(fields.fetch_ms);
      worker.hash_ms += finite(fields.hash_ms);
      worker.decode_ms += finite(fields.decode_ms);
      worker.kernel_ms +=
        typeof fields.kernel_ms === "number" ? finite(fields.kernel_ms) : finite(fields.worker_compute_ms);
      worker.queue_ms += finite(fields.queue_wait_ms);
      workers.set(workerID, worker);
    }
  }

  const workerRows = [...workers.values()].sort((left, right) => left.worker_id - right.worker_id).map(roundWorker);
  const pk = workerRows.reduce(
    (total, worker) => ({
      requests: total.requests + worker.requests,
      cache_hits: total.cache_hits + worker.cache_hits,
      cache_misses: total.cache_misses + worker.cache_misses,
      bytes_fetched: total.bytes_fetched + worker.bytes_fetched,
      bytes_from_cache: total.bytes_from_cache + worker.bytes_from_cache,
      bytes_used: total.bytes_used + worker.bytes_used,
    }),
    {
      requests: 0,
      cache_hits: 0,
      cache_misses: 0,
      bytes_fetched: 0,
      bytes_from_cache: 0,
      bytes_used: 0,
    },
  );
  const timings = input.preflight?.timings;
  return {
    schema: "browser-proving-diagnostic-v1",
    generated_at: new Date().toISOString(),
    lifecycle: {
      initialization_ms: round(input.initializationMS),
      preflight_ms: round(input.preflightMS),
      prepared_session_reused: input.preparedSessionReused,
      prepared_session_age_ms: round(input.preparedSessionAgeMS),
      proof_count: input.results.length,
      proof_wall_ms: round(proofWallMS),
    },
    ccs: {
      fetch_ms: round(finite(timings?.ccs_fetch_ms)),
      decode_ms: round(finite(timings?.ccs_decode_ms)),
      hash_ms: round(finite(timings?.ccs_hash_ms)),
      bytes_fetched: Math.round(finite(timings?.ccs_bytes_fetched)),
      browser_prefetch_ms: round(finite(timings?.ccs_browser_prefetch_ms)),
      browser_prefetch_bytes: Math.round(finite(timings?.ccs_browser_prefetch_bytes)),
    },
    applied,
    workers: workerRows,
    pk,
    stages: {
      solve_ms: round(solveMS),
      compute_h_fft_ms: round(computeHMS),
      verification_ms: round(verificationMS),
    },
    page: { visibility: input.visibility.map((entry) => ({ ...entry })) },
    host: structuredClone(input.host),
  };
}

function assertDiagnosticIsRedacted(diagnostic: BrowserProvingDiagnostic): void {
  const encoded = JSON.stringify(diagnostic);
  if (FORBIDDEN_DIAGNOSTIC_TEXT.test(encoded)) {
    throw new Error("The browser diagnostic failed its redaction gate.");
  }
}

function appliedTuning(value: unknown): BrowserProvingDiagnostic["applied"] {
  const fields = record(value);
  return {
    worker_count: Math.round(finite(fields.worker_count)),
    shard_count: Math.round(finite(fields.shard_count)),
    range_fetch_concurrency: Math.round(finite(fields.range_fetch_concurrency)),
    chunk_prefetch_window: Math.round(finite(fields.chunk_prefetch_window)),
  };
}

function mergeApplied(
  left: BrowserProvingDiagnostic["applied"],
  right: BrowserProvingDiagnostic["applied"],
): BrowserProvingDiagnostic["applied"] {
  return {
    worker_count: right.worker_count || left.worker_count,
    shard_count: right.shard_count || left.shard_count,
    range_fetch_concurrency: right.range_fetch_concurrency || left.range_fetch_concurrency,
    chunk_prefetch_window: right.chunk_prefetch_window || left.chunk_prefetch_window,
  };
}

function traceEvents(trace: RawProofTrace): Array<{
  phase: string;
  stage: string;
  atMS: number;
  fields: unknown;
}> {
  if (!Array.isArray(trace.events)) {
    return [];
  }
  return trace.events.flatMap((value) => {
    const event = record(value) as RawTraceEvent;
    if (typeof event.phase !== "string" || typeof event.stage !== "string") {
      return [];
    }
    return [
      {
        phase: event.phase,
        stage: event.stage,
        atMS: finite(event.at_ms),
        fields: event.fields,
      },
    ];
  });
}

function stageDuration(events: ReturnType<typeof traceEvents>, stage: string): number {
  const starts: number[] = [];
  let total = 0;
  for (const event of events) {
    if (event.stage !== stage) {
      continue;
    }
    if (event.phase === "start") {
      starts.push(event.atMS);
    } else if (event.phase === "end") {
      const started = starts.pop();
      if (started !== undefined && event.atMS >= started) {
        total += event.atMS - started;
      }
    }
  }
  return total;
}

function roundWorker(worker: BrowserProvingDiagnostic["workers"][number]): BrowserProvingDiagnostic["workers"][number] {
  return {
    ...worker,
    requests: Math.round(worker.requests),
    cache_hits: Math.round(worker.cache_hits),
    cache_misses: Math.round(worker.cache_misses),
    bytes_fetched: Math.round(worker.bytes_fetched),
    bytes_from_cache: Math.round(worker.bytes_from_cache),
    bytes_used: Math.round(worker.bytes_used),
    fetch_ms: round(worker.fetch_ms),
    hash_ms: round(worker.hash_ms),
    decode_ms: round(worker.decode_ms),
    kernel_ms: round(worker.kernel_ms),
    queue_ms: round(worker.queue_ms),
  };
}

function asTrace(value: unknown): RawProofTrace {
  return record(value) as RawProofTrace;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberField(value: unknown, key: string): number {
  return Math.round(finite(record(value)[key]));
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
