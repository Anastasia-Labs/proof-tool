import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as defaultSleep } from "node:timers/promises";
import { loadCip30HarnessFromEnv } from "./cip30-harness.mjs";
import { runAdaOnlyFundingStage } from "./funding-stage.mjs";
import { WebAppClaimFlowContractError } from "./web-app-claim-flow-contract.mjs";
import { createInjectedCip30HarnessDriver, installWalletDriverOnPage } from "./wallet-driver.mjs";

export const FIXTURE_DISCOVERY_TIMEOUT_ENV = "RECLAIM_E2E_FIXTURE_DISCOVERY_TIMEOUT_MS";
const DEFAULT_FIXTURE_DISCOVERY_TIMEOUT_MS = 3 * 60_000;
const FIXTURE_DISCOVERY_POLL_MS = 5_000;
const SETUP_UI_TIMEOUT_MS = 120_000;
const FUNDING_ROLE = "reclaim_funder";
const COMPROMISED_ROLE = "compromised_user";

export async function prepareOrResumeAdaOnlyClaimFixture(options = {}) {
  const { browserLauncher, config, expectedPaymentCredential, fetchFn, headers = {}, outputArtifacts = [] } = options;
  if (!browserLauncher || typeof browserLauncher.launch !== "function") {
    throw new WebAppClaimFlowContractError(
      "fixture_browser_unavailable",
      "Bundled Chromium is required to prepare the claim fixture.",
    );
  }
  if (typeof fetchFn !== "function") {
    throw new WebAppClaimFlowContractError(
      "fixture_provider_unavailable",
      "fetch is required to prepare the claim fixture.",
    );
  }

  const initialMatches = await listEligibleClaims(fetchFn, config.baseUrl, headers, expectedPaymentCredential);
  if (initialMatches.length > 1) {
    throw new WebAppClaimFlowContractError(
      "prepared_claim_not_unique",
      "The compromised test credential already has more than one unspent claim; clean the dedicated Preprod fixture wallet before retrying.",
    );
  }
  if (initialMatches.length === 1) {
    assertAdaOnly(initialMatches[0]);
    return fixtureResult(initialMatches[0], "resumed-existing");
  }

  const env = { ...(options.env ?? process.env), RECLAIM_E2E_LIVE_PREPROD: "1" };
  const harnessLoader = options.harnessLoader ?? loadCip30HarnessFromEnv;
  const driverFactory = options.driverFactory ?? createInjectedCip30HarnessDriver;
  const fundingRunner = options.fundingRunner ?? runAdaOnlyFundingStage;
  const harness = await harnessLoader({
    env,
    cwd: options.cwd,
    repoRoot: options.repoRoot,
    signingRoles: [FUNDING_ROLE],
  });
  const walletDriver = driverFactory(harness);
  assertFixtureWalletIdentity(walletDriver, expectedPaymentCredential);

  const setupDir = path.join(config.outputDir, "fixture-setup");
  mkdirSync(setupDir, { recursive: true });
  const browser = await browserLauncher.launch({ headless: true });
  let context;
  let funding;
  try {
    context = await browser.newContext({
      extraHTTPHeaders: headers,
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(SETUP_UI_TIMEOUT_MS);
    await installWalletDriverOnPage(page, walletDriver);
    await page.goto(new URL("/reclaim", config.baseUrl).href, { waitUntil: "domcontentloaded" });
    funding = await fundingRunner({
      env,
      page,
      walletHarness: walletDriver,
      outputDir: setupDir,
    });
    outputArtifacts.push(...(funding.artifacts ?? []));
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const submittedTxHash = String(funding?.summary?.submittedTxHash ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(submittedTxHash)) {
    throw new WebAppClaimFlowContractError(
      "fixture_funding_tx_invalid",
      "The fixture funding flow did not return a valid submitted transaction hash.",
    );
  }
  const match = await waitForFundedClaim({
    baseUrl: config.baseUrl,
    expectedPaymentCredential,
    fetchFn,
    headers,
    submittedTxHash,
    sleep: options.sleep ?? defaultSleep,
    timeoutMs: fixtureDiscoveryTimeoutMs(env),
  });
  assertAdaOnly(match);
  return fixtureResult(match, "funded-by-lane", submittedTxHash);
}

export async function listEligibleClaims(fetchFn, baseUrl, headers, paymentCredential) {
  const matches = [];
  let cursor = null;
  do {
    const url = new URL("/claim-api/reclaim-utxos", baseUrl);
    url.searchParams.set("limit", "100");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    const response = await fetchJson(fetchFn, url, headers);
    if (!response?.available || !Array.isArray(response.utxos)) {
      throw new WebAppClaimFlowContractError(
        "fixture_provider_unavailable",
        "The provider-backed reclaim index is unavailable.",
      );
    }
    matches.push(
      ...response.utxos.filter(
        (utxo) =>
          utxo.state === "unspent" &&
          utxo.datum?.status === "valid" &&
          String(utxo.datum.paymentCredential ?? "").toLowerCase() === String(paymentCredential).toLowerCase(),
      ),
    );
    cursor = response.page?.nextCursor ?? null;
  } while (cursor);
  return matches;
}

function assertFixtureWalletIdentity(walletDriver, expectedPaymentCredential) {
  const compromised = walletDriver.roleState(COMPROMISED_ROLE);
  const funder = walletDriver.roleState(FUNDING_ROLE);
  if (String(compromised?.paymentCredential ?? "").toLowerCase() !== String(expectedPaymentCredential).toLowerCase()) {
    throw new WebAppClaimFlowContractError(
      "fixture_wallet_identity_mismatch",
      "The local fixture wallet file and dedicated Lace profile do not derive the same compromised payment credential.",
    );
  }
  if (compromised?.canSign === true || funder?.canSign !== true) {
    throw new WebAppClaimFlowContractError(
      "fixture_signing_policy_invalid",
      "Fixture setup must permit only the reclaim_funder role to sign.",
    );
  }
}

async function waitForFundedClaim({
  baseUrl,
  expectedPaymentCredential,
  fetchFn,
  headers,
  submittedTxHash,
  sleep,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const matches = await listEligibleClaims(fetchFn, baseUrl, headers, expectedPaymentCredential);
    const transactionMatches = matches.filter((utxo) =>
      String(utxo.outRefId ?? "")
        .toLowerCase()
        .startsWith(`${submittedTxHash}#`),
    );
    if (transactionMatches.length === 1 && matches.length === 1) {
      return transactionMatches[0];
    }
    if (transactionMatches.length > 1 || matches.length > 1) {
      throw new WebAppClaimFlowContractError(
        "prepared_claim_not_unique",
        "Fixture funding produced more than one unspent claim for the compromised test credential.",
      );
    }
    await sleep(FIXTURE_DISCOVERY_POLL_MS);
  }
  throw new WebAppClaimFlowContractError(
    "fixture_funding_confirmation_timeout",
    "Timed out waiting for the newly funded ADA-only claim to become provider-visible.",
  );
}

async function fetchJson(fetchFn, url, headers) {
  let response;
  try {
    response = await fetchFn(url, { headers });
  } catch (error) {
    throw new WebAppClaimFlowContractError(
      "fixture_provider_unavailable",
      `Could not query the reclaim index: ${error instanceof Error ? error.message : "request failed"}.`,
    );
  }
  if (!response || response.status < 200 || response.status >= 300) {
    throw new WebAppClaimFlowContractError(
      "fixture_provider_unavailable",
      `The reclaim index returned HTTP ${response?.status ?? "unknown"}.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new WebAppClaimFlowContractError(
      "fixture_provider_unavailable",
      "The reclaim index did not return valid JSON.",
    );
  }
}

function assertAdaOnly(utxo) {
  if (!utxo || typeof utxo.outRefId !== "string" || !/^[0-9a-f]{64}#[0-9]+$/u.test(utxo.outRefId.toLowerCase())) {
    throw new WebAppClaimFlowContractError(
      "fixture_outref_invalid",
      "Prepared fixture does not expose a valid Cardano outref.",
    );
  }
  const nativeAssetCount = Object.keys(utxo.value ?? {}).filter((unit) => unit !== "lovelace").length;
  if (nativeAssetCount !== 0) {
    throw new WebAppClaimFlowContractError("fixture_not_ada_only", "The merge-gating fixture must contain ADA only.");
  }
}

function fixtureResult(utxo, source, fundingTransactionHash = null) {
  return Object.freeze({
    outRefId: utxo.outRefId.toLowerCase(),
    state: "unspent",
    lovelace: String(utxo.value?.lovelace ?? "0"),
    nativeAssetCount: 0,
    source,
    fundingTransactionHash,
  });
}

function fixtureDiscoveryTimeoutMs(env) {
  const raw = String(env[FIXTURE_DISCOVERY_TIMEOUT_ENV] ?? "").trim();
  if (!raw) {
    return DEFAULT_FIXTURE_DISCOVERY_TIMEOUT_MS;
  }
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new WebAppClaimFlowContractError(
      "fixture_discovery_timeout_invalid",
      `${FIXTURE_DISCOVERY_TIMEOUT_ENV} must be a positive integer number of milliseconds.`,
    );
  }
  return Number(raw);
}
