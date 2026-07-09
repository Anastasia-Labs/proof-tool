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
    const negativeGuardrailsStageRunner = vi.fn(async () => fakeNegativeGuardrailsStage(outputDir));
    const claimUiAcceptanceStageRunner = vi.fn(async () => fakeClaimUiAcceptanceStage(outputDir));

    const result = await runPreprodBrowserBootstrap({
      env: {},
      appTarget: {
        baseUrl: "http://127.0.0.1:3917",
      },
      helperTarget: {
        helperUrl: "http://127.0.0.1:49152",
        token: "pair-secret",
      },
      walletHarness,
      outputDir,
      browserLauncher: fake.launcher,
      fundingStageRunner,
      nativeFundingStageRunner,
      claimDiscoveryStageRunner,
      destinationProofStageRunner,
      negativeGuardrailsStageRunner,
      claimUiAcceptanceStageRunner,
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
        previousFundingTxHashes: ["f".repeat(64)],
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
        helperTarget: {
          helperUrl: "http://127.0.0.1:49152",
          token: "pair-secret",
        },
      }),
    );
    expect(claimUiAcceptanceStageRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        page: fake.page,
        walletHarness,
        outputDir,
        appTarget: {
          baseUrl: "http://127.0.0.1:3917",
        },
        helperTarget: {
          helperUrl: "http://127.0.0.1:49152",
          token: "pair-secret",
        },
        diagnosticProofBundle: {
          selectedOutrefs: ["a".repeat(64) + "#0"],
        },
      }),
    );
    expect(negativeGuardrailsStageRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        page: fake.page,
        walletHarness,
        outputDir,
        appTarget: {
          baseUrl: "http://127.0.0.1:3917",
        },
        helperTarget: {
          helperUrl: "http://127.0.0.1:49152",
          token: "pair-secret",
        },
        proofBundle: {
          selectedOutrefs: ["a".repeat(64) + "#0"],
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
      "negative-guardrails.json",
      "negative-guardrails.png",
      "claim-ui-acceptance.json",
      "claim-ui-acceptance.png",
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
      helperTarget: {
        helperUrl: "http://127.0.0.1:49152",
        token: "pair-secret",
      },
      walletHarness: fakeWalletHarness(),
      outputDir: tempDir(),
      browserLauncher: fake.launcher,
      fundingStageRunner: async () => fakeFundingStage(tempDir()),
      nativeFundingStageRunner: async () => fakeNativeFundingStage(tempDir()),
      claimDiscoveryStageRunner: async () => fakeClaimDiscoveryStage(tempDir()),
      destinationProofStageRunner: async () => fakeDestinationProofStage(tempDir()),
      negativeGuardrailsStageRunner: async () => fakeNegativeGuardrailsStage(tempDir()),
      claimUiAcceptanceStageRunner: async () => fakeClaimUiAcceptanceStage(tempDir()),
    });

    expect(fake.launcher.launch).toHaveBeenCalledWith({ headless: false });
  });

  it("uses a persistent Lace profile and runs the single-wallet smoke stage set", async () => {
    const outputDir = tempDir();
    const fake = fakeBrowserStack();
    const walletHarness = fakeLaceWalletDriver(fake.context);
    const nativeFundingStageRunner = vi.fn(async () => {
      throw new Error("native funding should stay out of Lace smoke");
    });
    const negativeGuardrailsStageRunner = vi.fn(async () => {
      throw new Error("negative guardrails should stay out of Lace smoke");
    });
    const claimDiscoveryStageRunner = vi.fn(async () => fakeClaimDiscoveryStage(outputDir));
    const destinationProofStageRunner = vi.fn(async () => fakeDestinationProofStage(outputDir));

    const result = await runPreprodBrowserBootstrap({
      env: {},
      appTarget: {
        baseUrl: "http://127.0.0.1:3917",
      },
      helperTarget: {
        helperUrl: "http://127.0.0.1:49152",
        token: "pair-secret",
      },
      walletHarness,
      outputDir,
      browserLauncher: fake.launcher,
      fundingStageRunner: async () => fakeFundingStage(outputDir),
      nativeFundingStageRunner,
      claimDiscoveryStageRunner,
      destinationProofStageRunner,
      negativeGuardrailsStageRunner,
      claimUiAcceptanceStageRunner: async () => fakeClaimUiAcceptanceStage(outputDir),
    });

    expect(result.ok).toBe(true);
    expect(fake.launcher.launch).not.toHaveBeenCalled();
    expect(walletHarness.launchBrowserContext).toHaveBeenCalledWith(fake.launcher, { headless: true });
    expect(nativeFundingStageRunner).not.toHaveBeenCalled();
    expect(negativeGuardrailsStageRunner).not.toHaveBeenCalled();
    expect(claimDiscoveryStageRunner).toHaveBeenCalledWith(expect.objectContaining({ expectedMinimumMatchingUtxos: 1 }));
    expect(destinationProofStageRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          RECLAIM_E2E_CLAIM_BATCH_SIZE: "1",
        }),
      }),
    );
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual([
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

  it("closes browser resources when navigation fails", async () => {
    const fake = fakeBrowserStack();
    fake.page.goto.mockRejectedValueOnce(new Error("navigation failed"));

    await expect(
      runPreprodBrowserBootstrap({
        appTarget: {
          baseUrl: "http://127.0.0.1:3917",
        },
        helperTarget: {
          helperUrl: "http://127.0.0.1:49152",
          token: "pair-secret",
        },
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
        browserLauncher: fake.launcher,
        fundingStageRunner: async () => fakeFundingStage(tempDir()),
        nativeFundingStageRunner: async () => fakeNativeFundingStage(tempDir()),
        claimDiscoveryStageRunner: async () => fakeClaimDiscoveryStage(tempDir()),
        destinationProofStageRunner: async () => fakeDestinationProofStage(tempDir()),
        negativeGuardrailsStageRunner: async () => fakeNegativeGuardrailsStage(tempDir()),
        claimUiAcceptanceStageRunner: async () => fakeClaimUiAcceptanceStage(tempDir()),
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
    recoveryPhraseForBrowserUi: vi.fn(async () => "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
  };
}

function fakeLaceWalletDriver(context) {
  return {
    mode: "lace",
    roles: ["deployer", "reclaim_funder", "compromised_user", "safe_claim_destination"],
    launchBrowserContext: vi.fn(async () => context),
    installOnPage: vi.fn(async () => undefined),
    probeWalletRoles: vi.fn(async () => ({
      reclaim_funder: {
        providerId: "lace",
        present: true,
        canEnable: null,
        networkId: null,
      },
    })),
    recoveryPhraseForBrowserUi: vi.fn(async () => "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
  };
}

function fakeFundingStage(outputDir) {
  const jsonPath = path.join(outputDir, "fund-ada-only-reclaim.json");
  const screenshotPath = path.join(outputDir, "screenshots", "fund-ada-only-reclaim.png");
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  return {
    ok: true,
    artifacts: [jsonPath, screenshotPath],
    summary: {
      submittedTxHash: "f".repeat(64),
    },
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

function fakeNegativeGuardrailsStage(outputDir) {
  const jsonPath = path.join(outputDir, "negative-guardrails.json");
  const screenshotPath = path.join(outputDir, "screenshots", "negative-guardrails.png");
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  return {
    ok: true,
    artifacts: [jsonPath, screenshotPath],
  };
}

function fakeClaimUiAcceptanceStage(outputDir) {
  const jsonPath = path.join(outputDir, "claim-ui-acceptance.json");
  const screenshotPath = path.join(outputDir, "screenshots", "claim-ui-acceptance.png");
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  return {
    ok: true,
    artifacts: [jsonPath, screenshotPath],
    summary: {
      browserUiDriven: true,
    },
  };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-browser-flow-"));
  tempDirs.push(dir);
  return dir;
}
