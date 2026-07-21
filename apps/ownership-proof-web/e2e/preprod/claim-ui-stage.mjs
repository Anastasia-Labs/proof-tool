import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { approveWalletConnection, approveWalletSigning, selectClaimRole } from "./wallet-driver.mjs";

export const CLAIM_UI_ACCEPTANCE_STAGE_NAME = "claim-ui-acceptance";
export const COMPROMISED_WALLET_ROLE = "compromised_user";
export const SAFE_WALLET_ROLE = "safe_claim_destination";

const CLAIM_FLOW_RESUME_STORAGE_KEY = "proof-tool.claim-flow.resume.v1";

export class PreprodClaimUiStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodClaimUiStageError";
    this.code = code;
  }
}

export async function runClaimUiAcceptanceStage(options = {}) {
  const page = requireOption(options.page, "page");
  const appTarget = requireOption(options.appTarget, "appTarget");
  const helperTarget = requireOption(options.helperTarget, "helperTarget");
  const walletHarness = requireOption(options.walletHarness, "walletHarness");
  const outputDir = requireOption(options.outputDir, "outputDir");
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const maxBatches = Number.parseInt(options.maxBatches ?? "6", 10);
  const recoveryPhrase = await recoveryPhraseForUi(walletHarness, COMPROMISED_WALLET_ROLE);
  const screenshotsDir = path.join(outputDir, "screenshots");
  const screenshotPath = path.join(screenshotsDir, "claim-ui-acceptance.png");
  const artifactPath = path.join(outputDir, "claim-ui-acceptance.json");

  const claimUrl = new URL("/claim", appTarget.baseUrl);
  const helperPairingUrl = new URL(claimUrl);
  helperPairingUrl.hash = new URLSearchParams({
    helper: helperTarget.helperUrl,
    pair: helperTarget.token,
  }).toString();

  await page.addInitScript(
    (storageKey) => globalThis.localStorage.removeItem(storageKey),
    CLAIM_FLOW_RESUME_STORAGE_KEY,
  );
  await page.goto(claimUrl.toString(), { waitUntil: "domcontentloaded" });
  await clickByRole(page, "button", "Continue");
  await selectClaimRole(page, walletHarness, COMPROMISED_WALLET_ROLE);
  await clickByRole(page, "button", "Connect impacted wallet");
  await approveWalletConnection(walletHarness, COMPROMISED_WALLET_ROLE);
  await waitForText(page, "Available claims");
  await clickByRole(page, "button", "Continue to safe wallet");
  await selectClaimRole(page, walletHarness, SAFE_WALLET_ROLE);
  await clickByRole(page, "button", "Connect safe wallet");
  await approveWalletConnection(walletHarness, SAFE_WALLET_ROLE);
  await waitForText(page, "Current draft", 180_000);
  await clickByRole(page, "button", "Confirm destination and continue");
  await page.getByRole("button", { name: "Choose method" }).waitFor({ timeout: 180_000 });
  await pairHelperThroughCourier(page, helperPairingUrl.toString());
  await chooseDesktopProofMethod(page);
  await allowDesktopConnectionIfRequested(page);

  let batches = 0;
  for (; batches < maxBatches; batches += 1) {
    if (await isRecoveryComplete(page)) {
      break;
    }
    await waitForHeading(page, "Create proofs");
    await fillRecoveryPhrase(page, recoveryPhrase);
    await clickByRole(page, "button", "Generate proofs");
    await waitForText(page, "Proofs ready", 900_000);
    await clickByRole(page, "button", "Continue to current batch");
    await waitForText(page, "Claim funds");
    await clickByRole(page, "button", "Build transaction for review");
    await waitForText(page, "Review hash", 180_000);
    await clickByRole(page, "button", "Sign and submit claim");
    await approveWalletSigning(walletHarness, SAFE_WALLET_ROLE, "claim");
    await waitForClaimBatchOutcome(page, 240_000);
    if (await isRecoveryComplete(page)) {
      break;
    }
  }

  if (!(await isRecoveryComplete(page))) {
    throw new PreprodClaimUiStageError("claim_ui_acceptance_incomplete", "Claim UI did not reach the final receipt.");
  }

  mkdir(screenshotsDir, { recursive: true });
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  const artifact = {
    schema: "proof-tool-preprod-claim-ui-acceptance-v1",
    stage: CLAIM_UI_ACCEPTANCE_STAGE_NAME,
    url: new URL("/claim", appTarget.baseUrl).toString(),
    impactedWalletRole: COMPROMISED_WALLET_ROLE,
    safeWalletRole: SAFE_WALLET_ROLE,
    helper: {
      helperUrl: helperTarget.helperUrl,
      tokenRequired: true,
      token: "[redacted]",
    },
    browserUiDriven: true,
    directApiBuildSubmitCalls: false,
    batchesAttempted: batches + 1,
    recoveryPhraseWritten: false,
    proofBytesWritten: false,
    witnessSetWritten: false,
    reviewTokenWritten: false,
    screenshots: [path.relative(outputDir, screenshotPath)],
  };
  writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return {
    ok: true,
    artifacts: [artifactPath, screenshotPath],
    summary: {
      stage: CLAIM_UI_ACCEPTANCE_STAGE_NAME,
      batchesAttempted: artifact.batchesAttempted,
      browserUiDriven: true,
    },
  };
}

