import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ADA_ONLY_FUNDING_STAGE_NAME = "fund-ada-only-reclaim";
export const NATIVE_ASSET_FUNDING_STAGE_NAME = "fund-native-asset-reclaims";
export const ADA_ONLY_AMOUNT_ENV = "RECLAIM_E2E_ADA_ONLY_AMOUNT";
export const FUNDING_WALLET_ROLE_ENV = "RECLAIM_E2E_FUNDING_WALLET_ROLE";
export const COMPROMISED_WALLET_ROLE_ENV = "RECLAIM_E2E_COMPROMISED_WALLET_ROLE";
export const NATIVE_ASSET_UNIT_ENV = "RECLAIM_E2E_NATIVE_ASSET_UNIT";
export const NATIVE_ASSET_QUANTITY_ENV = "RECLAIM_E2E_NATIVE_ASSET_QUANTITY";
export const NATIVE_RECLAIM_COUNT_ENV = "RECLAIM_E2E_NATIVE_RECLAIM_COUNT";
export const NATIVE_ADA_AMOUNT_ENV = "RECLAIM_E2E_NATIVE_ADA_AMOUNT";

const DEFAULT_ADA_ONLY_AMOUNT = "2";
const DEFAULT_FUNDING_WALLET_ROLE = "reclaim_funder";
const DEFAULT_COMPROMISED_WALLET_ROLE = "compromised_user";
const DEFAULT_NATIVE_ASSET_QUANTITY = "1";
const DEFAULT_NATIVE_RECLAIM_COUNT = 5;
const DEFAULT_NATIVE_ADA_AMOUNT = "2";

export class PreprodFundingStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodFundingStageError";
    this.code = code;
  }
}

export async function runAdaOnlyFundingStage(options = {}) {
  const env = options.env ?? process.env;
  const page = requireOption(options.page, "page");
  const walletHarness = requireOption(options.walletHarness, "walletHarness");
  const outputDir = requireOption(options.outputDir, "outputDir");
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const fundingRole = env[FUNDING_WALLET_ROLE_ENV]?.trim() || DEFAULT_FUNDING_WALLET_ROLE;
  const compromisedRole = env[COMPROMISED_WALLET_ROLE_ENV]?.trim() || DEFAULT_COMPROMISED_WALLET_ROLE;
  const adaAmount = env[ADA_ONLY_AMOUNT_ENV]?.trim() || DEFAULT_ADA_ONLY_AMOUNT;
  validateAdaAmount(ADA_ONLY_AMOUNT_ENV, adaAmount);
  const compromisedCredential = getCompromisedCredential(walletHarness, compromisedRole);

  await connectFundingWallet(page, fundingRole);
  const transaction = await buildSignSubmitFundingTransaction(page, {
    compromisedCredential,
    adaAmount,
  });
  const screenshotPath = path.join(outputDir, "screenshots", "fund-ada-only-reclaim.png");
  mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  const artifactPath = path.join(outputDir, "fund-ada-only-reclaim.json");
  const artifact = {
    schema: "proof-tool-preprod-funding-stage-v1",
    stage: ADA_ONLY_FUNDING_STAGE_NAME,
    fundingWalletRole: fundingRole,
    compromisedWalletRole: compromisedRole,
    compromisedCredential: redactCredential(compromisedCredential),
    adaAmount,
    reviewedTxHash: transaction.reviewedTxHash,
    submittedTxHash: transaction.submittedTxHash,
    screenshots: [path.relative(outputDir, screenshotPath)],
  };
  writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  return {
    ok: true,
    artifacts: [artifactPath, screenshotPath],
    summary: {
      stage: ADA_ONLY_FUNDING_STAGE_NAME,
      submittedTxHash: transaction.submittedTxHash,
      reviewedTxHash: transaction.reviewedTxHash,
    },
  };
}

