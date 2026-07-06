import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaimFirstBatchStage } from "./claim-stage.mjs";

const tempDirs = [];
const selectedOutrefs = ["1".repeat(64) + "#0", "2".repeat(64) + "#1", "3".repeat(64) + "#0", "4".repeat(64) + "#0"];
const deploymentId = "preprod:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1234567890abcdef1234567890abcdef12345678";
const txCbor = "84a10081825820" + "11".repeat(32);
const witnessSetCbor = "a100";
const reviewToken = "v1.review-token-secret";
const proofHex = "ab".repeat(192);
const publicInputDigestHex = "cd".repeat(32);
const safeAddress =
  "addr_test1qzjvktx3h2m6q3zv9n2wp0v8nyk2pyvrgk55l5xv8p0v08y5qtqv0w7wq7fxy8ky5flvypv4h8gnl3w2n2e2djf5qgpsx8x5g";
const destinationAddress = "01" + "2a".repeat(28) + "00" + "00".repeat(28);

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("claim-first-batch preprod stage", () => {
  it("builds, safe-wallet signs, submits, and writes only redacted summaries", async () => {
    const outputDir = tempDir();
    const fetch = fakeFetch();
    const walletHarness = fakeWalletHarness();
    const page = fakePage();

    const result = await runClaimFirstBatchStage({
      env: {},
      appTarget: { baseUrl: "http://127.0.0.1:3917" },
      walletHarness,
      outputDir,
      proofBundle: proofBundle(),
      page,
      fetch,
    });

    expect(result.ok).toBe(true);
    expect(fetch.calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "http://127.0.0.1:3917/claim-api/build"],
      ["POST", "http://127.0.0.1:3917/claim-api/submit"],
      ["GET", `http://127.0.0.1:3917/claim-api/progress?outrefs=${encodeURIComponent(selectedOutrefs.join(","))}`],
    ]);
    expect(fetch.buildBody).toMatchObject({
      deploymentId,
      networkId: 0,
      draftId: "d".repeat(64),
      selectedOutrefs,
      safeWalletChangeAddress: safeAddress,
      safeWalletAddresses: [safeAddress],
    });
    expect(fetch.buildBody.proofArtifacts).toHaveLength(4);
    expect(walletHarness.signCalls).toEqual([
      {
        role: "safe_claim_destination",
        txCbor,
        partialSign: true,
      },
    ]);
    expect(fetch.submitBody).toMatchObject({
      deploymentId,
      selectedOutrefs,
      unsignedTxCbor: txCbor,
      witnessSetCbor,
      claimBuildReviewToken: reviewToken,
    });

    const artifact = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(artifact).toMatchObject({
      schema: "proof-tool-preprod-claim-first-batch-stage-v1",
      stage: "claim-first-batch",
      deploymentId,
      draftId: "d".repeat(64),
      selectedOutrefs,
      txHash: txHash(),
      submittedTxHash: txHash(),
      safeWalletRole: "safe_claim_destination",
      safeWalletSignAttempts: {
        before: 0,
        after: 1,
      },
      progress: {
        status: "spent_or_unknown",
        polls: 1,
        selectedOutrefs: selectedOutrefs.map((outRefId) => ({
          outRefId,
          state: "spent_or_unknown",
        })),
      },
      evaluation: {
        redeemerCount: 1,
        totalMemory: "4000000",
        totalSteps: "1000000000",
        memoryPercent: 40,
        cpuPercent: 45,
      },
      txCborWritten: false,
      witnessSetWritten: false,
      reviewTokenWritten: false,
      proofBytesWritten: false,
      screenshots: ["screenshots/claim-first-batch.png"],
    });
    expect(artifact.destinationValueSummaries).toHaveLength(4);
    expect(artifact.destinationValueSummaries[0]).toMatchObject({
      outRefId: selectedOutrefs[0],
      value: {
        lovelace: "2000000",
      },
    });
    const serializedArtifact = JSON.stringify(artifact);
    expect(serializedArtifact).not.toContain(txCbor);
    expect(serializedArtifact).not.toContain(witnessSetCbor);
    expect(serializedArtifact).not.toContain(reviewToken);
    expect(serializedArtifact).not.toContain(proofHex);
    expect(serializedArtifact).not.toContain(publicInputDigestHex);
    expect(serializedArtifact).not.toContain(safeAddress);
    expect(serializedArtifact).not.toContain(destinationAddress);
    expect(page.screenshot).toHaveBeenCalledWith({
      path: path.join(outputDir, "screenshots", "claim-first-batch.png"),
      fullPage: true,
    });
    expect(result.claimBundle.destinationValueSummaries).toHaveLength(4);
  });

  it("always signs with safe_claim_destination even if the local env names another role", async () => {
    const fetch = fakeFetch();
    const walletHarness = fakeWalletHarness();

    await runClaimFirstBatchStage({
      env: {
        RECLAIM_E2E_SAFE_WALLET_ROLE: "deployer",
      },
      appTarget: { baseUrl: "http://127.0.0.1:3917" },
      walletHarness,
      outputDir: tempDir(),
      proofBundle: proofBundle(),
      fetch,
      sleep: async () => undefined,
    });

    expect(walletHarness.signCalls).toEqual([
      {
        role: "safe_claim_destination",
        txCbor,
        partialSign: true,
      },
    ]);
  });

  it("waits while progress reports the selected outrefs are still pending", async () => {
    const fetch = fakeFetch({
      progressStates: [
        ["pending", "pending", "pending", "pending"],
        ["spent_or_unknown", "spent_or_unknown", "spent_or_unknown", "spent_or_unknown"],
      ],
    });
    const sleeps = [];

    const result = await runClaimFirstBatchStage({
      env: {
        RECLAIM_E2E_CLAIM_PROGRESS_POLL_MS: "1",
      },
      appTarget: { baseUrl: "http://127.0.0.1:3917" },
      walletHarness: fakeWalletHarness(),
      outputDir: tempDir(),
      proofBundle: proofBundle(),
      fetch,
      sleep: async (ms) => sleeps.push(ms),
    });

    expect(result.summary.progress.polls).toBe(2);
    expect(sleeps).toEqual([1]);
  });

  it("rejects a build review hash mismatch before wallet signing", async () => {
    const fetch = fakeFetch({
      buildMutator(build) {
        build.reviewHash = "00".repeat(32);
      },
    });
    const walletHarness = fakeWalletHarness();

    await expect(
      runClaimFirstBatchStage({
        env: {},
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        walletHarness,
        outputDir: tempDir(),
        proofBundle: proofBundle(),
        fetch,
      }),
    ).rejects.toMatchObject({
      code: "claim_build_review_invalid",
    });
    expect(walletHarness.signCalls).toEqual([]);
  });

  it("rejects a safe wallet that does not sign exactly once", async () => {
    await expect(
      runClaimFirstBatchStage({
        env: {},
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        walletHarness: fakeWalletHarness({ signAttemptsAfter: 0 }),
        outputDir: tempDir(),
        proofBundle: proofBundle(),
        fetch: fakeFetch(),
      }),
    ).rejects.toMatchObject({
      code: "safe_wallet_sign_attempt_mismatch",
    });
  });

  it("includes typed submit error bodies in HTTP failures", async () => {
    await expect(
      runClaimFirstBatchStage({
        env: {},
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
        proofBundle: proofBundle(),
        fetch: fakeFetch({
          submitResponse: jsonResponse(
            {
              code: "claim_submit_provider_rejected",
              error: "Provider rejected the claim transaction: validation failed",
            },
            400,
          ),
        }),
      }),
    ).rejects.toMatchObject({
      code: "http_error",
      message:
        "/claim-api/submit returned HTTP 400: claim_submit_provider_rejected: Provider rejected the claim transaction: validation failed.",
    });
  });
});

