#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MANIFEST_PATH_ENVS,
  REQUIRED_WALLET_ROLES,
  MANIFEST_JSON_ENV,
  formatPreflightReport,
  redactSensitiveValue,
  runPreprodPreflight,
} from "./preflight.mjs";
import { preparePreprodAppTarget } from "./app-server.mjs";
import { runPreprodBrowserBootstrap } from "./browser-flow.mjs";
import { loadCip30HarnessFromEnv } from "./cip30-harness.mjs";
import { runDeployOrVerifyPreprodManifest } from "./deployment-stage.mjs";
import { validatePreprodHelperTarget, writePreprodHelperTargetArtifact } from "./helper-target.mjs";
import { validatePreprodLiveConfig, writePreprodLiveConfigArtifact } from "./live-config.mjs";

export const TRANSACTION_APPROVAL_ENV = "RECLAIM_E2E_SUBMIT_TRANSACTIONS";
export const MANIFEST_SNAPSHOT_FILE = "deployment-manifest.snapshot.json";

const DEFAULT_REPO_ROOT = defaultRepoRoot();

export const PREPROD_E2E_STAGES = Object.freeze([
  "deploy-or-verify-preprod-manifest",
  "fund-ada-only-reclaim",
  "fund-native-asset-reclaims",
  "discover-matching-claims",
  "generate-destination-bound-proofs",
  "negative-guardrails",
  "claim-first-batch",
  "claim-tail-and-receipt",
]);

export async function runPreprodE2E(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const liveConfigValidator = options.liveConfigValidator ?? validatePreprodLiveConfig;
  const liveConfigArtifactWriter = options.liveConfigArtifactWriter ?? writePreprodLiveConfigArtifact;
  const helperTargetValidator = options.helperTargetValidator ?? validatePreprodHelperTarget;
  const helperTargetArtifactWriter = options.helperTargetArtifactWriter ?? writePreprodHelperTargetArtifact;
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

  let helperTarget;
  try {
    helperTarget = helperTargetValidator(env);
    artifacts.push(helperTargetArtifactWriter(helperTarget, outputDir, { writeFile }));
  } catch (error) {
    const result = {
      ok: false,
      code: "helper_target_failed",
      preflight,
      outputDir,
      artifacts,
      error: sanitizeError(error, "helper_target_error", "Helper target validation failed."),
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

  let runEnv = env;
  try {
    const manifestSnapshotPath = writeManifestSnapshotForRun({
      env,
      cwd: options.cwd ?? process.cwd(),
      repoRoot: options.repoRoot ?? DEFAULT_REPO_ROOT,
      outputDir,
      writeFile,
    });
    if (manifestSnapshotPath) {
      artifacts.push(manifestSnapshotPath);
      runEnv = envWithManifestSnapshot(env, manifestSnapshotPath);
    }
  } catch (error) {
    const result = {
      ok: false,
      code: "manifest_snapshot_failed",
      preflight,
      outputDir,
      artifacts,
      error: sanitizeError(error, "manifest_snapshot_error", "Deployment manifest snapshot failed."),
    };
    return {
      ...result,
      report: formatRunnerReport(result),
    };
  }

  let appTarget;
  try {
    appTarget = await appTargetLoader({
      ...(options.appTargetOptions ?? {}),
      env: runEnv,
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
      env: runEnv,
      appTarget,
      walletHarness,
      helperTarget,
      outputDir,
    });
    if (Array.isArray(browserBootstrap?.artifacts)) {
      artifacts.push(...browserBootstrap.artifacts);
    }
    runManifest.completedAt = now().toISOString();
    runManifest.stages = runManifest.stages.map((stage) => ({
      ...stage,
      status: "complete",
      reason: null,
    }));
    writeFile(runManifestPath, `${JSON.stringify(runManifest, null, 2)}\n`, "utf8");
    const result = {
      ok: true,
      code: "live_preprod_e2e_complete",
      preflight,
      outputDir,
      artifacts,
    };
    return {
      ...result,
      report: formatRunnerReport(result),
    };
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
  } else if (result.ok === true) {
    lines.push("Live preprod E2E completed all configured gated stages.");
    lines.push("Completed stages: deploy-or-verify-preprod-manifest, fund-ada-only-reclaim, fund-native-asset-reclaims, discover-matching-claims, generate-destination-bound-proofs, negative-guardrails, claim-first-batch, claim-tail-and-receipt.");
  } else if (result.code === "live_browser_flow_not_implemented" || result.code === "live_product_flow_not_implemented") {
    lines.push("Live preprod E2E execution is not complete yet; remaining negative guardrails are still pending.");
    lines.push("Implemented stages run through first-batch claim, tail receipt, and safe-wallet balance evidence when the configured deployment supports them.");
    lines.push("Pending stages: negative-guardrails.");
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
  } else if (result.code === "helper_target_failed") {
    lines.push("Preprod helper target validation failed closed before wallet or browser work.");
    if (result.error) {
      lines.push(`- ${result.error.code}: ${result.error.message}`);
    }
  } else if (result.code === "manifest_snapshot_failed") {
    lines.push("Deployment manifest snapshot failed closed before app startup.");
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

function sanitizeError(error, fallbackCode = "cip30_harness_error", fallbackMessage = "CIP-30 harness setup failed.") {
  if (!error || typeof error !== "object") {
    return { code: "unknown_error", message: "Unknown preprod runner error." };
  }
  return {
    code: typeof error.code === "string" ? error.code : fallbackCode,
    message: typeof error.message === "string" ? error.message : fallbackMessage,
  };
}

function writeManifestSnapshotForRun({ env, cwd, repoRoot, outputDir, writeFile }) {
  const manifestJson = stringValue(env[MANIFEST_JSON_ENV]);
  let contents = "";
  if (manifestJson) {
    contents = `${JSON.stringify(JSON.parse(manifestJson), null, 2)}\n`;
  } else {
    const manifestPath = firstString(...MANIFEST_PATH_ENVS.map((name) => env[name]));
    if (!manifestPath) {
      return null;
    }
    contents = readFileSync(resolveConfigPath(manifestPath, { cwd, repoRoot }), "utf8");
    JSON.parse(contents);
    if (!contents.endsWith("\n")) {
      contents = `${contents}\n`;
    }
  }

  const snapshotPath = path.join(outputDir, MANIFEST_SNAPSHOT_FILE);
  writeFile(snapshotPath, contents, "utf8");
  return snapshotPath;
}

function envWithManifestSnapshot(env, manifestSnapshotPath) {
  const next = {
    ...env,
    RECLAIM_DEPLOYMENT_MANIFEST_PATH: manifestSnapshotPath,
  };
  delete next[MANIFEST_JSON_ENV];
  delete next.RECLAIM_DEPLOYMENT_MANIFEST;
  delete next.RECLAIM_MANIFEST_PATH;
  return next;
}

function resolveConfigPath(value, { cwd, repoRoot }) {
  if (path.isAbsolute(value)) {
    return value;
  }
  const candidates = [path.resolve(repoRoot, value), path.resolve(cwd, value)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function firstString(...values) {
  for (const value of values) {
    const text = stringValue(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function defaultRepoRoot() {
  if (import.meta.url.startsWith("file:")) {
    try {
      return path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
    } catch {
      return path.resolve(process.cwd(), "../..");
    }
  }
  return path.resolve(process.cwd(), "../..");
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
