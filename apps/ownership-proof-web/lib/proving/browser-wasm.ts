import type {
  BrowserProvingDescriptor,
  BrowserProvingTuning,
} from "../reclaim/types";
import type { ClaimProofRequest } from "../claim/types";
import {
  calibrateBrowserWorkerCapacity,
  checkBrowserProvingCapability,
} from "./capability";
import {
  BrowserProvingDiagnosticCollector,
  browserDiagnosticHostSignals,
} from "./diagnostic";
import type {
  BrowserProvingCheckResult,
  DestinationProofResponse,
  GenerateDestinationProofsInput,
  ProverPreflightResult,
  ProverProveResult,
  ProverWorkerLike,
  ProverWorkerRequest,
  ProverWorkerResponse,
} from "./types";

type ProverWorkerRequestBody = ProverWorkerRequest extends infer T
  ? T extends ProverWorkerRequest
    ? Omit<T, "id">
    : never
  : never;

// Init now downloads and compiles both proof-destination.wasm (~24.5 MB) and
// msmworker.wasm (~12 MB) before the worker acks ready, so the budget covers
// ~36.4 MB on a ~300 KB/s link rather than cutting off users the 60s budget
// served before the msm compile moved into init.
export const PROVER_WORKER_INIT_TIMEOUT_MS = 120_000;
export const PROVER_PREFLIGHT_TIMEOUT_MS = 300_000;
export const PREPARED_PROVER_TIMEOUT_MS = 180_000;

// Gate G1 defaults. Deployments may still pin explicit values; host adaptation
// occurs only when the descriptor explicitly opts into W5 and omits
// worker_count, which preserves the worker-8 floor for older descriptors.
const DEFAULT_TUNING: Required<Omit<BrowserProvingTuning, "shard_multiplier">> =
  {
    worker_count: 8,
    shard_count: 8,
    range_fetch_concurrency: 2,
    chunk_prefetch_window: 2,
    pinned_decode: true,
    opt_w1: true,
    opt_w2: true,
    opt_w3: true,
    opt_w5: true,
    opt_w6: true,
    opt_w7: true,
    // gogc=15/3200MiB measured faster than 50/3000MiB across cold/warm and
    // 8/16-worker cases (output/gogc50-comparison vs remote-browser-matrix-v2-opt-r1):
    // on the single-threaded main instance, small frequent GC cycles beat
    // large deferred ones, and the higher limit adds headroom against GC thrash.
    gogc: 15,
    gomemlimit: "3200MiB",
  };

export class ProvingCancelledError extends Error {
  constructor() {
    super("Proof generation was cancelled.");
    this.name = "ProvingCancelledError";
  }
}

export type BrowserWasmOptions = {
  // Test seam; production uses the classic worker at /proof-runtime/prover-worker.js.
  createWorker?: () => ProverWorkerLike;
};

function defaultCreateProverWorker(): ProverWorkerLike {
  return new Worker(
    "/proof-runtime/prover-worker.js",
  ) as unknown as ProverWorkerLike;
}

type PreparedProverSession = {
  publicKey: string;
  client: ProverWorkerClient;
  collector: BrowserProvingDiagnosticCollector;
  preflight: ProverPreflightResult;
  workerCount: number;
  createdAt: number;
  expiry: ReturnType<typeof setTimeout>;
};

let preparedSession: PreparedProverSession | null = null;

// Concurrent preparations must share one in-flight promise: a second worker
// prepared in parallel would be orphaned when the later `preparedSession`
// assignment wins, leaking the Go runtime and its nested MSM pool.
let preparingSession: {
  publicKey: string;
  promise: Promise<PreparedProverSession>;
} | null = null;

// Full readiness performs the signed asset preflight exactly once. The
// validated worker, CCS, and nested MSM pool remain available until proving,
// explicit disposal, or the short expiry below.
export async function checkBrowserProving(
  descriptor: BrowserProvingDescriptor | null | undefined,
  expectedVkHash: string,
  options: BrowserWasmOptions = {},
): Promise<BrowserProvingCheckResult> {
  const capability = await checkBrowserProvingCapability(descriptor);
  if (!capability.ok || !descriptor) {
    return { status: "unsupported", capability, preflight: null };
  }

  try {
    const session = await prepareProverSession(
      descriptor,
      expectedVkHash,
      options,
    );
    return { status: "ready", capability, preflight: session.preflight };
  } catch (error) {
    const message = sanitizeProverError(error);
    capability.failures.push({
      check: message.includes("do not match this deployment")
        ? "vk-hash"
        : "asset-preflight",
      message,
    });
    return {
      status: "asset-error",
      capability: { ...capability, ok: false },
      preflight: null,
    };
  }
}

