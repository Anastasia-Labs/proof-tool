import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaimTailAndReceiptStage } from "./tail-stage.mjs";

const tempDirs = [];
const impactedCredential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const firstClaim = claimBundle({
  txHash: "1".repeat(64),
  selectedOutrefs: ["a".repeat(64) + "#0", "b".repeat(64) + "#0", "c".repeat(64) + "#0", "d".repeat(64) + "#0"],
  lovelace: "8000000",
});
const tailOutrefs = ["e".repeat(64) + "#0", "f".repeat(64) + "#1"];
const proofHex = "ab".repeat(192);
const txCbor = "84a10081825820" + "11".repeat(32);
const witnessSetCbor = "a100";
const reviewToken = "v1.review-token-secret";

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("claim-tail-and-receipt preprod stage", () => {
  it("claims remaining matching UTxOs in a tail batch and writes a redacted receipt", async () => {
    const outputDir = tempDir();
    const fetch = fakeFetch([
      tailOutrefs,
      [],
    ]);
    const proofStageRunner = vi.fn(async ({ env, outputDir: batchOutputDir }) => {
      expect(env.RECLAIM_E2E_CLAIM_BATCH_SIZE).toBe("2");
      expect(path.basename(batchOutputDir)).toBe("claim-tail-batch-1");
      const artifact = path.join(batchOutputDir, "generate-destination-bound-proofs.json");
      writeFile(artifact, JSON.stringify({ schema: "proof", proofHex }));
      return {
        ok: true,
        artifacts: [artifact],
        proofBundle: {
          selectedOutrefs: tailOutrefs,
          proofArtifacts: tailOutrefs.map(() => ({ cardano: { proof_hex: proofHex } })),
        },
      };
    });
    const claimStageRunner = vi.fn(async ({ proofBundle, outputDir: batchOutputDir }) => {
      expect(proofBundle.selectedOutrefs).toEqual(tailOutrefs);
      const artifact = path.join(batchOutputDir, "claim-first-batch.json");
      writeFile(artifact, JSON.stringify({ schema: "claim", txCbor, witnessSetCbor, reviewToken }));
      return {
        ok: true,
        artifacts: [artifact],
        claimBundle: claimBundle({
          txHash: "2".repeat(64),
          selectedOutrefs: tailOutrefs,
          lovelace: "4000000",
        }),
      };
    });

    const result = await runClaimTailAndReceiptStage({
      env: {},
      appTarget: { baseUrl: "http://127.0.0.1:3917" },
      helperTarget: { helperUrl: "http://127.0.0.1:49152", token: "pair-secret" },
      walletHarness: fakeWalletHarness(),
      outputDir,
      firstClaimBundle: firstClaim,
      page: fakePage(),
      fetch,
      destinationProofStageRunner: proofStageRunner,
      claimFirstBatchStageRunner: claimStageRunner,
    });

    expect(result.ok).toBe(true);
    expect(proofStageRunner).toHaveBeenCalledTimes(1);
    expect(claimStageRunner).toHaveBeenCalledTimes(1);
    expect(fetch.calls).toEqual([
      "http://127.0.0.1:3917/claim-api/reclaim-utxos?limit=100",
      "http://127.0.0.1:3917/claim-api/reclaim-utxos?limit=100",
    ]);

    const receipt = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(receipt).toMatchObject({
      schema: "proof-tool-preprod-claim-tail-receipt-stage-v1",
      stage: "claim-tail-and-receipt",
      receiptReady: true,
      remainingMatchingUtxos: 0,
      claimCount: 2,
      claimTxHashes: ["1".repeat(64), "2".repeat(64)],
      claimedOutrefCount: 6,
      reviewedDestinationValue: {
        lovelace: "12000000",
      },
      safeWalletBalanceVerified: true,
      safeWalletBalance: {
        role: "safe_claim_destination",
        utxoCount: 3,
        assets: {
          lovelace: "12000000",
        },
        containsReviewedDestinationValue: true,
      },
      txCborWritten: false,
      witnessSetWritten: false,
      reviewTokenWritten: false,
      proofBytesWritten: false,
      screenshots: ["screenshots/claim-tail-and-receipt.png"],
    });
    expect(receipt.artifacts).toEqual([
      "claim-tail-batch-1/generate-destination-bound-proofs.json",
      "claim-tail-batch-1/claim-first-batch.json",
    ]);
    const serializedReceipt = JSON.stringify(receipt);
    expect(serializedReceipt).not.toContain(firstClaim.selectedOutrefs[0]);
    expect(serializedReceipt).not.toContain(tailOutrefs[0]);
    expect(serializedReceipt).not.toContain(proofHex);
    expect(serializedReceipt).not.toContain(txCbor);
    expect(serializedReceipt).not.toContain(witnessSetCbor);
    expect(serializedReceipt).not.toContain(reviewToken);
    expect(serializedReceipt).not.toContain("pair-secret");
  });

  it("succeeds when the final tail batch uses the max-tail batch allowance", async () => {
    const outputDir = tempDir();
    const proofStageRunner = vi.fn(async ({ outputDir: batchOutputDir }) => {
      writeFile(path.join(batchOutputDir, "generate-destination-bound-proofs.json"), "{}");
      return {
        artifacts: [path.join(batchOutputDir, "generate-destination-bound-proofs.json")],
        proofBundle: {
          selectedOutrefs: tailOutrefs,
          proofArtifacts: [],
        },
      };
    });
    const claimStageRunner = vi.fn(async ({ outputDir: batchOutputDir }) => {
      writeFile(path.join(batchOutputDir, "claim-first-batch.json"), "{}");
      return {
        artifacts: [path.join(batchOutputDir, "claim-first-batch.json")],
        claimBundle: claimBundle({
          txHash: "3".repeat(64),
          selectedOutrefs: tailOutrefs,
          lovelace: "4000000",
        }),
      };
    });

    const result = await runClaimTailAndReceiptStage({
      env: {
        RECLAIM_E2E_CLAIM_TAIL_MAX_BATCHES: "1",
      },
      appTarget: { baseUrl: "http://127.0.0.1:3917" },
      helperTarget: { helperUrl: "http://127.0.0.1:49152", token: "pair-secret" },
      walletHarness: fakeWalletHarness(),
      outputDir,
      firstClaimBundle: firstClaim,
      fetch: fakeFetch([tailOutrefs, []]),
      destinationProofStageRunner: proofStageRunner,
      claimFirstBatchStageRunner: claimStageRunner,
    });

    const receipt = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(receipt.remainingMatchingUtxos).toBe(0);
    expect(receipt.claimCount).toBe(2);
  });

  it("honors the configured claim batch size for tail batches", async () => {
    const outputDir = tempDir();
    const queuedOutrefs = [["e".repeat(64) + "#0"], ["f".repeat(64) + "#1"]];
    const proofStageRunner = vi.fn(async ({ env, outputDir: batchOutputDir }) => {
      expect(env.RECLAIM_E2E_CLAIM_BATCH_SIZE).toBe("1");
      const selectedOutrefs = queuedOutrefs.shift();
      const artifact = path.join(batchOutputDir, "generate-destination-bound-proofs.json");
      writeFile(artifact, JSON.stringify({ schema: "proof", proofHex }));
      return {
        artifacts: [artifact],
        proofBundle: {
          selectedOutrefs,
          proofArtifacts: selectedOutrefs.map(() => ({ cardano: { proof_hex: proofHex } })),
        },
      };
    });
    const claimStageRunner = vi.fn(async ({ proofBundle, outputDir: batchOutputDir }) => {
      expect(proofBundle.selectedOutrefs).toHaveLength(1);
      const artifact = path.join(batchOutputDir, "claim-first-batch.json");
      writeFile(artifact, JSON.stringify({ schema: "claim" }));
      return {
        artifacts: [artifact],
        claimBundle: claimBundle({
          txHash: `${claimStageRunner.mock.calls.length + 4}`.repeat(64).slice(0, 64),
          selectedOutrefs: proofBundle.selectedOutrefs,
          lovelace: "2000000",
        }),
      };
    });

    const result = await runClaimTailAndReceiptStage({
      env: {
        RECLAIM_E2E_CLAIM_BATCH_SIZE: "1",
      },
      appTarget: { baseUrl: "http://127.0.0.1:3917" },
      helperTarget: { helperUrl: "http://127.0.0.1:49152", token: "pair-secret" },
      walletHarness: fakeWalletHarness(),
      outputDir,
      firstClaimBundle: firstClaim,
      fetch: fakeFetch([[queuedOutrefs[0][0], queuedOutrefs[1][0]], [queuedOutrefs[1][0]], []]),
      destinationProofStageRunner: proofStageRunner,
      claimFirstBatchStageRunner: claimStageRunner,
    });

    const receipt = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(result.ok).toBe(true);
    expect(proofStageRunner).toHaveBeenCalledTimes(2);
    expect(claimStageRunner).toHaveBeenCalledTimes(2);
    expect(receipt.tailBatches.map((batch) => batch.selectedOutrefCount)).toEqual([1, 1]);
  });

  it("writes a receipt without tail batches when no matching UTxOs remain", async () => {
    const outputDir = tempDir();
    const result = await runClaimTailAndReceiptStage({
      env: {},
      appTarget: { baseUrl: "http://127.0.0.1:3917" },
      helperTarget: { helperUrl: "http://127.0.0.1:49152", token: "pair-secret" },
      walletHarness: fakeWalletHarness(),
      outputDir,
      firstClaimBundle: firstClaim,
      fetch: fakeFetch([[]]),
      destinationProofStageRunner() {
        throw new Error("must not run proof stage without remaining UTxOs");
      },
      claimFirstBatchStageRunner() {
        throw new Error("must not run claim stage without remaining UTxOs");
      },
    });

    const receipt = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(receipt.tailBatches).toEqual([]);
    expect(receipt.claimCount).toBe(1);
    expect(receipt.remainingMatchingUtxos).toBe(0);
  });

  it("fails when the safe wallet aggregate does not contain the reviewed destination value", async () => {
    await expect(
      runClaimTailAndReceiptStage({
        env: {},
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        helperTarget: { helperUrl: "http://127.0.0.1:49152", token: "pair-secret" },
        walletHarness: fakeWalletHarness({ assets: { lovelace: "1" } }),
        outputDir: tempDir(),
        firstClaimBundle: firstClaim,
        fetch: fakeFetch([[]]),
      }),
    ).rejects.toMatchObject({
      code: "safe_wallet_balance_missing_reviewed_value",
    });
  });

  it("fails instead of marking balance verified when reviewed destination value is missing", async () => {
    await expect(
      runClaimTailAndReceiptStage({
        env: {},
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        helperTarget: { helperUrl: "http://127.0.0.1:49152", token: "pair-secret" },
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
        firstClaimBundle: {
          ...firstClaim,
          destinationValueSummaries: [],
        },
        fetch: fakeFetch([[]]),
      }),
    ).rejects.toMatchObject({
      code: "safe_wallet_reviewed_value_missing",
    });
  });
});

