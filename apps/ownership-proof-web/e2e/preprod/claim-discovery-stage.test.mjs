import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaimDiscoveryStage } from "./claim-discovery-stage.mjs";

const tempDirs = [];
const compromisedCredential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("claim discovery preprod browser stage", () => {
  it("discovers matching claims through the UI without impacted wallet signing", async () => {
    const outputDir = tempDir();
    const page = fakeClaimPage({ matchingCount: 6 });

    const result = await runClaimDiscoveryStage({
      env: {
        RECLAIM_E2E_NATIVE_RECLAIM_COUNT: "4",
        RECLAIM_E2E_EXISTING_NATIVE_RECLAIM_COUNT: "1",
      },
      page,
      walletHarness: fakeWalletHarness([0, 0]),
      appTarget: { baseUrl: "http://127.0.0.1:3917" },
      outputDir,
    });

    expect(result.ok).toBe(true);
    expect(page.calls).toEqual([
      ["goto", "http://127.0.0.1:3917/claim"],
      ["click", "/^Continue$/iu"],
      ["waitFor", "heading", "Connect impacted wallet"],
      ["click", "/Proof Tool Preprod compromised user/iu"],
      ["click", "/Connect impacted wallet/iu"],
      ["waitFor", "heading", "Available claims"],
      ["textContent", ".claim-summary-tile", "Matching UTxOs", "strong"],
      ["screenshot", path.join(outputDir, "screenshots", "discover-matching-claims.png")],
    ]);

    const artifact = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(artifact).toMatchObject({
      schema: "proof-tool-preprod-claim-discovery-stage-v1",
      stage: "discover-matching-claims",
      url: "http://127.0.0.1:3917/claim",
      impactedWalletRole: "compromised_user",
      impactedPaymentCredential: "19e07fbc...5a8702e4",
      expectedMinimumMatchingUtxos: 6,
      discoveredMatchingUtxos: 6,
      impactedWalletSignAttempts: {
        before: 0,
        after: 0,
      },
      screenshots: ["screenshots/discover-matching-claims.png"],
    });
    expect(JSON.stringify(artifact)).not.toContain(compromisedCredential);
  });

  it("fails if fewer matching UTxOs are discovered than the funding stages should create", async () => {
    await expect(
      runClaimDiscoveryStage({
        env: {
          RECLAIM_E2E_NATIVE_RECLAIM_COUNT: "5",
        },
        page: fakeClaimPage({ matchingCount: 5 }),
        walletHarness: fakeWalletHarness([0, 0]),
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        outputDir: tempDir(),
      }),
    ).rejects.toMatchObject({
      code: "matching_utxo_count_too_low",
    });
  });

  it("fails if impacted wallet sign attempts change during discovery", async () => {
    await expect(
      runClaimDiscoveryStage({
        env: {
          RECLAIM_E2E_NATIVE_RECLAIM_COUNT: "5",
        },
        page: fakeClaimPage({ matchingCount: 6 }),
        walletHarness: fakeWalletHarness([0, 1]),
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        outputDir: tempDir(),
      }),
    ).rejects.toMatchObject({
      code: "impacted_wallet_signed",
    });
  });
});

function fakeWalletHarness(signAttempts) {
  let callIndex = 0;
  return {
    roleState(role) {
      if (role !== "compromised_user") {
        throw new Error(`unexpected role: ${role}`);
      }
      const signAttempt = signAttempts[Math.min(callIndex, signAttempts.length - 1)];
      callIndex += 1;
      return {
        role,
        paymentCredential: compromisedCredential,
        signAttempts: signAttempt,
      };
    },
  };
}

function fakeClaimPage({ matchingCount }) {
  const calls = [];
  return {
    calls,
    goto: vi.fn(async (url) => calls.push(["goto", url])),
    getByRole(role, options) {
      const name = roleName(options.name);
      return {
        click: vi.fn(async () => calls.push(["click", name])),
        waitFor: vi.fn(async () => calls.push(["waitFor", role, name])),
      };
    },
    locator(selector) {
      return {
        filter({ hasText }) {
          return {
            locator(childSelector) {
              return {
                textContent: vi.fn(async () => {
                  calls.push(["textContent", selector, hasText, childSelector]);
                  return String(matchingCount);
                }),
              };
            },
          };
        },
      };
    },
    screenshot: vi.fn(async ({ path: screenshotPath }) => {
      mkdirSync(path.dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, "fake png", "utf8");
      calls.push(["screenshot", screenshotPath]);
    }),
  };
}

function roleName(value) {
  if (value instanceof RegExp) {
    return String(value);
  }
  return String(value);
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-claim-discovery-stage-"));
  tempDirs.push(dir);
  return dir;
}
