import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runClaimUiAcceptanceStage } from "./claim-ui-stage.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

it("clears resumable state and starts a fresh browser claim flow", async () => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "proof-tool-claim-ui-"));
  tempDirs.push(outputDir);
  const calls = [];
  const page = {
    async addInitScript(_callback, storageKey) {
      calls.push(["addInitScript", storageKey]);
    },
    context() {
      return fakeBrowserContext(calls);
    },
    async goto(url) {
      calls.push(["goto", url]);
    },
    getByRole(role, { name }) {
      return {
        async isVisible() {
          calls.push(["isVisible", role, name]);
          return name !== "Continue";
        },
        async waitFor(options) {
          calls.push(["waitForRole", role, name, options?.timeout ?? null]);
        },
        async click() {
          calls.push(["click", role, name]);
        },
      };
    },
    getByText(text) {
      return {
        first() {
          return {
            async waitFor() {
              calls.push(["waitForText", text]);
            },
            async isVisible() {
              return text === "Recovery complete";
            },
          };
        },
      };
    },
    async screenshot({ path: screenshotPath }) {
      mkdirSync(path.dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, "fake png");
    },
  };
  const walletHarness = {
    async recoveryPhraseForBrowserUi() {
      return "one two three four five six seven eight nine ten eleven twelve";
    },
    async connectRole(_page, role, purpose) {
      calls.push(["connectRole", role, purpose]);
    },
    async approveDappConnection(role) {
      calls.push(["approve", role]);
    },
  };

  const result = await runClaimUiAcceptanceStage({
    page,
    appTarget: { baseUrl: "https://proof.example" },
    helperTarget: { helperUrl: "http://127.0.0.1:49152", token: "pair-secret" },
    walletHarness,
    outputDir,
  });

  expect(result.ok).toBe(true);
  expect(calls).toContainEqual(["addInitScript", "proof-tool.claim-flow.resume.v1"]);
  expect(calls).toContainEqual(["click", "button", "Continue"]);
  const artifact = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
  expect(artifact.helper.token).toBe("[redacted]");
});

it("waits for exact recovery-word inputs and enabled claim actions", async () => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "proof-tool-claim-ui-flow-"));
  tempDirs.push(outputDir);
  const calls = [];
  let submitted = false;
  const page = {
    async addInitScript(_callback, storageKey) {
      calls.push(["addInitScript", storageKey]);
    },
    context() {
      return fakeBrowserContext(calls);
    },
    async goto() {},
    getByRole(role, { name }) {
      return {
        async isVisible() {
          return true;
        },
        async waitFor(options) {
          calls.push(["waitForRole", role, name, options?.timeout ?? null]);
        },
        async click(options) {
          calls.push(["click", role, name, options?.timeout ?? null]);
          if (name === "Sign and submit claim") {
            submitted = true;
          }
        },
      };
    },
    getByText(text) {
      return {
        first() {
          return {
            async waitFor({ timeout }) {
              calls.push(["waitForText", text, timeout]);
            },
            async isVisible() {
              return text === "Recovery complete" && submitted;
            },
          };
        },
      };
    },
    getByLabel(label, options) {
      return {
        async waitFor({ timeout }) {
          calls.push(["waitForLabel", label, options?.exact, timeout]);
        },
        async fill() {
          calls.push(["fill", label, options?.exact]);
        },
      };
    },
    async screenshot({ path: screenshotPath }) {
      mkdirSync(path.dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, "fake png");
    },
  };
  const walletHarness = {
    async recoveryPhraseForBrowserUi() {
      return "one two three four five six seven eight nine ten eleven twelve";
    },
    async connectRole() {},
    async approveDappConnection() {},
    async approveWalletSigning(role, purpose) {
      calls.push(["approveSigning", role, purpose]);
    },
  };

  const result = await runClaimUiAcceptanceStage({
    page,
    appTarget: { baseUrl: "https://proof.example" },
    helperTarget: { helperUrl: "http://127.0.0.1:49152", token: "pair-secret" },
    walletHarness,
    outputDir,
  });

  expect(result.ok).toBe(true);
  expect(calls).toContainEqual(["waitForLabel", "Recovery word 1", true, 180_000]);
  expect(calls).toContainEqual(["fill", "Recovery word 1", true]);
  expect(calls).toContainEqual(["fill", "Recovery word 10", true]);
  expect(calls).toContainEqual(["waitForRole", "heading", "Create proofs", 120_000]);
  expect(calls.some((call) => call[0] === "waitForText" && call[1] === "Create proofs")).toBe(false);
  expect(calls).toContainEqual(["click", "button", "Continue to safe wallet", 180_000]);
  expect(calls).toContainEqual(["waitForText", "Current draft", 180_000]);
  expect(calls).toContainEqual(["click", "button", "Confirm destination and continue", 180_000]);
  expect(calls).toContainEqual(["click", "button", "Continue to desktop app", 180_000]);
  expect(calls).toContainEqual(["click", "button", "Close installer chooser", 180_000]);
  expect(calls.some((call) => call[0] === "click" && String(call[2]).includes("Allow desktop connection"))).toBe(true);
  expect(calls).toContainEqual(["approveSigning", "safe_claim_destination", "claim"]);
});

function fakeBrowserContext(calls) {
  return {
    async newPage() {
      calls.push(["newPage"]);
      return {
        async goto(url) {
          calls.push(["courierGoto", url]);
        },
        getByText(text) {
          return {
            async waitFor({ timeout }) {
              calls.push(["courierWaitForText", text, timeout]);
            },
          };
        },
        async close() {
          calls.push(["courierClose"]);
        },
      };
    },
  };
}
