import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdaOnlyFundingStage } from "./funding-stage.mjs";

const tempDirs = [];
const compromisedCredential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";

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
      ["waitForText", "/UTxO|assets|No assets/iu"],
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

function fakeFundingPage() {
  const calls = [];
  return {
    calls,
    getByLabel(label) {
      return {
        selectOption: vi.fn(async (value) => calls.push(["selectOption", label, value])),
        fill: vi.fn(async (value) => calls.push(["fill", label, value])),
      };
    },
    getByRole(_role, options) {
      const name = regexName(options.name);
      return {
        click: vi.fn(async () => calls.push(["click", name])),
      };
    },
    getByText(text) {
      return {
        waitFor: vi.fn(async () => calls.push(["waitForText", text instanceof RegExp ? String(text) : text])),
      };
    },
    locator(selector) {
      return fakeLocator(selector);
    },
    screenshot: vi.fn(async ({ path: screenshotPath }) => {
      mkdirSync(path.dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, "fake png", "utf8");
      calls.push(["screenshot", screenshotPath]);
    }),
  };
}

function fakeLocator(selector) {
  if (selector === ".review-item") {
    return {
      filter: () => ({
        locator: () => ({
          textContent: async () => "reviewed-body-hash",
        }),
      }),
    };
  }
  if (selector === ".result-band.ok span") {
    return {
      last: () => ({
        textContent: async () => "submitted-funding-hash",
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
