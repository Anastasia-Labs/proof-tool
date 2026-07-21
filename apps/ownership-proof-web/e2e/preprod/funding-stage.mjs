import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as defaultSleep } from "node:timers/promises";
import { approveWalletSigning, connectFundingRole } from "./wallet-driver.mjs";

export const ADA_ONLY_FUNDING_STAGE_NAME = "fund-ada-only-reclaim";
export const NATIVE_ASSET_FUNDING_STAGE_NAME = "fund-native-asset-reclaims";
export const ADA_ONLY_AMOUNT_ENV = "RECLAIM_E2E_ADA_ONLY_AMOUNT";
export const FUNDING_WALLET_ROLE_ENV = "RECLAIM_E2E_FUNDING_WALLET_ROLE";
export const COMPROMISED_WALLET_ROLE_ENV = "RECLAIM_E2E_COMPROMISED_WALLET_ROLE";
export const NATIVE_ASSET_UNIT_ENV = "RECLAIM_E2E_NATIVE_ASSET_UNIT";
export const NATIVE_ASSET_QUANTITY_ENV = "RECLAIM_E2E_NATIVE_ASSET_QUANTITY";
export const NATIVE_RECLAIM_COUNT_ENV = "RECLAIM_E2E_NATIVE_RECLAIM_COUNT";
export const NATIVE_ADA_AMOUNT_ENV = "RECLAIM_E2E_NATIVE_ADA_AMOUNT";
export const FUNDING_SETTLEMENT_MS_ENV = "RECLAIM_E2E_FUNDING_SETTLEMENT_MS";

