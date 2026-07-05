import type { Provider } from "@lucid-evolution/lucid";
import type { ClaimOutRef } from "../claim/types";

export function supportsAddressUtxoIndex(provider: Provider): boolean {
  return typeof provider.getUtxos === "function";
}

export function supportsOutRefLookup(provider: Provider): boolean {
  return typeof provider.getUtxosByOutRef === "function";
}

export function providerUnavailableResponse(deploymentId: string | null, network: string | null, reason: string) {
  return {
    available: false as const,
    deploymentId,
    network,
    indexer: {
      providerBacked: false as const,
      status: "disabled" as const,
    },
    code: "provider_index_unavailable",
    reason,
  };
}

export function outRefsForProvider(outrefs: ClaimOutRef[]) {
  return outrefs.map((outRef) => ({
    txHash: outRef.txHash,
    outputIndex: outRef.outputIndex,
  }));
}
