import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PREPROD_E2E_LACE_SMOKE_STAGES, PREPROD_E2E_STAGES, TRANSACTION_APPROVAL_ENV, runPreprodE2E } from "./run.mjs";

const tempDirs = [];
const nativeUnit = `${"a".repeat(56)}4e4654`;
const helperEnv = {
  RECLAIM_E2E_HELPER_URL: "http://127.0.0.1:49152",
  RECLAIM_E2E_HELPER_TOKEN: "pair-secret",
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("Phase 9A preprod E2E runner", () => {
  it("fails before artifact creation when preflight fails", async () => {
    const repo = tempDir();
    const result = await runPreprodE2E({
      env: {},
      cwd: repo,
      outputRoot: "output/preprod-e2e",
      preflightOptions: {
        env: {},
        cwd: repo,
        repoRoot: repo,
        readTextFile() {
          throw new Error("must not read files");
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("preflight_failed");
    expect(result.outputDir).toBeNull();
    expect(result.artifacts).toEqual([]);
  });

  it("fails closed before preflight when the proof provider env is invalid", async () => {
    const repo = tempDir();
    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_PROOF_PROVIDER: "gpu-farm",
      },
      cwd: repo,
      outputRoot: "output/preprod-e2e",
      preflightOptions: {
        env: {},
        cwd: repo,
        repoRoot: repo,
        readTextFile() {
          throw new Error("must not read files");
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("proof_provider_failed");
    expect(result.outputDir).toBeNull();
    expect(result.artifacts).toEqual([]);
    expect(result.report).toContain("proof_provider_invalid");
  });

  it("writes a redacted run manifest and blocks before live transaction approval", async () => {
    const repo = tempDir();
    const commit = "1234567890abcdef1234567890abcdef12345678";
    const walletPath = path.join(repo, "wallets.local.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        ...helperEnv,
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T12:00:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("live_transaction_gate_missing");
    expect(result.artifacts).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(manifest.schema).toBe("proof-tool-reclaim-preprod-e2e-run-v1");
    expect(manifest.transactionSubmissionApproved).toBe(false);
    expect(manifest.proofProvider).toBe("desktop-helper");
    expect(manifest.stages).toHaveLength(PREPROD_E2E_STAGES.length);
    expect(manifest.stages.every((stage) => stage.status === "blocked")).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain("abandon");
    expect(result.report).toContain(`${TRANSACTION_APPROVAL_ENV}=1`);
    expect(result.report).toContain("No browser automation");
  });

  it("returns success when approved live stage execution completes", async () => {
    const repo = tempDir();
    const commit = "abcdef1234567890abcdef1234567890abcdef12";
    const walletPath = path.join(repo, "wallets.local.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));
    let appEnv = null;

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        ...helperEnv,
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T13:00:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader: async () => fakeWalletHarness(),
      appTargetLoader: async ({ env }) => {
        appEnv = env;
        return fakeAppTarget();
      },
      deploymentStageRunner: async () => fakeDeploymentStage(repo),
      browserBootstrapRunner: async () => fakeBrowserBootstrap(repo),
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("live_preprod_e2e_complete");
    expect(result.report).toContain("Live preprod E2E completed all configured gated stages.");
    expect(result.report).not.toContain("Pending stages");
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual([
      "run-manifest.json",
      "live-config.json",
      "helper-target.json",
      "wallet-harness.json",
      "deployment-manifest.snapshot.json",
      "app-target.json",
      "deploy-or-verify-preprod-manifest.json",
      "browser-bootstrap.json",
      "reclaim-initial.png",
      "fund-ada-only-reclaim.json",
      "fund-ada-only-reclaim.png",
      "fund-native-asset-reclaims.json",
      "fund-native-asset-reclaims-1.png",
      "discover-matching-claims.json",
      "discover-matching-claims.png",
      "generate-destination-bound-proofs.json",
      "generate-destination-bound-proofs.png",
      "negative-guardrails.json",
      "negative-guardrails.png",
      "claim-ui-acceptance.json",
      "claim-ui-acceptance.png",
    ]);
    const manifest = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(manifest.transactionSubmissionApproved).toBe(true);
    expect(manifest.completedAt).toBe("2026-07-05T13:00:00.000Z");
    expect(manifest.stages.every((stage) => stage.status === "complete")).toBe(true);
    expect(path.basename(appEnv.RECLAIM_DEPLOYMENT_MANIFEST_PATH)).toBe("deployment-manifest.snapshot.json");
    expect(appEnv.RECLAIM_DEPLOYMENT_MANIFEST_JSON).toBeUndefined();
    const liveConfig = JSON.parse(readFileSync(result.artifacts[1], "utf8"));
    expect(liveConfig.schema).toBe("proof-tool-preprod-live-config-v1");
    const helperTarget = JSON.parse(readFileSync(result.artifacts[2], "utf8"));
    expect(helperTarget).toEqual({
      schema: "proof-tool-preprod-helper-target-v1",
      helperUrl: "http://127.0.0.1:49152",
      tokenRequired: true,
      token: "[redacted]",
    });
    expect(JSON.stringify(helperTarget)).not.toContain("pair-secret");
    const walletHarness = JSON.parse(readFileSync(result.artifacts[3], "utf8"));
    expect(walletHarness.schema).toBe("proof-tool-preprod-cip30-harness-summary-v1");
    expect(JSON.stringify(walletHarness)).not.toContain("abandon");
    const snapshot = JSON.parse(readFileSync(result.artifacts[4], "utf8"));
    expect(snapshot.source_commit).toBe(commit);
    const appTarget = JSON.parse(readFileSync(result.artifacts[5], "utf8"));
    expect(appTarget.schema).toBe("proof-tool-preprod-app-target-v1");
    expect(appTarget.baseUrl).toBe("http://127.0.0.1:3917");
    const deploymentStage = JSON.parse(readFileSync(result.artifacts[6], "utf8"));
    expect(deploymentStage.schema).toBe("proof-tool-preprod-deployment-stage-v1");
    const browserBootstrap = JSON.parse(readFileSync(result.artifacts[7], "utf8"));
    expect(browserBootstrap.schema).toBe("proof-tool-preprod-browser-bootstrap-v1");
  });

  it("uses the Lace smoke stage list when the wallet mode is Lace", async () => {
    const repo = tempDir();
    const commit = "abcdef1234567890abcdef1234567890abcdef12";
    const walletPath = path.join(repo, "wallets.local.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        RECLAIM_E2E_WALLET_MODE: "lace",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        ...helperEnv,
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T13:02:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader: async () => ({ ...fakeWalletHarness(), mode: "lace" }),
      appTargetLoader: async () => fakeAppTarget(),
      deploymentStageRunner: async () => fakeDeploymentStage(repo),
      browserBootstrapRunner: async () => fakeLaceBrowserBootstrap(repo),
    });

    expect(result.ok).toBe(true);
    const manifest = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(manifest.walletMode).toBe("lace");
    expect(manifest.stages.map((stage) => stage.name)).toEqual([...PREPROD_E2E_LACE_SMOKE_STAGES]);
    expect(result.report).toContain("Completed stages: deploy-or-verify-preprod-manifest, fund-ada-only-reclaim, discover-matching-claims, generate-destination-bound-proofs, claim-ui-acceptance.");
    expect(result.report).not.toContain("negative-guardrails");
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual([
      "run-manifest.json",
      "live-config.json",
      "helper-target.json",
      "wallet-harness.json",
      "deployment-manifest.snapshot.json",
      "app-target.json",
      "deploy-or-verify-preprod-manifest.json",
      "browser-bootstrap.json",
      "reclaim-initial.png",
      "fund-ada-only-reclaim.json",
      "fund-ada-only-reclaim.png",
      "discover-matching-claims.json",
      "discover-matching-claims.png",
      "generate-destination-bound-proofs.json",
      "generate-destination-bound-proofs.png",
      "claim-ui-acceptance.json",
      "claim-ui-acceptance.png",
    ]);
  });

  it("snapshots repo-relative manifest paths when running from the app directory", async () => {
    const repo = tempDir();
    const appCwd = path.join(repo, "apps", "ownership-proof-web");
    mkdirSync(path.join(repo, "deployments", "reclaim", "preprod"), { recursive: true });
    mkdirSync(appCwd, { recursive: true });
    const commit = "abcdef1234567890abcdef1234567890abcdef12";
    const walletPath = path.join(repo, "wallets.local.json");
    const manifestPath = path.join(repo, "deployments", "reclaim", "preprod", "live.local.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));
    writeFile(manifestPath, JSON.stringify(validManifest(commit)));
    let appEnv = null;

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_PATH: "deployments/reclaim/preprod/live.local.json",
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        ...helperEnv,
      },
      cwd: appCwd,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T13:05:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader: async () => fakeWalletHarness(),
      appTargetLoader: async ({ env }) => {
        appEnv = env;
        return fakeAppTarget();
      },
      deploymentStageRunner: async () => fakeDeploymentStage(repo),
      browserBootstrapRunner: async () => fakeBrowserBootstrap(repo),
    });

    expect(result.ok).toBe(true);
    expect(path.basename(appEnv.RECLAIM_DEPLOYMENT_MANIFEST_PATH)).toBe("deployment-manifest.snapshot.json");
    const snapshotPath = result.artifacts.find((artifact) => path.basename(artifact) === "deployment-manifest.snapshot.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    expect(snapshot.source_commit).toBe(commit);
  });

  it("fails closed before wallet loading when approved live config is incomplete", async () => {
    const repo = tempDir();
    const commit = "ba9876543210abcdef1234567890abcdef123456";
    const walletPath = path.join(repo, "wallets.local.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T13:15:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader() {
        throw new Error("must not load wallets before live config passes");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("live_config_failed");
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual(["run-manifest.json"]);
    expect(result.report).toContain("RECLAIM_E2E_NATIVE_ASSET_UNIT");
  });

  it("fails closed before wallet loading when the helper target is missing", async () => {
    const repo = tempDir();
    const commit = "cafe76543210abcdef1234567890abcdef123456";
    const walletPath = path.join(repo, "wallets.local.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T13:20:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader() {
        throw new Error("must not load wallets before helper target passes");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("helper_target_failed");
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual(["run-manifest.json", "live-config.json"]);
    expect(result.report).toContain("RECLAIM_E2E_HELPER_URL");
  });

  it("fails closed when the approved CIP-30 harness cannot be initialized", async () => {
    const repo = tempDir();
    const commit = "fedcba1234567890abcdef1234567890abcdef12";
    const walletPath = path.join(repo, "wallets.local.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        ...helperEnv,
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T13:30:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader: async () => {
        const error = new Error("wallet derivation failed");
        error.code = "wallet_harness_test_failure";
        throw error;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("cip30_harness_failed");
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual(["run-manifest.json", "live-config.json", "helper-target.json"]);
    expect(result.report).toContain("wallet_harness_test_failure");
  });

  it("fails closed with a Lace-specific code when the real Lace driver cannot be initialized", async () => {
    const repo = tempDir();
    const commit = "fedcba1234567890abcdef1234567890abcdef12";
    const walletPath = path.join(repo, "wallets.local.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        RECLAIM_E2E_WALLET_MODE: "lace",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        ...helperEnv,
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T13:35:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader: async () => {
        const error = new Error("Lace extension directory is missing");
        error.code = "lace_extension_missing";
        throw error;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("lace_wallet_driver_failed");
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual(["run-manifest.json", "live-config.json", "helper-target.json"]);
    expect(result.report).toContain("Real Lace wallet driver failed closed");
    expect(result.report).toContain("lace_extension_missing");
  });

  it("fails closed when the app target cannot be prepared", async () => {
    const repo = tempDir();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const walletPath = path.join(repo, "wallets.local.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        ...helperEnv,
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T14:00:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader: async () => fakeWalletHarness(),
      appTargetLoader: async () => {
        const error = new Error("app did not become ready");
        error.code = "app_target_test_failure";
        throw error;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("app_server_failed");
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual([
      "run-manifest.json",
      "live-config.json",
      "helper-target.json",
      "wallet-harness.json",
      "deployment-manifest.snapshot.json",
    ]);
    expect(result.report).toContain("app_target_test_failure");
  });

  it("fails closed when deployment verification fails after stopping the app target", async () => {
    const repo = tempDir();
    const commit = "456789abcdef0123456789abcdef0123456789ab";
    const walletPath = path.join(repo, "wallets.local.json");
    const appTarget = fakeAppTarget();
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        ...helperEnv,
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T14:15:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader: async () => fakeWalletHarness(),
      appTargetLoader: async () => appTarget,
      deploymentStageRunner: async () => {
        const error = new Error("deployment endpoint mismatch");
        error.code = "deployment_stage_test_failure";
        throw error;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("deployment_stage_failed");
    expect(appTarget.stopCalls).toBe(1);
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual([
      "run-manifest.json",
      "live-config.json",
      "helper-target.json",
      "wallet-harness.json",
      "deployment-manifest.snapshot.json",
      "app-target.json",
    ]);
    expect(result.report).toContain("deployment_stage_test_failure");
  });

  it("fails closed when browser bootstrap fails after stopping the app target", async () => {
    const repo = tempDir();
    const commit = "89abcdef0123456789abcdef0123456789abcdef";
    const walletPath = path.join(repo, "wallets.local.json");
    const appTarget = fakeAppTarget();
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        ...helperEnv,
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T14:30:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader: async () => fakeWalletHarness(),
      appTargetLoader: async () => appTarget,
      deploymentStageRunner: async () => fakeDeploymentStage(repo),
      browserBootstrapRunner: async () => {
        const error = new Error("browser launch failed");
        error.code = "browser_bootstrap_test_failure";
        throw error;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("browser_bootstrap_failed");
    expect(appTarget.stopCalls).toBe(1);
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual([
      "run-manifest.json",
      "live-config.json",
      "helper-target.json",
      "wallet-harness.json",
      "deployment-manifest.snapshot.json",
      "app-target.json",
      "deploy-or-verify-preprod-manifest.json",
    ]);
    expect(result.report).toContain("browser_bootstrap_test_failure");
  });

  it("fails closed when text artifacts leak a raw wallet mnemonic", async () => {
    const repo = tempDir();
    const commit = "89abcdef0123456789abcdef0123456789abcdef";
    const walletFile = validWalletFile();
    const leakedMnemonic = walletFile.reclaim_funder.mnemonic;
    const walletPath = path.join(repo, "wallets.local.json");
    const appTarget = fakeAppTarget();
    writeFile(walletPath, JSON.stringify(walletFile));

    const result = await runPreprodE2E({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        [TRANSACTION_APPROVAL_ENV]: "1",
        RECLAIM_REVIEW_TOKEN_SECRET: "test-review-token-secret",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        ...helperEnv,
      },
      cwd: repo,
      repoRoot: repo,
      outputRoot: "output/preprod-e2e",
      now: () => new Date("2026-07-05T14:45:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader: async () => fakeWalletHarness(),
      appTargetLoader: async () => appTarget,
      deploymentStageRunner: async () => fakeDeploymentStage(repo),
      browserBootstrapRunner: async () => {
        const artifactPath = path.join(repo, "browser-bootstrap.json");
        writeFile(
          artifactPath,
          JSON.stringify({
            schema: "proof-tool-preprod-browser-bootstrap-v1",
            leakedMnemonic,
          }),
        );
        return {
          ok: true,
          artifacts: [artifactPath],
        };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("artifact_leakage_failed");
    expect(appTarget.stopCalls).toBe(1);
    expect(result.report).toContain("artifact_secret_leakage");
    expect(result.report).toContain("browser-bootstrap.json:PREPROD_TEST_WALLETS_FILE.reclaim_funder.mnemonic");
    expect(result.report).not.toContain(leakedMnemonic);
  });
});

function validWalletFile() {
  return {
    deployer: { mnemonic: words("able", 12), address: "addr_test1deployer0000000000000000000000000000" },
    reclaim_funder: { mnemonic: words("baker", 12), address: "addr_test1funder00000000000000000000000000000" },
    compromised_user: { mnemonic: words("cable", 12), address: "addr_test1compromised000000000000000000000000" },
    safe_claim_destination: { mnemonic: words("delta", 12), address: "addr_test1safe0000000000000000000000000000000" },
  };
}

function validManifest(commit) {
  return {
    deployment_id: `preprod:${"a".repeat(56)}:${commit}`,
    network: "Preprod",
    network_id: 0,
    source_commit: commit,
    enabled: true,
    reference_scripts: {
      reclaim_base: {
        tx_hash: "1".repeat(64),
        output_index: 0,
        script_hash: "a".repeat(56),
      },
      reclaim_global: {
        tx_hash: "2".repeat(64),
        output_index: 0,
        script_hash: "b".repeat(56),
      },
    },
  };
}

function words(prefix, count) {
  const suffixes = [
    "abandon",
    "baker",
    "cable",
    "delta",
    "eager",
    "fable",
    "gather",
    "harbor",
    "island",
    "jacket",
    "kitten",
    "ladder",
    "magnet",
    "napkin",
    "orange",
    "paddle",
  ];
  return suffixes.slice(0, count).map((suffix) => `${prefix}${suffix}`).join(" ");
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-preprod-run-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, { encoding: "utf8", flag: "w" });
}

function fakeGit({ commit, status }) {
  return (_command, args, _options, callback) => {
    if (args[0] === "rev-parse") {
      callback(null, `${commit}\n`, "");
      return;
    }
    if (args[0] === "status") {
      callback(null, status, "");
      return;
    }
    callback(new Error(`unexpected git command: ${args.join(" ")}`), "", "");
  };
}

function fakeWalletHarness() {
  return {
    network: "Preprod",
    networkId: 0,
    derivation: "test-derivation",
    roles: ["deployer", "reclaim_funder", "compromised_user", "safe_claim_destination"],
    summary: {
      deployer: {
        address: "addr_test1...deployer",
        canSign: true,
      },
      compromised_user: {
        address: "addr_test1...compromised",
        canSign: false,
      },
    },
  };
}

function fakeAppTarget() {
  return {
    baseUrl: "http://127.0.0.1:3917",
    external: false,
    command: "pnpm",
    args: ["dev"],
    appDir: "/tmp/app",
    stopCalls: 0,
    async stop() {
      this.stopCalls += 1;
    },
  };
}

function fakeBrowserBootstrap(repo) {
  const stages = [
    ["browser-bootstrap.json", "proof-tool-preprod-browser-bootstrap-v1"],
    ["fund-ada-only-reclaim.json", "proof-tool-preprod-funding-stage-v1"],
    ["fund-native-asset-reclaims.json", "proof-tool-preprod-native-funding-stage-v1"],
    ["discover-matching-claims.json", "proof-tool-preprod-claim-discovery-stage-v1"],
    ["generate-destination-bound-proofs.json", "proof-tool-preprod-destination-proof-stage-v1"],
    ["negative-guardrails.json", "proof-tool-preprod-negative-guardrails-stage-v1"],
    ["claim-ui-acceptance.json", "proof-tool-preprod-claim-ui-acceptance-v1"],
  ];
  const screenshots = [
    "reclaim-initial.png",
    "fund-ada-only-reclaim.png",
    "fund-native-asset-reclaims-1.png",
    "discover-matching-claims.png",
    "generate-destination-bound-proofs.png",
    "negative-guardrails.png",
    "claim-ui-acceptance.png",
  ];
  const artifacts = [];
  for (const [fileName, schema] of stages) {
    const artifactPath = path.join(repo, fileName);
    writeFile(
      artifactPath,
      JSON.stringify({
        schema,
      }),
    );
    artifacts.push(artifactPath);
    const screenshotName = screenshots.shift();
    const screenshotPath = path.join(repo, "screenshots", screenshotName);
    writeFile(screenshotPath, "fake png");
    artifacts.push(screenshotPath);
  }
  return {
    ok: true,
    artifacts,
  };
}

function fakeLaceBrowserBootstrap(repo) {
  const stages = [
    ["browser-bootstrap.json", "proof-tool-preprod-browser-bootstrap-v1"],
    ["fund-ada-only-reclaim.json", "proof-tool-preprod-funding-stage-v1"],
    ["discover-matching-claims.json", "proof-tool-preprod-claim-discovery-stage-v1"],
    ["generate-destination-bound-proofs.json", "proof-tool-preprod-destination-proof-stage-v1"],
    ["claim-ui-acceptance.json", "proof-tool-preprod-claim-ui-acceptance-v1"],
  ];
  const screenshots = [
    "reclaim-initial.png",
    "fund-ada-only-reclaim.png",
    "discover-matching-claims.png",
    "generate-destination-bound-proofs.png",
    "claim-ui-acceptance.png",
  ];
  const artifacts = [];
  for (const [fileName, schema] of stages) {
    const artifactPath = path.join(repo, fileName);
    writeFile(
      artifactPath,
      JSON.stringify({
        schema,
      }),
    );
    artifacts.push(artifactPath);
    const screenshotName = screenshots.shift();
    const screenshotPath = path.join(repo, "screenshots", screenshotName);
    writeFile(screenshotPath, "fake png");
    artifacts.push(screenshotPath);
  }
  return {
    ok: true,
    artifacts,
  };
}

function fakeDeploymentStage(repo) {
  const jsonPath = path.join(repo, "deploy-or-verify-preprod-manifest.json");
  writeFile(
    jsonPath,
    JSON.stringify({
      schema: "proof-tool-preprod-deployment-stage-v1",
    }),
  );
  return {
    ok: true,
    artifacts: [jsonPath],
  };
}
