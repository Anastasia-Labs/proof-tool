import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ADA_ONLY_FUNDING_STAGE_NAME = "fund-ada-only-reclaim";
export const ADA_ONLY_AMOUNT_ENV = "RECLAIM_E2E_ADA_ONLY_AMOUNT";
export const FUNDING_WALLET_ROLE_ENV = "RECLAIM_E2E_FUNDING_WALLET_ROLE";
export const COMPROMISED_WALLET_ROLE_ENV = "RECLAIM_E2E_COMPROMISED_WALLET_ROLE";

const DEFAULT_ADA_ONLY_AMOUNT = "2";
const DEFAULT_FUNDING_WALLET_ROLE = "reclaim_funder";
const DEFAULT_COMPROMISED_WALLET_ROLE = "compromised_user";

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
  validateAdaAmount(adaAmount);

  const compromisedState = walletHarness.roleState?.(compromisedRole);
  const compromisedCredential = compromisedState?.paymentCredential;
  if (typeof compromisedCredential !== "string" || !/^[0-9a-f]{56}$/u.test(compromisedCredential)) {
    throw new PreprodFundingStageError("compromised_credential_missing", `${compromisedRole} must expose a 28-byte payment credential.`);
  }

  await page.getByLabel("Cardano wallet").selectOption(fundingRole);
  await page.getByRole("button", { name: /connect wallet/iu }).click();
  await page.getByText(/CIP-30 wallet address/iu).waitFor();
  await page.getByLabel("Payment key credential").fill(compromisedCredential);
  await page.getByLabel("ADA amount").fill(adaAmount);
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
    reviewedTxHash,
    submittedTxHash,
    screenshots: [path.relative(outputDir, screenshotPath)],
  };
  writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  return {
    ok: true,
    artifacts: [artifactPath, screenshotPath],
    summary: {
      stage: ADA_ONLY_FUNDING_STAGE_NAME,
      submittedTxHash,
      reviewedTxHash,
    },
  };
}

function requireOption(value, name) {
  if (!value) {
    throw new PreprodFundingStageError(`${name}_missing`, `${name} is required for ADA-only funding.`);
  }
  return value;
}

function validateAdaAmount(value) {
  if (!/^(?:[1-9][0-9]*|0)(?:\.[0-9]{1,6})?$/u.test(value) || Number(value) <= 0) {
    throw new PreprodFundingStageError("ada_amount_invalid", `${ADA_ONLY_AMOUNT_ENV} must be a positive ADA amount with at most 6 decimals.`);
  }
}

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function redactCredential(value) {
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}
