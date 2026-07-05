#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  REQUIRED_WALLET_ROLES,
  formatPreflightReport,
  redactSensitiveValue,
  runPreprodPreflight,
} from "./preflight.mjs";
import { preparePreprodAppTarget } from "./app-server.mjs";
import { runPreprodBrowserBootstrap } from "./browser-flow.mjs";
import { loadCip30HarnessFromEnv } from "./cip30-harness.mjs";
import { runDeployOrVerifyPreprodManifest } from "./deployment-stage.mjs";
import { validatePreprodLiveConfig, writePreprodLiveConfigArtifact } from "./live-config.mjs";

export const TRANSACTION_APPROVAL_ENV = "RECLAIM_E2E_SUBMIT_TRANSACTIONS";

export const PREPROD_E2E_STAGES = Object.freeze([
  "deploy-or-verify-preprod-manifest",
  "fund-ada-only-reclaim",
  "fund-native-asset-reclaims",
  "discover-matching-claims",
  "generate-destination-bound-proofs",
  "claim-first-batch",
  "claim-tail-and-receipt",
  "negative-guardrails",
]);

export async function runPreprodE2E(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const liveConfigValidator = options.liveConfigValidator ?? validatePreprodLiveConfig;
  const liveConfigArtifactWriter = options.liveConfigArtifactWriter ?? writePreprodLiveConfigArtifact;
  const walletHarnessLoader = options.walletHarnessLoader ?? loadCip30HarnessFromEnv;
  const appTargetLoader = options.appTargetLoader ?? preparePreprodAppTarget;
  const deploymentStageRunner = options.deploymentStageRunner ?? runDeployOrVerifyPreprodManifest;
  const browserBootstrapRunner = options.browserBootstrapRunner ?? runPreprodBrowserBootstrap;
  const outputRoot = options.outputRoot ?? env.RECLAIM_E2E_OUTPUT_DIR ?? "output/preprod-e2e";
  const preflight = await runPreprodPreflight(options.preflightOptions ?? options);
  if (!preflight.ok) {
    return {
      ok: false,
      code: "preflight_failed",
      preflight,
      outputDir: null,
      artifacts: [],
      report: formatPreflightReport(preflight),
    };
  }

  const runId = makeRunId(preflight.context.git.commit, now());
  const outputDir = path.resolve(options.cwd ?? process.cwd(), outputRoot, runId);
  const approved = env[TRANSACTION_APPROVAL_ENV]?.trim() === "1";
  const runManifest = {
    schema: "proof-tool-reclaim-preprod-e2e-run-v1",
    runId,
    sourceCommit: preflight.context.git.commit,
    createdAt: now().toISOString(),
    transactionSubmissionApproved: approved,
    requiredWalletRoles: REQUIRED_WALLET_ROLES,
    stages: PREPROD_E2E_STAGES.map((name) => ({
      name,
      status: approved ? "pending" : "blocked",
      reason: approved ? null : `${TRANSACTION_APPROVAL_ENV}=1 is required before browser signing or provider submission.`,
    })),
    context: redactSensitiveValue(preflight.context),
  };

  mkdir(outputDir, { recursive: true });
  const runManifestPath = path.join(outputDir, "run-manifest.json");
  writeFile(runManifestPath, `${JSON.stringify(runManifest, null, 2)}\n`, "utf8");
  const artifacts = [runManifestPath];

  if (!approved) {
    return {
      ok: false,
      code: "live_transaction_gate_missing",
      preflight,
      outputDir,
      artifacts,
      report: formatRunnerReport({
        ok: false,
        code: "live_transaction_gate_missing",
        preflight,
        outputDir,
        artifacts,
      }),
    };
  }

  try {
    const liveConfig = liveConfigValidator(env);
    artifacts.push(liveConfigArtifactWriter(liveConfig, outputDir, { writeFile }));
  } catch (error) {
    const result = {
      ok: false,
      code: "live_config_failed",
      preflight,
      outputDir,
      artifacts,
      error: sanitizeError(error),
    };
    return {
      ...result,
      report: formatRunnerReport(result),
    };
  }

  let walletHarness;
  try {
    walletHarness = await walletHarnessLoader({
      ...(options.walletHarnessOptions ?? {}),
      env,
      cwd: options.cwd ?? process.cwd(),
      repoRoot: options.repoRoot,
    });
  } catch (error) {
    const result = {
      ok: false,
      code: "cip30_harness_failed",
      preflight,
      outputDir,
      artifacts,
      error: sanitizeError(error),
    };
    return {
      ...result,
      report: formatRunnerReport(result),
    };
  }

  const walletHarnessPath = path.join(outputDir, "wallet-harness.json");
  writeFile(
    walletHarnessPath,
    `${JSON.stringify(
      {
        schema: "proof-tool-preprod-cip30-harness-summary-v1",
        network: walletHarness.network,
        networkId: walletHarness.networkId,
        derivation: walletHarness.derivation,
        roles: walletHarness.roles,
        summary: walletHarness.summary,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  artifacts.push(walletHarnessPath);

  let appTarget;
  try {
    appTarget = await appTargetLoader({
      ...(options.appTargetOptions ?? {}),
      env,
      cwd: options.cwd ?? process.cwd(),
      repoRoot: options.repoRoot,
      outputDir,
    });
  } catch (error) {
    const result = {
      ok: false,
      code: "app_server_failed",
      preflight,
      outputDir,
      artifacts,
      error: sanitizeError(error),
    };
    return {
      ...result,
      report: formatRunnerReport(result),
    };
  }

  const appTargetPath = path.join(outputDir, "app-target.json");
  writeFile(
    appTargetPath,
    `${JSON.stringify(
      {
        schema: "proof-tool-preprod-app-target-v1",
        baseUrl: appTarget.baseUrl,
        external: appTarget.external,
        command: appTarget.command,
        args: appTarget.args,
        appDir: appTarget.appDir,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  artifacts.push(appTargetPath);

  try {
    try {
      const deploymentStage = await deploymentStageRunner({
        ...(options.deploymentStageOptions ?? {}),
        appTarget,
        preflight,
        outputDir,
      });
      if (Array.isArray(deploymentStage?.artifacts)) {
        artifacts.push(...deploymentStage.artifacts);
      }
    } catch (error) {
      const result = {
        ok: false,
        code: "deployment_stage_failed",
        preflight,
        outputDir,
        artifacts,
        error: sanitizeError(error),
      };
      return {
        ...result,
        report: formatRunnerReport(result),
      };
    }

    const browserBootstrap = await browserBootstrapRunner({
      ...(options.browserBootstrapOptions ?? {}),
      env,
      appTarget,
      walletHarness,
      outputDir,
    });
    if (Array.isArray(browserBootstrap?.artifacts)) {
      artifacts.push(...browserBootstrap.artifacts);
    }
  } catch (error) {
    const result = {
      ok: false,
      code: "browser_bootstrap_failed",
      preflight,
      outputDir,
      artifacts,
      error: sanitizeError(error),
    };
    return {
      ...result,
      report: formatRunnerReport(result),
    };
  } finally {
    await appTarget.stop?.();
  }

  return {
    ok: false,
    code: "live_product_flow_not_implemented",
    preflight,
    outputDir,
    artifacts,
    report: formatRunnerReport({
      ok: false,
      code: "live_product_flow_not_implemented",
      preflight,
      outputDir,
      artifacts,
    }),
  };
}

export function formatRunnerReport(result) {
  const lines = [formatPreflightReport(result.preflight)];
  if (result.outputDir) {
    lines.push(`- artifact directory: ${result.outputDir}`);
  }
  if (result.artifacts?.length) {
    lines.push(`- artifacts: ${result.artifacts.map((artifact) => path.basename(artifact)).join(", ")}`);
  }
  if (result.code === "live_transaction_gate_missing") {
    lines.push(`Live browser signing and provider submission are blocked until ${TRANSACTION_APPROVAL_ENV}=1 is set.`);
    lines.push("No browser automation, wallet signing, provider submission, proof bytes, witness sets, or CBOR artifacts were produced.");
  } else if (result.code === "live_browser_flow_not_implemented" || result.code === "live_product_flow_not_implemented") {
    lines.push("Live preprod E2E execution is not complete yet; remaining claim/proof/receipt stages are still pending.");
    lines.push(`Pending stages: ${PREPROD_E2E_STAGES.join(", ")}.`);
  } else if (result.code === "cip30_harness_failed") {
    lines.push("CIP-30 preprod wallet harness failed closed before browser automation.");
    if (result.error) {
      lines.push(`- ${result.error.code}: ${result.error.message}`);
    }
  } else if (result.code === "live_config_failed") {
    lines.push("Live preprod transaction configuration failed closed before wallet or browser work.");
    if (result.error) {
      lines.push(`- ${result.error.code}: ${result.error.message}`);
    }
  } else if (result.code === "app_server_failed") {
    lines.push("Preprod app target failed closed before browser automation.");
    if (result.error) {
      lines.push(`- ${result.error.code}: ${result.error.message}`);
    }
  } else if (result.code === "browser_bootstrap_failed") {
    lines.push("Preprod browser bootstrap failed closed before funding or claim transactions.");
    if (result.error) {
      lines.push(`- ${result.error.code}: ${result.error.message}`);
    }
  } else if (result.code === "deployment_stage_failed") {
    lines.push("Preprod deployment verification failed closed before browser funding or claim work.");
    if (result.error) {
      lines.push(`- ${result.error.code}: ${result.error.message}`);
    }
  }
  return lines.join("\n");
}

function makeRunId(commit, now) {
  const timestamp = now.toISOString().replace(/[:.]/gu, "-");
  const shortCommit = typeof commit === "string" && commit ? commit.slice(0, 12) : "unknown";
  return `${timestamp}-${shortCommit}`;
}

function sanitizeError(error) {
  if (!error || typeof error !== "object") {
    return { code: "unknown_error", message: "Unknown CIP-30 harness error." };
  }
  return {
    code: typeof error.code === "string" ? error.code : "cip30_harness_error",
    message: typeof error.message === "string" ? error.message : "CIP-30 harness setup failed.",
  };
}

async function main() {
  const result = await runPreprodE2E();
  const report = result.report ?? formatRunnerReport(result);
  if (result.ok) {
    console.log(report);
    return;
  }
  console.error(report);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Phase 9A live-preprod E2E runner failed closed.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
