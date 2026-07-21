import type { ClaimDraftResponse } from "../claim/types";
import type { BrowserProvingDescriptor } from "../reclaim/types";

export type ProofProviderKind = "desktop-helper" | "browser-wasm";

export type DestinationProofArtifactItem = {
  out_ref?: string;
  artifact?: Record<string, unknown>;
};

export type DestinationProofResponse = {
  profile?: string;
  artifacts?: DestinationProofArtifactItem[];
};

export type ProofProgressEvent = {
  provider: ProofProviderKind;
  stage: string;
  frac?: number;
  current?: number;
  total?: number;
  engine?: string;
  discovery?: {
    candidatesScanned: number;
    candidatesTotal: number;
    candidatesPerSecond: number;
    etaSeconds: number;
    matched: number;
    targets: number;
  };
};

export type BrowserProvingStatus = "unknown" | "checking" | "ready" | "unsupported" | "asset-error";

export type BrowserCapabilityFailure = {
  check:
    | "descriptor"
    | "webassembly"
    | "worker"
    | "fetch"
    | "cross-origin-isolation"
    | "shared-array-buffer"
    | "nested-worker"
    | "hardware-concurrency"
    | "asset-preflight"
    | "vk-hash";
  message: string;
};

export type BrowserCapabilityReport = {
  ok: boolean;
  failures: BrowserCapabilityFailure[];
  hardwareConcurrency: number | null;
  deviceMemoryGiB: number | null;
  warnings: string[];
};

export type BrowserProvingCheckResult = {
  status: Extract<BrowserProvingStatus, "ready" | "unsupported" | "asset-error">;
  capability: BrowserCapabilityReport;
  preflight: ProverPreflightResult | null;
};

export type GenerateDestinationProofsInput = {
  masterXPrv: Uint8Array;
  draft: ClaimDraftResponse;
  expectedVkHash: string;
  browserProving?: BrowserProvingDescriptor;
  signal?: AbortSignal;
  onProgress?: (event: ProofProgressEvent) => void;
};

export type ProofProviderStatus = {
  kind: ProofProviderKind;
  ready: boolean;
  reason: string;
};

export interface DestinationProofProvider {
  kind: ProofProviderKind;
  check(): Promise<ProofProviderStatus>;
  prove(input: GenerateDestinationProofsInput): Promise<DestinationProofResponse>;
}

export type ProverPreflightResult = {
  ok?: boolean;
  vk_hash?: string;
  constraints?: number;
  chunk_manifest?: string;
  chunks?: number;
  chunk_size?: number;
  deployment_id?: string;
  signature_key_id?: string;
  applied_tuning?: {
    worker_count?: number;
    shard_count?: number;
    range_fetch_concurrency?: number;
    chunk_prefetch_window?: number;
  };
  timings?: {
    initialization_ms?: number;
    asset_open_ms?: number;
    ccs_fetch_ms?: number;
    ccs_decode_ms?: number;
    ccs_hash_ms?: number;
    ccs_bytes_fetched?: number;
    ccs_browser_prefetch_ms?: number;
    ccs_browser_prefetch_bytes?: number;
  };
};

export type ProverProveResult = {
  artifact?: Record<string, unknown>;
  engine?: string;
  ms?: number;
  wall_seconds?: number;
  peak_heap_gib?: number;
  verified_locally?: boolean;
  trace?: unknown;
};

export type ProverDiscoverResult = {
  ok?: boolean;
  matched?: number;
  targets?: number;
  candidates_scanned?: number;
  candidates_total?: number;
  candidates_per_second?: number;
  elapsed_ms?: number;
};

// postMessage protocol with public/proof-runtime/prover-worker.js. The request
// JSON crossing this boundary contains master_xprv_hex; nothing that carries it
// may be logged, thrown, or surfaced outside the provider modules.
export type ProverWorkerRequest =
  | {
      id: string;
      type: "init";
      wasmUrl: string;
      wasmExecUrl: string;
      msmWorkerWasmUrl: string;
      gogc: number;
      gomemlimit: string;
    }
  | { id: string; type: "preflight"; requestJson: string }
  | { id: string; type: "discover"; requestJson: string }
  | { id: string; type: "prove"; requestJson: string };

export type ProverWorkerResponse =
  | { id: string; type: "ready" }
  | { id: string; type: "preflight-result"; result: ProverPreflightResult }
  | { id: string; type: "discover-result"; result: ProverDiscoverResult }
  | {
      id: string;
      type: "progress";
      stage?: string;
      frac?: number;
      candidates_scanned?: number;
      candidates_total?: number;
      candidates_per_second?: number;
      eta_seconds?: number;
      matched?: number;
      targets?: number;
    }
  | { id: string; type: "prove-result"; result: ProverProveResult }
  | { id: string; type: "error"; message?: string };

export type ProverWorkerLike = {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ProverWorkerResponse>) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<ProverWorkerResponse>) => void): void;
  removeEventListener(type: "error", listener: (event: unknown) => void): void;
};

export type { BrowserProvingDescriptor };
