import type { BrowserProvingDescriptor, BrowserProvingTuning } from "../reclaim/types";
import type { ClaimProofRequest } from "../claim/types";
import { checkBrowserProvingCapability } from "./capability";
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

type ProverWorkerRequestBody = ProverWorkerRequest extends infer T ? (T extends ProverWorkerRequest ? Omit<T, "id"> : never) : never;

export const PROVER_WORKER_INIT_TIMEOUT_MS = 60_000;
export const PROVER_PREFLIGHT_TIMEOUT_MS = 300_000;

// Production tuning is the measured local7 configuration (115.9 s / 2.32 GiB).
// Deployments may override via the descriptor's tuning block; code must not.
const DEFAULT_TUNING: Required<Omit<BrowserProvingTuning, "shard_multiplier">> = {
  worker_count: 8,
  shard_count: 32,
  range_fetch_concurrency: 2,
  pinned_decode: true,
  gogc: 50,
  gomemlimit: "3000MiB",
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
  return new Worker("/proof-runtime/prover-worker.js") as unknown as ProverWorkerLike;
}

// Full readiness check for the browser provider: capability preflight first
// (cheap, no network), then the asset preflight inside the prover worker
// (signed manifest, chunk manifest, runtime hash pins), then the vk_hash chain
// against the deployment's verifier hash. Runs before the browser option is
// enabled and again before proving — always before the phrase is read.
export async function checkBrowserProving(
  descriptor: BrowserProvingDescriptor | null | undefined,
  expectedVkHash: string,
  options: BrowserWasmOptions = {},
): Promise<BrowserProvingCheckResult> {
  const capability = await checkBrowserProvingCapability(descriptor);
  if (!capability.ok || !descriptor) {
    return { status: "unsupported", capability, preflight: null };
  }

  const client = new ProverWorkerClient(options.createWorker ?? defaultCreateProverWorker);
  try {
    await client.init(descriptor);
    const preflight = await client.preflight(buildPreflightRequestJson(descriptor));
    if (preflight.ok !== true) {
      capability.failures.push({ check: "asset-preflight", message: "Proof assets failed verification." });
      return { status: "asset-error", capability: { ...capability, ok: false }, preflight };
    }
    if (preflight.vk_hash !== expectedVkHash) {
      capability.failures.push({
        check: "vk-hash",
        message: "Proof assets do not match this deployment's verifier key.",
      });
      return { status: "asset-error", capability: { ...capability, ok: false }, preflight };
    }
    return { status: "ready", capability, preflight };
  } catch (error) {
    capability.failures.push({ check: "asset-preflight", message: sanitizeProverError(error) });
    return { status: "asset-error", capability: { ...capability, ok: false }, preflight: null };
  } finally {
    client.terminate();
  }
}

// Sequential per-request proving in one long-lived worker: the runtime and
// verified asset state are reused across the batch, and the ~2.3 GiB peak per
// proof leaves no headroom for parallelism. All-or-nothing, matching helper
// semantics. AbortSignal terminates the worker outright — the Go runtime does
// not cancel mid-MSM.
export async function proveDestinationInBrowser(
  input: GenerateDestinationProofsInput,
  options: BrowserWasmOptions = {},
): Promise<DestinationProofResponse> {
  const descriptor = input.browserProving;
  if (!descriptor || !descriptor.enabled) {
    throw new Error("Browser proving is not enabled for this deployment.");
  }
  const total = input.draft.proofRequests.length;
  const client = new ProverWorkerClient(options.createWorker ?? defaultCreateProverWorker);
  let masterXPrvHex: string | null = null;
  const onAbort = () => client.terminate(new ProvingCancelledError());
  try {
    if (input.signal?.aborted) {
      throw new ProvingCancelledError();
    }
    input.signal?.addEventListener("abort", onAbort);

    await client.init(descriptor);
    const preflight = await client.preflight(buildPreflightRequestJson(descriptor));
    if (preflight.ok !== true) {
      throw new Error("Proof assets failed verification.");
    }
    if (preflight.vk_hash !== input.expectedVkHash) {
      throw new Error("Proof assets do not match this deployment's verifier key.");
    }

    masterXPrvHex = bytesToHex(input.masterXPrv);
    const artifacts: Array<{ out_ref: string; artifact: Record<string, unknown> }> = [];
    for (const [index, request] of input.draft.proofRequests.entries()) {
      if (input.signal?.aborted) {
        throw new ProvingCancelledError();
      }
      const result = await client.prove(buildProveRequestJson(descriptor, masterXPrvHex, request), (stage, frac) => {
        input.onProgress?.({
          provider: "browser-wasm",
          stage: stage ?? "prove",
          frac,
          current: index + 1,
          total,
          engine: "streampk-sharded-groth16",
        });
      });
      if (result.verified_locally !== true) {
        throw new Error("The browser prover could not verify a generated proof locally.");
      }
      if (!result.artifact || typeof result.artifact !== "object") {
        throw new Error("The browser prover returned a malformed proof artifact.");
      }
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
    client.terminate();
  }
}

function buildPreflightRequestJson(descriptor: BrowserProvingDescriptor): string {
  return JSON.stringify({ artifacts: buildArtifactsBlock(descriptor) });
}

function buildProveRequestJson(
  descriptor: BrowserProvingDescriptor,
  masterXPrvHex: string,
  request: ClaimProofRequest,
): string {
  const tuning = { ...DEFAULT_TUNING, ...descriptor.tuning };
  return JSON.stringify({
    master_xprv_hex: masterXPrvHex,
    target_credential_hex: request.target_credential,
    destination_address_hex: request.destination_address,
    search: {
      max_account: 9,
      max_index: 999,
    },
    artifacts: buildArtifactsBlock(descriptor),
    tuning: {
      worker_count: tuning.worker_count,
      shard_count: tuning.shard_count,
      range_fetch_concurrency: tuning.range_fetch_concurrency,
      pinned_decode: tuning.pinned_decode,
      ...(descriptor.tuning?.shard_multiplier !== undefined ? { shard_multiplier: descriptor.tuning.shard_multiplier } : {}),
    },
    include_debug_path: false,
  });
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
function buildArtifactsBlock(descriptor: BrowserProvingDescriptor): Record<string, string> {
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
        wasmExecUrl: absolutize(`${trimSlash(descriptor.runtime_base_url)}/wasm_exec.js`),
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

  async prove(requestJson: string, onProgress: (stage?: string, frac?: number) => void): Promise<ProverProveResult> {
    const response = await this.request({ type: "prove", requestJson }, { expected: "prove-result", onProgress });
    return response.type === "prove-result" ? response.result : {};
  }

  terminate(pendingError: unknown = new Error("The proving worker was stopped.")): void {
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
      throw this.terminationError ?? new Error("The proving worker is not running.");
    }
    const id = `prove-${(this.nextId += 1)}`;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<ProverWorkerResponse>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (response) => {
            if (response.type !== options.expected) {
              reject(new Error("The proving worker sent an unexpected response."));
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