async function pairHelperThroughCourier(page, pairingUrl) {
  const context = page.context?.();
  if (!context || typeof context.newPage !== "function") {
    throw new PreprodClaimUiStageError(
      "claim_ui_pairing_context_missing",
      "Claim UI helper pairing requires a browser context.",
    );
  }
  const courierPage = await context.newPage();
  try {
    await courierPage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await courierPage.getByText("Proof Helper paired", { exact: false }).waitFor({ timeout: 120_000 });
  } finally {
    await courierPage.close();
  }
}

async function chooseDesktopProofMethod(page) {
  await clickByRole(page, "button", "Choose method");
  await page.getByRole("radio", { name: /Proof Helper Desktop/iu }).click({ timeout: 180_000 });
  await clickByRole(page, "button", "Continue to desktop app");
  await clickByRole(page, "button", "Close installer chooser");
}

async function allowDesktopConnectionIfRequested(page) {
  const permissionButton = page.getByRole("button", {
    name: /Allow desktop connection|Check permission again|Check helper again/iu,
  });
  try {
    await permissionButton.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return;
  }
  await permissionButton.click({ timeout: 180_000 });
}

async function recoveryPhraseForUi(walletHarness, role) {
  if (typeof walletHarness.recoveryPhraseForBrowserUi === "function") {
    const phrase = await walletHarness.recoveryPhraseForBrowserUi(role);
    if (typeof phrase === "string" && phrase.trim().split(/\s+/u).length >= 12) {
      return phrase.trim();
    }
  }
  throw new PreprodClaimUiStageError(
    "claim_ui_recovery_phrase_unavailable",
    "CIP-30 harness must expose recoveryPhraseForBrowserUi for the impacted wallet in browser UI acceptance.",
  );
}

async function fillRecoveryPhrase(page, phrase) {
  const words = phrase.trim().split(/\s+/u);
  for (const [index, word] of words.entries()) {
    const input = page.getByLabel(`Recovery word ${index + 1}`, { exact: true });
    if (index === 0) {
      await input.waitFor({ timeout: 180_000 });
    }
    await input.fill(word);
  }
}

async function clickByRole(page, role, name) {
  await page.getByRole(role, { name }).click({ timeout: 180_000 });
}

async function waitForText(page, text, timeout = 120_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout });
}

async function waitForHeading(page, name, timeout = 120_000) {
  await page.getByRole("heading", { name }).waitFor({ timeout });
}

async function waitForClaimBatchOutcome(page, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isRecoveryComplete(page)) {
      return "recovery-complete";
    }
    if (await isHeadingVisible(page, "Create proofs")) {
      return "next-batch";
    }
    await page.waitForTimeout(500);
  }
  throw new PreprodClaimUiStageError(
    "claim_ui_wait_timeout",
    "Timed out waiting for the final recovery receipt or the next Create proofs screen.",
  );
}

async function isRecoveryComplete(page) {
  return isLocatorVisible(page.getByText("Recovery complete", { exact: false }).first());
}

async function isHeadingVisible(page, name) {
  return isLocatorVisible(page.getByRole("heading", { name }));
}

async function isLocatorVisible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

function requireOption(value, name) {
  if (!value) {
    throw new PreprodClaimUiStageError(`${name}_missing`, `${name} is required for claim UI acceptance.`);
  }
  return value;
}
