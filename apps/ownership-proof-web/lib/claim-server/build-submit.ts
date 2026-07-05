import { blake2b } from "@noble/hashes/blake2b";
import { Constr, Data, type Provider } from "@lucid-evolution/lucid";
import type { ReclaimDeployment } from "../reclaim/types";
import {
  DESTINATION_ADDRESS_V1_ENCODING,
  type ClaimBuildRequest,
  type ClaimDraftResponse,
  type ClaimOutRef,
  type ClaimSubmitRequest,
} from "../claim/types";
import {
  assertCborHex,
  assertExactDeploymentId,
  assertHex,
  assertObject,
  assertOutRef,
  assertOutRefList,
  ClaimValidationError,
  outRefToString,
} from "../claim/validation";
import { assertWalletAddresses, assertWalletAddress, assertWalletNetwork } from "../reclaim/validation";
import { createClaimDraft } from "./draft";

const DESTINATION_CIRCUIT_ID = "root-ownership-destination-v1/bls12-381/groth16";
const DESTINATION_PUBLIC_INPUT_DOMAIN = "ROOT-OWNERSHIP-DESTINATION-v1";
const DESTINATION_PUBLIC_INPUT_ENCODING = "single-credential-destination-v1";
const CARDANO_PROOF_FORMAT = "groth16-bls12-381-bsb22";
const PROOF_SCHEMA = "root-ownership-proof-artifact-v1";

export type ClaimBuildPreflight = {
  deploymentId: string;
  draftId: string;
  selectedOutrefs: string[];
  destinationOutputStartIndex: number;
  orderedPaymentCredentials: string[];
  destinationOutputs: ClaimDraftResponse["destinationOutputs"];
  proofSummaries: Array<{
    outRefId: string;
    targetCredential: string;
    destinationAddress: string;
    proofHex: string;
    publicInputDigestHex: string;
  }>;
  reclaimGlobalRedeemerCbor: string;
};

type NormalizedProofArtifact = {
  outRefId: string;
  targetCredential: string;
  destinationAddress: string;
  proofHex: string;
  publicInputDigestHex: string;
};

export async function validateClaimBuildRequest(
  provider: Provider,
  deployment: ReclaimDeployment,
  request: ClaimBuildRequest,
): Promise<never> {
  const preflight = await prepareClaimBuildPreflight(provider, deployment, request);
  throw new UnsupportedClaimBuildError(preflight);
}

export async function prepareClaimBuildPreflight(
  provider: Provider,
  deployment: ReclaimDeployment,
  request: ClaimBuildRequest,
): Promise<ClaimBuildPreflight> {
  const raw = assertObject(request, "claim build request") as ClaimBuildRequest;
  assertExactDeploymentId(raw.deploymentId, deployment.id);
  assertWalletNetwork(raw.networkId, deployment.networkId);
  const draftId = assertDraftId(raw.draftId);
  const selectedOutrefs = assertOutRefList(raw.selectedOutrefs, "selectedOutrefs");
  if (selectedOutrefs.length === 0) {
    throw new ClaimValidationError("selected_outrefs_empty", "Claim build requires selected reclaim outrefs.");
  }
  assertWalletAddress(raw.safeWalletChangeAddress, deployment.network);
  assertWalletAddresses(raw.safeWalletAddresses, deployment.network);
  const draft = await createClaimDraft(provider, deployment, {
    deploymentId: deployment.id,
    networkId: deployment.networkId,
    selectedOutrefs,
    safeWalletChangeAddress: raw.safeWalletChangeAddress,
    safeWalletAddresses: raw.safeWalletAddresses,
  });
  if (draft.draftId !== draftId) {
    throw new ClaimValidationError("claim_draft_stale", "Claim draft no longer matches current chain data and safe-wallet destination.");
  }

  const proofs = assertProofArtifacts(raw.proofArtifacts, draft, deployment.verifierVkHash);
  const proofHexes = proofs.map((proof) => proof.proofHex);

  return {
    deploymentId: deployment.id,
    draftId,
    selectedOutrefs: selectedOutrefs.map(outRefId),
    destinationOutputStartIndex: draft.expectedDestinationOutputStartIndex,
    orderedPaymentCredentials: draft.orderedPaymentCredentials,
    destinationOutputs: draft.destinationOutputs,
    proofSummaries: proofs,
    reclaimGlobalRedeemerCbor: makeReclaimGlobalRedeemer(
      0,
      draft.expectedDestinationOutputStartIndex,
      proofHexes,
    ),
  };
}