const DEFAULT_ADA_ONLY_AMOUNT = "2";
const DEFAULT_FUNDING_WALLET_ROLE = "reclaim_funder";
const DEFAULT_COMPROMISED_WALLET_ROLE = "compromised_user";
const DEFAULT_NATIVE_ASSET_QUANTITY = "1";
const DEFAULT_NATIVE_RECLAIM_COUNT = 5;
const DEFAULT_NATIVE_ADA_AMOUNT = "2";
const DEFAULT_LIVE_FUNDING_SETTLEMENT_MS = 45_000;
const WALLET_INVENTORY_READY = /^[0-9]+ UTxOs?, [0-9]+ assets?$/iu;
const WALLET_INVENTORY_TIMEOUT_MS = 30_000;
const WALLET_INVENTORY_POLL_MS = 100;
const BUILD_RESULT_TIMEOUT_MS = 180_000;
const SUBMIT_RESULT_TIMEOUT_MS = 120_000;

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
  const sleep = options.sleep ?? defaultSleep;
  const fundingRole = env[FUNDING_WALLET_ROLE_ENV]?.trim() || DEFAULT_FUNDING_WALLET_ROLE;
  const compromisedRole = env[COMPROMISED_WALLET_ROLE_ENV]?.trim() || DEFAULT_COMPROMISED_WALLET_ROLE;
  const adaAmount = env[ADA_ONLY_AMOUNT_ENV]?.trim() || DEFAULT_ADA_ONLY_AMOUNT;
  const settlementWaitMs = parseFundingSettlementMs(env);
  validateAdaAmount(ADA_ONLY_AMOUNT_ENV, adaAmount);
  const compromisedCredential = getCompromisedCredential(walletHarness, compromisedRole);

  await connectFundingRole(page, walletHarness, fundingRole);
  const transaction = await buildSignSubmitFundingTransaction(page, {
    compromisedCredential,
    adaAmount,
    walletDriver: walletHarness,
    signingRole: fundingRole,
  });
  await waitForFundingSettlement(sleep, settlementWaitMs);
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
    settlementWaitMs,
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
  const sleep = options.sleep ?? defaultSleep;
  const fundingRole = env[FUNDING_WALLET_ROLE_ENV]?.trim() || DEFAULT_FUNDING_WALLET_ROLE;
  const compromisedRole = env[COMPROMISED_WALLET_ROLE_ENV]?.trim() || DEFAULT_COMPROMISED_WALLET_ROLE;
  const adaAmount = env[NATIVE_ADA_AMOUNT_ENV]?.trim() || DEFAULT_NATIVE_ADA_AMOUNT;
  const nativeAssetUnit = env[NATIVE_ASSET_UNIT_ENV]?.trim();
  const nativeAssetQuantity = env[NATIVE_ASSET_QUANTITY_ENV]?.trim() || DEFAULT_NATIVE_ASSET_QUANTITY;
  const nativeReclaimCount = parseNativeCount(
    env[NATIVE_RECLAIM_COUNT_ENV]?.trim() || String(DEFAULT_NATIVE_RECLAIM_COUNT),
  );
  const settlementWaitMs = parseFundingSettlementMs(env);
  const seenTxHashes = new Set(normalizeTxHashList(options.previousFundingTxHashes));
  const startsAfterPriorFunding = seenTxHashes.size > 0;
  validateAdaAmount(NATIVE_ADA_AMOUNT_ENV, adaAmount);
  validateNativeAssetUnit(nativeAssetUnit);
  validateNativeAssetQuantity(nativeAssetQuantity);
  const compromisedCredential = getCompromisedCredential(walletHarness, compromisedRole);

  if (startsAfterPriorFunding) {
    await page.getByRole("button", { name: /lock another batch/iu }).click();
  }
  await connectFundingRole(page, walletHarness, fundingRole);
  const screenshots = [];
  const transactions = [];
  for (let index = 0; index < nativeReclaimCount; index += 1) {
    const transaction = await buildSignSubmitFundingTransaction(page, {
      compromisedCredential,
      adaAmount,
      walletDriver: walletHarness,
      signingRole: fundingRole,
      nativeAsset: {
        unit: nativeAssetUnit,
        quantity: nativeAssetQuantity,
      },
      disallowedTxHashes: seenTxHashes,
    });
    seenTxHashes.add(transaction.reviewedTxHash);
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
    await waitForFundingSettlement(sleep, settlementWaitMs);
    if (index + 1 < nativeReclaimCount) {
      await page.getByRole("button", { name: /lock another batch/iu }).click();
    }
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
    settlementWaitMs,
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

async function buildSignSubmitFundingTransaction(
  page,
  { compromisedCredential, adaAmount, walletDriver, signingRole, nativeAsset = null, disallowedTxHashes = new Set() },
) {
  await page.getByLabel("Payment key credential").fill(compromisedCredential);
  await page.getByLabel("ADA amount").fill(adaAmount);
  await page.getByRole("button", { name: /refresh assets/iu }).click();
  await waitForWalletInventory(page);
  if (nativeAsset) {
    await selectNativeAsset(page, nativeAsset);
  }
  await page.getByRole("button", { name: /build transaction/iu }).click();
  const buildResult = await waitForBuildResult(page);
  if (buildResult.status === "failed") {
    throw new PreprodFundingStageError(
      "funding_build_failed",
      buildResult.message || "Funding transaction build failed.",
    );
  }
  const reviewedTxHash = sanitizeText(
    await page.locator(".claim-review-row").filter({ hasText: "Tx hash" }).locator("code").textContent(),
  );
  if (disallowedTxHashes.has(reviewedTxHash)) {
    throw new PreprodFundingStageError(
      "funding_review_tx_reused",
      "Funding page reused a previously reviewed transaction after asset changes.",
    );
  }
  await page.getByRole("button", { name: /sign and submit/iu }).click();
  await approveWalletSigning(walletDriver, signingRole, "funding");
  const submitResult = await waitForSubmitResult(page);
  if (submitResult.status === "failed") {
    throw new PreprodFundingStageError(
      "funding_submit_failed",
      submitResult.message || "Funding transaction submission failed.",
    );
  }
  const submittedTxHash = sanitizeText(
    await page.locator(".claim-review-row").filter({ hasText: "Tx hash" }).locator("code").textContent(),
  );
  if (!submittedTxHash) {
    throw new PreprodFundingStageError(
      "submitted_tx_hash_missing",
      "Funding flow did not expose a submitted transaction hash.",
    );
  }
  return {
    reviewedTxHash,
    submittedTxHash,
  };
}

async function selectNativeAsset(page, nativeAsset) {
  await page.getByRole("button", { name: /^token$/iu }).click();
  await page.getByPlaceholder("Search policy ID or token name").fill(nativeAsset.unit);
  await page.getByRole("button", { name: /^select$/iu }).click();
  await page.getByRole("textbox", { name: /amount to lock/iu }).fill(nativeAsset.quantity);
  await page.getByRole("button", { name: /add token/iu }).click();
}

async function waitForWalletInventory(page, sleep = defaultSleep) {
  const inventory = page.getByLabel("Wallet inventory");
  await inventory.waitFor({ timeout: WALLET_INVENTORY_TIMEOUT_MS });
  const deadline = Date.now() + WALLET_INVENTORY_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const value = sanitizeText(await inventory.inputValue());
    if (WALLET_INVENTORY_READY.test(value)) {
      return;
    }
    await sleep(WALLET_INVENTORY_POLL_MS);
  }
  throw new PreprodFundingStageError(
    "wallet_inventory_timeout",
    `Wallet inventory did not load within ${WALLET_INVENTORY_TIMEOUT_MS / 1000}s.`,
  );
}

