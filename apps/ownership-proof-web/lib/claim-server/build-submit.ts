import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import * as LucidExports from "@lucid-evolution/lucid";
import {
  CML,
  Constr,
  Data,
  Lucid,
  credentialToRewardAddress,
  scriptHashToCredential,
  type Assets,
  type Provider,
  type TransactionWitnesses,
  type UTxO,
} from "@lucid-evolution/lucid";
import type { BuildTxWithRedeemer, EvalRedeemer } from "@lucid-evolution/core-types";
import type { ReclaimDeployment, ReclaimReferenceScriptDeployment } from "../reclaim/types";
import {
  DESTINATION_ADDRESS_V1_ENCODING,
  type ClaimBuildResponse,
  type ClaimBuildRequest,
  type ClaimBuildReview,
  type ClaimDraftResponse,
  type ClaimOutRef,
  type ClaimSubmitResponse,
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
import { assertWalletAddresses, assertWalletAddress, assertWalletNetwork, assetMapToStringMap } from "../reclaim/validation";
import { createClaimDraft } from "./draft";

const DESTINATION_CIRCUIT_ID = "root-ownership-destination-v1/bls12-381/groth16";
const DESTINATION_PUBLIC_INPUT_DOMAIN = "ROOT-OWNERSHIP-DESTINATION-v1";
const DESTINATION_PUBLIC_INPUT_ENCODING = "single-credential-destination-v1";
const CARDANO_PROOF_FORMAT = "groth16-bls12-381-bsb22";
const PROOF_SCHEMA = "root-ownership-proof-artifact-v1";
const validatorToScriptHash = (LucidExports as unknown as {
  validatorToScriptHash: (script: NonNullable<UTxO["scriptRef"]>) => string;
}).validatorToScriptHash;

type ClaimReferenceScriptRole = "reclaim_base" | "reclaim_global";

type ClaimReferenceScriptInput = {
  role: ClaimReferenceScriptRole;
  outRefId: string;
  holderAddress: string;
  scriptHash: string;
  scriptType: NonNullable<UTxO["scriptRef"]>["type"];
};

type ClaimReferenceScriptsPreflight = {
  ready: boolean;
  missing: string[];
  inputs: ClaimReferenceScriptInput[];
};

export type ClaimBuildPreflight = {
  deploymentId: string;
  draftId: string;
  selectedOutrefs: string[];
  paramsReferenceInput: {
    outRefId: string;
    holderAddress: string;
    datumCbor: string;
  };
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
  referenceScripts: ClaimReferenceScriptsPreflight;
  missingBuildArtifacts: string[];
  buildReady: boolean;
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

export async function buildClaimTx(
  provider: Provider,
  deployment: ReclaimDeployment,
  request: ClaimBuildRequest,
): Promise<ClaimBuildResponse> {
  const preflight = await prepareClaimBuildPreflight(provider, deployment, request);
  if (!preflight.buildReady) {
    throw new UnsupportedClaimBuildError(preflight);
  }

  const raw = assertObject(request, "claim build request") as ClaimBuildRequest;
  const safeWalletChangeAddress = assertWalletAddress(raw.safeWalletChangeAddress, deployment.network);
  const safeWalletAddresses = assertWalletAddresses(raw.safeWalletAddresses, deployment.network);
  const buildInputs = await loadClaimBuildInputs(provider, deployment, preflight, safeWalletChangeAddress, safeWalletAddresses);
  const orderedOutrefs = claimTransactionInputOrder(preflight.selectedOutrefs);
  const orderedReclaimUtxos = orderUtxosByOutRef(buildInputs.reclaimUtxos, orderedOutrefs);
  const orderedDestinationOutputs = orderByOutRef(preflight.destinationOutputs, orderedOutrefs, (output) => output.outRefId);
  const proofByOutRef = new Map(preflight.proofSummaries.map((proof) => [proof.outRefId, proof]));
  const destinationOutputStartIndex = 0;
  const globalRedeemer = reclaimGlobalRedeemerBuilder({
    deployment,
    paramsOutRefId: preflight.paramsReferenceInput.outRefId,
    orderedOutrefs,
    proofByOutRef,
    destinationOutputStartIndex,
  });

  const lucid = await Lucid(provider, deployment.network);
  lucid.selectWallet.fromAddress(safeWalletChangeAddress, buildInputs.safeWalletUtxos);

  let tx = lucid
    .newTx()
    .readFrom([buildInputs.paramsUtxo, ...buildInputs.referenceScriptUtxos])
    .collectFrom(orderedReclaimUtxos, Data.void())
    .withdraw(reclaimGlobalRewardAddress(deployment), 0n, globalRedeemer);

  for (const output of orderedDestinationOutputs) {
    tx = tx.pay.ToAddress(output.address, assetsFromStringMap(output.value));
  }

  const signBuilder = await tx.complete({
    canonical: true,
    changeAddress: safeWalletChangeAddress,
    localUPLCEval: false,
    presetWalletInputs: buildInputs.safeWalletUtxos,
  });
  const txCbor = signBuilder.toCBOR({ canonical: true });
  const txHash = signBuilder.toHash();
  const inspectedHash = parseTransactionHash(txCbor, "claim unsigned tx");
  if (inspectedHash !== txHash) {
    throw new ClaimValidationError("claim_build_tx_hash_mismatch", "Built claim transaction hash is inconsistent.");
  }

  const protocol = await provider.getProtocolParameters();
  const evaluationRedeemers = await provider.evaluateTx(txCbor, dedupeUtxos([
    ...buildInputs.safeWalletUtxos,
    ...orderedReclaimUtxos,
    buildInputs.paramsUtxo,
    ...buildInputs.referenceScriptUtxos,
  ]));
  const evaluation = summarizeEvaluation(evaluationRedeemers, protocol);
  if (evaluation.memoryPercent !== null && deployment.batching && evaluation.memoryPercent > deployment.batching.max_tx_mem_percent) {
    throw new ClaimValidationError("claim_evaluation_margin_exceeded", "Claim transaction memory execution units exceed the configured deployment margin.");
  }
  if (evaluation.cpuPercent !== null && deployment.batching && evaluation.cpuPercent > deployment.batching.max_tx_cpu_percent) {
    throw new ClaimValidationError("claim_evaluation_margin_exceeded", "Claim transaction CPU execution units exceed the configured deployment margin.");
  }

  const review = {
    deploymentId: deployment.id,
    draftId: preflight.draftId,
    selectedOutrefs: preflight.selectedOutrefs,
    transactionInputOrder: orderedOutrefs,
    destinationOutputStartIndex,
    destinationOutputs: orderedDestinationOutputs,
    paramsReferenceInput: preflight.paramsReferenceInput,
    referenceScriptInputs: preflight.referenceScripts.inputs,
    proofDigests: orderedOutrefs.map((outRefIdValue) => {
      const proof = proofByOutRef.get(outRefIdValue);
      if (!proof) {
        throw new ClaimValidationError("proof_artifacts_count", "Proof artifact count must match selected reclaim inputs.");
      }
      return {
        outRefId: proof.outRefId,
        targetCredential: proof.targetCredential,
        destinationAddress: proof.destinationAddress,
        publicInputDigestHex: proof.publicInputDigestHex,
      };
    }),
  };
  const reviewHash = hashClaimBuildReview(review);
  return {
    txCbor,
    txHash,
    review,
    reviewHash,
    reviewToken: signClaimBuildReviewToken(deployment, {
      txHash,
      txCborHash: sha256Hex(txCbor),
      reviewHash,
    }),
    evaluation,
  };
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
  const paramsReferenceInput = await loadParamsReferenceInput(provider, deployment);
  const referenceScripts = await loadClaimReferenceScripts(provider, deployment);

  return {
    deploymentId: deployment.id,
    draftId,
    selectedOutrefs: selectedOutrefs.map(outRefId),
    paramsReferenceInput,
    destinationOutputStartIndex: draft.expectedDestinationOutputStartIndex,
    orderedPaymentCredentials: draft.orderedPaymentCredentials,
    destinationOutputs: draft.destinationOutputs,
    proofSummaries: proofs,
    referenceScripts,
    missingBuildArtifacts: referenceScripts.missing,
    buildReady: referenceScripts.ready,
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

export function validateClaimSubmitRequest(deployment: ReclaimDeployment, request: ClaimSubmitRequest): void {
  const raw = assertObject(request, "claim submit request") as ClaimSubmitRequest;
  assertExactDeploymentId(raw.deploymentId, deployment.id);
  const selectedOutrefs = assertOutRefList(raw.selectedOutrefs, "selectedOutrefs");
  if (selectedOutrefs.length === 0) {
    throw new ClaimValidationError("selected_outrefs_empty", "Claim submit requires selected reclaim outrefs.");
  }
  if (raw.signedTxCbor !== undefined) {
    assertCborHex(raw.signedTxCbor, "signedTxCbor");
  }
  if (raw.unsignedTxCbor !== undefined) {
    assertCborHex(raw.unsignedTxCbor, "unsignedTxCbor");
  }
  if (raw.witnessSetCbor !== undefined) {
    assertCborHex(raw.witnessSetCbor, "witnessSetCbor");
  }
  if (typeof raw.claimBuildReviewToken !== "string" || raw.claimBuildReviewToken.trim() === "") {
    throw new ClaimValidationError("claim_submit_review_required", "Claim submit requires a reviewed claim build token.");
  }
  if (!raw.review) {
    throw new ClaimValidationError("claim_submit_review_required", "Claim submit requires the reviewed claim build summary.");
  }
  if (!raw.signedTxCbor && (!raw.unsignedTxCbor || !raw.witnessSetCbor)) {
    throw new ClaimValidationError("claim_submit_signed_tx_required", "Claim submit requires signedTxCbor or unsignedTxCbor plus witnessSetCbor.");
  }
}

export async function submitClaimTx(
  provider: Provider,
  deployment: ReclaimDeployment,
  request: ClaimSubmitRequest,
): Promise<ClaimSubmitResponse> {
  validateClaimSubmitRequest(deployment, request);
  const raw = request as Required<Pick<ClaimSubmitRequest, "claimBuildReviewToken" | "review">> & ClaimSubmitRequest;
  const inspection = await inspectClaimSubmitRequest(provider, deployment, raw);
  const submittedHash = await provider.submitTx(inspection.signedTxCbor);
  if (submittedHash !== inspection.txHash) {
    throw new ClaimValidationError("claim_submit_hash_mismatch", "Provider returned a transaction hash that does not match the reviewed claim transaction.");
  }
  return {
    txHash: submittedHash,
    deploymentId: deployment.id,
    selectedOutrefs: inspection.review.selectedOutrefs,
    reviewHash: inspection.reviewHash,
    provider: {
      submitted: true,
    },
    progress: {
      pollAfterSeconds: 20,
    },
  };
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

function makeReclaimGlobalRedeemer(paramsIdx: number | bigint, destinationOutputStartIndex: number | bigint, proofs: string[]): string {
  return Data.to(new Constr(0, [BigInt(paramsIdx), BigInt(destinationOutputStartIndex), proofs]));
}

async function loadParamsReferenceInput(
  provider: Provider,
  deployment: ReclaimDeployment,
): Promise<ClaimBuildPreflight["paramsReferenceInput"]> {
  if (!deployment.paramsUtxo) {
    throw new ClaimValidationError("claim_params_missing", "Reclaim deployment is missing the parameter reference UTxO.");
  }
  const outRef = {
    txHash: deployment.paramsUtxo.tx_hash,
    outputIndex: deployment.paramsUtxo.output_index,
  };
  const outRefIdValue = outRefToString(outRef);
  const utxos = await provider.getUtxosByOutRef([outRef]);
  const paramsUtxo = utxos.find((utxo) => outRefToString(utxo) === outRefIdValue);
  if (!paramsUtxo) {
    throw new ClaimValidationError("claim_params_not_found", "Parameter reference UTxO is spent or unavailable.");
  }
  assertParamsUtxo(paramsUtxo, deployment);
  return {
    outRefId: outRefIdValue,
    holderAddress: paramsUtxo.address,
    datumCbor: paramsUtxo.datum ?? "",
  };
}

function assertParamsUtxo(utxo: UTxO, deployment: ReclaimDeployment): void {
  const params = deployment.paramsUtxo;
  if (!params) {
    throw new ClaimValidationError("claim_params_missing", "Reclaim deployment is missing the parameter reference UTxO.");
  }
  if (utxo.address !== params.holder_address) {
    throw new ClaimValidationError("claim_params_wrong_address", "Parameter reference UTxO is not at the configured holder address.");
  }
  const unit = `${params.policy_id}${params.token_name}`;
  if (utxo.assets[unit] !== 1n) {
    throw new ClaimValidationError("claim_params_token_missing", "Parameter reference UTxO does not contain exactly one configured parameter NFT.");
  }
  for (const [assetUnit, amount] of Object.entries(utxo.assets)) {
    if (assetUnit !== "lovelace" && assetUnit.startsWith(params.policy_id) && (assetUnit !== unit || amount !== 1n)) {
      throw new ClaimValidationError("claim_params_token_mismatch", "Parameter reference UTxO contains unexpected tokens under the parameter policy.");
    }
  }
  const expectedDatum = Data.to(new Constr(0, [deployment.reclaimBaseScriptHash]));
  if (!utxo.datum || utxo.datum.toLowerCase() !== expectedDatum) {
    throw new ClaimValidationError("claim_params_datum_mismatch", "Parameter reference datum does not bind the configured ReclaimBase script hash.");
  }
}

async function loadClaimBuildInputs(
  provider: Provider,
  deployment: ReclaimDeployment,
  preflight: ClaimBuildPreflight,
  safeWalletChangeAddress: string,
  safeWalletAddresses: string[],
): Promise<{
  reclaimUtxos: UTxO[];
  safeWalletUtxos: UTxO[];
  paramsUtxo: UTxO;
  referenceScriptUtxos: UTxO[];
}> {
  const selectedOutrefs = preflight.selectedOutrefs.map((outRefIdValue) => assertOutRef(outRefIdValue, "selectedOutrefs"));
  const selectedIds = new Set(preflight.selectedOutrefs);
  const loadedSelected = await provider.getUtxosByOutRef(selectedOutrefs);
  const reclaimUtxos = loadedSelected.filter((utxo) => selectedIds.has(outRefToString(utxo)));
  if (reclaimUtxos.length !== preflight.selectedOutrefs.length) {
    throw new ClaimValidationError("selected_outref_not_found", "Selected reclaim UTxOs are spent or unavailable.");
  }
  for (const utxo of reclaimUtxos) {
    assertReclaimUtxoMatchesPreflight(utxo, deployment, preflight);
  }

  const paramsOutRef = assertOutRef(preflight.paramsReferenceInput.outRefId, "paramsReferenceInput.outRefId");
  const paramsUtxos = await provider.getUtxosByOutRef([paramsOutRef]);
  const paramsUtxo = paramsUtxos.find((utxo) => outRefToString(utxo) === preflight.paramsReferenceInput.outRefId);
  if (!paramsUtxo) {
    throw new ClaimValidationError("claim_params_not_found", "Parameter reference UTxO is spent or unavailable.");
  }
  assertParamsUtxo(paramsUtxo, deployment);

  const referenceScriptOutrefs = preflight.referenceScripts.inputs.map((input) => assertOutRef(input.outRefId, "referenceScripts.inputs.outRefId"));
  const loadedReferenceScripts = await provider.getUtxosByOutRef(referenceScriptOutrefs);
  const referenceScriptUtxos = orderUtxosByOutRef(
    loadedReferenceScripts,
    preflight.referenceScripts.inputs.map((input) => input.outRefId),
  );
  for (const input of preflight.referenceScripts.inputs) {
    const referenceScript = input.role === "reclaim_base" ? deployment.referenceScripts?.reclaimBase : deployment.referenceScripts?.reclaimGlobal;
    const expectedScriptHash = input.role === "reclaim_base" ? deployment.reclaimBaseScriptHash : deployment.reclaimGlobalScriptHash;
    const utxo = referenceScriptUtxos.find((candidate) => outRefToString(candidate) === input.outRefId);
    if (!referenceScript || !utxo) {
      throw new ClaimValidationError("claim_reference_script_not_found", `${input.role} reference script UTxO is spent or unavailable.`);
    }
    assertReferenceScriptUtxo(input.role, utxo, referenceScript, expectedScriptHash);
  }

  const safeWalletUtxos = await loadSafeWalletUtxos(provider, safeWalletChangeAddress, safeWalletAddresses);
  return {
    reclaimUtxos,
    safeWalletUtxos,
    paramsUtxo,
    referenceScriptUtxos,
  };
}

function assertReclaimUtxoMatchesPreflight(utxo: UTxO, deployment: ReclaimDeployment, preflight: ClaimBuildPreflight): void {
  if (utxo.address !== deployment.reclaimBaseAddress) {
    throw new ClaimValidationError("selected_outref_wrong_address", "Selected outref is not locked at the current ReclaimBase address.");
  }
  const outRefIdValue = outRefToString(utxo);
  const expectedOutput = preflight.destinationOutputs.find((output) => output.outRefId === outRefIdValue);
  if (!expectedOutput) {
    throw new ClaimValidationError("claim_draft_stale", "Claim draft no longer matches selected reclaim inputs.");
  }
  if (stableStringify(assetMapToStringMap(utxo.assets)) !== stableStringify(expectedOutput.value)) {
    throw new ClaimValidationError("claim_draft_stale", "Selected reclaim value changed after draft creation.");
  }
}

async function loadSafeWalletUtxos(provider: Provider, changeAddress: string, walletAddresses: string[]): Promise<UTxO[]> {
  const queryAddresses = [...new Set([changeAddress, ...walletAddresses])];
  const utxoGroups = await Promise.all(queryAddresses.map((address) => provider.getUtxos(address)));
  const utxos = dedupeUtxos(utxoGroups.flat());
  if (utxos.length === 0) {
    throw new ClaimValidationError("safe_wallet_lovelace_unavailable", "Safe wallet must have UTxOs available for claim fees and collateral.");
  }
  return utxos;
}

async function loadClaimReferenceScripts(provider: Provider, deployment: ReclaimDeployment): Promise<ClaimReferenceScriptsPreflight> {
  const missing = missingReferenceScriptArtifacts(deployment);
  if (missing.length > 0) {
    return {
      ready: false,
      missing,
      inputs: [],
    };
  }

  const configured = deployment.referenceScripts;
  if (!configured) {
    throw new ClaimValidationError("claim_reference_scripts_missing", "Reclaim deployment is missing claim reference script metadata.");
  }
  const expected = [
    {
      role: "reclaim_base" as const,
      referenceScript: configured.reclaimBase,
      expectedScriptHash: deployment.reclaimBaseScriptHash,
    },
    {
      role: "reclaim_global" as const,
      referenceScript: configured.reclaimGlobal,
      expectedScriptHash: deployment.reclaimGlobalScriptHash,
    },
  ];
  const utxos = await provider.getUtxosByOutRef(expected.map((entry) => referenceScriptOutRef(entry.referenceScript)));
  const inputs = expected.map((entry) => {
    const outRefIdValue = referenceScriptOutRefId(entry.referenceScript);
    const utxo = utxos.find((candidate) => outRefToString(candidate) === outRefIdValue);
    if (!utxo) {
      throw new ClaimValidationError("claim_reference_script_not_found", `${entry.role} reference script UTxO is spent or unavailable.`);
    }
    return assertReferenceScriptUtxo(entry.role, utxo, entry.referenceScript, entry.expectedScriptHash);
  });

  return {
    ready: true,
    missing: [],
    inputs,
  };
}

function missingReferenceScriptArtifacts(deployment: ReclaimDeployment): string[] {
  const missing: string[] = [];
  if (!deployment.referenceScripts?.reclaimBase) {
    missing.push("reference_scripts.reclaim_base");
  }
  if (!deployment.referenceScripts?.reclaimGlobal) {
    missing.push("reference_scripts.reclaim_global");
  }
  return missing;
}

function referenceScriptOutRef(referenceScript: ReclaimReferenceScriptDeployment) {
  return {
    txHash: referenceScript.tx_hash,
    outputIndex: referenceScript.output_index,
  };
}

function referenceScriptOutRefId(referenceScript: ReclaimReferenceScriptDeployment): string {
  return outRefToString(referenceScriptOutRef(referenceScript));
}

function assertReferenceScriptUtxo(
  role: ClaimReferenceScriptRole,
  utxo: UTxO,
  referenceScript: ReclaimReferenceScriptDeployment,
  expectedScriptHash: string,
): ClaimReferenceScriptInput {
  const outRefIdValue = referenceScriptOutRefId(referenceScript);
  if (referenceScript.holder_address && utxo.address !== referenceScript.holder_address) {
    throw new ClaimValidationError("claim_reference_script_wrong_address", `${role} reference script UTxO is not at the configured holder address.`);
  }
  if (referenceScript.script_hash !== expectedScriptHash) {
    throw new ClaimValidationError("claim_reference_script_hash_mismatch", `${role} reference script hash does not match deployment script hash.`);
  }
  if (!utxo.scriptRef) {
    throw new ClaimValidationError("claim_reference_script_missing_script_ref", `${role} reference script UTxO is missing a reference script.`);
  }
  if (utxo.scriptRef.type !== "PlutusV3") {
    throw new ClaimValidationError("claim_reference_script_wrong_type", `${role} reference script must be PlutusV3.`);
  }
  const actualScriptHash = referenceScriptHash(role, utxo.scriptRef);
  if (actualScriptHash !== referenceScript.script_hash) {
    throw new ClaimValidationError("claim_reference_script_hash_mismatch", `${role} reference script hash does not match the scriptRef bytes.`);
  }
  return {
    role,
    outRefId: outRefIdValue,
    holderAddress: utxo.address,
    scriptHash: actualScriptHash,
    scriptType: utxo.scriptRef.type,
  };
}

function referenceScriptHash(role: ClaimReferenceScriptRole, scriptRef: NonNullable<UTxO["scriptRef"]>): string {
  try {
    return validatorToScriptHash(scriptRef).toLowerCase();
  } catch {
    throw new ClaimValidationError("claim_reference_script_invalid", `${role} reference script bytes are invalid.`);
  }
}

function reclaimGlobalRedeemerBuilder(input: {
  deployment: ReclaimDeployment;
  paramsOutRefId: string;
  orderedOutrefs: string[];
  proofByOutRef: Map<string, NormalizedProofArtifact>;
  destinationOutputStartIndex: number;
}): BuildTxWithRedeemer {
  return (ctx) => {
    const paramsIdx = ctx.referenceInputs.findIndex((utxo) => outRefToString(utxo) === input.paramsOutRefId);
    if (paramsIdx < 0) {
      throw new Error("claim params reference input missing from final transaction context");
    }
    const selected = new Set(input.orderedOutrefs);
    const finalReclaimOrder = ctx.inputs
      .filter((utxo) => selected.has(outRefToString(utxo)) && utxo.address === input.deployment.reclaimBaseAddress)
      .map(outRefToString);
    if (finalReclaimOrder.length !== input.orderedOutrefs.length || finalReclaimOrder.join("|") !== input.orderedOutrefs.join("|")) {
      throw new Error("claim transaction input order changed after destination outputs were fixed");
    }
    const proofs = finalReclaimOrder.map((outRefIdValue) => {
      const proof = input.proofByOutRef.get(outRefIdValue);
      if (!proof) {
        throw new Error("claim proof missing for final transaction input order");
      }
      return proof.proofHex;
    });
    return makeReclaimGlobalRedeemer(BigInt(paramsIdx), BigInt(input.destinationOutputStartIndex), proofs);
  };
}

function reclaimGlobalRewardAddress(deployment: ReclaimDeployment): string {
  const scriptHash = deployment.reclaimGlobalRewardingCredential ?? deployment.reclaimGlobalCredential;
  return credentialToRewardAddress(deployment.network, scriptHashToCredential(scriptHash));
}

function claimTransactionInputOrder(outrefs: string[]): string[] {
  return [...outrefs].sort(compareOutRefIds);
}

function compareOutRefIds(left: string, right: string): number {
  const leftOutRef = assertOutRef(left, "leftOutRef");
  const rightOutRef = assertOutRef(right, "rightOutRef");
  const txHashCompare = leftOutRef.txHash.localeCompare(rightOutRef.txHash);
  if (txHashCompare !== 0) {
    return txHashCompare;
  }
  return leftOutRef.outputIndex - rightOutRef.outputIndex;
}

function orderUtxosByOutRef(utxos: UTxO[], orderedOutrefs: string[]): UTxO[] {
  return orderByOutRef(utxos, orderedOutrefs, outRefToString);
}

function orderByOutRef<T>(items: T[], orderedOutrefs: string[], getOutRefId: (item: T) => string): T[] {
  const byOutRef = new Map(items.map((item) => [getOutRefId(item), item]));
  return orderedOutrefs.map((outRefIdValue) => {
    const item = byOutRef.get(outRefIdValue);
    if (!item) {
      throw new ClaimValidationError("selected_outref_not_found", "Selected reclaim UTxOs are spent or unavailable.");
    }
    return item;
  });
}

function dedupeUtxos(utxos: UTxO[]): UTxO[] {
  const seen = new Set<string>();
  const deduped: UTxO[] = [];
  for (const utxo of utxos) {
    const outRefIdValue = outRefToString(utxo);
    if (seen.has(outRefIdValue)) {
      continue;
    }
    seen.add(outRefIdValue);
    deduped.push(utxo);
  }
  return deduped;
}

function assetsFromStringMap(value: Record<string, string>): Assets {
  const assets: Assets = {};
  for (const [unit, rawAmount] of Object.entries(value)) {
    if (!/^\d+$/u.test(rawAmount)) {
      throw new ClaimValidationError("claim_value_invalid", "Claim destination output value is malformed.");
    }
    assets[unit] = BigInt(rawAmount);
  }
  return assets;
}

function summarizeEvaluation(
  redeemers: EvalRedeemer[],
  protocol: Awaited<ReturnType<Provider["getProtocolParameters"]>>,
): ClaimBuildResponse["evaluation"] {
  const totalMemory = redeemers.reduce((sum, redeemer) => sum + BigInt(redeemer.ex_units.mem), 0n);
  const totalSteps = redeemers.reduce((sum, redeemer) => sum + BigInt(redeemer.ex_units.steps), 0n);
  const memoryPercent = protocol.maxTxExMem > 0n ? percentCeil(totalMemory, protocol.maxTxExMem) : null;
  const cpuPercent = protocol.maxTxExSteps > 0n ? percentCeil(totalSteps, protocol.maxTxExSteps) : null;
  return {
    redeemers: redeemers.map((redeemer) => ({
      tag: redeemer.redeemer_tag,
      index: redeemer.redeemer_index,
      memory: redeemer.ex_units.mem,
      steps: redeemer.ex_units.steps,
    })),
    totalMemory: totalMemory.toString(),
    totalSteps: totalSteps.toString(),
    memoryPercent,
    cpuPercent,
  };
}

function percentCeil(value: bigint, max: bigint): number {
  return Number((value * 100n + max - 1n) / max);
}

function parseTransactionHash(txCbor: string, field: string): string {
  try {
    const tx = CML.Transaction.from_cbor_hex(txCbor);
    const hash = CML.hash_transaction(tx.body()).to_hex();
    tx.free();
    return hash;
  } catch {
    throw new ClaimValidationError("claim_tx_cbor_invalid", `${field} must be valid Cardano transaction CBOR.`);
  }
}

async function inspectClaimSubmitRequest(
  provider: Provider,
  deployment: ReclaimDeployment,
  request: Required<Pick<ClaimSubmitRequest, "claimBuildReviewToken" | "review">> & ClaimSubmitRequest,
): Promise<{
  txHash: string;
  signedTxCbor: string;
  review: ClaimBuildReview;
  reviewHash: string;
}> {
  const review = assertClaimBuildReview(request.review, deployment);
  const selectedOutrefs = assertOutRefList(request.selectedOutrefs, "selectedOutrefs").map(outRefToString);
  if (selectedOutrefs.join("|") !== review.selectedOutrefs.join("|")) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim submit selected outrefs do not match the reviewed claim build.");
  }
  const reviewHash = hashClaimBuildReview(review);
  const token = verifyClaimBuildReviewToken(deployment, request.claimBuildReviewToken);
  if (token.reviewHash !== reviewHash) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review token does not match the reviewed claim build summary.");
  }

  const unsignedTxCbor = request.unsignedTxCbor ? assertCborHex(request.unsignedTxCbor, "unsignedTxCbor") : "";
  if (unsignedTxCbor && token.txCborHash !== sha256Hex(unsignedTxCbor)) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review token does not match the reviewed unsigned transaction.");
  }

  const signedTxCbor = request.signedTxCbor
    ? assertCborHex(request.signedTxCbor, "signedTxCbor")
    : await assembleClaimWitnessSet(provider, deployment, unsignedTxCbor, request.witnessSetCbor);
  const signedTxHash = parseTransactionHash(signedTxCbor, "signedTxCbor");
  if (signedTxHash !== token.txHash) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Signed claim transaction body does not match the reviewed build.");
  }
  if (unsignedTxCbor) {
    const unsignedTxHash = parseTransactionHash(unsignedTxCbor, "unsignedTxCbor");
    if (unsignedTxHash !== signedTxHash) {
      throw new ClaimValidationError("claim_submit_review_mismatch", "Signed claim transaction body does not match unsignedTxCbor.");
    }
  }

  return {
    txHash: signedTxHash,
    signedTxCbor,
    review,
    reviewHash,
  };
}

async function assembleClaimWitnessSet(
  provider: Provider,
  deployment: ReclaimDeployment,
  unsignedTxCbor: string,
  witnessSetCbor: unknown,
): Promise<string> {
  if (!unsignedTxCbor) {
    throw new ClaimValidationError("claim_submit_signed_tx_required", "Claim submit requires unsignedTxCbor when witnessSetCbor is provided.");
  }
  const witnessSet = assertCborHex(witnessSetCbor, "witnessSetCbor");
  const lucid = await Lucid(provider, deployment.network);
  const signedTx = await lucid.fromTx(unsignedTxCbor).assemble([witnessSet as TransactionWitnesses]).complete();
  return signedTx.toCBOR({ canonical: true });
}

function assertClaimBuildReview(value: unknown, deployment: ReclaimDeployment): ClaimBuildReview {
  const review = assertObject(value, "review") as ClaimBuildReview;
  assertExactDeploymentId(review.deploymentId, deployment.id);
  assertDraftId(review.draftId);
  const selectedOutrefs = assertOutRefList(review.selectedOutrefs, "review.selectedOutrefs").map(outRefToString);
  const transactionInputOrder = assertOutRefList(review.transactionInputOrder, "review.transactionInputOrder").map(outRefToString);
  if (selectedOutrefs.length === 0 || transactionInputOrder.length !== selectedOutrefs.length) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review input order is malformed.");
  }
  if (!Number.isInteger(review.destinationOutputStartIndex) || review.destinationOutputStartIndex < 0) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review destination output index is malformed.");
  }
  if (!Array.isArray(review.destinationOutputs) || review.destinationOutputs.length !== selectedOutrefs.length) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review destination outputs are malformed.");
  }
  if (!Array.isArray(review.referenceScriptInputs) || review.referenceScriptInputs.length !== 2) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review reference scripts are malformed.");
  }
  if (!Array.isArray(review.proofDigests) || review.proofDigests.length !== selectedOutrefs.length) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review proof digests are malformed.");
  }
  return {
    deploymentId: review.deploymentId,
    draftId: review.draftId,
    selectedOutrefs,
    transactionInputOrder,
    destinationOutputStartIndex: review.destinationOutputStartIndex,
    destinationOutputs: review.destinationOutputs,
    paramsReferenceInput: {
      outRefId: outRefToString(assertOutRef(review.paramsReferenceInput?.outRefId, "review.paramsReferenceInput.outRefId")),
      holderAddress: String(review.paramsReferenceInput?.holderAddress ?? ""),
      datumCbor: assertCborHex(review.paramsReferenceInput?.datumCbor, "review.paramsReferenceInput.datumCbor"),
    },
    referenceScriptInputs: review.referenceScriptInputs,
    proofDigests: review.proofDigests,
  };
}

