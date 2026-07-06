import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPreprodBrowserBootstrap } from "./browser-flow.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("preprod browser bootstrap", () => {
  it("installs the CIP-30 harness, opens /reclaim, captures artifacts, and closes the browser", async () => {
    const outputDir = tempDir();
    const fake = fakeBrowserStack();
    const walletHarness = fakeWalletHarness();
    const fundingStageRunner = vi.fn(async () => fakeFundingStage(outputDir));
    const nativeFundingStageRunner = vi.fn(async () => fakeNativeFundingStage(outputDir));
    const claimDiscoveryStageRunner = vi.fn(async () => fakeClaimDiscoveryStage(outputDir));
    const destinationProofStageRunner = vi.fn(async () => fakeDestinationProofStage(outputDir));
    const claimFirstBatchStageRunner = vi.fn(async () => fakeClaimFirstBatchStage(outputDir));
    const claimTailReceiptStageRunner = vi.fn(async () => fakeClaimTailReceiptStage(outputDir));

    const result = await runPreprodBrowserBootstrap({
      env: {},
      appTarget: {
        baseUrl: "http://127.0.0.1:3917",
      },
      walletHarness,
      outputDir,
      browserLauncher: fake.launcher,
      fundingStageRunner,
      nativeFundingStageRunner,
      claimDiscoveryStageRunner,
      destinationProofStageRunner,
      claimFirstBatchStageRunner,
      claimTailReceiptStageRunner,
    });

    expect(result.ok).toBe(true);
    expect(fake.launcher.launch).toHaveBeenCalledWith({ headless: true });
    expect(walletHarness.installOnPage).toHaveBeenCalledWith(fake.page);
    expect(fake.page.goto).toHaveBeenCalledWith("http://127.0.0.1:3917/reclaim", { waitUntil: "domcontentloaded" });
    expect(fake.page.screenshot).toHaveBeenCalledWith({
      path: path.join(outputDir, "screenshots", "reclaim-initial.png"),
      fullPage: true,
    });
    expect(fundingStageRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        page: fake.page,
        walletHarness,
        outputDir,
      }),
    );
    expect(nativeFundingStageRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        page: fake.page,
        walletHarness,
        outputDir,
      }),
    );
    expect(claimDiscoveryStageRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        page: fake.page,
        walletHarness,
        outputDir,
        appTarget: {
          baseUrl: "http://127.0.0.1:3917",
        },
      }),
    );
    expect(destinationProofStageRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        page: fake.page,
        walletHarness,
        outputDir,
        appTarget: {
          baseUrl: "http://127.0.0.1:3917",
        },
        helperTarget: null,
      }),
    );
    expect(claimFirstBatchStageRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        page: fake.page,
        walletHarness,
        outputDir,
        appTarget: {
          baseUrl: "http://127.0.0.1:3917",
        },
        proofBundle: {
          selectedOutrefs: ["a".repeat(64) + "#0"],
        },
      }),
    );
    expect(claimTailReceiptStageRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        page: fake.page,
        walletHarness,
        outputDir,
        appTarget: {
          baseUrl: "http://127.0.0.1:3917",
        },
        helperTarget: null,
        firstClaimBundle: {
          txHash: "1".repeat(64),
        },
      }),
    );
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual([
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
      "claim-first-batch.json",
      "claim-first-batch.png",
      "claim-tail-and-receipt.json",
      "claim-tail-and-receipt.png",
    ]);

    const artifact = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(artifact).toMatchObject({
      schema: "proof-tool-preprod-browser-bootstrap-v1",
      stage: "browser-bootstrap",
      baseUrl: "http://127.0.0.1:3917",
      url: "http://127.0.0.1:3917/reclaim",
      headed: false,
      screenshots: ["screenshots/reclaim-initial.png"],
    });
    expect(artifact.walletRoles.compromised_user).toEqual({
      present: true,
      canEnable: true,
      networkId: 0,
    });
  });

  it("supports headed mode through the explicit local env", async () => {
    const fake = fakeBrowserStack();
    await runPreprodBrowserBootstrap({
      env: {
        RECLAIM_E2E_HEADED: "1",
      },
      appTarget: {
        baseUrl: "http://127.0.0.1:3917",
      },
      walletHarness: fakeWalletHarness(),
      outputDir: tempDir(),
      browserLauncher: fake.launcher,
      fundingStageRunner: async () => fakeFundingStage(tempDir()),
      nativeFundingStageRunner: async () => fakeNativeFundingStage(tempDir()),
      claimDiscoveryStageRunner: async () => fakeClaimDiscoveryStage(tempDir()),
      destinationProofStageRunner: async () => fakeDestinationProofStage(tempDir()),
      claimFirstBatchStageRunner: async () => fakeClaimFirstBatchStage(tempDir()),
      claimTailReceiptStageRunner: async () => fakeClaimTailReceiptStage(tempDir()),
    });

    expect(fake.launcher.launch).toHaveBeenCalledWith({ headless: false });
  });

  it("closes browser resources when navigation fails", async () => {
    const fake = fakeBrowserStack();
    fake.page.goto.mockRejectedValueOnce(new Error("navigation failed"));

    await expect(
      runPreprodBrowserBootstrap({
        appTarget: {
          baseUrl: "http://127.0.0.1:3917",
        },
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
        browserLauncher: fake.launcher,
        fundingStageRunner: async () => fakeFundingStage(tempDir()),
        nativeFundingStageRunner: async () => fakeNativeFundingStage(tempDir()),
        claimDiscoveryStageRunner: async () => fakeClaimDiscoveryStage(tempDir()),
        destinationProofStageRunner: async () => fakeDestinationProofStage(tempDir()),
        claimFirstBatchStageRunner: async () => fakeClaimFirstBatchStage(tempDir()),
        claimTailReceiptStageRunner: async () => fakeClaimTailReceiptStage(tempDir()),
      }),
    ).rejects.toMatchObject({
      code: "browser_bootstrap_failed",
    });
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });
});

