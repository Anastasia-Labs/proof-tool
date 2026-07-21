import { setTimeout as defaultSleep } from "node:timers/promises";
import { WebAppClaimFlowContractError } from "./web-app-claim-flow-contract.mjs";

const DEFAULT_PROVIDER_OUTPUT_TIMEOUT_MS = 5 * 60_000;
const PROVIDER_OUTPUT_POLL_MS = 5_000;

export async function waitForSafeDestinationOutput(options = {}) {
  const provider = options.provider;
  const build = options.build;
  const safeAddress = String(options.safeAddress ?? "");
  const transactionHash = String(options.transactionHash ?? "").toLowerCase();
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_OUTPUT_TIMEOUT_MS;
  if (!provider || typeof provider.getUtxos !== "function") {
    throw new WebAppClaimFlowContractError(
      "provider_confirmation_unavailable",
      "A read-capable Preprod provider is required.",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(transactionHash)) {
    throw new WebAppClaimFlowContractError(
      "provider_confirmation_failed",
      "The submitted transaction hash is invalid.",
    );
  }
  const destinationOutputs = build?.review?.destinationOutputs;
  const destinationOutputStartIndex = build?.review?.destinationOutputStartIndex;
  if (
    !Array.isArray(destinationOutputs) ||
    destinationOutputs.length !== 1 ||
    !Number.isSafeInteger(destinationOutputStartIndex)
  ) {
    throw new WebAppClaimFlowContractError(
      "provider_confirmation_failed",
      "The reviewed build does not identify exactly one destination output index.",
    );
  }
  const expected = destinationOutputs[0];
  if (expected.address !== safeAddress) {
    throw new WebAppClaimFlowContractError(
      "provider_confirmation_failed",
      "The reviewed destination does not match the safe Lace address.",
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let utxos;
    try {
      utxos = await provider.getUtxos(safeAddress);
    } catch {
      await sleep(PROVIDER_OUTPUT_POLL_MS);
      continue;
    }
    const matchingOutput = (Array.isArray(utxos) ? utxos : []).find(
      (utxo) =>
        String(utxo.txHash ?? "").toLowerCase() === transactionHash &&
        Number(utxo.outputIndex) === destinationOutputStartIndex,
    );
    if (!matchingOutput) {
      await sleep(PROVIDER_OUTPUT_POLL_MS);
      continue;
    }
    if (matchingOutput.address !== safeAddress || !assetMapsEqual(matchingOutput.assets, expected.value)) {
      throw new WebAppClaimFlowContractError(
        "provider_destination_mismatch",
        "The provider-visible transaction output does not match the reviewed safe destination and value.",
      );
    }
    return Object.freeze({
      outputIndex: destinationOutputStartIndex,
      transactionHash,
      value: normalizeAssetMap(matchingOutput.assets),
    });
  }
  throw new WebAppClaimFlowContractError(
    "provider_destination_timeout",
    "Timed out waiting for the reviewed safe-destination output.",
  );
}

function assetMapsEqual(providerAssets, reviewedValue) {
  const actual = normalizeAssetMap(providerAssets);
  const expected = normalizeAssetMap(reviewedValue);
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(([unit, quantity]) => actual[unit] === quantity)
  );
}

function normalizeAssetMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([unit, quantity]) => [unit, String(quantity)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
