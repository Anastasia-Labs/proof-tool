import { writeFileSync } from "node:fs";
import path from "node:path";
import { ADA_ONLY_AMOUNT_ENV } from "./funding-stage.mjs";

export const NATIVE_ASSET_UNIT_ENV = "RECLAIM_E2E_NATIVE_ASSET_UNIT";
export const NATIVE_ASSET_QUANTITY_ENV = "RECLAIM_E2E_NATIVE_ASSET_QUANTITY";
export const NATIVE_RECLAIM_COUNT_ENV = "RECLAIM_E2E_NATIVE_RECLAIM_COUNT";
export const NATIVE_ADA_AMOUNT_ENV = "RECLAIM_E2E_NATIVE_ADA_AMOUNT";

const DEFAULT_ADA_ONLY_AMOUNT = "2";
const DEFAULT_NATIVE_ASSET_QUANTITY = "1";
const DEFAULT_NATIVE_RECLAIM_COUNT = 5;
const DEFAULT_NATIVE_ADA_AMOUNT = "2";

export class PreprodLiveConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodLiveConfigError";
    this.code = code;
  }
}

export function validatePreprodLiveConfig(env = process.env) {
  const adaOnlyAmount = env[ADA_ONLY_AMOUNT_ENV]?.trim() || DEFAULT_ADA_ONLY_AMOUNT;
  const nativeAdaAmount = env[NATIVE_ADA_AMOUNT_ENV]?.trim() || DEFAULT_NATIVE_ADA_AMOUNT;
  const nativeAssetUnit = env[NATIVE_ASSET_UNIT_ENV]?.trim();
  const nativeAssetQuantity = env[NATIVE_ASSET_QUANTITY_ENV]?.trim() || DEFAULT_NATIVE_ASSET_QUANTITY;
  const nativeReclaimCount = parseCount(env[NATIVE_RECLAIM_COUNT_ENV]?.trim() || String(DEFAULT_NATIVE_RECLAIM_COUNT));

  validateAdaAmount(ADA_ONLY_AMOUNT_ENV, adaOnlyAmount);
  validateAdaAmount(NATIVE_ADA_AMOUNT_ENV, nativeAdaAmount);
  if (!nativeAssetUnit) {
    throw new PreprodLiveConfigError(
      "native_asset_unit_missing",
      `${NATIVE_ASSET_UNIT_ENV} is required before approved live preprod transaction work.`,
    );
  }
  if (!/^[0-9a-f]{56}(?:[0-9a-f]{2})*$/u.test(nativeAssetUnit)) {
    throw new PreprodLiveConfigError(
      "native_asset_unit_invalid",
      `${NATIVE_ASSET_UNIT_ENV} must be a lowercase hex policy id plus optional token-name hex.`,
    );
  }
  if (!/^[1-9][0-9]*$/u.test(nativeAssetQuantity)) {
    throw new PreprodLiveConfigError(
      "native_asset_quantity_invalid",
      `${NATIVE_ASSET_QUANTITY_ENV} must be a positive integer.`,
    );
  }
  if (nativeReclaimCount < 5) {
    throw new PreprodLiveConfigError(
      "native_reclaim_count_too_low",
      `${NATIVE_RECLAIM_COUNT_ENV} must be at least 5 so Phase 9A can reach six total reclaim UTxOs after the ADA-only funding transaction.`,
    );
  }

  return {
    schema: "proof-tool-preprod-live-config-v1",
    adaOnlyAmount,
    nativeAdaAmount,
    nativeAssetUnit,
    nativeAssetQuantity,
    nativeReclaimCount,
    expectedMinimumReclaimUtxos: nativeReclaimCount + 1,
  };
}

export function writePreprodLiveConfigArtifact(config, outputDir, options = {}) {
  const writeFile = options.writeFile ?? writeFileSync;
  const artifactPath = path.join(outputDir, "live-config.json");
  writeFile(artifactPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return artifactPath;
}

function validateAdaAmount(field, value) {
  if (!/^(?:[1-9][0-9]*|0)(?:\.[0-9]{1,6})?$/u.test(value) || Number(value) <= 0) {
    throw new PreprodLiveConfigError("ada_amount_invalid", `${field} must be a positive ADA amount with at most 6 decimals.`);
  }
}

function parseCount(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new PreprodLiveConfigError(
      "native_reclaim_count_invalid",
      `${NATIVE_RECLAIM_COUNT_ENV} must be a positive integer.`,
    );
  }
  return Number(value);
}
