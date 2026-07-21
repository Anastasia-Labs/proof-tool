import { createHash } from "crypto";
import type { Provider, UTxO } from "@lucid-evolution/lucid";
import type { ReclaimDeployment } from "../reclaim/types";
import {
  assertWalletAddresses,
  assertWalletAddress,
  assertWalletNetwork,
  assetMapToStringMap,
  sumUtxoAssets,
} from "../reclaim/validation";
import {
  CLAIM_DEFAULT_BATCH_CAP,
  CLAIM_DISTINCT_7_MAX_TX_CPU_PERCENT,
  CLAIM_DISTINCT_7_MAX_TX_MEM_PERCENT,
  CLAIM_HARD_BATCH_CAP,
  CLAIM_OPTIMIZATION_BATCH_CAP,
  DESTINATION_ADDRESS_V1_ENCODING,
  type ClaimDraftDestinationOutput,
  type ClaimDraftInput,
  type ClaimDraftRequest,
  type ClaimDraftResponse,
  type ClaimOutRef,
  type ClaimProofRequest,
} from "../claim/types";
import { destinationAddressV1, assertSafeWalletAddress } from "../claim/addresses";
import { parseReclaimBaseDatum } from "../claim/datum";
import {
  assertExactDeploymentId,
  assertObject,
  assertOutRefList,
  ClaimValidationError,
  outRefToString,
} from "../claim/validation";
import { compareIndexedUtxos, confirmationSlot, toIndexedReclaimUtxo } from "./indexer";
import { outRefsForProvider, supportsOutRefLookup } from "./provider";

const MIN_SAFE_WALLET_LOVELACE = 5_000_000n;
type ClaimBatchPolicy = {
  defaultCap: number;
  hardCap: number;
};

export async function createClaimDraft(
  provider: Provider,
  deployment: ReclaimDeployment,
  request: ClaimDraftRequest,
): Promise<ClaimDraftResponse> {
  const raw = assertObject(request, "claim draft request") as ClaimDraftRequest;
  assertExactDeploymentId(raw.deploymentId, deployment.id);
  assertWalletNetwork(raw.networkId, deployment.networkId);

  const safeWallet = await loadSafeWallet(provider, deployment, raw);
  const batchPolicy = deploymentBatchPolicy(deployment);
  const requestedCap = assertBatchCap(raw.maxUtxos, batchPolicy);
  const pendingOutrefs = new Set(assertOutRefList(raw.pendingOutrefs, "pendingOutrefs").map(outRefToString));
  const selectedOutrefs = assertOutRefList(raw.selectedOutrefs, "selectedOutrefs");

  let reclaimUtxos: UTxO[];
  const reductions: string[] = [];
  if (selectedOutrefs.length > 0) {
    if (selectedOutrefs.length > requestedCap) {
      throw new ClaimValidationError("batch_cap_exceeded", `Claim batch cannot exceed ${requestedCap} UTxOs.`);
    }
    const pendingSelection = selectedOutrefs.map(outRefToString).filter((outRefId) => pendingOutrefs.has(outRefId));
    if (pendingSelection.length > 0) {
      throw new ClaimValidationError("selected_outref_pending", "Selected reclaim UTxOs include pending outrefs.");
    }
    reclaimUtxos = await loadSelectedReclaimUtxos(provider, selectedOutrefs);
  } else {
    if (raw.nextBatch !== true) {
      throw new ClaimValidationError("claim_batch_selection_required", "Claim draft requires selected outrefs or nextBatch=true.");
    }
    const allUtxos = await provider.getUtxos(deployment.reclaimBaseAddress);
    const eligible = allUtxos
      .filter((utxo) => !pendingOutrefs.has(outRefToString(utxo)))
      .filter((utxo) => utxo.address === deployment.reclaimBaseAddress)
      .filter((utxo) => toIndexedReclaimUtxo(utxo, deployment).datum.status === "valid")
      .sort((left, right) => compareIndexedUtxos(toIndexedReclaimUtxo(left, deployment), toIndexedReclaimUtxo(right, deployment)));
    if (eligible.length > requestedCap) {
      reductions.push(`reduced_to_batch_cap_${requestedCap}`);
    }
    reclaimUtxos = eligible.slice(0, requestedCap);
  }

  if (reclaimUtxos.length === 0) {
    throw new ClaimValidationError("claim_batch_empty", "No reclaim UTxOs are available for this draft.");
  }
  if (reclaimUtxos.length > requestedCap || reclaimUtxos.length > batchPolicy.hardCap) {
    throw new ClaimValidationError("batch_cap_exceeded", "Claim batch exceeds the configured UTxO cap.");
  }

  const orderedInputs = reclaimUtxos
    .map((utxo) => reclaimDraftInputFromUtxo(utxo, deployment))
    .sort(compareDraftInputs);
  const orderedPaymentCredentials = orderedInputs.map((input) => input.paymentCredential);
  const destinationBytes = destinationAddressV1(safeWallet.changeAddress, deployment.networkId);
  const destinationOutputs: ClaimDraftDestinationOutput[] = orderedInputs.map((input) => ({
    outRefId: input.outRefId,
    address: safeWallet.changeAddress,
    destinationAddressEncoding: DESTINATION_ADDRESS_V1_ENCODING,
    destinationAddress: destinationBytes,
    value: input.value,
  }));
  const proofRequests: ClaimProofRequest[] = orderedInputs.map((input) => ({
    out_ref: input.outRefId,
    target_credential: input.paymentCredential,
    destination_address_encoding: DESTINATION_ADDRESS_V1_ENCODING,
    destination_address: destinationBytes,
  }));

  const draftMaterial = {
    deploymentId: deployment.id,
    networkId: deployment.networkId,
    orderedInputs,
    destinationOutputs,
    proofRequests,
  };
  const draftId = createHash("sha256").update(stableJson(draftMaterial)).digest("hex");

  return {
    draftId,
    deploymentId: deployment.id,
    network: deployment.network,
    networkId: deployment.networkId,
    proofProfile: "single-destination",
    batchCap: {
      requested: requestedCap,
      default: batchPolicy.defaultCap,
      hardMax: batchPolicy.hardCap,
    },
    orderedInputs,
    orderedPaymentCredentials,
    destinationOutputs,
    proofRequests,
    expectedDestinationOutputStartIndex: 0,
    safeWallet,
    reductions,
    buildSupported: Boolean(deployment.referenceScripts?.reclaimBase && deployment.referenceScripts.reclaimGlobal),
  };
}

