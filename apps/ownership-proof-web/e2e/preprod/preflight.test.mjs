import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatPreflightReport,
  redactSensitiveValue,
  runPreprodPreflight,
  validateExecutionGate,
  validatePreprodManifest,
  validatePreprodWalletFile,
  validateProviderHealth,
} from "./preflight.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("Phase 9A preprod preflight", () => {
  it("fails closed before reading local wallet files unless the live gate is explicit", async () => {
    let readCount = 0;
    const result = await runPreprodPreflight({
      env: {
        PREPROD_TEST_WALLETS_FILE: "deployments/reclaim/preprod/test-wallets.local.json",
      },
      readTextFile() {
        readCount += 1;
        throw new Error("must not read files before the live gate");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("live_preprod_gate_missing");
    expect(readCount).toBe(0);
  });

  it("rejects NODE_ENV=production even when the live preprod gate is set", () => {
    expect(
      validateExecutionGate({
        RECLAIM_E2E_LIVE_PREPROD: "1",
        NODE_ENV: "production",
      }).map((error) => error.code),
    ).toContain("production_node_env");
  });

  it("passes the scoped preflight with preprod wallet roles, matching source commit, and injected preprod health", async () => {
    const repo = tempDir();
    const walletPath = path.join(repo, "deployments/reclaim/preprod/test-wallets.local.json");
    const commit = "0e3c88005d771149269e7bb5829183f296aa1e17";
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodPreflight({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        PREPROD_TEST_WALLETS_FILE: "deployments/reclaim/preprod/test-wallets.local.json",
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
        RECLAIM_E2E_PROVIDER_HEALTH_JSON: JSON.stringify({ network: "preprod", network_id: 0 }),
      },
      cwd: path.join(repo, "apps/ownership-proof-web"),
      repoRoot: repo,
      execFile: fakeGit({ commit, status: "" }),
    });

    expect(result.ok).toBe(true);
    expect(formatPreflightReport(result)).toContain("preflight passed");
    expect(formatPreflightReport(result)).toContain("does not run browser automation or submit transactions");
  });

  it("resolves repo-root relative manifest and wallet paths when package cwd is apps/ownership-proof-web", async () => {
    const repo = tempDir();
    const appCwd = path.join(repo, "apps/ownership-proof-web");
    const commit = "1111111111111111111111111111111111111111";
    const walletPath = path.join(repo, "deployments/reclaim/preprod/test-wallets.local.json");
    const manifestPath = path.join(repo, "deployments/reclaim/preprod/preprod-manifest.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));
    writeFile(manifestPath, JSON.stringify(validManifest(commit)));

    const result = await runPreprodPreflight({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        PREPROD_TEST_WALLETS_FILE: "deployments/reclaim/preprod/test-wallets.local.json",
        RECLAIM_DEPLOYMENT_MANIFEST_PATH: "deployments/reclaim/preprod/preprod-manifest.json",
      },
      cwd: appCwd,
      repoRoot: repo,
      execFile: fakeGit({ commit, status: "" }),
    });

    expect(result.ok).toBe(true);
  });

  it("requires all four preprod wallet roles and redacts secret material from reports", async () => {
    const repo = tempDir();
    const walletPath = path.join(repo, "wallets.json");
    const leakedMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    writeFile(
      walletPath,
      JSON.stringify({
        deployer: { mnemonic: leakedMnemonic },
      }),
    );

    const result = await runPreprodPreflight({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest("2222222222222222222222222222222222222222")),
      },
      cwd: repo,
      repoRoot: repo,
      execFile: fakeGit({ commit: "2222222222222222222222222222222222222222", status: "" }),
    });
    const report = formatPreflightReport(result);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("wallet_role_missing");
    expect(report).not.toContain(leakedMnemonic);
    expect(report).toContain("No browser automation");
  });

  it("rejects malformed wallet roles and mainnet addresses", () => {
    const result = validatePreprodWalletFile({
      roles: {
        deployer: { mnemonic: "too short" },
        reclaim_funder: { mnemonic: words("able", 12), address: "addr1mainnetdestination" },
        compromised_user: { mnemonic: words("baker", 12) },
        safe_claim_destination: { mnemonic: words("cable", 12) },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("wallet_mnemonic_malformed");
    expect(result.errors.map((error) => error.code)).toContain("wallet_address_not_preprod");
  });

  it("requires the deployment manifest to be Preprod and match the current clean commit", () => {
    expect(
      validatePreprodManifest(
        {
          ...validManifest("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
          network: "Mainnet",
          network_id: 1,
        },
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ).map((error) => error.code),
    ).toEqual(expect.arrayContaining(["manifest_network_not_preprod", "manifest_network_id_not_preprod"]));

    expect(
      validatePreprodManifest(validManifest("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), "cccccccccccccccccccccccccccccccccccccccc").map(
        (error) => error.code,
      ),
    ).toContain("manifest_source_commit_mismatch");
  });

  it("rejects dirty git state before live preprod work", async () => {
    const repo = tempDir();
    const walletPath = path.join(repo, "wallets.json");
    const commit = "3333333333333333333333333333333333333333";
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const result = await runPreprodPreflight({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        PREPROD_TEST_WALLETS_FILE: walletPath,
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(validManifest(commit)),
      },
      cwd: repo,
      repoRoot: repo,
      execFile: fakeGit({ commit, status: " M apps/ownership-proof-web/package.json\n" }),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("git_worktree_dirty");
  });

  it("allows absent provider health but rejects injected health that does not report preprod", () => {
    expect(validateProviderHealth(undefined)).toEqual([]);
    expect(validateProviderHealth({ network: "mainnet", network_id: 1 }).map((error) => error.code)).toEqual(
      expect.arrayContaining(["provider_health_not_preprod", "provider_health_network_id_not_preprod"]),
    );
  });

  it("redacts nested secret-shaped fields", () => {
    const redacted = redactSensitiveValue({
      name: "preprod",
      mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      nested: {
        root_xprv: "xprv-secret",
        address: "addr_test1public",
      },
    });

    expect(redacted.name).toBe("preprod");
    expect(redacted.mnemonic).toMatch(/^\[redacted:/u);
    expect(redacted.nested.root_xprv).toMatch(/^\[redacted:/u);
    expect(redacted.nested.address).toBe("addr_test1public");
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
  };
}

function words(prefix, count) {
  const suffixes = [
    "able",
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
    "quartz",
    "rocket",
    "saddle",
    "table",
    "urban",
    "velvet",
    "window",
    "yellow",
  ];
  return suffixes.slice(0, count).map((suffix) => `${prefix}${suffix}`).join(" ");
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-preprod-preflight-"));
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