async function waitForBuildResult(page) {
  try {
    return await Promise.race([
      page
        .getByText("Datum CBOR")
        .waitFor({ timeout: BUILD_RESULT_TIMEOUT_MS })
        .then(() => ({ status: "built" })),
      page
        .locator(".claim-notice.bad")
        .waitFor({ timeout: BUILD_RESULT_TIMEOUT_MS })
        .then(async () => ({
          status: "failed",
          message: sanitizeText(await page.locator(".claim-notice.bad p").last().textContent()),
        })),
    ]);
  } catch (error) {
    throw new PreprodFundingStageError(
      "funding_build_result_timeout",
      `Funding transaction build did not reach a success or failure state within ${BUILD_RESULT_TIMEOUT_MS / 1000}s: ${
        error instanceof Error ? error.message : "timed out"
      }`,
    );
  }
}

async function waitForSubmitResult(page) {
  try {
    return await Promise.race([
      page
        .getByText("Transaction submitted")
        .waitFor({ timeout: SUBMIT_RESULT_TIMEOUT_MS })
        .then(() => ({ status: "submitted" })),
      page
        .locator(".claim-notice.bad")
        .waitFor({ timeout: SUBMIT_RESULT_TIMEOUT_MS })
        .then(async () => ({
          status: "failed",
          message: sanitizeText(await page.locator(".claim-notice.bad p").last().textContent()),
        })),
    ]);
  } catch (error) {
    throw new PreprodFundingStageError(
      "funding_submit_result_timeout",
      `Funding transaction submission did not reach a success or failure state within ${SUBMIT_RESULT_TIMEOUT_MS / 1000}s: ${
        error instanceof Error ? error.message : "timed out"
      }`,
    );
  }
}

function getCompromisedCredential(walletHarness, compromisedRole) {
  const compromisedState = walletHarness.roleState?.(compromisedRole);
  const compromisedCredential = compromisedState?.paymentCredential;
  if (typeof compromisedCredential !== "string" || !/^[0-9a-f]{56}$/u.test(compromisedCredential)) {
    throw new PreprodFundingStageError(
      "compromised_credential_missing",
      `${compromisedRole} must expose a 28-byte payment credential.`,
    );
  }
  return compromisedCredential;
}

function validateAdaAmount(field, value) {
  if (!/^(?:[1-9][0-9]*|0)(?:\.[0-9]{1,6})?$/u.test(value) || Number(value) <= 0) {
    throw new PreprodFundingStageError(
      "ada_amount_invalid",
      `${field} must be a positive ADA amount with at most 6 decimals.`,
    );
  }
}

function validateNativeAssetUnit(value) {
  if (!value) {
    throw new PreprodFundingStageError(
      "native_asset_unit_missing",
      `${NATIVE_ASSET_UNIT_ENV} is required for native-asset funding.`,
    );
  }
  if (!/^[0-9a-f]{56}(?:[0-9a-f]{2})*$/u.test(value)) {
    throw new PreprodFundingStageError(
      "native_asset_unit_invalid",
      `${NATIVE_ASSET_UNIT_ENV} must be a lowercase hex policy id plus optional token-name hex.`,
    );
  }
}

function validateNativeAssetQuantity(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new PreprodFundingStageError(
      "native_asset_quantity_invalid",
      `${NATIVE_ASSET_QUANTITY_ENV} must be a positive integer.`,
    );
  }
}

function parseNativeCount(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new PreprodFundingStageError(
      "native_reclaim_count_invalid",
      `${NATIVE_RECLAIM_COUNT_ENV} must be a positive integer.`,
    );
  }
  return Number(value);
}

function parseFundingSettlementMs(env) {
  const configured = env[FUNDING_SETTLEMENT_MS_ENV]?.trim();
  if (!configured) {
    return (env.RECLAIM_E2E_LIVE_PREPROD ?? "").trim() === "1" ? DEFAULT_LIVE_FUNDING_SETTLEMENT_MS : 0;
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(configured)) {
    throw new PreprodFundingStageError(
      "funding_settlement_ms_invalid",
      `${FUNDING_SETTLEMENT_MS_ENV} must be a non-negative integer.`,
    );
  }
  return Number(configured);
}

function normalizeTxHashList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);
}

async function waitForFundingSettlement(sleep, settlementWaitMs) {
  if (settlementWaitMs > 0) {
    await sleep(settlementWaitMs);
  }
}

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function redactCredential(value) {
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}