// Sequential per-request proving uses the prepared worker. The Go runtime
// consumes the prepared CCS on the first proof and retains the verified asset
// reader plus nested pool for later distinct statements in this claim flow.
export async function proveDestinationInBrowser(
  input: GenerateDestinationProofsInput,
  options: BrowserWasmOptions = {},
): Promise<DestinationProofResponse> {
  const descriptor = input.browserProving;
  if (!descriptor || !descriptor.enabled) {
    throw new Error("Browser proving is not enabled for this deployment.");
  }
  if (input.signal?.aborted) {
    throw new ProvingCancelledError();
  }
  const total = input.draft.proofRequests.length;
  // Preparation (calibration + init + preflight) can take minutes on slow
  // links; racing it against the abort signal keeps Cancel responsive. An
  // abandoned preparation completes in the background and parks itself as the
  // prepared session, where the expiry timer reclaims it.
  const session = await raceSessionWithAbort(
    takeOrPrepareProverSession(descriptor, input.expectedVkHash, options),
    input.signal,
  );
  const client = session.client;
  let masterXPrvHex: string | null = null;
  const onAbort = () => client.terminate(new ProvingCancelledError());
  try {
    if (input.signal?.aborted) {
      throw new ProvingCancelledError();
    }
    input.signal?.addEventListener("abort", onAbort);

    masterXPrvHex = bytesToHex(input.masterXPrv);
    const artifacts: Array<{
      out_ref: string;
      artifact: Record<string, unknown>;
    }> = [];
    const artifactByStatement = new Map<string, Record<string, unknown>>();
    for (const [index, request] of input.draft.proofRequests.entries()) {
      if (input.signal?.aborted) {
        throw new ProvingCancelledError();
      }
      const statementKey = proofRequestStatementKey(request);
      const reusedArtifact = artifactByStatement.get(statementKey);
      if (reusedArtifact) {
        artifacts.push({ out_ref: request.out_ref, artifact: reusedArtifact });
        input.onProgress?.({
          provider: "browser-wasm",
          stage: "reuse-proof",
          frac: 1,
          current: index + 1,
          total,
          engine: "streampk-sharded-groth16",
        });
        continue;
      }
      const result = await client.prove(
        buildProveRequestJson(
          descriptor,
          session.workerCount,
          masterXPrvHex,
          request,
        ),
        (stage, frac) => {
          input.onProgress?.({
            provider: "browser-wasm",
            stage: stage ?? "prove",
            frac,
            current: index + 1,
            total,
            engine: "streampk-sharded-groth16",
          });
        },
      );
      session.collector.addProof(result);
      if (result.verified_locally !== true) {
        throw new Error(
          "The browser prover could not verify a generated proof locally.",
        );
      }
      if (!result.artifact || typeof result.artifact !== "object") {
        throw new Error(
          "The browser prover returned a malformed proof artifact.",
        );
      }
      artifactByStatement.set(statementKey, result.artifact);
      artifacts.push({ out_ref: request.out_ref, artifact: result.artifact });
    }

    return {
      profile: input.draft.proofProfile,
      artifacts,
    };
  } catch (error) {
    if (error instanceof ProvingCancelledError) {
      throw error;
    }
    throw new Error(sanitizeProverError(error));
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    masterXPrvHex = null;
    session.collector.finish();
    client.terminate();
    if (preparedSession === session) preparedSession = null;
  }
}

export function disposePreparedBrowserProvingSession(): void {
  const session = preparedSession;
  preparedSession = null;
  if (!session) return;
  clearTimeout(session.expiry);
  session.collector.finish();
  session.client.terminate();
}

async function takeOrPrepareProverSession(
  descriptor: BrowserProvingDescriptor,
  expectedVkHash: string,
  options: BrowserWasmOptions,
): Promise<PreparedProverSession> {
  const publicKey = preparedSessionPublicKey(descriptor, expectedVkHash);
  if (preparedSession?.publicKey === publicKey) {
    clearTimeout(preparedSession.expiry);
    preparedSession.collector.recordPreparedSessionReuse(
      nowMS() - preparedSession.createdAt,
    );
    return preparedSession;
  }
  const session = await prepareProverSession(
    descriptor,
    expectedVkHash,
    options,
  );
  clearTimeout(session.expiry);
  return session;
}

