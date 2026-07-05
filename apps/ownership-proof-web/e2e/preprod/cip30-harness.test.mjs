import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CIP30_HARNESS_WINDOW_BRIDGE,
  WALLET_DERIVATION_LIMITATION,
  createCip30WalletHarness,
  installCip30WalletHarnessOnPage,
  loadCip30HarnessFromEnv,
} from "./cip30-harness.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("preprod CIP-30 wallet harness", () => {
  it("fails before reading wallet files when the live gate is absent", async () => {
    await expect(
      loadCip30HarnessFromEnv({
        env: {
          PREPROD_TEST_WALLETS_FILE: "wallets.local.json",
        },
        provider: fakeProvider(),
        readTextFile() {
          throw new Error("must not read wallet secrets before gate");
        },
      }),
    ).rejects.toMatchObject({
      code: "live_preprod_gate_missing",
    });
  });

  it("derives deterministic preprod CIP-30 addresses without leaking mnemonic material", async () => {
    const walletFile = validWalletFile();
    const harness = await createCip30WalletHarness({
      provider: fakeProvider(),
      walletFile,
    });

    expect(harness.network).toBe("Preprod");
    expect(harness.networkId).toBe(0);
    expect(harness.derivation).toBe(WALLET_DERIVATION_LIMITATION);
    expect(harness.roles).toEqual(["deployer", "reclaim_funder", "compromised_user", "safe_claim_destination"]);

    const changeAddress = await harness.call("reclaim_funder", "getChangeAddress");
    const usedAddresses = await harness.call("reclaim_funder", "getUsedAddresses");
    expect(changeAddress).toMatch(/^[0-9a-f]+$/u);
    expect(usedAddresses).toEqual([changeAddress]);
    expect(await harness.call("reclaim_funder", "getNetworkId")).toBe(0);

    const serializedSummary = JSON.stringify(harness.summary);
    expect(serializedSummary).toContain("...");
    expect(serializedSummary).not.toContain("drip announce");
    expect(serializedSummary).not.toContain("fix kite");
    expect(serializedSummary).not.toContain(harness.roleState("reclaim_funder").address);
  });

  it("keeps the compromised wallet read-only even when signTx is requested", async () => {
    const harness = await createCip30WalletHarness({
      provider: fakeProvider(),
      walletFile: validWalletFile(),
    });

    expect(await harness.call("compromised_user", "getUsedAddresses")).toHaveLength(1);
    await expect(harness.call("compromised_user", "signTx", ["00", true])).rejects.toMatchObject({
      code: "wallet_role_signing_forbidden",
    });
    expect(harness.roleState("compromised_user")).toMatchObject({
      canSign: false,
      signAttempts: 1,
    });
  });

  it("loads wallet JSON from the gated local env path", async () => {
    const repo = tempDir();
    const walletPath = path.join(repo, "wallets.local.json");
    writeFile(walletPath, JSON.stringify(validWalletFile()));

    const harness = await loadCip30HarnessFromEnv({
      env: {
        RECLAIM_E2E_LIVE_PREPROD: "1",
        PREPROD_TEST_WALLETS_FILE: walletPath,
      },
      provider: fakeProvider(),
      cwd: repo,
    });

    expect(harness.roles).toContain("safe_claim_destination");
    expect(harness.roleState("safe_claim_destination").canSign).toBe(true);
  });

  it("installs role-scoped providers through a Playwright page bridge", async () => {
    const harness = await createCip30WalletHarness({
      provider: fakeProvider(),
      walletFile: validWalletFile(),
    });
    const page = fakePage();

    await installCip30WalletHarnessOnPage(page, harness);

    expect(page.exposed.name).toBe(CIP30_HARNESS_WINDOW_BRIDGE);
    expect(page.initScript.args.walletRoles.map((role) => role.id)).toEqual(harness.roles);
    expect(await page.exposed.callback("reclaim_funder", "getNetworkId", [])).toBe(0);
  });
});

function validWalletFile() {
  return {
    deployer: {
      mnemonic:
        "drip announce dwarf dose culture friend nasty large foam boy estate fault scan bar banner index swarm nut horse law sick swift cherry enough",
    },
    reclaim_funder: {
      mnemonic:
        "fix kite shoot check image divert armor receive long mind meat version grid robot green crucial couple object curtain soft scorpion main discover return",
    },
    compromised_user: {
      mnemonic:
        "enrich next used cinnamon rug warrior maid maple grocery video remind program govern fat journey abuse fish thunder capital smoke ensure crater firm column",
    },
    safe_claim_destination: {
      mnemonic:
        "current salt affair theory oil acoustic fun evidence present dose cook bicycle warrior arch real pluck surprise dice enlist same echo pulp tooth record",
    },
  };
}

function fakeProvider() {
  return {
    async getUtxos() {
      return [];
    },
    async submitTx() {
      return "0".repeat(64);
    },
  };
}

function fakePage() {
  return {
    exposed: null,
    initScript: null,
    async exposeFunction(name, callback) {
      this.exposed = { name, callback };
    },
    async addInitScript(script, args) {
      this.initScript = { script, args };
    },
  };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-cip30-harness-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, { encoding: "utf8", flag: "w" });
}