function fakeFetch(options = {}) {
  const calls = [];
  let progressCall = 0;
  const fetch = vi.fn(async (url, init = {}) => {
    const urlText = String(url);
    const method = init.method ?? "GET";
    calls.push({ method, url: urlText });
    if (urlText === "http://127.0.0.1:3917/claim-api/build") {
      fetch.buildBody = JSON.parse(init.body);
      const build = claimBuildResponse();
      options.buildMutator?.(build);
      return jsonResponse(build);
    }
    if (urlText === "http://127.0.0.1:3917/claim-api/submit") {
      fetch.submitBody = JSON.parse(init.body);
      if (options.submitResponse) {
        return options.submitResponse;
      }
      return jsonResponse({
        txHash: txHash(),
        deploymentId,
        selectedOutrefs,
        reviewHash: fetch.submitBody.review ? sha256Stable(fetch.submitBody.review) : "00".repeat(32),
        provider: {
          submitted: true,
        },
      });
    }
    if (urlText.startsWith("http://127.0.0.1:3917/claim-api/progress?")) {
      const configuredStates = options.progressStates?.[Math.min(progressCall, options.progressStates.length - 1)];
      progressCall += 1;
      const states = configuredStates ?? selectedOutrefs.map(() => "spent_or_unknown");
      return jsonResponse({
        deploymentId,
        providerAvailable: true,
        outrefs: selectedOutrefs.map((outRefId, index) => ({
          outRef: {
            txHash: outRefId.split("#")[0],
            outputIndex: Number(outRefId.split("#")[1]),
          },
          outRefId,
          state: states[index],
        })),
        nextBatch: {
          available: false,
          count: 0,
        },
      });
    }
    throw new Error(`unexpected fetch ${method} ${urlText}`);
  });
  fetch.calls = calls;
  return fetch;
}

