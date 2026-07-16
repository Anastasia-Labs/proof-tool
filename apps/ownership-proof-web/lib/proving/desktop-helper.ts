import type { ClaimDraftResponse } from "../claim/types";
import type { DestinationProofResponse, ProofProgressEvent } from "./types";
import { fetchLoopback } from "./loopback-access";

export const DESTINATION_PREFLIGHT_CAPABILITY = "prove-destination-preflight-v1";
const LEGACY_PREFLIGHT_ERROR = "The destination proof request was not valid JSON.";
const DESTINATION_PROGRESS_CONTENT_TYPE = "application/x-ndjson";

export type DesktopHelperProveInput = {
  masterXPrv: Uint8Array;
  draft: ClaimDraftResponse;
  helperUrl: string;
  helperToken: string;
  signal?: AbortSignal;
  onProgress?: (event: ProofProgressEvent) => void;
};

export class DesktopHelperCancelledError extends Error {
  constructor() {
    super("Proof generation was cancelled.");
    this.name = "DesktopHelperCancelledError";
  }
}

export async function preflightDestinationViaHelper(input: {
  helperUrl: string;
  helperToken: string;
}): Promise<void> {
  const { response, payload } = await requestJSON(
    `${trimSlash(input.helperUrl)}/prove-destination`,
    { preflight_only: true },
    { "X-Proof-Tool-Token": input.helperToken },
  );
  const result = payload as { ok?: boolean; capability?: string; code?: string; error?: string } | null;
  if (response.ok && result?.ok === true && result.capability === DESTINATION_PREFLIGHT_CAPABILITY) {
    return;
  }
  // v0.2.1 authenticates the origin/token and resolves DestinationGenerator
  // before its strict decoder rejects the new field. This exact response is a
  // safe compatibility acknowledgement from the already-published helper: the
  // request exercised the real endpoint and contained no recovery secret.
  if (
    response.status === 400 &&
    result?.code === "invalid_request" &&
    result.error === LEGACY_PREFLIGHT_ERROR
  ) {
    return;
  }
  throw new Error(result?.error || "Proof Helper did not confirm destination-proof preflight support.");
}

// Behavior-preserving extraction of the helper POST from
// ClaimFlow.generateClaimProofs: same URL, body, and headers. Response
// validation stays with the caller (validateDestinationProofResponse), as
// before.
export async function proveDestinationViaHelper(input: DesktopHelperProveInput): Promise<DestinationProofResponse> {
  const representativeByStatement = new Map<string, string>();
  const uniqueRequests = input.draft.proofRequests.filter((request) => {
    const key = proofRequestStatementKey(request);
    if (representativeByStatement.has(key)) {
      return false;
    }
    representativeByStatement.set(key, request.out_ref);
    return true;
  });
  let response: DestinationProofResponse;
  try {
    const httpResponse = await fetchLoopback(`${trimSlash(input.helperUrl)}/prove-destination`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: DESTINATION_PROGRESS_CONTENT_TYPE,
        "X-Proof-Tool-Token": input.helperToken,
      },
      body: JSON.stringify({
        master_xprv_base64: bytesToBase64(input.masterXPrv),
        profile: input.draft.proofProfile,
        requests: uniqueRequests,
        search: {
          max_account: 9,
          max_index: 999,
        },
        include_debug_path: false,
      }),
      signal: input.signal,
    });
    if (responseContentType(httpResponse) === DESTINATION_PROGRESS_CONTENT_TYPE) {
      response = await readDestinationProgressStream(httpResponse, input);
    } else {
      const payload = await readResponseJSON(httpResponse);
      if (!httpResponse.ok) {
        const error = payload as { error?: string; reason?: string } | null;
        throw new Error(error?.error || error?.reason || "Request failed.");
      }
      response = payload as DestinationProofResponse;
    }
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) {
      throw new DesktopHelperCancelledError();
    }
    throw error;
  }
  if (!Array.isArray(response.artifacts)) {
    return response;
  }
  const artifactByOutRef = new Map(
    response.artifacts.map((item) => [item.out_ref, item]),
  );
  const expandedArtifacts = input.draft.proofRequests.map((request) => {
    const representativeOutRef = representativeByStatement.get(
      proofRequestStatementKey(request),
    );
    const representative = representativeOutRef
      ? artifactByOutRef.get(representativeOutRef)
      : undefined;
    return representative
      ? { ...representative, out_ref: request.out_ref }
      : undefined;
  });
  if (expandedArtifacts.some((item) => item === undefined)) {
    return response;
  }
  return {
    ...response,
    artifacts: expandedArtifacts as NonNullable<DestinationProofResponse["artifacts"]>,
  };
}

