import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdaOnlyFundingStage, runNativeAssetFundingStage } from "./funding-stage.mjs";

const tempDirs = [];
const compromisedCredential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const nativeUnit = `${"a".repeat(56)}4e4654`;

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("ADA-only preprod funding stage", () => {
  it("drives the funding page through connect, build, sign, submit, and artifact capture", async () => {
    const outputDir = tempDir();
    const page = fakeFundingPage();

    const result = await runAdaOnlyFundingStage({
      env: {
        RECLAIM_E2E_ADA_ONLY_AMOUNT: "1.75",
      },
      page,
      walletHarness: fakeWalletHarness(),
      outputDir,
    });

    expect(result.ok).toBe(true);
    expect(page.calls).toEqual([
      ["selectOption", "Cardano wallet", "reclaim_funder"],
      ["click", "connect wallet"],
      ["waitForText", "/CIP-30 wallet address/iu"],
      ["fill", "Payment key credential", compromisedCredential],
      ["fill", "ADA amount", "1.75"],
      ["click", "refresh assets"],
      ["waitForLabel", "Wallet inventory"],
      ["inputValue", "Wallet inventory"],
      ["click", "build transaction"],
      ["waitForText", "Datum CBOR"],
      ["click", "sign and submit"],
      ["waitForText", "Transaction submitted"],
      ["screenshot", path.join(outputDir, "screenshots", "fund-ada-only-reclaim.png")],
    ]);

    const artifact = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(artifact).toMatchObject({
      schema: "proof-tool-preprod-funding-stage-v1",
      stage: "fund-ada-only-reclaim",
      fundingWalletRole: "reclaim_funder",
      compromisedWalletRole: "compromised_user",
      adaAmount: "1.75",
      reviewedTxHash: "reviewed-body-hash",
      submittedTxHash: "submitted-funding-hash",
      screenshots: ["screenshots/fund-ada-only-reclaim.png"],
    });
    expect(JSON.stringify(artifact)).not.toContain(compromisedCredential);
    expect(artifact.compromisedCredential).toBe("19e07fbc...5a8702e4");
  });

  it("rejects invalid ADA amounts before touching the page", async () => {
    const page = fakeFundingPage();

    await expect(
      runAdaOnlyFundingStage({
        env: {
          RECLAIM_E2E_ADA_ONLY_AMOUNT: "0.0000001",
        },
        page,
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
      }),
    ).rejects.toMatchObject({
      code: "ada_amount_invalid",
    });
    expect(page.calls).toEqual([]);
  });

  it("requires the compromised wallet payment credential from the harness", async () => {
    await expect(
      runAdaOnlyFundingStage({
        page: fakeFundingPage(),
        walletHarness: {
          roleState() {
            return { paymentCredential: null };
          },
        },
        outputDir: tempDir(),
      }),
    ).rejects.toMatchObject({
      code: "compromised_credential_missing",
    });
  });

  it("surfaces funding submit failures from the page instead of waiting only for success", async () => {
    await expect(
      runAdaOnlyFundingStage({
        page: fakeFundingPage({
          submitFailure: "Provider rejected the transaction.",
        }),
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
      }),
    ).rejects.toMatchObject({
      code: "funding_submit_failed",
      message: "Provider rejected the transaction.",
    });
  });

  it("surfaces funding build failures from the page instead of waiting only for the review", async () => {
    await expect(
      runAdaOnlyFundingStage({
        page: fakeFundingPage({
          buildFailure: "Wallet UTxOs do not contain enough lovelace.",
        }),
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
      }),
    ).rejects.toMatchObject({
      code: "funding_build_failed",
      message: "Wallet UTxOs do not contain enough lovelace.",
    });
  });
});

