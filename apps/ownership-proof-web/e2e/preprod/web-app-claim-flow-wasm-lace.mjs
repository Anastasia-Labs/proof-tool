#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createPreprodProviderFromEnv } from "./cip30-harness.mjs";
import { assertNoPreprodArtifactSecretLeakage } from "./run.mjs";
import { createRealLaceProfileDriverFromEnv } from "./real-lace-driver.mjs";
import { prepareOrResumeAdaOnlyClaimFixture } from "./web-app-claim-fixture.mjs";
import { waitForSafeDestinationOutput } from "./web-app-claim-provider.mjs";
import {
  BUILD_PROVENANCE_PATH,
  CLAIM_FLOW_SCREENSHOTS,
  FIXTURE_MODE_PREPARE,
  WebAppClaimFlowContractError,
  assertCompleteScreenshotLedger,
  browserContextHeaders,
  loadWebAppClaimFlowConfig,
  redactedProvenanceArtifact,
  validateBrowserWasmClaimDeployment,
  validateClaimBuildReview,
  validateClaimSubmit,
  validatePreviewProvenance,
} from "./web-app-claim-flow-contract.mjs";

const COMPROMISED_ROLE = "compromised_user";
const SAFE_ROLE = "safe_claim_destination";
const DEFAULT_UI_TIMEOUT_MS = 120_000;
const PROOF_TIMEOUT_MS = 10 * 60_000;
const CONFIRMATION_TIMEOUT_MS = 5 * 60_000;
const CONFIRMATION_POLL_MS = 5_000;

