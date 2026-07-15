import type { ClaimDraftResponse } from "../claim/types";
import type { DestinationProofResponse } from "./types";
import { fetchLoopback } from "./loopback-access";

export const DESTINATION_PREFLIGHT_CAPABILITY = "prove-destination-preflight-v1";
const LEGACY_PREFLIGHT_ERROR = "The destination proof request was not valid JSON.";

export type DesktopHelperProveInput = {
  masterXPrv: Uint8Array;
  draft: ClaimDraftResponse;
  helperUrl: string;
  helperToken: string;
};

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
  const response = await postJSON<DestinationProofResponse>(
    `${trimSlash(input.helperUrl)}/prove-destination`,
    {
      master_xprv_base64: bytesToBase64(input.masterXPrv),
      profile: input.draft.proofProfile,
      requests: uniqueRequests,
      search: {
        max_account: 9,
        max_index: 999,
      },
      include_debug_path: false,
    },
    {
      "X-Proof-Tool-Token": input.helperToken,
    },
  );
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

function proofRequestStatementKey(request: ClaimDraftResponse["proofRequests"][number]): string {
  return [
    request.target_credential,
    request.destination_address_encoding,
    request.destination_address,
  ].join(":");
}

async function postJSON<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  const { response, payload } = await requestJSON(url, body, headers);
  if (!response.ok) {
    const error = payload as { error?: string; reason?: string } | null;
    throw new Error(error?.error || error?.reason || "Request failed.");
  }
  return payload as T;
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