function hashClaimBuildReview(review: ClaimBuildResponse["review"]): string {
  return sha256Hex(stableStringify(review));
}

function signClaimBuildReviewToken(
  deployment: ReclaimDeployment,
  payload: { txHash: string; txCborHash: string; reviewHash: string },
): string {
  const body = stableStringify({
    v: 1,
    kind: "claim-build",
    deploymentId: deployment.id,
    network: deployment.network,
    ...payload,
  });
  const signature = createHmac("sha256", reviewTokenSecret()).update(body).digest("hex");
  return `v1.${Buffer.from(body, "utf8").toString("base64url")}.${signature}`;
}

function verifyClaimBuildReviewToken(
  deployment: ReclaimDeployment,
  token: string,
): { txHash: string; txCborHash: string; reviewHash: string } {
  const [version, encoded, signature, extra] = token.split(".");
  if (version !== "v1" || !encoded || !signature || extra !== undefined) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review token is malformed.");
  }
  const body = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = createHmac("sha256", reviewTokenSecret()).update(body).digest("hex");
  if (!safeEqualHex(signature, expected)) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review token signature is invalid.");
  }
  const parsed = JSON.parse(body) as {
    v?: unknown;
    kind?: unknown;
    deploymentId?: unknown;
    network?: unknown;
    txHash?: unknown;
    txCborHash?: unknown;
    reviewHash?: unknown;
  };
  if (parsed.v !== 1 || parsed.kind !== "claim-build" || parsed.deploymentId !== deployment.id || parsed.network !== deployment.network) {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review token was issued for a different deployment.");
  }
  if (typeof parsed.txHash !== "string" || typeof parsed.txCborHash !== "string" || typeof parsed.reviewHash !== "string") {
    throw new ClaimValidationError("claim_submit_review_mismatch", "Claim build review token payload is malformed.");
  }
  return {
    txHash: parsed.txHash,
    txCborHash: parsed.txCborHash,
    reviewHash: parsed.reviewHash,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reviewTokenSecret(): string {
  const secret = process.env.RECLAIM_REVIEW_TOKEN_SECRET?.trim();
  if (!secret) {
    throw new Error("RECLAIM_REVIEW_TOKEN_SECRET is required for claim transaction review tokens.");
  }
  return secret;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/iu.test(left) || !/^[0-9a-f]+$/iu.test(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
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
  readonly reason: string;
  readonly missingBuildArtifacts: string[];

  constructor(preflight?: ClaimBuildPreflight) {
    super("Live claim transaction construction is not enabled for this deployment.");
    this.name = "UnsupportedClaimBuildError";
    this.preflight = preflight;
    this.reason = preflight?.buildReady ? "transaction_builder_not_implemented" : "build_prerequisites_missing";
    this.missingBuildArtifacts = preflight?.missingBuildArtifacts ?? [];
  }
}