export async function runWebAppClaimFlowWasmLace(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const fetchFn = options.fetch ?? globalThis.fetch;
  const browserLauncher = options.browserLauncher ?? chromium;
  const providerLoader = options.providerLoader ?? createPreprodProviderFromEnv;
  const walletDriverLoader = options.walletDriverLoader ?? createRealLaceProfileDriverFromEnv;
  const config = loadWebAppClaimFlowConfig(env, { cwd, now });
  const screenshotsDir = path.join(config.outputDir, "screenshots");
  mkdirSync(screenshotsDir, { recursive: true });

  const artifacts = [];
  const consoleEntries = [];
  const networkEntries = [];
  const run = {
    schema: "proof-tool-preprod-web-app-claim-flow-wasm-lace-v1",
    runId: config.runId,
    status: "running",
    createdAt: now().toISOString(),
    target: {
      mode: config.targetMode,
      origin: config.baseUrl,
      expectedCommitSha: config.expectedCommitSha,
      expectedPrNumber: config.expectedPrNumber,
      githubPullRequestMergeSha: config.prMergeSha,
    },
    journey: {
      startsAtLandingPage: true,
      proofMethod: "browser-wasm",
      walletProvider: "Lace",
      directClaimApiTransitions: false,
      fixtureMode: config.fixtureMode,
      preparedOutref: null,
      screens: [],
    },
    failure: null,
  };
  const runPath = path.join(config.outputDir, "run.json");
  const consolePath = path.join(config.outputDir, "console.log");
  const networkPath = path.join(config.outputDir, "network-summary.json");
  const providerPath = path.join(config.outputDir, "provider-confirmation.json");
  artifacts.push(runPath, consolePath, networkPath);
  persistRun(runPath, run);

  let context;
  try {
    if (typeof fetchFn !== "function") {
      throw new WebAppClaimFlowContractError("fetch_unavailable", "fetch is required for Preview and provider verification.");
    }
    const headers = browserContextHeaders(config);
    const provenanceResponse = await fetchJson(fetchFn, new URL(BUILD_PROVENANCE_PATH, config.baseUrl), headers, "preview_provenance_unavailable");
    const provenance = validatePreviewProvenance(provenanceResponse, config);
    run.target.provenance = redactedProvenanceArtifact(provenance);

    const claimDeploymentResponse = await fetchJson(fetchFn, new URL("/claim-api/deployment", config.baseUrl), headers, "preprod_manifest_incoherent");
    const claimDeployment = validateBrowserWasmClaimDeployment(claimDeploymentResponse);
    run.target.claimDeployment = claimDeployment;
    persistRun(runPath, run);

    const walletDriver = await walletDriverLoader({ env, cwd, repoRoot: options.repoRoot });
    if (walletDriver.browserChannel !== "chromium") {
      throw new WebAppClaimFlowContractError(
        "lace_browser_not_bundled_chromium",
        "The PR acceptance lane requires Playwright's bundled Chromium channel.",
      );
    }
    const compromised = requireRole(walletDriver, COMPROMISED_ROLE);
    const safe = requireRole(walletDriver, SAFE_ROLE);
    if (!compromised.paymentCredential || !safe.paymentCredential || compromised.paymentCredential === safe.paymentCredential) {
      throw new WebAppClaimFlowContractError("lace_role_identity_mismatch", "Compromised and safe Lace roles must have distinct payment credentials.");
    }
    if (compromised.canSign === true || safe.canSign !== true) {
      throw new WebAppClaimFlowContractError("lace_role_signing_policy_invalid", "Only the safe Lace role may sign the claim transaction.");
    }
    const confirmationProvider = await providerLoader(env);
    if (!confirmationProvider || typeof confirmationProvider.getUtxos !== "function") {
      throw new WebAppClaimFlowContractError("provider_confirmation_unavailable", "A read-capable Preprod provider is required.");
    }

    let expectedOutref = config.expectedOutref;
    if (config.fixtureMode === FIXTURE_MODE_PREPARE) {
      const preparedFixture = await prepareOrResumeAdaOnlyClaimFixture({
        browserLauncher,
        config,
        cwd,
        env,
        expectedPaymentCredential: compromised.paymentCredential,
        fetchFn,
        headers,
        outputArtifacts: artifacts,
        repoRoot: options.repoRoot,
        sleep: options.sleep,
      });
      expectedOutref = preparedFixture.outRefId;
      run.journey.fixturePreparation = {
        source: preparedFixture.source,
        fundingTransactionHash: preparedFixture.fundingTransactionHash,
      };
    }
    if (!expectedOutref) {
      throw new WebAppClaimFlowContractError("fixture_outref_missing", "The claim journey does not have a prepared outref.");
    }
    run.journey.preparedOutref = expectedOutref;
    const fixture = await verifyExactPreparedFixture(fetchFn, config, headers, compromised.paymentCredential, expectedOutref);
    run.journey.fixture = fixture;
    persistRun(runPath, run);

    context = await walletDriver.launchBrowserContext(browserLauncher, {
      headless: false,
      extraHTTPHeaders: headers,
      viewport: { width: 1440, height: 1000 },
    });
    await prepareLaceRoleBeforeNavigation(walletDriver, COMPROMISED_ROLE, config.baseUrl);
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_UI_TIMEOUT_MS);
    installObservation(page, consoleEntries, networkEntries, env);

    const capture = createScreenshotRecorder({ run, runPath, screenshotsDir, artifacts });
    const buildResponse = observeJsonResponse(page, "/claim-api/build");
    const submitResponse = observeJsonResponse(page, "/claim-api/submit");

    await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectHeading(page, "Recover funds from a compromised Cardano wallet");
    await capture("00-landing.png", page, "landing");
    await page.getByRole("link", { name: /Claim funds/iu }).click();
    await page.waitForURL((url) => url.origin === config.baseUrl && url.pathname === "/claim");

    await expectHeading(page, "Verify this recovery service");
    await capture("01-service-review.png", page, "deployment-review");
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expectHeading(page, "Connect impacted wallet");
    await capture("02-impacted-wallet.png", page, "impacted-wallet");
    await walletDriver.connectRole(page, COMPROMISED_ROLE, "claim-wallet-option");
    const scanBarrier = await createResponseBarrier(page, "/claim-api/reclaim-utxos");
    await page.getByRole("button", { name: "Connect impacted wallet", exact: true }).click();
    await walletDriver.approveDappConnection(COMPROMISED_ROLE, {
      beforeApprove: (extensionPage) => capture("03-lace-impacted-connect.png", extensionPage, "lace-impacted-connect"),
    });
    await walletDriver.assertActiveDappRole(page, COMPROMISED_ROLE);
    await scanBarrier.waitUntilIntercepted();
    await expectHeading(page, "Available claims");
    await capture("04-impacted-connected.png", page, "impacted-connected");
    await page.getByText("Scanning locked funds", { exact: false }).first().waitFor();
    await capture("05-scanning-claims.png", page, "scanning-claims");
    await scanBarrier.release();

    await page.getByText("Showing 1-1 of 1 UTxOs", { exact: true }).waitFor();
    await assertExpectedOutrefVisible(page, expectedOutref);
    await capture("06-available-claims.png", page, "available-claims");
    await page.getByRole("button", { name: "Continue to safe wallet", exact: true }).click();

    await expectHeading(page, "Connect safe wallet");
    await capture("07-safe-wallet.png", page, "safe-wallet");
    await walletDriver.disconnectDappOrigin(config.baseUrl, {
      beforeDisconnect: (extensionPage) =>
        capture("08-lace-impacted-disconnect.png", extensionPage, "lace-impacted-disconnect"),
    });
    await walletDriver.connectRole(page, SAFE_ROLE, "claim-wallet-option");
    await page.getByRole("button", { name: "Connect safe wallet", exact: true }).click();
    await walletDriver.approveDappConnection(SAFE_ROLE, {
      beforeApprove: (extensionPage) => capture("09-lace-safe-connect.png", extensionPage, "lace-safe-connect"),
    });
    await walletDriver.assertActiveDappRole(page, SAFE_ROLE);
    await page.getByRole("button", { name: "Confirm destination and continue", exact: true }).waitFor();
    await capture("10-safe-destination.png", page, "safe-destination");
    await page.getByRole("button", { name: "Confirm destination and continue", exact: true }).click();

    await expectHeading(page, "Create proofs");
    await page.getByRole("button", { name: "Choose method", exact: true }).click();
    const methodDialog = page.getByRole("dialog", { name: "Choose how to create proofs" });
    await methodDialog.getByRole("radio", { name: /Prove in this browser/iu }).click();
    await methodDialog.getByText("This browser can generate proofs", { exact: true }).waitFor({ timeout: PROOF_TIMEOUT_MS });
    await capture("11-proof-method.png", page, "proof-method-browser-ready");
    await methodDialog.getByRole("button", { name: "Continue", exact: true }).click();

    const mnemonic = await walletDriver.recoveryPhraseForBrowserUi(COMPROMISED_ROLE);
    const words = mnemonic.trim().split(/\s+/u);
    await page.getByRole("button", { name: `${words.length} words`, exact: true }).click();
    await page.getByLabel("Recovery word 1", { exact: true }).waitFor();
    await capture("12-create-proofs-ready.png", page, "create-proofs-ready");
    for (const [index, word] of words.entries()) {
      await page.getByLabel(`Recovery word ${index + 1}`, { exact: true }).fill(word);
    }
    await page.getByRole("button", { name: "Generate proofs", exact: true }).click();
    await page.getByText("Proof generation is running in this browser", { exact: false }).waitFor({ timeout: PROOF_TIMEOUT_MS });
    await assertRecoveryInputsCleared(page);
    await capture("13-proofs-generating.png", page, "create-proofs-generating");

    await expectHeading(page, "Proofs ready", PROOF_TIMEOUT_MS);
    await capture("14-proofs-ready.png", page, "create-proofs-complete");
    await page.getByRole("button", { name: "Continue to current batch", exact: true }).click();

    await expectHeading(page, "Claim funds");
    await capture("15-current-batch.png", page, "current-batch");
    await page.getByRole("button", { name: "Build transaction for review", exact: true }).click();
    const build = await buildResponse.next(DEFAULT_UI_TIMEOUT_MS);
    validateClaimBuildReview(build, expectedOutref, safe.address);
    await page.getByText("Review hash", { exact: true }).waitFor();
    await capture("16-transaction-review.png", page, "transaction-review");

    await walletDriver.assertActiveDappRole(page, SAFE_ROLE);
    const progressBarrier = await createResponseBarrier(page, "/claim-api/progress");
    await page.getByRole("button", { name: "Sign and submit claim", exact: true }).click();
    await walletDriver.approveWalletSigning(SAFE_ROLE, "claim", {
      beforeApprove: (extensionPage) => capture("17-lace-signing.png", extensionPage, "lace-signing"),
    });
    const submit = await submitResponse.next(DEFAULT_UI_TIMEOUT_MS);
    validateClaimSubmit(submit, build, expectedOutref);
    await progressBarrier.waitUntilIntercepted();
    await expectHeading(page, "Claim review");
    await page.getByText("Claim submitted", { exact: true }).waitFor();
    await capture("18-submitted.png", page, "submitted-refreshing");
    await progressBarrier.release();

    await page.getByText("Recovery complete", { exact: true }).waitFor({ timeout: CONFIRMATION_TIMEOUT_MS });
    await capture("19-recovery-complete.png", page, "claim-review-complete");
    assertCompleteScreenshotLedger(run.journey.screens.map((screen) => screen.file));

    const progress = await waitForSpentConfirmation(fetchFn, config, headers, expectedOutref, options.sleep);
    const destinationOutput = await waitForSafeDestinationOutput({
      build,
      provider: confirmationProvider,
      safeAddress: safe.address,
      sleep: options.sleep,
      transactionHash: submit.txHash,
    });
    const providerArtifact = {
      schema: "proof-tool-preprod-provider-confirmation-v1",
      deploymentId: claimDeployment.deploymentId,
      outRefId: expectedOutref,
      state: progress.state,
      transactionHash: submit.txHash,
      buildTransactionHash: build.txHash,
      safeDestinationSha256: sha256Hex(safe.address),
      destinationMatchedBuild: true,
      destinationMatchedProvider: true,
      destinationOutput,
      receiptMatchedSubmission: true,
    };
    writeFileSync(providerPath, `${JSON.stringify(providerArtifact, null, 2)}\n`, "utf8");
    artifacts.push(providerPath);

    run.status = "complete";
    run.completedAt = now().toISOString();
    run.result = {
      transactionHash: submit.txHash,
      preparedOutref: expectedOutref,
      providerState: progress.state,
      screenshotCount: run.journey.screens.length,
    };
    persistRun(runPath, run);
  } catch (error) {
    run.status = "failed";
    run.failedAt = now().toISOString();
    run.failure = sanitizeFailure(error);
    persistRun(runPath, run);
    throw error;
  } finally {
    writeFileSync(consolePath, consoleEntries.map((entry) => JSON.stringify(entry)).join("\n") + (consoleEntries.length ? "\n" : ""), "utf8");
    writeFileSync(networkPath, `${JSON.stringify(networkEntries, null, 2)}\n`, "utf8");
    await context?.close().catch(() => undefined);
  }

  try {
    assertNoPreprodArtifactSecretLeakage({ artifacts, env, cwd, repoRoot: options.repoRoot ?? defaultRepoRoot() });
  } catch (error) {
    run.status = "failed";
    run.failedAt = now().toISOString();
    run.failure = sanitizeFailure(error);
    delete run.completedAt;
    delete run.result;
    persistRun(runPath, run);
    throw error;
  }
  return {
    ok: true,
    code: "web_app_claim_flow_wasm_lace_complete",
    outputDir: config.outputDir,
    artifacts,
    result: run.result,
  };
}