describe("native-asset preprod funding stage", () => {
  it("drives repeated native-asset funding transactions and captures redacted artifacts", async () => {
    const outputDir = tempDir();
    const page = fakeFundingPage({
      reviewedTxHashes: ["native-reviewed-hash-1", "native-reviewed-hash-2"],
      submittedTxHashes: ["native-submitted-hash-1", "native-submitted-hash-2"],
    });

    const result = await runNativeAssetFundingStage({
      env: {
        RECLAIM_E2E_NATIVE_ADA_AMOUNT: "2.25",
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        RECLAIM_E2E_NATIVE_ASSET_QUANTITY: "3",
        RECLAIM_E2E_NATIVE_RECLAIM_COUNT: "2",
      },
      page,
      walletHarness: fakeWalletHarness(),
      outputDir,
      previousFundingTxHashes: ["ada-funding-hash"],
    });

    expect(result.ok).toBe(true);
    expect(page.calls).toEqual([
      ["click", "lock another batch"],
      ["selectOption", "Cardano wallet", "reclaim_funder"],
      ["click", "connect wallet"],
      ["waitForText", "/CIP-30 wallet address/iu"],
      ["fill", "Payment key credential", compromisedCredential],
      ["fill", "ADA amount", "2.25"],
      ["click", "refresh assets"],
      ["waitForLabel", "Wallet inventory"],
      ["inputValue", "Wallet inventory"],
      ["click", "token"],
      ["fillPlaceholder", "Search policy ID or token name", nativeUnit],
      ["click", "select"],
      ["fillRole", "textbox", "amount to lock", "3"],
      ["click", "add token"],
      ["click", "build transaction"],
      ["waitForText", "Datum CBOR"],
      ["click", "sign and submit"],
      ["waitForText", "Transaction submitted"],
      ["screenshot", path.join(outputDir, "screenshots", "fund-native-asset-reclaims-1.png")],
      ["click", "lock another batch"],
      ["fill", "Payment key credential", compromisedCredential],
      ["fill", "ADA amount", "2.25"],
      ["click", "refresh assets"],
      ["waitForLabel", "Wallet inventory"],
      ["inputValue", "Wallet inventory"],
      ["click", "token"],
      ["fillPlaceholder", "Search policy ID or token name", nativeUnit],
      ["click", "select"],
      ["fillRole", "textbox", "amount to lock", "3"],
      ["click", "add token"],
      ["click", "build transaction"],
      ["waitForText", "Datum CBOR"],
      ["click", "sign and submit"],
      ["waitForText", "Transaction submitted"],
      ["screenshot", path.join(outputDir, "screenshots", "fund-native-asset-reclaims-2.png")],
    ]);

    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual([
      "fund-native-asset-reclaims.json",
      "fund-native-asset-reclaims-1.png",
      "fund-native-asset-reclaims-2.png",
    ]);
    const artifact = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(artifact).toMatchObject({
      schema: "proof-tool-preprod-native-funding-stage-v1",
      stage: "fund-native-asset-reclaims",
      fundingWalletRole: "reclaim_funder",
      compromisedWalletRole: "compromised_user",
      compromisedCredential: "19e07fbc...5a8702e4",
      expectedReclaimUtxosFunded: 2,
      adaAmount: "2.25",
      nativeAssetUnit: nativeUnit,
      nativeAssetQuantity: "3",
      screenshots: ["screenshots/fund-native-asset-reclaims-1.png", "screenshots/fund-native-asset-reclaims-2.png"],
    });
    expect(artifact.transactions).toHaveLength(2);
    expect(JSON.stringify(artifact)).not.toContain(compromisedCredential);
  });

  it("rejects a reused reviewed funding transaction before signing", async () => {
    const page = fakeFundingPage({
      reviewedTxHashes: ["previous-reviewed-hash"],
    });

    await expect(
      runNativeAssetFundingStage({
        env: {
          RECLAIM_E2E_NATIVE_ADA_AMOUNT: "2.25",
          RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
          RECLAIM_E2E_NATIVE_ASSET_QUANTITY: "3",
          RECLAIM_E2E_NATIVE_RECLAIM_COUNT: "1",
        },
        page,
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
        previousFundingTxHashes: ["previous-reviewed-hash"],
      }),
    ).rejects.toMatchObject({
      code: "funding_review_tx_reused",
    });
    expect(page.calls).not.toContainEqual(["click", "sign and submit"]);
  });

  it("rejects missing native asset unit before touching the page", async () => {
    const page = fakeFundingPage();

    await expect(
      runNativeAssetFundingStage({
        env: {
          RECLAIM_E2E_NATIVE_RECLAIM_COUNT: "2",
        },
        page,
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
      }),
    ).rejects.toMatchObject({
      code: "native_asset_unit_missing",
    });
    expect(page.calls).toEqual([]);
  });
});