async function loadSafeWallet(
  provider: Provider,
  deployment: ReclaimDeployment,
  request: ClaimDraftRequest,
): Promise<ClaimDraftResponse["safeWallet"]> {
  const changeAddress = assertWalletAddress(request.safeWalletChangeAddress, deployment.network);
  const walletAddresses = assertWalletAddresses(request.safeWalletAddresses, deployment.network);
  const queryAddresses = [...new Set([changeAddress, ...walletAddresses])];
  for (const address of queryAddresses) {
    assertSafeWalletAddress(address, deployment.networkId);
  }

  const utxoGroups = await Promise.all(queryAddresses.map((address) => provider.getUtxos(address)));
  const utxos = dedupeUtxos(utxoGroups.flat());
  const totalAssets = sumUtxoAssets(utxos);
  const totalLovelace = totalAssets.lovelace ?? 0n;
  if (utxos.length === 0 || totalLovelace < MIN_SAFE_WALLET_LOVELACE) {
    // C32: carry the amounts so the UI can say how much ADA is available vs
    // required instead of a purely qualitative message.
    throw new ClaimValidationError(
      "safe_wallet_lovelace_unavailable",
      "Safe wallet must have enough ADA to pay claim fees, collateral, and destination-output min-ADA.",
      {
        availableLovelace: totalLovelace.toString(),
        requiredLovelace: MIN_SAFE_WALLET_LOVELACE.toString(),
      },
    );
  }

  return {
    changeAddress,
    addresses: queryAddresses,
    totalLovelace: totalLovelace.toString(),
    minimumRequiredLovelace: MIN_SAFE_WALLET_LOVELACE.toString(),
    utxoCount: utxos.length,
  };
}

async function loadSelectedReclaimUtxos(provider: Provider, selectedOutrefs: ClaimOutRef[]): Promise<UTxO[]> {
  if (!supportsOutRefLookup(provider)) {
    throw new ClaimValidationError("provider_outref_lookup_unavailable", "Configured Cardano provider cannot query selected outrefs.");
  }
  const selectedIds = new Set(selectedOutrefs.map(outRefToString));
  const utxos = (await provider.getUtxosByOutRef(outRefsForProvider(selectedOutrefs))).filter((utxo) =>
    selectedIds.has(outRefToString(utxo)),
  );
  const foundIds = new Set(utxos.map(outRefToString));
  const missing = [...selectedIds].filter((outRefId) => !foundIds.has(outRefId));
  if (missing.length > 0) {
    throw new ClaimValidationError("selected_outref_not_found", "Selected reclaim UTxOs are spent or unavailable.");
  }
  return dedupeUtxos(utxos);
}