function claimBuildResponse() {
  const review = claimReview();
  return {
    txCbor,
    txHash: txHash(),
    review,
    reviewHash: sha256Stable(review),
    reviewToken,
    evaluation: {
      redeemers: [
        {
          tag: "withdrawal",
          index: 0,
          memory: 4000000,
          steps: 1000000000,
        },
      ],
      totalMemory: "4000000",
      totalSteps: "1000000000",
      memoryPercent: 40,
      cpuPercent: 45,
    },
  };
}

function claimReview() {
  return {
    deploymentId,
    draftId: "d".repeat(64),
    selectedOutrefs,
    transactionInputOrder: [...selectedOutrefs],
    destinationOutputStartIndex: 0,
    destinationOutputs: selectedOutrefs.map((outRefId) => ({
      outRefId,
      address: safeAddress,
      destinationAddressEncoding: "destination-address-v1",
      destinationAddress,
      value: {
        lovelace: "2000000",
      },
    })),
    paramsReferenceInput: {
      outRefId: "9".repeat(64) + "#0",
      holderAddress: "addr_test1params",
      datumCbor: "d87980",
    },
    referenceScriptInputs: [
      {
        role: "reclaim_base",
        outRefId: "8".repeat(64) + "#0",
        holderAddress: "addr_test1base",
        scriptHash: "a".repeat(56),
        scriptType: "PlutusV3",
      },
      {
        role: "reclaim_global",
        outRefId: "7".repeat(64) + "#0",
        holderAddress: "addr_test1global",
        scriptHash: "b".repeat(56),
        scriptType: "PlutusV3",
      },
    ],
    proofDigests: selectedOutrefs.map((outRefId) => ({
      outRefId,
      targetCredential: "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4",
      destinationAddress,
      publicInputDigestHex,
    })),
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
    safeWalletChangeAddress: safeAddress,
    safeWalletAddresses: [safeAddress],
    proofArtifacts: selectedOutrefs.map((outRefId) => ({
      out_ref: outRefId,
      artifact: {
        cardano: {
          proof_hex: proofHex,
          public_input_digest_hex: publicInputDigestHex,
        },
      },
    })),
  };
}

function fakeWalletHarness(options = {}) {
  let signAttempts = 0;
  return {
    signCalls: [],
    roleState(role) {
      if (role !== "safe_claim_destination") {
        throw new Error(`unexpected role: ${role}`);
      }
      return {
        role,
        canSign: true,
        signAttempts: options.signAttemptsAfter ?? signAttempts,
      };
    },
    async call(role, method, args) {
      if (role !== "safe_claim_destination" || method !== "signTx") {
        throw new Error(`unexpected wallet call: ${role}.${method}`);
      }
      this.signCalls.push({
        role,
        txCbor: args[0],
        partialSign: args[1],
      });
      signAttempts += 1;
      return witnessSetCbor;
    },
  };
}

function fakePage() {
  return {
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

function txHash() {
  return "5".repeat(64);
}

function sha256Stable(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-claim-stage-"));
  tempDirs.push(dir);
  return dir;
}