function fakeFetch(sequences) {
  let index = 0;
  const calls = [];
  const fetch = vi.fn(async (url) => {
    const urlText = String(url);
    calls.push(urlText);
    if (urlText.startsWith("http://127.0.0.1:3917/claim-api/reclaim-utxos?")) {
      const outrefs = sequences[Math.min(index, sequences.length - 1)];
      index += 1;
      return jsonResponse({
        available: true,
        page: {
          nextCursor: null,
        },
        utxos: outrefs.map((outRefId) => ({
          outRefId,
          state: "unspent",
          datum: {
            status: "valid",
            paymentCredential: impactedCredential,
          },
        })),
      });
    }
    throw new Error(`unexpected fetch ${urlText}`);
  });
  fetch.calls = calls;
  return fetch;
}

function fakeWalletHarness(options = {}) {
  return {
    roleState(role) {
      if (role !== "compromised_user") {
        throw new Error(`unexpected role: ${role}`);
      }
      return {
        role,
        paymentCredential: impactedCredential,
      };
    },
    async roleUtxoAssetSummary(role) {
      if (role !== "safe_claim_destination") {
        throw new Error(`unexpected safe wallet role: ${role}`);
      }
      return {
        role,
        utxoCount: 3,
        assets: options.assets ?? { lovelace: "12000000" },
      };
    },
  };
}

function fakePage() {
  return {
    screenshot: vi.fn(async ({ path: screenshotPath }) => {
      writeFile(screenshotPath, "fake png");
    }),
  };
}

function claimBundle({ txHash, selectedOutrefs, lovelace }) {
  return {
    deploymentId: "preprod:test",
    draftId: "d".repeat(64),
    selectedOutrefs,
    txHash,
    reviewHash: txHash,
    destinationValueSummaries: selectedOutrefs.map((outRefId, index) => ({
      outRefId,
      destinationAddressSha256: `${index}`.repeat(64).slice(0, 64),
      value: {
        lovelace: (BigInt(lovelace) / BigInt(selectedOutrefs.length)).toString(),
      },
    })),
    evaluation: {
      redeemerCount: 1,
    },
  };
}

function jsonResponse(value) {
  return {
    status: 200,
    async json() {
      return value;
    },
  };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-tail-stage-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, { encoding: "utf8", flag: "w" });
}