function reclaimDraftInputFromUtxo(utxo: UTxO, deployment: ReclaimDeployment): ClaimDraftInput {
  if (utxo.address !== deployment.reclaimBaseAddress) {
    throw new ClaimValidationError("selected_outref_wrong_address", "Selected outref is not locked at the current ReclaimBase address.");
  }
  if (!utxo.datum) {
    throw new ClaimValidationError("missing_inline_datum", "Selected reclaim UTxO is missing an inline datum.");
  }
  const parsedDatum = parseReclaimBaseDatum(utxo.datum);
  const outRef = { txHash: utxo.txHash, outputIndex: utxo.outputIndex };
  return {
    outRef,
    outRefId: outRefToString(outRef),
    value: assetMapToStringMap(utxo.assets),
    paymentCredential: parsedDatum.paymentCredential,
    datumCbor: utxo.datum.toLowerCase(),
    confirmation: {
      slot: confirmationSlot(utxo),
    },
  };
}

function assertBatchCap(value: unknown, policy: ClaimBatchPolicy): number {
  if (value === undefined || value === null) {
    return policy.defaultCap;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ClaimValidationError("batch_cap_invalid", "Claim batch cap must be a positive integer.");
  }
  if (value > policy.hardCap) {
    throw new ClaimValidationError("batch_cap_exceeded", `Claim batch cap cannot exceed this deployment's ${policy.hardCap} UTxO limit.`);
  }
  return value;
}

function deploymentBatchPolicy(deployment: ReclaimDeployment): ClaimBatchPolicy {
  const batching = deployment.batching;
  const distinctSevenOptIn = batching?.distinct_7_opt_in;
  if (
    deployment.reclaimGlobalProofSlotEncoding !== "full-proof-plus-public-input-digest-v2" ||
    !batching ||
    batching.default_utxo_count !== CLAIM_DEFAULT_BATCH_CAP ||
    batching.optimization_utxo_count !== CLAIM_OPTIMIZATION_BATCH_CAP ||
    batching.hard_max_utxo_count !== CLAIM_HARD_BATCH_CAP ||
    batching.max_tx_cpu_percent !== CLAIM_DISTINCT_7_MAX_TX_CPU_PERCENT ||
    batching.max_tx_mem_percent !== CLAIM_DISTINCT_7_MAX_TX_MEM_PERCENT ||
    distinctSevenOptIn?.request_parameter !== "maxUtxos" ||
    distinctSevenOptIn.request_value !== CLAIM_HARD_BATCH_CAP ||
    distinctSevenOptIn.require_explicit_request !== true ||
    distinctSevenOptIn.require_measured_execution_units !== true
  ) {
    throw new ClaimValidationError(
      "batch_cap_manifest_invalid",
      "ReclaimGlobalV2 requires the explicit seven-slot batching policy and measured execution limits.",
    );
  }
  return {
    defaultCap: CLAIM_DEFAULT_BATCH_CAP,
    hardCap: CLAIM_HARD_BATCH_CAP,
  };
}

function compareDraftInputs(left: ClaimDraftInput, right: ClaimDraftInput): number {
  const indexedLeft = {
    outRef: left.outRef,
    outRefId: left.outRefId,
    address: "",
    value: left.value,
    datum: { status: "valid" as const, paymentCredential: left.paymentCredential },
    datumCbor: left.datumCbor,
    state: "unspent" as const,
    deploymentId: "",
    confirmation: left.confirmation,
  };
  const indexedRight = {
    outRef: right.outRef,
    outRefId: right.outRefId,
    address: "",
    value: right.value,
    datum: { status: "valid" as const, paymentCredential: right.paymentCredential },
    datumCbor: right.datumCbor,
    state: "unspent" as const,
    deploymentId: "",
    confirmation: right.confirmation,
  };
  return compareIndexedUtxos(indexedLeft, indexedRight);
}

function dedupeUtxos(utxos: UTxO[]): UTxO[] {
  const seen = new Set<string>();
  const deduped: UTxO[] = [];
  for (const utxo of utxos) {
    const outRefId = outRefToString(utxo);
    if (seen.has(outRefId)) {
      continue;
    }
    seen.add(outRefId);
    deduped.push(utxo);
  }
  return deduped;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