type DestinationProgressEnvelope = {
  type?: string;
  stage?: string;
  current?: number;
  total?: number;
  discovery?: {
    candidates_scanned?: number;
    candidates_total?: number;
    candidates_per_second?: number;
    eta_seconds?: number;
    matched?: number;
    targets?: number;
  };
  result?: DestinationProofResponse;
  code?: string;
  error?: string;
};

async function readDestinationProgressStream(
  response: Response,
  input: DesktopHelperProveInput,
): Promise<DestinationProofResponse> {
  if (!response.ok || !response.body) {
    throw new Error("Proof Helper could not start its local progress stream.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: DestinationProofResponse | null = null;

  const consumeLine = (line: string) => {
    if (!line.trim()) {
      return;
    }
    let event: DestinationProgressEnvelope;
    try {
      event = JSON.parse(line) as DestinationProgressEnvelope;
    } catch {
      throw new Error("Proof Helper returned an invalid progress stream.");
    }
    if (event.type === "progress") {
      input.onProgress?.(proofProgressEvent(event));
      return;
    }
    if (event.type === "error") {
      if (event.code === "request_cancelled") {
        throw new DesktopHelperCancelledError();
      }
      throw new Error(typeof event.error === "string" && event.error ? event.error : "The helper could not generate destination-bound proofs.");
    }
    if (event.type === "result" && event.result && result === null) {
      result = event.result;
      return;
    }
    throw new Error("Proof Helper returned an invalid progress stream.");
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) {
      break;
    }
  }
  if (buffer.trim()) {
    consumeLine(buffer);
  }
  if (!result) {
    throw new Error("Proof Helper ended without returning proof artifacts.");
  }
  return result;
}

function proofProgressEvent(event: DestinationProgressEnvelope): ProofProgressEvent {
  const current = finiteNonNegative(event.current);
  const total = finiteNonNegative(event.total);
  const scanned = finiteNonNegative(event.discovery?.candidates_scanned);
  const candidatesTotal = finiteNonNegative(event.discovery?.candidates_total);
  const discovery = event.discovery
    ? {
        candidatesScanned: scanned,
        candidatesTotal,
        candidatesPerSecond: finiteNonNegative(event.discovery.candidates_per_second),
        etaSeconds: finiteNonNegative(event.discovery.eta_seconds),
        matched: finiteNonNegative(event.discovery.matched),
        targets: finiteNonNegative(event.discovery.targets),
      }
    : undefined;
  return {
    provider: "desktop-helper",
    stage: helperProgressStage(event.stage),
    ...(total > 0 ? { current, total, frac: Math.min(1, current / total) } : {}),
    ...(discovery
      ? {
          frac: candidatesTotal > 0 ? Math.min(1, scanned / candidatesTotal) : 0,
          discovery,
        }
      : {}),
  };
}

function helperProgressStage(value: unknown): string {
  return value === "locating-keys" || value === "open-keys" || value === "prove" || value === "done"
    ? value
    : "working";
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function responseContentType(response: Response): string {
  const raw = response.headers?.get?.("Content-Type") ?? "";
  return raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function readResponseJSON(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";
}

function proofRequestStatementKey(request: ClaimDraftResponse["proofRequests"][number]): string {
  return [
    request.target_credential,
    request.destination_address_encoding,
    request.destination_address,
  ].join(":");
}

async function requestJSON(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ response: Response; payload: unknown }> {
  const response = await fetchLoopback(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { response, payload };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}