function fakeWalletHarness() {
  return {
    roleState(role) {
      if (role !== "compromised_user") {
        throw new Error(`unexpected role: ${role}`);
      }
      return {
        paymentCredential: compromisedCredential,
      };
    },
  };
}

function fakeFundingPage(options = {}) {
  const calls = [];
  const state = {
    reviewedTxHashes: [...(options.reviewedTxHashes ?? [])],
    submittedTxHashes: [...(options.submittedTxHashes ?? [])],
    txHashReads: 0,
  };
  return {
    calls,
    getByLabel(label) {
      return {
        selectOption: vi.fn(async (value) => calls.push(["selectOption", label, value])),
        fill: vi.fn(async (value) => calls.push(["fill", label, value])),
        waitFor: vi.fn(async () => calls.push(["waitForLabel", label])),
        inputValue: vi.fn(async () => {
          calls.push(["inputValue", label]);
          return options.inventorySummary ?? "1 UTxO, 0 assets";
        }),
      };
    },
    getByPlaceholder(placeholder) {
      return {
        fill: vi.fn(async (value) => calls.push(["fillPlaceholder", placeholder, value])),
      };
    },
    getByRole(_role, options) {
      const name = regexName(options.name);
      return {
        click: vi.fn(async () => calls.push(["click", name])),
        fill: vi.fn(async (value) => calls.push(["fillRole", _role, name, value])),
      };
    },
    getByText(text) {
      return {
        waitFor: vi.fn(async () => {
          if (text === "Datum CBOR" && options.buildFailure) {
            return new Promise(() => undefined);
          }
          if (text === "Transaction submitted" && options.submitFailure) {
            return new Promise(() => undefined);
          }
          calls.push(["waitForText", text instanceof RegExp ? String(text) : text]);
        }),
      };
    },
    locator(selector) {
      return fakeLocator(selector, calls, options, state);
    },
    screenshot: vi.fn(async ({ path: screenshotPath }) => {
      mkdirSync(path.dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, "fake png", "utf8");
      calls.push(["screenshot", screenshotPath]);
    }),
  };
}

function fakeLocator(selector, calls, options, state) {
  if (selector === ".claim-notice.bad") {
    return {
      waitFor: vi.fn(async () => {
        if (!options.submitFailure && !options.buildFailure) {
          return new Promise(() => undefined);
        }
        calls.push(["waitForLocator", selector]);
      }),
    };
  }
  if (selector === ".claim-notice.bad p") {
    return {
      last: () => ({
        textContent: async () => options.submitFailure ?? options.buildFailure,
      }),
    };
  }
  if (selector === ".claim-review-row") {
    return {
      filter: () => ({
        locator: () => ({
          textContent: async () => {
            const reviewed = state.txHashReads % 2 === 0;
            state.txHashReads += 1;
            return reviewed
              ? state.reviewedTxHashes.shift() ?? "reviewed-body-hash"
              : state.submittedTxHashes.shift() ?? "submitted-funding-hash";
          },
        }),
      }),
    };
  }
  throw new Error(`unexpected selector: ${selector}`);
}

function regexName(value) {
  if (value instanceof RegExp) {
    return value.source.replaceAll("\\s+", " ").replaceAll(/[^a-z ]/giu, "").trim();
  }
  return String(value);
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-funding-stage-"));
  tempDirs.push(dir);
  return dir;
}