export async function prepareLaceRoleBeforeNavigation(walletDriver, role, origin) {
  if (
    !walletDriver ||
    typeof walletDriver.disconnectDappOrigin !== "function" ||
    typeof walletDriver.switchActiveWallet !== "function"
  ) {
    throw new WebAppClaimFlowContractError(
      "lace_role_preload_unavailable",
      "The Lace driver must reset the local DApp origin and initialize the active wallet before the web-app page is created.",
    );
  }
  await walletDriver.disconnectDappOrigin(origin, { required: false });
  await walletDriver.switchActiveWallet(role);
}

function createScreenshotRecorder({ run, runPath, screenshotsDir, artifacts }) {
  return async (file, page, state) => {
    if (run.journey.screens.some((screen) => screen.file === file)) {
      throw new WebAppClaimFlowContractError("screenshot_duplicate", `Screenshot ${file} was captured more than once.`);
    }
    const expectedIndex = run.journey.screens.length;
    if (CLAIM_FLOW_SCREENSHOTS[expectedIndex] !== file) {
      throw new WebAppClaimFlowContractError(
        "claim_step_missing_or_out_of_order",
        `Expected screenshot ${CLAIM_FLOW_SCREENSHOTS[expectedIndex]} before ${file}.`,
      );
    }
    const screenshotPath = path.join(screenshotsDir, file);
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      mask: [page.locator('[data-claim-recovery-word="true"]'), page.locator('input[type="password"]')],
      maskColor: "#4b5563",
    });
    run.journey.screens.push({
      index: expectedIndex,
      file,
      state,
      url: sanitizedPageUrl(page.url()),
    });
    artifacts.push(screenshotPath);
    persistRun(runPath, run);
  };
}

