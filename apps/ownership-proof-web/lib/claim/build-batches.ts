import type { ClaimBuildResponse, ClaimDraftResponse } from "./types";

// Return one build for review at a time. Remaining inputs stay claimable in the
// next batch; no subset is signed or submitted as part of this fallback.
export async function buildClaimBatch(
  original: ClaimDraftResponse,
  artifacts: Record<string, unknown>[],
  actions: {
    draft: (outrefs: string[]) => Promise<ClaimDraftResponse>;
    build: (draft: ClaimDraftResponse, proofs: Record<string, unknown>[]) => Promise<ClaimBuildResponse>;
    defer: (outref: string) => void;
  },
): Promise<{ draft: ClaimDraftResponse; artifacts: Record<string, unknown>[]; build: ClaimBuildResponse } | null> {
  const proofs = new Map(original.orderedInputs.map((input, index) => [input.outRefId, artifacts[index]]));
  const statements = new Map(original.proofRequests.map((request) => [request.out_ref, request]));
  const queue = [original.orderedInputs.map((input) => input.outRefId)];
  let first = true;
  for (let outrefs = queue.shift(); outrefs; outrefs = queue.shift()) {
    const draft = first ? original : await actions.draft(outrefs);
    first = false;
    const subset = draft.proofRequests.map((request) => {
      const previous = statements.get(request.out_ref);
      const proof = proofs.get(request.out_ref);
      if (
        !previous ||
        !proof ||
        request.target_credential !== previous.target_credential ||
        request.destination_address !== previous.destination_address ||
        request.destination_address_encoding !== previous.destination_address_encoding ||
        draft.deploymentId !== original.deploymentId
      ) {
        throw new Error("Claim destination or inputs changed. Generate new proofs before building.");
      }
      return proof;
    });
    try {
      return { draft, artifacts: subset, build: await actions.build(draft, subset) };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "claim_batch_capacity_exceeded" && code !== "claim_evaluation_margin_exceeded") throw error;
      if (outrefs.length === 1) {
        actions.defer(outrefs[0]);
      } else {
        const middle = Math.ceil(outrefs.length / 2);
        queue.unshift(outrefs.slice(0, middle), outrefs.slice(middle));
      }
    }
  }
  return null;
}
