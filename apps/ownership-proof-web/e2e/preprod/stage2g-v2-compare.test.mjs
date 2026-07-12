import { describe, expect, it, vi } from "vitest";
import {
  Stage2gV2ComparisonError,
  assertComparisonGate,
  comparisonFailureSummary,
  compareStage2gV2ToBaseline,
} from "./stage2g-v2-compare.mjs";

describe("Stage 2g V2 baseline comparison", () => {
  it("evaluates equivalent baseline and candidate transactions without signing or submitting", async () => {
    const material = benchmarkMaterial();
    const provider = {
      getProtocolParameters: vi.fn(async () => ({
        maxTxExMem: 14_000_000n,
        maxTxExSteps: 10_000_000_000n,
      })),
      evaluateTx: vi.fn(async (txCbor) => measuredRedeemers(txCbor === "aa00" ? 9_100_000_000n : 8_900_000_000n)),
      submitTx: vi.fn(),
      signTx: vi.fn(),
    };
    const baselineScripts = scripts("11", "22", 435, 4467, "bytes-empty-same-as-previous-v1", "proof-only-v1");
    const candidateScripts = scripts(
      "33",
      "44",
      435,
      3648,
      "full-proof-plus-public-input-digest-v2",
      "statement-bound-v2",
    );
    const builder = vi.fn(async ({ scripts: selected }) => ({
      txCbor: selected.batchTranscript === "proof-only-v1" ? "aa00" : "bb0000",
      additionalUtxos: Array.from({ length: 10 }, () => ({})),
    }));
    const log = vi.fn();

    const result = await compareStage2gV2ToBaseline({
      env: gates(),
      material,
      provider,
      baselineExporter: vi.fn(async () => baselineScripts),
      candidateExporter: vi.fn(async () => candidateScripts),
      builder,
      log,
    });

    expect(result.ok).toBe(true);
    expect(provider.evaluateTx).toHaveBeenCalledTimes(2);
    expect(provider.submitTx).not.toHaveBeenCalled();
    expect(provider.signTx).not.toHaveBeenCalled();
    expect(result.summary.profiles["current-proof-only-v1"].transaction.tx_cbor_bytes).toBe(2);
    expect(result.summary.profiles["statement-bound-v2"].transaction.tx_cbor_bytes).toBe(3);
    expect(result.summary.delta_candidate_minus_baseline.cpu).toBe("-200000000");
    expect(result.summary.delta_candidate_minus_baseline.tx_cbor_bytes).toBe(1);
    expect(result.summary.headroom.candidate.cpu).toBe("1100000000");
    expect(Object.values(result.summary.safety).every((value) => value === false)).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.summary)).not.toContain(material.entries[0].proofHex);
    expect(JSON.stringify(result.summary)).not.toContain(material.entries[0].credential);
  });

  it("requires both gates and rejects submission mode", () => {
    expect(() => assertComparisonGate({})).toThrow(Stage2gV2ComparisonError);
    expect(() => assertComparisonGate({ RECLAIM_E2E_LIVE_PREPROD: "1" })).toThrowError(
      expect.objectContaining({ code: "stage2g_compare_gate_missing" }),
    );
    expect(() =>
      assertComparisonGate({
        ...gates(),
        RECLAIM_E2E_SUBMIT_TRANSACTIONS: "1",
      }),
    ).toThrowError(expect.objectContaining({ code: "submission_mode_forbidden" }));
  });

  it("redacts proof-like provider material from CLI failure summaries", () => {
    const proofHex = "ab".repeat(336);
    const token = "Z".repeat(160);
    const summary = comparisonFailureSummary(
      new Error(`provider rejected tx proof=${proofHex} token=${token}`),
    );

    expect(summary).toEqual(
      expect.objectContaining({
        outcome: "failed",
        code: "stage2g_comparison_failed",
      }),
    );
    expect(summary.message).toContain("[hex-redacted]");
    expect(summary.message).toContain("[token-redacted]");
    expect(JSON.stringify(summary)).not.toContain(proofHex);
    expect(JSON.stringify(summary)).not.toContain(token);
  });

  it("redacts every segment of dotted provider authorization tokens", () => {
    const segments = ["g".repeat(80), "h".repeat(180), "i".repeat(80)];
    const authorization = `Bearer ${segments.join(".")}`;
    const summary = comparisonFailureSummary(
      new Error(`provider failed authorization=${authorization}`),
    );

    expect(summary.message).toContain("[authorization-redacted]");
    for (const segment of segments) {
      expect(JSON.stringify(summary)).not.toContain(segment);
    }
  });
});

function gates() {
  return {
    RECLAIM_E2E_LIVE_PREPROD: "1",
    RECLAIM_E2E_STAGE2G_V2_COMPARE: "1",
  };
}

function scripts(baseByte, globalByte, baseBytes, globalBytes, proofSlotEncoding, batchTranscript) {
  return {
    attachment: "direct",
    baseScript: { type: "PlutusV3", script: baseByte.repeat(baseBytes) },
    globalScript: { type: "PlutusV3", script: globalByte.repeat(globalBytes) },
    baseScriptHash: baseByte.repeat(28),
    globalScriptHash: globalByte.repeat(28),
    proofSlotEncoding,
    batchTranscript,
  };
}

function measuredRedeemers(totalCpu) {
  const baseCpu = 20_000_000n;
  const globalCpu = totalCpu - 7n * baseCpu;
  return [
    ...Array.from({ length: 7 }, (_, index) => ({
      redeemer_tag: "spend",
      redeemer_index: index,
      ex_units: { mem: 100_000n, steps: baseCpu },
    })),
    {
      redeemer_tag: "withdraw",
      redeemer_index: 0,
      ex_units: { mem: 1_000_000n, steps: globalCpu },
    },
  ];
}

function benchmarkMaterial() {
  return {
    policy: {
      defaultUtxoCount: 6,
      optimizationUtxoCount: 6,
      hardMaxUtxoCount: 7,
      maxTxCpuPercent: 90,
      maxTxMemPercent: 80,
    },
    params: {},
    bootstrap: {},
    entries: [
      {
        credential: "ab".repeat(28),
        proofHex: "cd".repeat(336),
      },
    ],
  };
}