export function validateClaimBuildRequestShape(deployment: ReclaimDeployment, request: ClaimBuildRequest): void {
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

function assertProofArtifacts(value: unknown, draft: ClaimDraftResponse, expectedVkHash: string): NormalizedProofArtifact[] {
  if (!Array.isArray(value)) {
    throw new ClaimValidationError("proof_artifacts_invalid", "Claim build requires destination-bound proof artifacts.");
  }
  if (value.length !== draft.orderedInputs.length) {
    throw new ClaimValidationError("proof_artifacts_count", "Proof artifact count must match selected reclaim inputs.");
  }

  return value.map((artifact, index) => {
    const expectedInput = draft.orderedInputs[index];
    const expectedOutput = draft.destinationOutputs[index];
    if (!expectedInput || !expectedOutput) {
      throw new ClaimValidationError("proof_artifacts_count", "Proof artifact count must match selected reclaim inputs.");
    }

    const raw = assertObject(artifact, `proofArtifacts[${index}]`);
    if (raw.path !== undefined || raw.paths !== undefined) {
      throw new ClaimValidationError("proof_artifact_path_metadata", "Backend-bound proof artifacts must not include derivation path metadata.");
    }
    const outRefIdValue = raw.out_ref ?? raw.outRef ?? raw.outRefId;
    if (outRefIdValue !== undefined && outRefIdValue !== null && artifactOutRefId(outRefIdValue, `proofArtifacts[${index}].out_ref`) !== expectedInput.outRefId) {
      throw new ClaimValidationError("proof_artifact_outref_order", "Proof artifact out_ref must match backend draft order.");
    }
    const body = assertObject(raw.artifact ?? raw, `proofArtifacts[${index}].artifact`);
    if (body.path !== undefined || body.paths !== undefined) {
      throw new ClaimValidationError("proof_artifact_path_metadata", "Backend-bound proof artifacts must not include derivation path metadata.");
    }
    if (body.schema !== PROOF_SCHEMA) {
      throw new ClaimValidationError("proof_artifact_schema", "Proof artifact schema is not supported.");
    }
    if (body.circuit_id !== DESTINATION_CIRCUIT_ID) {
      throw new ClaimValidationError("proof_artifact_circuit", "Proof artifact circuit id is not destination-bound.");
    }
    if (body.vk_hash !== expectedVkHash) {
      throw new ClaimValidationError("proof_artifact_vk_hash", "Proof artifact verifier key hash does not match deployment.");
    }
    if (body.target_credential !== expectedInput.paymentCredential) {
      throw new ClaimValidationError("proof_artifact_target_credential", "Proof artifact target credential does not match the ordered reclaim datum.");
    }
    if (body.destination_address_encoding !== DESTINATION_ADDRESS_V1_ENCODING) {
      throw new ClaimValidationError("proof_artifact_destination_encoding", "Proof artifact destination encoding is not supported.");
    }
    if (body.destination_address !== expectedOutput.destinationAddress) {
      throw new ClaimValidationError("proof_artifact_destination", "Proof artifact destination does not match the backend-computed destination.");
    }
    if (body.public_input_encoding !== DESTINATION_PUBLIC_INPUT_ENCODING) {
      throw new ClaimValidationError("proof_artifact_public_input_encoding", "Proof artifact public input encoding is not supported.");
    }
    const cardano = assertObject(body.cardano, `proofArtifacts[${index}].artifact.cardano`);
    if (cardano.format !== CARDANO_PROOF_FORMAT) {
      throw new ClaimValidationError("proof_artifact_cardano_format", "Proof artifact Cardano proof format is not supported.");
    }
    const proofHex = assertHex(cardano.proof_hex, `proofArtifacts[${index}].artifact.cardano.proof_hex`);
    const publicInputDigestHex = assertHex(
      cardano.public_input_digest_hex,
      `proofArtifacts[${index}].artifact.cardano.public_input_digest_hex`,
    );
    const expectedDigest = destinationPublicInputDigest(expectedInput.paymentCredential, expectedOutput.destinationAddress);
    if (publicInputDigestHex !== expectedDigest) {
      throw new ClaimValidationError("proof_artifact_public_input_digest", "Proof artifact public input digest does not match credential and destination.");
    }

    return {
      outRefId: expectedInput.outRefId,
      targetCredential: expectedInput.paymentCredential,
      destinationAddress: expectedOutput.destinationAddress,
      proofHex,
      publicInputDigestHex,
    };
  });
}

function destinationPublicInputDigest(credentialHex: string, destinationAddressHex: string): string {
  const preimage = Buffer.concat([
    Buffer.from(DESTINATION_PUBLIC_INPUT_DOMAIN, "utf8"),
    Buffer.from(credentialHex, "hex"),
    Buffer.from(destinationAddressHex, "hex"),
  ]);
  return Buffer.from(blake2b(new Uint8Array(preimage), { dkLen: 32 })).toString("hex");
}

function makeReclaimGlobalRedeemer(paramsIdx: number, destinationOutputStartIndex: number, proofs: string[]): string {
  return Data.to(new Constr(0, [BigInt(paramsIdx), BigInt(destinationOutputStartIndex), proofs]));
}

function outRefId(value: string | ClaimOutRef): string {
  if (typeof value === "string") {
    return value;
  }
  return `${value.txHash}#${value.outputIndex}`;
}

function artifactOutRefId(value: unknown, field: string): string {
  return outRefToString(assertOutRef(value, field));
}

export class UnsupportedClaimBuildError extends Error {
  readonly code = "claim_build_unsupported";
  readonly preflight?: ClaimBuildPreflight;

  constructor(preflight?: ClaimBuildPreflight) {
    super("Live claim transaction construction is not enabled for this deployment.");
    this.name = "UnsupportedClaimBuildError";
    this.preflight = preflight;
  }
}

export class UnsupportedClaimSubmitError extends Error {
  readonly code = "claim_submit_unsupported";

  constructor() {
    super("Live claim transaction submission is not enabled for this deployment.");
    this.name = "UnsupportedClaimSubmitError";
  }
}