function fakeBrowserStack() {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (_fn, roles) =>
      Object.fromEntries(
        roles.map((role) => [
          role,
          {
            present: true,
            canEnable: true,
            networkId: 0,
          },
        ]),
      ),
    ),
    screenshot: vi.fn(async ({ path: screenshotPath }) => {
      mkdirSync(path.dirname(screenshotPath), { recursive: true });
      return Buffer.from("fake-png");
    }),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  const launcher = {
    launch: vi.fn(async () => browser),
  };
  return {
    launcher,
    browser,
    context,
    page,
  };
}

function fakeWalletHarness() {
  return {
    roles: ["deployer", "reclaim_funder", "compromised_user", "safe_claim_destination"],
    installOnPage: vi.fn(async () => undefined),
  };
}

function fakeFundingStage(outputDir) {
  const jsonPath = path.join(outputDir, "fund-ada-only-reclaim.json");
  const screenshotPath = path.join(outputDir, "screenshots", "fund-ada-only-reclaim.png");
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  return {
    ok: true,
    artifacts: [jsonPath, screenshotPath],
  };
}

function fakeNativeFundingStage(outputDir) {
  const jsonPath = path.join(outputDir, "fund-native-asset-reclaims.json");
  const screenshotPath = path.join(outputDir, "screenshots", "fund-native-asset-reclaims-1.png");
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  return {
    ok: true,
    artifacts: [jsonPath, screenshotPath],
  };
}

function fakeClaimDiscoveryStage(outputDir) {
  const jsonPath = path.join(outputDir, "discover-matching-claims.json");
  const screenshotPath = path.join(outputDir, "screenshots", "discover-matching-claims.png");
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  return {
    ok: true,
    artifacts: [jsonPath, screenshotPath],
  };
}

function fakeDestinationProofStage(outputDir) {
  const jsonPath = path.join(outputDir, "generate-destination-bound-proofs.json");
  const screenshotPath = path.join(outputDir, "screenshots", "generate-destination-bound-proofs.png");
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  return {
    ok: true,
    artifacts: [jsonPath, screenshotPath],
    proofBundle: {
      selectedOutrefs: ["a".repeat(64) + "#0"],
    },
  };
}

function fakeClaimFirstBatchStage(outputDir) {
  const jsonPath = path.join(outputDir, "claim-first-batch.json");
  const screenshotPath = path.join(outputDir, "screenshots", "claim-first-batch.png");
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  return {
    ok: true,
    artifacts: [jsonPath, screenshotPath],
    claimBundle: {
      txHash: "1".repeat(64),
    },
  };
}

function fakeClaimTailReceiptStage(outputDir) {
  const jsonPath = path.join(outputDir, "claim-tail-and-receipt.json");
  const screenshotPath = path.join(outputDir, "screenshots", "claim-tail-and-receipt.png");
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  return {
    ok: true,
    artifacts: [jsonPath, screenshotPath],
  };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-browser-flow-"));
  tempDirs.push(dir);
  return dir;
}
