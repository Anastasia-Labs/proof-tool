import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { runClaimDiscoveryStage } from "./claim-discovery-stage.mjs";
import { runAdaOnlyFundingStage, runNativeAssetFundingStage } from "./funding-stage.mjs";
import { runNegativeGuardrailsStage } from "./guardrails-stage.mjs";
import { runDestinationProofStageForProvider } from "./proof-stage.mjs";
import { runClaimUiAcceptanceStage } from "./claim-ui-stage.mjs";
import { CLAIM_BATCH_SIZE_ENV } from "./proof-stage.mjs";
import { installWalletDriverOnPage, probeWalletRoles } from "./wallet-driver.mjs";

export const HEADED_ENV = "RECLAIM_E2E_HEADED";
export const BROWSER_BOOTSTRAP_STAGE = "browser-bootstrap";

export class PreprodBrowserFlowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodBrowserFlowError";
    this.code = code;
  }
}

export async function runPreprodBrowserBootstrap(options = {}) {
  const env = options.env ?? process.env;
  const appTarget = requireOption(options.appTarget, "appTarget");
  const walletHarness = requireOption(options.walletHarness, "walletHarness");
  const outputDir = requireOption(options.outputDir, "outputDir");
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const helperTarget = options.helperTarget ?? null;
  const browserLauncher = options.browserLauncher ?? chromium;
  const fundingStageRunner = options.fundingStageRunner ?? runAdaOnlyFundingStage;
  const nativeFundingStageRunner = options.nativeFundingStageRunner ?? runNativeAssetFundingStage;
  const claimDiscoveryStageRunner = options.claimDiscoveryStageRunner ?? runClaimDiscoveryStage;
  const destinationProofStageRunner = options.destinationProofStageRunner ?? runDestinationProofStageForProvider;
  const negativeGuardrailsStageRunner = options.negativeGuardrailsStageRunner ?? runNegativeGuardrailsStage;
  const claimUiAcceptanceStageRunner = options.claimUiAcceptanceStageRunner ?? runClaimUiAcceptanceStage;
  const realLaceMode = walletHarness.mode === "lace";
  const stageEnv = realLaceMode
    ? {
        ...env,
        [CLAIM_BATCH_SIZE_ENV]: env[CLAIM_BATCH_SIZE_ENV]?.trim() || "1",
      }
    : env;
  const screenshotsDir = path.join(outputDir, "screenshots");
  const stagePath = path.join(outputDir, "browser-bootstrap.json");
  const reclaimScreenshotPath = path.join(screenshotsDir, "reclaim-initial.png");
  let browser = null;
  let context = null;

  try {
    const headless = (env[HEADED_ENV] ?? "").trim() !== "1";
    if (typeof walletHarness.launchBrowserContext === "function") {
      context = await walletHarness.launchBrowserContext(browserLauncher, { headless });
    } else {
      browser = await browserLauncher.launch({
        headless,
      });
      context = await browser.newContext();
    }
    const page = await context.newPage();
    await installWalletDriverOnPage(page, walletHarness);

    const reclaimUrl = new URL("/reclaim", appTarget.baseUrl).toString();
    await page.goto(reclaimUrl, {
      waitUntil: "domcontentloaded",
    });
    const walletProbe = await probeWalletRoles(page, walletHarness);

    mkdir(screenshotsDir, { recursive: true });
    await page.screenshot({
      path: reclaimScreenshotPath,
      fullPage: true,
    });

    const artifact = {
      schema: "proof-tool-preprod-browser-bootstrap-v1",
      stage: BROWSER_BOOTSTRAP_STAGE,
      baseUrl: appTarget.baseUrl,
      url: reclaimUrl,
      headed: (env[HEADED_ENV] ?? "").trim() === "1",
      helperTarget: helperTarget
        ? {
            helperUrl: helperTarget.helperUrl,
            tokenRequired: true,
          }
        : null,
      walletRoles: walletProbe,
      screenshots: [path.relative(outputDir, reclaimScreenshotPath)],
    };
    writeFile(stagePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const artifacts = [stagePath, reclaimScreenshotPath];

    const fundingStage = await fundingStageRunner({
      ...(options.fundingStageOptions ?? {}),
      env: stageEnv,
      page,
      walletHarness,
      outputDir,
    });
    if (Array.isArray(fundingStage?.artifacts)) {
      artifacts.push(...fundingStage.artifacts);
    }
    if (!realLaceMode) {
      const nativeFundingStage = await nativeFundingStageRunner({
        ...(options.nativeFundingStageOptions ?? {}),
        env: stageEnv,
        page,
        walletHarness,
        outputDir,
        previousFundingTxHashes: collectSubmittedTxHashes(fundingStage),
      });
      if (Array.isArray(nativeFundingStage?.artifacts)) {
        artifacts.push(...nativeFundingStage.artifacts);
      }
    }
    const claimDiscoveryStage = await claimDiscoveryStageRunner({
      ...(options.claimDiscoveryStageOptions ?? {}),
      env: stageEnv,
      page,
      walletHarness,
      appTarget,
      helperTarget,
      outputDir,
      ...(realLaceMode ? { expectedMinimumMatchingUtxos: 1 } : {}),
    });
    if (Array.isArray(claimDiscoveryStage?.artifacts)) {
      artifacts.push(...claimDiscoveryStage.artifacts);
    }
    const destinationProofStage = await destinationProofStageRunner({
      ...(options.destinationProofStageOptions ?? {}),
      env: stageEnv,
      page,
      walletHarness,
      appTarget,
      helperTarget,
      outputDir,
    });
    if (Array.isArray(destinationProofStage?.artifacts)) {
      artifacts.push(...destinationProofStage.artifacts);
    }
    if (!realLaceMode) {
      const negativeGuardrailsStage = await negativeGuardrailsStageRunner({
        ...(options.negativeGuardrailsStageOptions ?? {}),
        env: stageEnv,
        page,
        walletHarness,
        appTarget,
        helperTarget,
        outputDir,
        proofBundle: destinationProofStage.proofBundle,
      });
      if (Array.isArray(negativeGuardrailsStage?.artifacts)) {
        artifacts.push(...negativeGuardrailsStage.artifacts);
      }
    }
    const claimUiAcceptanceStage = await claimUiAcceptanceStageRunner({
      ...(options.claimUiAcceptanceStageOptions ?? {}),
      env: stageEnv,
      page,
      walletHarness,
      appTarget,
      helperTarget,
      outputDir,
      diagnosticProofBundle: destinationProofStage.proofBundle,
    });
    if (Array.isArray(claimUiAcceptanceStage?.artifacts)) {
      artifacts.push(...claimUiAcceptanceStage.artifacts);
    }

    return {
      ok: true,
      artifacts,
      artifact,
    };
  } catch (error) {
    throw new PreprodBrowserFlowError(
      error?.code ?? "browser_bootstrap_failed",
      error?.message ?? "Preprod browser bootstrap failed.",
    );
  } finally {
    await safeClose(context);
    await safeClose(browser);
  }
}

function requireOption(value, name) {
  if (!value) {
    throw new PreprodBrowserFlowError(`${name}_missing`, `${name} is required for preprod browser bootstrap.`);
  }
  return value;
}

async function safeClose(value) {
  if (value && typeof value.close === "function") {
    await value.close();
  }
}

function collectSubmittedTxHashes(stageResult) {
  const hashes = [];
  const single = stageResult?.summary?.submittedTxHash;
  if (typeof single === "string" && single.trim()) {
    hashes.push(single.trim());
  }
  const many = stageResult?.summary?.submittedTxHashes;
  if (Array.isArray(many)) {
    for (const hash of many) {
      if (typeof hash === "string" && hash.trim()) {
        hashes.push(hash.trim());
      }
    }
  }
  return hashes;
}