async function verifyExactPreparedFixture(fetchFn, config, headers, paymentCredential, expectedOutref) {
  const progress = await fetchJson(
    fetchFn,
    progressUrl(config.baseUrl, expectedOutref),
    headers,
    "fixture_outref_missing_or_spent",
  );
  const entry = progress?.outrefs?.find((item) => item.outRefId === expectedOutref);
  if (!progress?.providerAvailable || entry?.state !== "unspent") {
    throw new WebAppClaimFlowContractError("fixture_outref_missing_or_spent", "The prepared claim outref is not provider-visible and unspent.");
  }

  const matches = [];
  let cursor = null;
  do {
    const url = new URL("/claim-api/reclaim-utxos", config.baseUrl);
    url.searchParams.set("limit", "100");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    const page = await fetchJson(fetchFn, url, headers, "fixture_outref_missing_or_spent");
    if (!page?.available || !Array.isArray(page.utxos)) {
      throw new WebAppClaimFlowContractError("fixture_outref_missing_or_spent", "The provider-backed reclaim index is unavailable.");
    }
    matches.push(
      ...page.utxos.filter(
        (utxo) =>
          utxo.state === "unspent" &&
          utxo.datum?.status === "valid" &&
          String(utxo.datum.paymentCredential).toLowerCase() === paymentCredential.toLowerCase(),
      ),
    );
    cursor = page.page?.nextCursor ?? null;
  } while (cursor);

  if (matches.length !== 1 || matches[0].outRefId.toLowerCase() !== expectedOutref) {
    throw new WebAppClaimFlowContractError(
      "prepared_claim_not_unique",
      "The compromised test credential must have exactly one unspent claim and it must be the prepared outref.",
    );
  }
  const nativeAssetCount = Object.keys(matches[0].value ?? {}).filter((unit) => unit !== "lovelace").length;
  if (nativeAssetCount !== 0) {
    throw new WebAppClaimFlowContractError("fixture_not_ada_only", "The merge-gating fixture must contain ADA only.");
  }
  return {
    outRefId: expectedOutref,
    state: "unspent",
    lovelace: String(matches[0].value?.lovelace ?? "0"),
    nativeAssetCount,
  };
}

