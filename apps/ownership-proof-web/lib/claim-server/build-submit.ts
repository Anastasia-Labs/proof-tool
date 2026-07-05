import type { ReclaimDeployment } from "../reclaim/types";
import type { ClaimBuildRequest, ClaimSubmitRequest } from "../claim/types";
import {
  assertCborHex,
  assertExactDeploymentId,
  assertHex,
  assertObject,
  assertOutRefList,
  ClaimValidationError,
} from "../claim/validation";
import { assertWalletAddresses, assertWalletAddress, assertWalletNetwork } from "../reclaim/validation";

const DESTINATION_CIRCUIT_ID = "root-ownership-destination-v1/bls12-381/groth16";

export function validateClaimBuildRequest(deployment: ReclaimDeployment, request: ClaimBuildRequest): never {
  const raw = assertObject(request, "claim build request") as ClaimBuildRequest;
  assertExactDeploymentId(raw.deploymentId, deployment.id);
  assertWalletNetwork(raw.networkId, deployment.networkId);
  assertDraftId(raw.draftId);
  const selectedOutrefs = assertOutRefList(raw.selectedOutrefs, "selectedOutrefs");
  if (selectedOutrefs.length === 0) {
    throw new ClaimValidationError("selected_outrefs_empty", "Claim build requires selected reclaim outrefs.");
  }
  assertWalletAddress(raw.safeWalletChangeAddress, deployment.network);
  assertWalletAddresses(raw.safeWalletAddresses, deployment.network);
  assertProofArtifacts(raw.proofArtifacts, selectedOutrefs.length, deployment.verifierVkHash);

  throw new UnsupportedClaimBuildError();
}

export function validateClaimSubmitRequest(deployment: ReclaimDeployment, request: ClaimSubmitRequest): never {
  const raw = assertObject(request, "claim submit request") as ClaimSubmitRequest;
  assertExactDeploymentId(raw.deploymentId, deployment.id);
  const selectedOutrefs = assertOutRefList(raw.selectedOutrefs, "selectedOutrefs");
  if (selectedOutrefs.length === 0) {
    throw new ClaimValidationError("selected_outrefs_empty", "Claim submit requires selected reclaim outrefs.");
  }
  assertCborHex(raw.signedTxCbor, "signedTxCbor");
  if (typeof raw.claimBuildReviewToken !== "string" || raw.claimBuildReviewToken.trim() === "") {
    throw new ClaimValidationError("claim_submit_review_required", "Claim submit requires a reviewed claim build token.");
  }

  throw new UnsupportedClaimSubmitError();
}

function assertDraftId(value: unknown): string {
  return assertHex(value, "draftId");
}

function assertProofArtifacts(value: unknown, expectedCount: number, expectedVkHash: string): void {
  if (!Array.isArray(value)) {
    throw new ClaimValidationError("proof_artifacts_invalid", "Claim build requires destination-bound proof artifacts.");
  }
  if (value.length !== expectedCount) {
    throw new ClaimValidationError("proof_artifacts_count", "Proof artifact count must match selected reclaim inputs.");
  }

  for (const [index, artifact] of value.entries()) {
    const raw = assertObject(artifact, `proofArtifacts[${index}]`);
    const body = assertObject(raw.artifact ?? raw, `proofArtifacts[${index}].artifact`);
    if (body.circuit_id !== DESTINATION_CIRCUIT_ID) {
      throw new ClaimValidationError("proof_artifact_circuit", "Proof artifact circuit id is not destination-bound.");
    }
    if (body.vk_hash !== expectedVkHash) {
      throw new ClaimValidationError("proof_artifact_vk_hash", "Proof artifact verifier key hash does not match deployment.");
    }
    const cardano = assertObject(body.cardano, `proofArtifacts[${index}].artifact.cardano`);
    assertHex(cardano.proof_hex, `proofArtifacts[${index}].artifact.cardano.proof_hex`);
    assertHex(cardano.public_input_digest_hex, `proofArtifacts[${index}].artifact.cardano.public_input_digest_hex`);
  }
}

export class UnsupportedClaimBuildError extends Error {
  readonly code = "claim_build_unsupported";

  constructor() {
    super("Live claim transaction construction is not enabled for this deployment.");
    this.name = "UnsupportedClaimBuildError";
  }
}

export class UnsupportedClaimSubmitError extends Error {
  readonly code = "claim_submit_unsupported";

  constructor() {
    super("Live claim transaction submission is not enabled for this deployment.");
    this.name = "UnsupportedClaimSubmitError";
  }
}
