import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LACE_EXTENSION_DIR_ENV,
  LACE_ROLE_LABELS_JSON_ENV,
  createRealLaceProfileDriverFromEnv,
} from "./real-lace-driver.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("real Lace profile driver", () => {
  it("fails closed when the unpacked extension directory is missing", async () => {
    await expect(
      createRealLaceProfileDriverFromEnv({
        env: {
          PW_USER_DATA_DIR: "/tmp/profile",
          PREPROD_TEST_WALLETS_FILE: "/tmp/wallets.local.json",
        },
      }),
    ).rejects.toMatchObject({
      code: "reclaim_e2e_lace_extension_dir_missing",
    });
  });

  it("launches a persistent headed profile with only the configured Lace extension", async () => {
    const repo = tempDir();
    const extensionDir = path.join(repo, "lace-extension");
    const userDataDir = path.join(repo, "lace-profile");
    const walletPath = path.join(repo, "wallets.local.json");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(path.join(extensionDir, "manifest.json"), JSON.stringify({ manifest_version: 3 }), "utf8");
    writeFileSync(walletPath, JSON.stringify(validWalletFile()), "utf8");

    const driver = await createRealLaceProfileDriverFromEnv({
      env: {
        [LACE_EXTENSION_DIR_ENV]: extensionDir,
        [LACE_ROLE_LABELS_JSON_ENV]: JSON.stringify({
          reclaim_funder: "Proof Tool Preprod Funder",
        }),
        PW_USER_DATA_DIR: userDataDir,
        PREPROD_TEST_WALLETS_FILE: walletPath,
      },
      cwd: repo,
      repoRoot: repo,
      deriveRoleState,
    });

    const calls = [];
    const context = await driver.launchBrowserContext(
      {
        async launchPersistentContext(profileDir, options) {
          calls.push({ profileDir, options });
          return fakeExtensionContext();
        },
      },
      { headless: true },
    );

    expect(context.serviceWorkers()).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].profileDir).toBe(userDataDir);
    expect(calls[0].options.headless).toBe(false);
    expect(calls[0].options.args).toEqual([
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ]);
    expect(driver.extensionId).toBe("laceextensionid");
  });

  it("keeps mnemonic material out of the public driver summary", async () => {
    const repo = tempDir();
    const extensionDir = path.join(repo, "lace-extension");
    const walletPath = path.join(repo, "wallets.local.json");
    const walletFile = validWalletFile();
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(path.join(extensionDir, "manifest.json"), JSON.stringify({ manifest_version: 3 }), "utf8");
    writeFileSync(walletPath, JSON.stringify(walletFile), "utf8");

    const driver = await createRealLaceProfileDriverFromEnv({
      env: {
        [LACE_EXTENSION_DIR_ENV]: extensionDir,
        PW_USER_DATA_DIR: path.join(repo, "lace-profile"),
        PREPROD_TEST_WALLETS_FILE: walletPath,
      },
      cwd: repo,
      repoRoot: repo,
      deriveRoleState,
    });

    const summaryText = JSON.stringify(driver.summary);
    expect(summaryText).not.toContain(walletFile.reclaim_funder.mnemonic);
    expect(summaryText).toContain("Proof Tool Preprod reclaim funder");
    expect(await driver.recoveryPhraseForBrowserUi("reclaim_funder")).toBe(walletFile.reclaim_funder.mnemonic);
  });
});

function validWalletFile() {
  return {
    deployer: { mnemonic: words("able", 12) },
    reclaim_funder: { mnemonic: words("baker", 12) },
    compromised_user: { mnemonic: words("cable", 12) },
    safe_claim_destination: { mnemonic: words("delta", 12) },
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
  ];
  return suffixes.slice(0, count).map((suffix) => `${prefix}${suffix}`).join(" ");
}

function deriveRoleState({ role, mnemonic, label }) {
  return {
    role,
    label,
    mnemonic,
    address: `addr_test1${role}`,
    addressHex: `hex-${role}`,
    rewardAddress: null,
    rewardAddressHex: null,
    paymentCredential: "a".repeat(56),
    stakeCredential: null,
    canSign: role !== "compromised_user",
  };
}

function fakeExtensionContext() {
  return {
    serviceWorkers() {
      return [
        {
          url() {
            return "chrome-extension://laceextensionid/background.js";
          },
        },
      ];
    },
  };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-real-lace-driver-"));
  tempDirs.push(dir);
  return dir;
}