export async function runNativeAssetFundingStage(options = {}) {
  const env = options.env ?? process.env;
  const page = requireOption(options.page, "page");
  const walletHarness = requireOption(options.walletHarness, "walletHarness");
  const outputDir = requireOption(options.outputDir, "outputDir");
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const fundingRole = env[FUNDING_WALLET_ROLE_ENV]?.trim() || DEFAULT_FUNDING_WALLET_ROLE;
  const compromisedRole = env[COMPROMISED_WALLET_ROLE_ENV]?.trim() || DEFAULT_COMPROMISED_WALLET_ROLE;
  const adaAmount = env[NATIVE_ADA_AMOUNT_ENV]?.trim() || DEFAULT_NATIVE_ADA_AMOUNT;
  const nativeAssetUnit = env[NATIVE_ASSET_UNIT_ENV]?.trim();
  const nativeAssetQuantity = env[NATIVE_ASSET_QUANTITY_ENV]?.trim() || DEFAULT_NATIVE_ASSET_QUANTITY;
  const nativeReclaimCount = parseNativeCount(env[NATIVE_RECLAIM_COUNT_ENV]?.trim() || String(DEFAULT_NATIVE_RECLAIM_COUNT));
  validateAdaAmount(NATIVE_ADA_AMOUNT_ENV, adaAmount);
  validateNativeAssetUnit(nativeAssetUnit);
  validateNativeAssetQuantity(nativeAssetQuantity);
  const compromisedCredential = getCompromisedCredential(walletHarness, compromisedRole);

  await connectFundingWallet(page, fundingRole);
  const screenshots = [];
  const transactions = [];
  for (let index = 0; index < nativeReclaimCount; index += 1) {
    const transaction = await buildSignSubmitFundingTransaction(page, {
      compromisedCredential,
      adaAmount,
      nativeAsset: {
        unit: nativeAssetUnit,
        quantity: nativeAssetQuantity,
      },
    });
    const screenshotPath = path.join(outputDir, "screenshots", `fund-native-asset-reclaims-${index + 1}.png`);
    mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });
    screenshots.push(screenshotPath);
    transactions.push({
      index: index + 1,
      reviewedTxHash: transaction.reviewedTxHash,
      submittedTxHash: transaction.submittedTxHash,
      adaAmount,
      nativeAssetUnit,
      nativeAssetQuantity,
      screenshot: path.relative(outputDir, screenshotPath),
    });
  }

  const artifactPath = path.join(outputDir, "fund-native-asset-reclaims.json");
  const artifact = {
    schema: "proof-tool-preprod-native-funding-stage-v1",
    stage: NATIVE_ASSET_FUNDING_STAGE_NAME,
    fundingWalletRole: fundingRole,
    compromisedWalletRole: compromisedRole,
    compromisedCredential: redactCredential(compromisedCredential),
    expectedReclaimUtxosFunded: nativeReclaimCount,
    adaAmount,
    nativeAssetUnit,
    nativeAssetQuantity,
    transactions,
    screenshots: screenshots.map((screenshotPath) => path.relative(outputDir, screenshotPath)),
  };
  writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  return {
    ok: true,
    artifacts: [artifactPath, ...screenshots],
    summary: {
      stage: NATIVE_ASSET_FUNDING_STAGE_NAME,
      submittedTxHashes: transactions.map((transaction) => transaction.submittedTxHash),
      expectedReclaimUtxosFunded: nativeReclaimCount,
    },
  };
}

function requireOption(value, name) {
  if (!value) {
    throw new PreprodFundingStageError(`${name}_missing`, `${name} is required for preprod funding.`);
  }
  return value;
}

async function connectFundingWallet(page, fundingRole) {
  await page.getByLabel("Cardano wallet").selectOption(fundingRole);
  await page.getByRole("button", { name: /connect wallet/iu }).click();
  await page.getByText(/CIP-30 wallet address/iu).waitFor();
}

async function buildSignSubmitFundingTransaction(page, { compromisedCredential, adaAmount, nativeAsset = null }) {
  await page.getByLabel("Payment key credential").fill(compromisedCredential);
  await page.getByLabel("ADA amount").fill(adaAmount);
  if (nativeAsset) {
    await page.getByPlaceholder("policyId + tokenName hex").fill(nativeAsset.unit);
    await page.getByPlaceholder("0").fill(nativeAsset.quantity);
  }
  await page.getByRole("button", { name: /refresh assets/iu }).click();
  await page.getByText(/UTxO|assets|No assets/iu).waitFor();
  await page.getByRole("button", { name: /build transaction/iu }).click();
  await page.getByText("Datum CBOR").waitFor();
  const reviewedTxHash = sanitizeText(await page.locator(".review-item").filter({ hasText: "Tx hash" }).locator("code").textContent());
  await page.getByRole("button", { name: /sign and submit/iu }).click();
  await page.getByText("Transaction submitted").waitFor();
  const submittedTxHash = sanitizeText(await page.locator(".result-band.ok span").last().textContent());
  if (!submittedTxHash) {
    throw new PreprodFundingStageError("submitted_tx_hash_missing", "Funding flow did not expose a submitted transaction hash.");
  }
  return {
    reviewedTxHash,
    submittedTxHash,
  };
}

function getCompromisedCredential(walletHarness, compromisedRole) {
  const compromisedState = walletHarness.roleState?.(compromisedRole);
  const compromisedCredential = compromisedState?.paymentCredential;
  if (typeof compromisedCredential !== "string" || !/^[0-9a-f]{56}$/u.test(compromisedCredential)) {
    throw new PreprodFundingStageError("compromised_credential_missing", `${compromisedRole} must expose a 28-byte payment credential.`);
  }
  return compromisedCredential;
}

function validateAdaAmount(field, value) {
  if (!/^(?:[1-9][0-9]*|0)(?:\.[0-9]{1,6})?$/u.test(value) || Number(value) <= 0) {
    throw new PreprodFundingStageError("ada_amount_invalid", `${field} must be a positive ADA amount with at most 6 decimals.`);
  }
}

function validateNativeAssetUnit(value) {
  if (!value) {
    throw new PreprodFundingStageError("native_asset_unit_missing", `${NATIVE_ASSET_UNIT_ENV} is required for native-asset funding.`);
  }
  if (!/^[0-9a-f]{56}(?:[0-9a-f]{2})*$/u.test(value)) {
    throw new PreprodFundingStageError("native_asset_unit_invalid", `${NATIVE_ASSET_UNIT_ENV} must be a lowercase hex policy id plus optional token-name hex.`);
  }
}

function validateNativeAssetQuantity(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new PreprodFundingStageError("native_asset_quantity_invalid", `${NATIVE_ASSET_QUANTITY_ENV} must be a positive integer.`);
  }
}

function parseNativeCount(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new PreprodFundingStageError("native_reclaim_count_invalid", `${NATIVE_RECLAIM_COUNT_ENV} must be a positive integer.`);
  }
  return Number(value);
}

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function redactCredential(value) {
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}