async function assertExpectedOutrefVisible(page, outRef) {
  const [txHash, outputIndex] = outRef.split("#");
  const abbreviated = `${txHash.slice(0, 6)}...${txHash.slice(-6)}`;
  const row = page.getByRole("row").filter({ hasText: abbreviated }).filter({ hasText: outputIndex });
  if ((await row.count()) !== 1) {
    throw new WebAppClaimFlowContractError("prepared_claim_not_discovered", "The available-claims table did not show the exact prepared outref.");
  }
}

async function waitForSpentConfirmation(fetchFn, config, headers, expectedOutref, sleepFn = sleep) {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const progress = await fetchJson(fetchFn, progressUrl(config.baseUrl, expectedOutref), headers, "provider_confirmation_failed");
    const entry = progress?.outrefs?.find((item) => item.outRefId === expectedOutref);
    if (progress?.providerAvailable && (entry?.state === "spent_or_unknown" || entry?.state === "confirmed_spent")) {
      return entry;
    }
    await sleepFn(CONFIRMATION_POLL_MS);
  }
  throw new WebAppClaimFlowContractError("provider_confirmation_timeout", "Timed out waiting for the prepared outref to become provider-visible as spent.");
}

async function createResponseBarrier(page, pathname) {
  let interceptedResolve;
  let releaseResolve;
  const intercepted = new Promise((resolve) => {
    interceptedResolve = resolve;
  });
  const released = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  let used = false;
  const handler = async (route) => {
    if (used || new URL(route.request().url()).pathname !== pathname) {
      await route.continue();
      return;
    }
    used = true;
    const response = await route.fetch();
    interceptedResolve();
    await released;
    await route.fulfill({ response });
    await page.unroute(`**${pathname}*`, handler).catch(() => undefined);
  };
  await page.route(`**${pathname}*`, handler);
  return {
    async waitUntilIntercepted() {
      await withTimeout(intercepted, DEFAULT_UI_TIMEOUT_MS, `Timed out waiting for ${pathname}.`);
    },
    async release() {
      releaseResolve();
    },
  };
}

