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

it("continues when deployment review was already accepted in the browser context", async () => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "proof-tool-claim-ui-"));
  tempDirs.push(outputDir);
  const calls = [];
  const page = {
    async goto(url) {
      calls.push(["goto", url]);
    },
    getByRole(role, { name }) {
      return {
        async isVisible() {
          calls.push(["isVisible", role, name]);
          return name !== "I reviewed deployment";
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
          };
        },
        async count() {
          return text === "Recovery complete" ? 1 : 0;
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
  expect(calls).toContainEqual(["isVisible", "button", "I reviewed deployment"]);
  expect(calls).not.toContainEqual(["click", "button", "I reviewed deployment"]);
  const artifact = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
  expect(artifact.helper.token).toBe("[redacted]");
});

it("waits for exact recovery-word inputs and enabled claim actions", async () => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "proof-tool-claim-ui-flow-"));
  tempDirs.push(outputDir);
  const calls = [];
  let submitted = false;
  const page = {
    async goto() {},
    getByRole(role, { name }) {
      return {
        async isVisible() {
          return true;
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
          };
        },
        async count() {
          return text === "Recovery complete" && submitted ? 1 : 0;
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
  expect(calls).toContainEqual(["click", "button", "Continue to safe wallet", 180_000]);
  expect(calls).toContainEqual(["approveSigning", "safe_claim_destination", "claim"]);
});
