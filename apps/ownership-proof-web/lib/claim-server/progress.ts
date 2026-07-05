import type { Provider } from "@lucid-evolution/lucid";
import type { ReclaimDeployment } from "../reclaim/types";
import type { ClaimProgressEntry, ClaimProgressResponse } from "../claim/types";
import { assertOutRefList, outRefToString } from "../claim/validation";
import { toIndexedReclaimUtxo } from "./indexer";
import { outRefsForProvider, supportsAddressUtxoIndex, supportsOutRefLookup } from "./provider";

export async function getClaimProgress(
  provider: Provider | null,
  deployment: ReclaimDeployment | null,
  input: { outrefs?: unknown; pendingOutrefs?: unknown },
): Promise<ClaimProgressResponse> {
  const requestedOutrefs = assertOutRefList(input.outrefs, "outrefs");
  const pendingOutrefs = new Set(assertOutRefList(input.pendingOutrefs, "pendingOutrefs").map(outRefToString));
  const deploymentId = deployment?.id ?? null;

  if (!provider || !deployment || !supportsOutRefLookup(provider)) {
    return {
      deploymentId,
      providerAvailable: false,
      outrefs: requestedOutrefs.map((outRef) => ({
        outRef,
        outRefId: outRefToString(outRef),
        state: "provider_unavailable",
      })),
      nextBatch: {
        available: false,
        count: 0,
      },
    };
  }

  const unspent = new Set((await provider.getUtxosByOutRef(outRefsForProvider(requestedOutrefs))).map(outRefToString));
  const outrefs: ClaimProgressEntry[] = requestedOutrefs.map((outRef) => {
    const outRefId = outRefToString(outRef);
    const isPending = pendingOutrefs.has(outRefId);
    if (unspent.has(outRefId)) {
      return {
        outRef,
        outRefId,
        state: isPending ? "pending" : "unspent",
      };
    }
    return {
      outRef,
      outRefId,
      state: "spent_or_unknown",
    };
  });

  const remainingCount = supportsAddressUtxoIndex(provider)
    ? (await provider.getUtxos(deployment.reclaimBaseAddress))
        .filter((utxo) => utxo.address === deployment.reclaimBaseAddress)
        .map((utxo) => toIndexedReclaimUtxo(utxo, deployment, pendingOutrefs))
        .filter((utxo) => utxo.state === "unspent" && utxo.datum.status === "valid").length
    : 0;

  return {
    deploymentId,
    providerAvailable: true,
    outrefs,
    nextBatch: {
      available: remainingCount > 0,
      count: remainingCount,
    },
  };
}