function observeJsonResponse(page, pathname) {
  const queue = [];
  const waiters = [];
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname !== pathname || response.status() < 200 || response.status() >= 300) {
      return;
    }
    const value = await response.json().catch(() => null);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(value);
    } else {
      queue.push(value);
    }
  });
  return {
    async next(timeoutMs) {
      if (queue.length > 0) {
        return queue.shift();
      }
      return withTimeout(new Promise((resolve) => waiters.push(resolve)), timeoutMs, `Timed out waiting for ${pathname} response.`);
    },
  };
}

function installObservation(page, consoleEntries, networkEntries, env) {
  page.on("console", (message) => {
    if (message.type() !== "warning" && message.type() !== "error") {
      return;
    }
    consoleEntries.push({ type: message.type(), text: sanitizeText(message.text(), env) });
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    networkEntries.push({
      method: request.method(),
      origin: url.origin,
      path: url.pathname,
      status: "failed",
      failure: sanitizeText(request.failure()?.errorText ?? "request failed", env),
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) {
      return;
    }
    const url = new URL(response.url());
    networkEntries.push({ method: response.request().method(), origin: url.origin, path: url.pathname, status: response.status() });
  });
}

async function assertRecoveryInputsCleared(page) {
  const inputs = page.locator('[data-claim-recovery-word="true"]');
  for (let index = 0; index < (await inputs.count()); index += 1) {
    if ((await inputs.nth(index).inputValue()) !== "") {
      throw new WebAppClaimFlowContractError("recovery_phrase_not_cleared", "Recovery phrase inputs remained populated after proof generation started.");
    }
  }
}

async function expectHeading(page, name, timeout = DEFAULT_UI_TIMEOUT_MS) {
  await page.getByRole("heading", { name, exact: true }).waitFor({ timeout });
}

async function fetchJson(fetchFn, url, headers, code) {
  let response;
  try {
    response = await fetchFn(url, { headers });
  } catch (error) {
    throw new WebAppClaimFlowContractError(code, `Could not fetch ${url.pathname}: ${error?.message ?? "request failed"}.`);
  }
  if (!response || response.status < 200 || response.status >= 300) {
    throw new WebAppClaimFlowContractError(code, `${url.pathname} returned HTTP ${response?.status ?? "unknown"}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new WebAppClaimFlowContractError(code, `${url.pathname} did not return valid JSON.`);
  }
}

function progressUrl(baseUrl, outRef) {
  const url = new URL("/claim-api/progress", baseUrl);
  url.searchParams.set("outrefs", outRef);
  return url;
}

function requireRole(walletDriver, role) {
  const state = walletDriver.roleState(role);
  if (!state) {
    throw new WebAppClaimFlowContractError("lace_role_identity_mismatch", `Dedicated Lace profile does not expose ${role}.`);
  }
  return state;
}

function sanitizedPageUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[unavailable]";
  }
}

function sanitizeText(value, env) {
  let text = String(value ?? "").replace(/\s+/gu, " ").slice(0, 600);
  for (const [key, secret] of Object.entries(env)) {
    if (!/(MNEMONIC|SEED|PHRASE|XPRV|PRIVATE|SECRET|TOKEN|PASSWORD)/u.test(key)) {
      continue;
    }
    const normalized = String(secret ?? "").trim();
    if (normalized.length >= 8) {
      text = text.replaceAll(normalized, "[secret-redacted]");
    }
  }
  return text
    .replace(/\baddr(?:_test)?1[0-9a-z]{20,}\b/giu, "[address-redacted]")
    .replace(/\bstake(?:_test)?1[0-9a-z]{20,}\b/giu, "[address-redacted]")
    .replace(/\b[0-9a-f]{96,}\b/giu, "[hex-redacted]");
}

function sanitizeFailure(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "web_app_claim_flow_failed",
    message: typeof error?.message === "string" ? error.message : "Web-app claim flow failed.",
  };
}

function persistRun(runPath, run) {
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new WebAppClaimFlowContractError("claim_step_timeout", message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRepoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
}

async function main() {
  try {
    const result = await runWebAppClaimFlowWasmLace();
    console.log(`Web-app browser-WASM + Lace claim flow completed: ${result.result.transactionHash}`);
    console.log(`Evidence: ${result.outputDir}`);
  } catch (error) {
    console.error(`${error?.code ?? "web_app_claim_flow_failed"}: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
