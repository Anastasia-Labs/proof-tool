import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { runAdaOnlyFundingStage, runNativeAssetFundingStage } from "./funding-stage.mjs";

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
  const browserLauncher = options.browserLauncher ?? chromium;
  const fundingStageRunner = options.fundingStageRunner ?? runAdaOnlyFundingStage;
  const nativeFundingStageRunner = options.nativeFundingStageRunner ?? runNativeAssetFundingStage;
  const screenshotsDir = path.join(outputDir, "screenshots");
  const stagePath = path.join(outputDir, "browser-bootstrap.json");
  const reclaimScreenshotPath = path.join(screenshotsDir, "reclaim-initial.png");
  let browser = null;
  let context = null;

  try {
    browser = await browserLauncher.launch({
      headless: (env[HEADED_ENV] ?? "").trim() !== "1",
    });
    context = await browser.newContext();
    const page = await context.newPage();
    await walletHarness.installOnPage(page);

    const reclaimUrl = new URL("/reclaim", appTarget.baseUrl).toString();
    await page.goto(reclaimUrl, {
      waitUntil: "domcontentloaded",
    });
    const walletProbe = await page.evaluate(async (requiredRoles) => {
      const cardano = globalThis.cardano && typeof globalThis.cardano === "object" ? globalThis.cardano : {};
      const roles = {};
      for (const role of requiredRoles) {
        const provider = cardano[role];
        const api = provider && typeof provider.enable === "function" ? await provider.enable() : null;
        roles[role] = {
          present: Boolean(provider),
          canEnable: Boolean(api),
          networkId: api && typeof api.getNetworkId === "function" ? await api.getNetworkId() : null,
        };
      }
      return roles;
    }, walletHarness.roles);

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
      walletRoles: walletProbe,
      screenshots: [path.relative(outputDir, reclaimScreenshotPath)],
    };
    writeFile(stagePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const artifacts = [stagePath, reclaimScreenshotPath];

    const fundingStage = await fundingStageRunner({
      ...(options.fundingStageOptions ?? {}),
      env,
      page,
      walletHarness,
      outputDir,
    });
    if (Array.isArray(fundingStage?.artifacts)) {
      artifacts.push(...fundingStage.artifacts);
    }
    const nativeFundingStage = await nativeFundingStageRunner({
      ...(options.nativeFundingStageOptions ?? {}),
      env,
      page,
      walletHarness,
      outputDir,
    });
    if (Array.isArray(nativeFundingStage?.artifacts)) {
      artifacts.push(...nativeFundingStage.artifacts);
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