// Settles a session-preparation promise the caller no longer wants (the user
// aborted while it was in flight). The finished session stays parked for
// reuse under its expiry timer; anything else is torn down immediately.
function reparkAbandonedSession(
  preparation: Promise<PreparedProverSession>,
): void {
  void preparation.then(
    (session) => {
      if (preparedSession === session) {
        resetPreparedSessionExpiry(session);
      } else {
        session.collector.finish();
        session.client.terminate();
      }
    },
    () => undefined,
  );
}

async function raceSessionWithAbort(
  preparation: Promise<PreparedProverSession>,
  signal: AbortSignal | null | undefined,
): Promise<PreparedProverSession> {
  if (!signal) {
    return preparation;
  }
  if (signal.aborted) {
    reparkAbandonedSession(preparation);
    throw new ProvingCancelledError();
  }
  let onAbort: (() => void) | null = null;
  try {
    return await new Promise<PreparedProverSession>((resolve, reject) => {
      onAbort = () => {
        reparkAbandonedSession(preparation);
        reject(new ProvingCancelledError());
      };
      signal.addEventListener("abort", onAbort);
      preparation.then(resolve, reject);
    });
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function prepareProverSession(
  descriptor: BrowserProvingDescriptor,
  expectedVkHash: string,
  options: BrowserWasmOptions,
): Promise<PreparedProverSession> {
  const publicKey = preparedSessionPublicKey(descriptor, expectedVkHash);
  if (preparedSession?.publicKey === publicKey) {
    resetPreparedSessionExpiry(preparedSession);
    return preparedSession;
  }
  if (preparingSession?.publicKey === publicKey) {
    return preparingSession.promise;
  }
  if (preparingSession) {
    // A preparation for a different deployment is in flight; let it settle so
    // the preparedSession overwrite below cannot orphan its worker.
    await preparingSession.promise.catch(() => undefined);
    if (preparedSession?.publicKey === publicKey) {
      resetPreparedSessionExpiry(preparedSession);
      return preparedSession;
    }
  }
  const inFlight = {
    publicKey,
    promise: createProverSession(publicKey, descriptor, expectedVkHash, options),
  };
  preparingSession = inFlight;
  try {
    return await inFlight.promise;
  } finally {
    if (preparingSession === inFlight) {
      preparingSession = null;
    }
  }
}

async function createProverSession(
  publicKey: string,
  descriptor: BrowserProvingDescriptor,
  expectedVkHash: string,
  options: BrowserWasmOptions,
): Promise<PreparedProverSession> {
  disposePreparedBrowserProvingSession();

  const calibration = options.createWorker
    ? {
        attemptedWorkerCounts: [],
        appliedWorkerCount: resolveBrowserWorkerCount(descriptor),
        durationMs: 0,
        reason: "injected-worker-test-seam",
      }
    : await calibrateBrowserWorkerCapacity(descriptor);
  const workerCount = calibration.appliedWorkerCount;
  const collector = new BrowserProvingDiagnosticCollector(
    browserDiagnosticHostSignals(calibration),
  );
  const client = new ProverWorkerClient(
    options.createWorker ?? defaultCreateProverWorker,
  );
  try {
    const initializationStarted = nowMS();
    const ccsPrefetch = options.createWorker
      ? Promise.resolve({ durationMS: 0, bytes: 0 })
      : prefetchPublicCCS(descriptor.ccs_url);
    await client.init(descriptor);
    collector.recordInitialization(nowMS() - initializationStarted);
    const prefetched = await ccsPrefetch;

    const preflightStarted = nowMS();
    const preflight = await client.preflight(
      buildPreflightRequestJson(descriptor, workerCount),
    );
    preflight.timings = {
      ...preflight.timings,
      ccs_browser_prefetch_ms: prefetched.durationMS,
      ccs_browser_prefetch_bytes: prefetched.bytes,
    };
    collector.recordPreflight(nowMS() - preflightStarted, preflight);
    if (preflight.ok !== true) {
      throw new Error("Proof assets failed verification.");
    }
    if (preflight.vk_hash !== expectedVkHash) {
      throw new Error(
        "Proof assets do not match this deployment's verifier key.",
      );
    }
    const session: PreparedProverSession = {
      publicKey,
      client,
      collector,
      preflight,
      workerCount,
      createdAt: nowMS(),
      expiry: setTimeout(() => undefined, PREPARED_PROVER_TIMEOUT_MS),
    };
    resetPreparedSessionExpiry(session);
    preparedSession = session;
    return session;
  } catch (error) {
    collector.finish();
    client.terminate();
    throw error;
  }
}

function resetPreparedSessionExpiry(session: PreparedProverSession): void {
  clearTimeout(session.expiry);
  session.expiry = setTimeout(() => {
    if (preparedSession === session) {
      disposePreparedBrowserProvingSession();
    }
  }, PREPARED_PROVER_TIMEOUT_MS);
}

function preparedSessionPublicKey(
  descriptor: BrowserProvingDescriptor,
  expectedVkHash: string,
): string {
  return JSON.stringify({
    artifacts: buildArtifactsBlock(descriptor),
    tuning: descriptor.tuning ?? null,
    expectedVkHash,
  });
}

// Cache-warming only: the worker preflight re-reads the CCS through the HTTP
// cache. The prefetch is bounded so a stalled connection can never wedge the
// readiness check — on timeout the abort rejects any pending read and the
// preparation proceeds without the warm cache.
const PUBLIC_CCS_PREFETCH_TIMEOUT_MS = 120_000;

async function prefetchPublicCCS(
  ccsURL: string,
): Promise<{ durationMS: number; bytes: number }> {
  const started = nowMS();
  let bytes = 0;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const deadline = setTimeout(
    () => controller?.abort(),
    PUBLIC_CCS_PREFETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(absolutize(ccsURL), {
      cache: "force-cache",
      signal: controller?.signal,
    });
    if (!response.ok || !response.body) {
      return { durationMS: nowMS() - started, bytes: 0 };
    }
    const reader = response.body.getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
    }
  } catch {
    bytes = 0;
  } finally {
    clearTimeout(deadline);
  }
  return { durationMS: nowMS() - started, bytes };
}

function nowMS(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
      ? performance.now()
      : Date.now();
}

function proofRequestStatementKey(request: ClaimProofRequest): string {
  return [
    request.target_credential,
    request.destination_address_encoding,
    request.destination_address,
  ].join(":");
}

function buildPreflightRequestJson(
  descriptor: BrowserProvingDescriptor,
  workerCount: number,
): string {
  return JSON.stringify({
    artifacts: buildArtifactsBlock(descriptor),
    tuning: buildTuningBlock(descriptor, workerCount),
  });
}

function buildProveRequestJson(
  descriptor: BrowserProvingDescriptor,
  workerCount: number,
  masterXPrvHex: string,
  request: ClaimProofRequest,
): string {
  return JSON.stringify({
    master_xprv_hex: masterXPrvHex,
    target_credential_hex: request.target_credential,
    destination_address_hex: request.destination_address,
    search: {
      max_account: 9,
      max_index: 999,
    },
    artifacts: buildArtifactsBlock(descriptor),
    tuning: buildTuningBlock(descriptor, workerCount),
    include_debug_path: false,
  });
}

function buildTuningBlock(
  descriptor: BrowserProvingDescriptor,
  appliedWorkerCount?: number,
): Record<string, boolean | number> {
  const tuning = { ...DEFAULT_TUNING, ...descriptor.tuning };
  const workerCount =
    appliedWorkerCount ?? resolveBrowserWorkerCount(descriptor);
  return {
    worker_count: workerCount,
    // Every selected Worker must receive at least one section shard. The
    // descriptor's shard count is a floor; adaptive W5 and explicit larger
    // worker pools raise it without changing the published base descriptor.
    shard_count: Math.max(tuning.shard_count, workerCount),
    range_fetch_concurrency: tuning.range_fetch_concurrency,
    chunk_prefetch_window: tuning.chunk_prefetch_window,
    pinned_decode: tuning.pinned_decode,
    opt_w1: tuning.opt_w1,
    opt_w2: tuning.opt_w2,
    opt_w3: tuning.opt_w3,
    opt_w5: tuning.opt_w5,
    opt_w6: tuning.opt_w6,
    opt_w7: tuning.opt_w7,
    ...(descriptor.tuning?.shard_multiplier !== undefined
      ? { shard_multiplier: descriptor.tuning.shard_multiplier }
      : {}),
  };
}

const W5_WORKER_FLOOR = 8;
const W5_WORKER_CAP = 16;
const W5_RESERVED_THREADS = 2;
const W5_MIN_DEVICE_MEMORY_GIB = 8;

export type BrowserWorkerHostCapacity = {
  hardwareConcurrency: number | null;
  deviceMemoryGiB: number | null;
};

// W5 is descriptor-gated and honors valid explicit worker_count values up to
// the advertised cap. Older clients ignore opt_w5 and retain their worker-8
// default; newer clients also fail safely to eight when either host signal is
// absent or insufficient.
export function resolveBrowserWorkerCount(
  descriptor: BrowserProvingDescriptor,
  host: BrowserWorkerHostCapacity = browserWorkerHostCapacity(),
): number {
  const explicit = descriptor.tuning?.worker_count;
  if (Number.isSafeInteger(explicit) && Number(explicit) > 0) {
    return Math.min(W5_WORKER_CAP, Number(explicit));
  }
  if (descriptor.tuning?.opt_w5 !== true) {
    return W5_WORKER_FLOOR;
  }
  if (
    host.hardwareConcurrency === null ||
    !Number.isFinite(host.hardwareConcurrency) ||
    host.deviceMemoryGiB === null ||
    !Number.isFinite(host.deviceMemoryGiB) ||
    host.deviceMemoryGiB < W5_MIN_DEVICE_MEMORY_GIB
  ) {
    return W5_WORKER_FLOOR;
  }
  const available = Math.floor(host.hardwareConcurrency) - W5_RESERVED_THREADS;
  return Math.min(W5_WORKER_CAP, Math.max(W5_WORKER_FLOOR, available));
}

function browserWorkerHostCapacity(): BrowserWorkerHostCapacity {
  if (typeof navigator === "undefined") {
    return { hardwareConcurrency: null, deviceMemoryGiB: null };
  }
  const hardwareConcurrency = Number.isFinite(navigator.hardwareConcurrency)
    ? navigator.hardwareConcurrency
    : null;
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory;
  const deviceMemoryGiB =
    typeof deviceMemory === "number" && Number.isFinite(deviceMemory)
      ? deviceMemory
      : null;
  return { hardwareConcurrency, deviceMemoryGiB };
}

// Per-MSM-worker Go runtime limits (the O5 gap). The MSM worker reads these
// from its own URL query string — sharded_js.go spawns workers with this URL
// verbatim and its message protocol has no field to carry env vars. A query
// string does not change the pinned file bytes. Peak per-worker heap is well
// under 100 MiB; 512MiB gives headroom without letting eight workers balloon.
const MSM_WORKER_GOGC = 50;
const MSM_WORKER_GOMEMLIMIT = "512MiB";

function msmWorkerUrlWithTuning(url: string): string {
  if (url.includes("?")) {
    return url;
  }
  return `${url}?gogc=${MSM_WORKER_GOGC}&gomemlimit=${MSM_WORKER_GOMEMLIMIT}`;
}

// Note: msm_worker_wasm_url is hash-pin-only on the Go side; the MSM worker
// always loads `msmworker.wasm` relative to its own script URL. The descriptor
// must keep both files co-located under runtime_base_url so the pinned URL and
// the actually-loaded URL coincide.
function buildArtifactsBlock(
  descriptor: BrowserProvingDescriptor,
): Record<string, string> {
  return {
    manifest_url: absolutize(descriptor.manifest_url),
    manifest_sig_url: absolutize(descriptor.manifest_sig_url),
    manifest_public_key_hex: descriptor.manifest_public_key_hex,
    vk_url: absolutize(descriptor.vk_url),
    pk_url: absolutize(descriptor.pk_url),
    pk_index_url: absolutize(descriptor.pk_index_url),
    ccs_url: absolutize(descriptor.ccs_url),
    ccs_blake2b256: descriptor.ccs_blake2b256,
    chunk_manifest_url: absolutize(descriptor.chunk_manifest_url),
    chunk_manifest_sig_url: absolutize(descriptor.chunk_manifest_sig_url),
    chunk_manifest_public_key_hex: descriptor.chunk_manifest_public_key_hex,
    deployment_manifest_url: absolutize(descriptor.deployment_manifest_url),
    proof_wasm_url: absolutize(descriptor.proof_wasm_url),
    worker_js_url: msmWorkerUrlWithTuning(absolutize(descriptor.worker_js_url)),
    msm_worker_wasm_url: absolutize(descriptor.msm_worker_wasm_url),
  };
}

function absolutize(url: string): string {
  if (typeof window === "undefined" || /^https?:\/\//u.test(url)) {
    return url;
  }
  return new URL(url, window.location.origin).toString();
}

class ProverWorkerClient {
  private worker: ProverWorkerLike | null = null;
  private terminationError: unknown = null;
  private readonly createWorker: () => ProverWorkerLike;
  private readonly pending = new Map<
    string,
    {
      resolve: (response: ProverWorkerResponse) => void;
      reject: (error: unknown) => void;
      onProgress?: (stage?: string, frac?: number) => void;
    }
  >();
  private nextId = 0;
  private readonly onMessage = (event: MessageEvent<ProverWorkerResponse>) => {
    const data = event.data;
    if (!data || typeof data.id !== "string") {
      return;
    }
    const entry = this.pending.get(data.id);
    if (!entry) {
      return;
    }
    if (data.type === "progress") {
      entry.onProgress?.(data.stage, data.frac);
      return;
    }
    this.pending.delete(data.id);
    if (data.type === "error") {
      entry.reject(new Error(sanitizeProverError(data.message)));
      return;
    }
    entry.resolve(data);
  };
  private readonly onError = () => {
    this.failAllPending(new Error("The proving worker failed to load."));
  };

  constructor(createWorker: () => ProverWorkerLike) {
    this.createWorker = createWorker;
  }

  async init(descriptor: BrowserProvingDescriptor): Promise<void> {
    if (this.worker) {
      return;
    }
    this.worker = this.createWorker();
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onError);
    const tuning = { ...DEFAULT_TUNING, ...descriptor.tuning };
    await this.request(
      {
        type: "init",
        wasmUrl: absolutize(descriptor.proof_wasm_url),
        wasmExecUrl: absolutize(
          `${trimSlash(descriptor.runtime_base_url)}/wasm_exec.js`,
        ),
        msmWorkerWasmUrl: absolutize(descriptor.msm_worker_wasm_url),
        gogc: tuning.gogc,
        gomemlimit: tuning.gomemlimit,
      },
      { timeoutMs: PROVER_WORKER_INIT_TIMEOUT_MS, expected: "ready" },
    );
  }

  async preflight(requestJson: string): Promise<ProverPreflightResult> {
    const response = await this.request(
      { type: "preflight", requestJson },
      { timeoutMs: PROVER_PREFLIGHT_TIMEOUT_MS, expected: "preflight-result" },
    );
    return response.type === "preflight-result" ? response.result : {};
  }

  async prove(
    requestJson: string,
    onProgress: (stage?: string, frac?: number) => void,
  ): Promise<ProverProveResult> {
    const response = await this.request(
      { type: "prove", requestJson },
      { expected: "prove-result", onProgress },
    );
    return response.type === "prove-result" ? response.result : {};
  }

  terminate(
    pendingError: unknown = new Error("The proving worker was stopped."),
  ): void {
    // Remember why we stopped so any request issued after termination (e.g. the
    // next prove in the loop racing an abort) rejects with the same reason,
    // not a generic "not running".
    this.terminationError = pendingError;
    this.failAllPending(pendingError);
    if (this.worker) {
      this.worker.removeEventListener("message", this.onMessage);
      this.worker.removeEventListener("error", this.onError);
      this.worker.terminate();
      this.worker = null;
    }
  }

  private failAllPending(error: unknown): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.reject(error);
    }
  }

  private async request(
    message: ProverWorkerRequestBody,
    options: {
      timeoutMs?: number;
      expected: ProverWorkerResponse["type"];
      onProgress?: (stage?: string, frac?: number) => void;
    },
  ): Promise<ProverWorkerResponse> {
    if (!this.worker) {
      throw (
        this.terminationError ?? new Error("The proving worker is not running.")
      );
    }
    const id = `prove-${(this.nextId += 1)}`;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<ProverWorkerResponse>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (response) => {
            if (response.type !== options.expected) {
              reject(
                new Error("The proving worker sent an unexpected response."),
              );
              return;
            }
            resolve(response);
          },
          reject,
          onProgress: options.onProgress,
        });
        if (options.timeoutMs) {
          timeoutId = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error("The proving worker timed out."));
          }, options.timeoutMs);
        }
        this.worker!.postMessage({ id, ...message });
      });
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}

// Defense in depth for the secrets policy: no prover error may surface a long
// hex value (master xprv, witness material) to state, logs, or the UI.
export function sanitizeProverError(error: unknown): string {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "Browser proving failed.";
  const redacted = raw.replace(/[0-9a-fA-F]{32,}/gu, "[redacted]");
  return redacted || "Browser proving failed.";
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let index = 0; index < bytes.length; index += 1) {
    hex += bytes[index].toString(16).padStart(2, "0");
  }
  return hex;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
