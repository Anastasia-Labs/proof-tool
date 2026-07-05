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

    const result = await runPreprodBrowserBootstrap({
      env: {},
      appTarget: {
        baseUrl: "http://127.0.0.1:3917",
      },
      walletHarness,
      outputDir,
      browserLauncher: fake.launcher,
    });

    expect(result.ok).toBe(true);
    expect(fake.launcher.launch).toHaveBeenCalledWith({ headless: true });
    expect(walletHarness.installOnPage).toHaveBeenCalledWith(fake.page);
    expect(fake.page.goto).toHaveBeenCalledWith("http://127.0.0.1:3917/reclaim", { waitUntil: "domcontentloaded" });
    expect(fake.page.screenshot).toHaveBeenCalledWith({
      path: path.join(outputDir, "screenshots", "reclaim-initial.png"),
      fullPage: true,
    });
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    expect(fake.browser.close).toHaveBeenCalledTimes(1);

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

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-browser-flow-"));
  tempDirs.push(dir);
  return dir;
}
