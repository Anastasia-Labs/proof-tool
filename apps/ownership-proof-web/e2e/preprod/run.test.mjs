import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PREPROD_E2E_STAGES, TRANSACTION_APPROVAL_ENV, runPreprodE2E } from "./run.mjs";

const tempDirs = [];

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
    expect(manifest.stages).toHaveLength(PREPROD_E2E_STAGES.length);
    expect(manifest.stages.every((stage) => stage.status === "blocked")).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain("abandon");
    expect(result.report).toContain(`${TRANSACTION_APPROVAL_ENV}=1`);
    expect(result.report).toContain("No browser automation");
  });

  it("keeps approved live runs fail-closed until stage execution exists", async () => {
    const repo = tempDir();
    const commit = "abcdef1234567890abcdef1234567890abcdef12";
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
      now: () => new Date("2026-07-05T13:00:00.000Z"),
      execFile: fakeGit({ commit, status: "" }),
      walletHarnessLoader: async () => fakeWalletHarness(),
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("live_browser_flow_not_implemented");
    expect(result.report).toContain("Pending stages");
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual(["run-manifest.json", "wallet-harness.json"]);
    const manifest = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(manifest.transactionSubmissionApproved).toBe(true);
    expect(manifest.stages.every((stage) => stage.status === "pending")).toBe(true);
    const walletHarness = JSON.parse(readFileSync(result.artifacts[1], "utf8"));
    expect(walletHarness.schema).toBe("proof-tool-preprod-cip30-harness-summary-v1");
    expect(JSON.stringify(walletHarness)).not.toContain("abandon");
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
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual(["run-manifest.json"]);
    expect(result.report).toContain("wallet_harness_test_failure");
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
