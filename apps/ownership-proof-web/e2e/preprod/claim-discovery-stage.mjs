import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  COMPROMISED_WALLET_ROLE_ENV,
  NATIVE_RECLAIM_COUNT_ENV,
} from "./funding-stage.mjs";

export const CLAIM_DISCOVERY_STAGE_NAME = "discover-matching-claims";

const DEFAULT_COMPROMISED_WALLET_ROLE = "compromised_user";
const DEFAULT_NATIVE_RECLAIM_COUNT = 5;

export class PreprodClaimDiscoveryStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodClaimDiscoveryStageError";
    this.code = code;
  }
}

export async function runClaimDiscoveryStage(options = {}) {
  const env = options.env ?? process.env;
  const page = requireOption(options.page, "page");
  const walletHarness = requireOption(options.walletHarness, "walletHarness");
  const appTarget = requireOption(options.appTarget, "appTarget");
  const outputDir = requireOption(options.outputDir, "outputDir");
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const compromisedRole = env[COMPROMISED_WALLET_ROLE_ENV]?.trim() || DEFAULT_COMPROMISED_WALLET_ROLE;
  const expectedMinimumMatchingUtxos = parseExpectedMinimum(env[NATIVE_RECLAIM_COUNT_ENV]?.trim() || String(DEFAULT_NATIVE_RECLAIM_COUNT)) + 1;
  const beforeState = walletHarness.roleState?.(compromisedRole);
  if (!beforeState) {
    throw new PreprodClaimDiscoveryStageError("impacted_wallet_missing", `${compromisedRole} is not available in the CIP-30 harness.`);
  }
  const signAttemptsBefore = numberOrZero(beforeState.signAttempts);

  const claimUrl = new URL("/claim", appTarget.baseUrl).toString();
  await page.goto(claimUrl, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: /I reviewed deployment/iu }).click();
  await page.getByRole("heading", { name: "Connect impacted wallet" }).waitFor();
  await page.getByRole("button", { name: walletButtonName(compromisedRole) }).click();
  await page.getByRole("button", { name: /Connect impacted wallet/iu }).click();
  await page.getByRole("heading", { name: "Available claims" }).waitFor();

  const discoveredMatchingUtxos = await readMatchingUtxoCount(page);
  if (discoveredMatchingUtxos < expectedMinimumMatchingUtxos) {
    throw new PreprodClaimDiscoveryStageError(
      "matching_utxo_count_too_low",
      `Claim discovery found ${discoveredMatchingUtxos} matching UTxOs; expected at least ${expectedMinimumMatchingUtxos}.`,
    );
  }

  const afterState = walletHarness.roleState?.(compromisedRole);
  const signAttemptsAfter = numberOrZero(afterState?.signAttempts);
  if (signAttemptsAfter !== signAttemptsBefore) {
    throw new PreprodClaimDiscoveryStageError(
      "impacted_wallet_signed",
      `${compromisedRole} signAttempts changed during impacted-wallet discovery.`,
    );
  }

  const screenshotPath = path.join(outputDir, "screenshots", "discover-matching-claims.png");
  mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  const artifactPath = path.join(outputDir, "discover-matching-claims.json");
  const artifact = {
    schema: "proof-tool-preprod-claim-discovery-stage-v1",
    stage: CLAIM_DISCOVERY_STAGE_NAME,
    url: claimUrl,
    impactedWalletRole: compromisedRole,
    impactedPaymentCredential: redactCredential(beforeState.paymentCredential),
    expectedMinimumMatchingUtxos,
    discoveredMatchingUtxos,
    impactedWalletSignAttempts: {
      before: signAttemptsBefore,
      after: signAttemptsAfter,
    },
    screenshots: [path.relative(outputDir, screenshotPath)],
  };
  writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  return {
    ok: true,
    artifacts: [artifactPath, screenshotPath],
    summary: {
      stage: CLAIM_DISCOVERY_STAGE_NAME,
      discoveredMatchingUtxos,
      impactedWalletSignAttempts: artifact.impactedWalletSignAttempts,
    },
  };
}

async function readMatchingUtxoCount(page) {
  const summaryText = sanitizeText(
    await page.locator(".claim-summary-tile").filter({ hasText: "Matching UTxOs" }).textContent(),
  );
  const match = /Matching UTxOs\s+([0-9]+)/iu.exec(summaryText);
  if (!match) {
    throw new PreprodClaimDiscoveryStageError("matching_utxo_count_missing", "Claim discovery UI did not expose a matching UTxO count.");
  }
  return Number(match[1]);
}

function walletButtonName(role) {
  return new RegExp(`Proof Tool Preprod ${escapeRegex(role.replaceAll("_", " "))}`, "iu");
}

function parseExpectedMinimum(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new PreprodClaimDiscoveryStageError("native_reclaim_count_invalid", `${NATIVE_RECLAIM_COUNT_ENV} must be a positive integer.`);
  }
  return Number(value);
}

function requireOption(value, name) {
  if (!value) {
    throw new PreprodClaimDiscoveryStageError(`${name}_missing`, `${name} is required for claim discovery.`);
  }
  return value;
}

function sanitizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function redactCredential(value) {
  if (typeof value !== "string" || value.length < 16) {
    return "[redacted-credential]";
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
