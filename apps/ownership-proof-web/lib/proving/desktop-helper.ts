import type { ClaimDraftResponse } from "../claim/types";
import type { DestinationProofResponse } from "./types";

export type DesktopHelperProveInput = {
  masterXPrv: Uint8Array;
  draft: ClaimDraftResponse;
  helperUrl: string;
  helperToken: string;
};

// Behavior-preserving extraction of the helper POST from
// ClaimFlow.generateClaimProofs: same URL, body, and headers. Response
// validation stays with the caller (validateDestinationProofResponse), as
// before.
export async function proveDestinationViaHelper(input: DesktopHelperProveInput): Promise<DestinationProofResponse> {
  return postJSON<DestinationProofResponse>(
    `${trimSlash(input.helperUrl)}/prove-destination`,
    {
      master_xprv_base64: bytesToBase64(input.masterXPrv),
      profile: input.draft.proofProfile,
      requests: input.draft.proofRequests,
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
}

async function postJSON<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
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
  if (!response.ok) {
    const error = payload as { error?: string; reason?: string } | null;
    throw new Error(error?.error || error?.reason || "Request failed.");
  }
  return payload as T;
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
