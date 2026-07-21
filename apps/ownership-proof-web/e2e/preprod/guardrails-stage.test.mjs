import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNegativeGuardrailsStage } from "./guardrails-stage.mjs";

const tempDirs = [];
const deploymentId = `Preprod:${"a".repeat(56)}:test`;
const selectedOutrefs = [`${"1".repeat(64)}#0`];
const txCbor =
  "84a40081825820000000000000000000000000000000000000000000000000000000000000000000018182581d6019e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e41a001e8480021a0002a300a0f5f6";
const witnessSetCbor = "a100";
const reviewToken = "review-token-secret";
const proofHex = "ab".repeat(96);

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("preprod negative guardrails stage", () => {
  it("runs non-mutating guardrail probes and writes only redacted evidence", async () => {
    const outputDir = tempDir();
    const fetch = fakeFetch();
    const walletHarness = fakeWalletHarness();

    const result = await runNegativeGuardrailsStage({
      env: {},
      page: fakePage(),
      appTarget: { baseUrl: "http://127.0.0.1:3917" },
      helperTarget: { helperUrl: "http://127.0.0.1:49152", token: "pair-secret" },
      walletHarness,
      outputDir,
      proofBundle: proofBundle(),
      fetch,
    });

    expect(result.ok).toBe(true);
    expect(walletHarness.signCalls).toEqual([
      { role: "compromised_user", method: "signTx", args: ["00", true] },
      { role: "safe_claim_destination", method: "signTx", args: [txCbor, true] },
    ]);
    expect(fetch.calls[1].body).toMatchObject({
      unsignedTxCbor: `${txCbor.slice(0, -1)}0`,
      witnessSetCbor,
      claimBuildReviewToken: reviewToken,
    });
    expect(fetch.calls.map((call) => call.pathname)).toEqual([
      "/claim-api/build",
      "/claim-api/submit",
      "/claim-api/build",
      "/claim-api/draft",
    ]);
    const artifact = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(artifact).toMatchObject({
      schema: "proof-tool-preprod-negative-guardrails-stage-v1",
      stage: "negative-guardrails",
      selectedOutrefCount: 1,
      txCborWritten: false,
      witnessSetWritten: false,
      reviewTokenWritten: false,
      proofBytesWritten: false,
    });
    expect(artifact.checks.map((check) => check.name)).toEqual([
      "wrong-network-reclaim-page",
      "wrong-network-claim-page",
      "impacted-wallet-signing",
      "safe-impacted-wallet-overlap",
      "tampered-claim-submit",
      "wrong-destination-proof",
      "insufficient-safe-wallet-fee-ada",
    ]);
    expect(artifact.checks.every((check) => check.status === "blocked")).toBe(true);
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(txCbor);
    expect(serialized).not.toContain(witnessSetCbor);
    expect(serialized).not.toContain(reviewToken);
    expect(serialized).not.toContain(proofHex);
    expect(serialized).not.toContain("pair-secret");
  });

  it("fails if the tampered signed claim submit is accepted", async () => {
    await expect(
      runNegativeGuardrailsStage({
        env: {},
        page: fakePage(),
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        helperTarget: { helperUrl: "http://127.0.0.1:49152", token: "pair-secret" },
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
        proofBundle: proofBundle(),
        fetch: fakeFetch({ acceptTamperedSubmit: true }),
      }),
    ).rejects.toMatchObject({
      code: "tampered_claim_submit_not_rejected",
    });
  });
});

function fakeFetch(options = {}) {
  let buildCalls = 0;
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = JSON.parse(init.body);
    calls.push({ pathname: parsed.pathname, body });
    if (parsed.pathname === "/claim-api/build") {
      buildCalls += 1;
      if (buildCalls === 1) {
        return jsonResponse(claimBuildResponse());
      }
      return jsonResponse({ code: "proof_artifact_destination", error: "wrong destination" }, 400);
    }
    if (parsed.pathname === "/claim-api/submit") {
      if (options.acceptTamperedSubmit) {
        return jsonResponse({ txHash: "5".repeat(64) });
      }
      if (
        body.unsignedTxCbor !== txCbor &&
        body.witnessSetCbor === witnessSetCbor &&
        body.claimBuildReviewToken === reviewToken
      ) {
        return jsonResponse({ code: "claim_submit_review_mismatch", error: "tampered tx" }, 400);
      }
      return jsonResponse({ txHash: "5".repeat(64) });
    }
    if (parsed.pathname === "/claim-api/draft") {
      return jsonResponse({ code: "safe_wallet_lovelace_unavailable", error: "low ADA" }, 400);
    }
    throw new Error(`unexpected request ${parsed.pathname}`);
  });
  fetch.calls = calls;
  return fetch;
}

function claimBuildResponse() {
  return {
    txCbor,
    txHash: "5".repeat(64),
    reviewToken,
    review: {
      deploymentId,
      draftId: "d".repeat(64),
      selectedOutrefs,
    },
  };
}

function proofBundle() {
  return {
    deploymentId,
    draft: {
      draftId: "d".repeat(64),
      networkId: 0,
    },
    selectedOutrefs,
    safeWalletChangeAddress: "addr_test1safe",
    safeWalletAddresses: ["addr_test1safe"],
    proofArtifacts: [
      {
        out_ref: selectedOutrefs[0],
        artifact: {
          schema: "root-ownership-proof-artifact-v1",
          destination_address: `01${"2a".repeat(28)}00${"00".repeat(28)}`,
          cardano: {
            proof_hex: proofHex,
          },
        },
      },
    ],
  };
}

function fakeWalletHarness() {
  const signCalls = [];
  return {
    signCalls,
    roleState(role) {
      if (role === "compromised_user") {
        return {
          role,
          paymentCredential: "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4",
          canSign: false,
        };
      }
      if (role === "safe_claim_destination") {
        return {
          role,
          paymentCredential: "29e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4",
          canSign: true,
        };
      }
      return {
        role,
        paymentCredential: "39e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4",
        canSign: true,
      };
    },
    async call(role, method, args) {
      signCalls.push({ role, method, args });
      if (role === "compromised_user" && method === "signTx") {
        const error = new Error("read-only");
        error.code = "wallet_role_signing_forbidden";
        throw error;
      }
      if (role === "safe_claim_destination" && method === "signTx") {
        return witnessSetCbor;
      }
      throw new Error(`unexpected wallet call: ${role}.${method}`);
    },
  };
}

function fakePage() {
  return {
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
    getByLabel: vi.fn(() => ({
      selectOption: vi.fn(async () => undefined),
    })),
    getByRole: vi.fn(() => ({
      click: vi.fn(async () => undefined),
      waitFor: vi.fn(async () => undefined),
    })),
    getByText: vi.fn(() => ({
      waitFor: vi.fn(async () => undefined),
    })),
    screenshot: vi.fn(async ({ path: screenshotPath }) => {
      mkdirSync(path.dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, "fake png", "utf8");
    }),
  };
}

function jsonResponse(value, status = 200) {
  return {
    status,
    async json() {
      return value;
    },
  };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-negative-guardrails-"));
  tempDirs.push(dir);
  return dir;
}
