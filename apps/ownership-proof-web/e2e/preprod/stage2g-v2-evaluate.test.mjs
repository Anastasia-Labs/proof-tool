import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { blake2b } from "@noble/hashes/blake2b";
import { credentialToAddress, keyHashToCredential } from "@lucid-evolution/lucid";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Stage2gV2EvaluationError,
  assertEvaluationGate,
  destinationPublicInputDigest,
  evaluateStage2gV2,
} from "./stage2g-v2-evaluate.mjs";

const tempDirs = [];
const protocolParameters = {
  maxTxExMem: 100_000n,
  maxTxExSteps: 1_000_000n,
};
const scripts = {
  attachment: "direct",
  baseScript: { type: "PlutusV3", script: "00" },
  globalScript: { type: "PlutusV3", script: "01" },
  baseScriptHash: "11".repeat(28),
  globalScriptHash: "22".repeat(28),
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("Stage 2g V2 distinct benchmark evaluator", () => {
  it("uses local material, direct scripts, and exactly one provider measurement while writing redacted evidence", async () => {
    const outputDir = tempDir();
    const material = benchmarkMaterial();
    const materialPath = writeMaterial(outputDir, material);
    const evidencePath = stageEvidencePath(outputDir);
    const provider = fakeProvider();
    const exporter = vi.fn(async () => scripts);
    const log = vi.fn();
    const bootstrapBuilder = vi.fn(async () => ({
      txCbor: "a100",
      additionalUtxos: Array.from({ length: 10 }, (_, index) => ({ txHash: `${index}`.repeat(64), outputIndex: 0 })),
      attachment: "direct",
    }));

    const result = await evaluateStage2gV2({
      env: gates(),
      repoRoot: outputDir,
      materialPath,
      evidencePath,
      provider,
      exporter,
      bootstrapBuilder,
      protocolParameters,
      log,
    });

    expect(result.ok).toBe(true);
    expect(exporter).toHaveBeenCalledTimes(1);
    expect(bootstrapBuilder).toHaveBeenCalledWith(expect.objectContaining({
      material: expect.objectContaining({ entries: expect.any(Array) }),
      scripts,
    }));
    expect(provider.evaluateTx).toHaveBeenCalledTimes(1);
    expect(provider.evaluateTx).toHaveBeenCalledWith("a100", expect.any(Array));
    expect(provider.submitTx).not.toHaveBeenCalled();
    expect(provider.signTx).not.toHaveBeenCalled();
    expect(provider.getUtxos).not.toHaveBeenCalled();

    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence).toMatchObject({
      schema: "proof-tool-stage2g-v2-distinct-benchmark-evidence-v1",
      outcome: "evaluated",
      material: {
        supplied_entry_count: 7,
        distinct_credentials: 7,
        distinct_proofs: 7,
        distinct_public_input_digests: 7,
      },
      policy: {
        default_utxo_count: 6,
        optimization_utxo_count: 6,
        hard_max_utxo_count: 7,
        max_tx_cpu_percent: 90,
        max_tx_mem_percent: 80,
      },
      scripts: {
        attachment: "direct",
        base_type: "PlutusV3",
        global_type: "PlutusV3",
      },
      transaction: {
        unsigned: true,
        tx_cbor_written: false,
        tx_cbor_bytes: 2,
        reference_scripts: false,
        provider_measurement_only: true,
      },
      safety: {
        signing: false,
        submission: false,
        funding: false,
        minting: false,
        stake_registration: false,
        deployment: false,
        deployment_record_write: false,
      },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(material.entries[0].credential);
    expect(serialized).not.toContain(material.entries[0].proof_hex);
    expect(serialized).not.toContain(material.entries[0].public_input_digest_hex);
    expect(serialized).not.toContain(material.entries[0].destination_address);
    expect(serialized).not.toContain("a100");
    expect(JSON.stringify(log.mock.calls)).not.toContain(material.entries[0].proof_hex);
  });

  it("rejects repeated benchmark proof material before exporting or measuring", async () => {
    const outputDir = tempDir();
    const material = benchmarkMaterial();
    material.entries[6].proof_hex = material.entries[0].proof_hex;
    const exporter = vi.fn(async () => scripts);
    const provider = fakeProvider();

    await expect(
      evaluateStage2gV2({
        env: gates(),
        repoRoot: outputDir,
        materialPath: writeMaterial(outputDir, material),
        evidencePath: stageEvidencePath(outputDir),
        provider,
        exporter,
        bootstrapBuilder: vi.fn(),
        protocolParameters,
        log: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "benchmark_entries_not_distinct" });
    expect(exporter).not.toHaveBeenCalled();
    expect(provider.evaluateTx).not.toHaveBeenCalled();
  });

  it("records redacted measured units when the CPU ceiling rejects the benchmark", async () => {
    const outputDir = tempDir();
    const material = benchmarkMaterial();
    const evidencePath = stageEvidencePath(outputDir);
    const provider = fakeProvider();
    provider.evaluateTx.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        redeemer_tag: index < 7 ? "spend" : "withdraw",
        redeemer_index: index < 7 ? index : 0,
        ex_units: { mem: 1_000, steps: 120_000 },
      })),
    );

    await expect(
      evaluateStage2gV2({
        env: gates(),
        repoRoot: outputDir,
        materialPath: writeMaterial(outputDir, material),
        evidencePath,
        provider,
        exporter: async () => scripts,
        bootstrapBuilder: async () => ({
          txCbor: "a100",
          additionalUtxos: Array.from({ length: 10 }, (_, index) => ({ txHash: `${index}`.repeat(64), outputIndex: 0 })),
          attachment: "direct",
        }),
        protocolParameters,
        log: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "stage2g_cpu_margin_exceeded" });

    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence).toMatchObject({
      outcome: "rejected",
      evaluation: { totalSteps: "960000", cpuPercent: 96, totalMemory: "8000", memoryPercent: 8 },
      failure: { code: "stage2g_cpu_margin_exceeded" },
    });
    expect(JSON.stringify(evidence)).not.toContain(material.entries[0].proof_hex);
    expect(JSON.stringify(evidence)).not.toContain(material.entries[0].credential);
  });

  it("surfaces synthetic reward-account rejection without trying to change stake state", async () => {
    const outputDir = tempDir();
    const material = benchmarkMaterial();
    const leakedCredential = material.entries[0].credential;
    const provider = fakeProvider({
      error: new Error(
        `withdrawal stake account not registered for ${material.entries[0].destination_address}; credential=${leakedCredential}; proof=${material.entries[0].proof_hex}`,
      ),
    });
    const evidencePath = stageEvidencePath(outputDir);
    const log = vi.fn();

    await expect(
      evaluateStage2gV2({
        env: gates(),
        repoRoot: outputDir,
        materialPath: writeMaterial(outputDir, material),
        evidencePath,
        provider,
        exporter: async () => scripts,
        bootstrapBuilder: async () => ({
          txCbor: "a100",
          additionalUtxos: Array.from({ length: 10 }, (_, index) => ({ txHash: `${index}`.repeat(64), outputIndex: 0 })),
          attachment: "direct",
        }),
        protocolParameters,
        log,
      }),
    ).rejects.toMatchObject({
      code: "synthetic_stake_state_rejected",
    });
    expect(provider.evaluateTx).toHaveBeenCalledTimes(1);
    expect(provider.submitTx).not.toHaveBeenCalled();
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence).toMatchObject({
      outcome: "rejected",
      failure: { code: "synthetic_stake_state_rejected" },
      safety: { stake_registration: false, submission: false },
    });
    expect(JSON.stringify(evidence)).not.toContain(material.entries[0].destination_address);
    expect(JSON.stringify(evidence)).not.toContain(leakedCredential);
    expect(JSON.stringify(evidence)).not.toContain(material.entries[0].proof_hex);
    expect(JSON.stringify(log.mock.calls)).not.toContain(leakedCredential);
    expect(JSON.stringify(log.mock.calls)).not.toContain(material.entries[0].proof_hex);
  });

  it("refuses evidence paths outside the dedicated output directory or through a symlink", async () => {
    const outputDir = tempDir();
    const material = benchmarkMaterial();
    const exporter = vi.fn(async () => scripts);
    const options = {
      env: gates(),
      repoRoot: outputDir,
      materialPath: writeMaterial(outputDir, material),
      provider: fakeProvider(),
      exporter,
      bootstrapBuilder: vi.fn(),
      protocolParameters,
      log: () => undefined,
    };

    await expect(
      evaluateStage2gV2({
        ...options,
        evidencePath: path.join(outputDir, "deployment-record.json"),
      }),
    ).rejects.toMatchObject({ code: "stage2g_evidence_path_unsafe" });
    expect(exporter).not.toHaveBeenCalled();

    const stageOutput = path.join(outputDir, "output", "preprod-e2e");
    mkdirSync(stageOutput, { recursive: true });
    symlinkSync(path.join(outputDir, "outside"), path.join(stageOutput, "stage2g-v2"));
    await expect(
      evaluateStage2gV2({
        ...options,
        evidencePath: stageEvidencePath(outputDir),
      }),
    ).rejects.toMatchObject({ code: "stage2g_evidence_path_unsafe" });
  });

  it("refuses an evidence root whose absolute path traverses a symlink", async () => {
    const root = tempDir();
    const realAncestor = path.join(root, "real-ancestor");
    const realRepoRoot = path.join(realAncestor, "repo");
    const symlinkedAncestor = path.join(root, "symlinked-ancestor");
    mkdirSync(realRepoRoot, { recursive: true });
    symlinkSync(realAncestor, symlinkedAncestor, "dir");
    const repoRoot = path.join(symlinkedAncestor, "repo");
    const material = benchmarkMaterial();
    const evidencePath = stageEvidencePath(repoRoot);

    await expect(
      evaluateStage2gV2({
        env: gates(),
        repoRoot,
        materialPath: writeMaterial(realRepoRoot, material),
        evidencePath,
        provider: fakeProvider(),
        exporter: async () => scripts,
        bootstrapBuilder: async () => ({
          txCbor: "a100",
          additionalUtxos: Array.from({ length: 10 }, (_, index) => ({ txHash: `${index}`.repeat(64), outputIndex: 0 })),
          attachment: "direct",
        }),
        protocolParameters,
        log: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "stage2g_evidence_write_failed" });
    expect(existsSync(stageEvidencePath(realRepoRoot))).toBe(false);
  });

  it("never overwrites an existing evidence file", async () => {
    const outputDir = tempDir();
    const material = benchmarkMaterial();
    const evidencePath = stageEvidencePath(outputDir);
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, "sentinel\n", "utf8");

    await expect(
      evaluateStage2gV2({
        env: gates(),
        repoRoot: outputDir,
        materialPath: writeMaterial(outputDir, material),
        evidencePath,
        provider: fakeProvider(),
        exporter: async () => scripts,
        bootstrapBuilder: async () => ({
          txCbor: "a100",
          additionalUtxos: Array.from({ length: 10 }, (_, index) => ({ txHash: `${index}`.repeat(64), outputIndex: 0 })),
          attachment: "direct",
        }),
        protocolParameters,
        log: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "stage2g_evidence_write_failed" });
    expect(readFileSync(evidencePath, "utf8")).toBe("sentinel\n");
  });

  it("requires both explicit live and Stage 2g gates", () => {
    expect(() => assertEvaluationGate({})).toThrow(Stage2gV2EvaluationError);
    expect(() => assertEvaluationGate({ RECLAIM_E2E_LIVE_PREPROD: "1" })).toThrowError(
      expect.objectContaining({ code: "stage2g_evaluate_gate_missing" }),
    );
    expect(() => assertEvaluationGate({ ...gates(), RECLAIM_E2E_SUBMIT_TRANSACTIONS: "1" })).toThrowError(
      expect.objectContaining({ code: "submission_mode_forbidden" }),
    );
  });
});

function gates() {
  return {
    RECLAIM_E2E_LIVE_PREPROD: "1",
    RECLAIM_E2E_STAGE2G_V2_EVALUATE: "1",
  };
}

function fakeProvider(options = {}) {
  return {
    evaluateTx: vi.fn(async () => {
      if (options.error) {
        throw options.error;
      }
      return [
        ...Array.from({ length: 7 }, (_, index) => ({
          redeemer_tag: "spend",
          redeemer_index: index,
          ex_units: { mem: 1_000, steps: 10_000 },
        })),
        {
          redeemer_tag: "withdraw",
          redeemer_index: 0,
          ex_units: { mem: 1_000, steps: 10_000 },
        },
      ];
    }),
    getProtocolParameters: vi.fn(async () => protocolParameters),
    submitTx: vi.fn(),
    signTx: vi.fn(),
    getUtxos: vi.fn(),
  };
}

function benchmarkMaterial() {
  const destinationCredential = "aa".repeat(28);
  const destinationAddress = credentialToAddress("Preprod", keyHashToCredential(destinationCredential));
  const cardanoVkHex = "cd".repeat(672);
  const cardanoVkHash = Buffer.from(blake2b(hexToBytes(cardanoVkHex), { dkLen: 32 })).toString("hex");
  const entries = Array.from({ length: 7 }, (_, index) => {
    const credential = `${(index + 1).toString(16).padStart(2, "0")}${"ab".repeat(27)}`;
    const destinationV1 = `01${destinationCredential}00${"00".repeat(28)}`;
    return {
      tx_hash: `${(index + 1).toString(16)}`.repeat(64),
      output_index: index,
      credential,
      proof_hex: `${(index + 1).toString(16).padStart(2, "0")}`.repeat(336),
      public_input_digest_hex: destinationPublicInputDigest(credential, destinationV1),
      destination_address: destinationAddress,
      value: { lovelace: "3000000" },
    };
  });
  return {
    schema: "proof-tool-stage2g-v2-distinct-benchmark-material-v1",
    network: "Preprod",
    policy: {
      default_utxo_count: 6,
      optimization_utxo_count: 6,
      hard_max_utxo_count: 7,
      max_tx_cpu_percent: 90,
      max_tx_mem_percent: 80,
      distinct_7_opt_in: {
        request_parameter: "maxUtxos",
        request_value: 7,
        require_explicit_request: true,
        require_measured_execution_units: true,
      },
    },
    cardano_vk_hex: cardanoVkHex,
    cardano_vk_blake2b256: `blake2b256:${cardanoVkHash}`,
    params: {
      policy_id: "01".repeat(28),
      token_name: "5245434c41494d504152414d53",
      tx_hash: "02".repeat(32),
      output_index: 0,
      address: destinationAddress,
      lovelace: "3000000",
    },
    bootstrap: {
      address: destinationAddress,
      utxos: [
        { tx_hash: "03".repeat(32), output_index: 0, lovelace: "50000000" },
        { tx_hash: "04".repeat(32), output_index: 0, lovelace: "50000000" },
      ],
    },
    entries,
  };
}

function writeMaterial(outputDir, material) {
  const materialPath = path.join(outputDir, "material.json");
  writeFileSync(materialPath, `${JSON.stringify(material, null, 2)}\n`, "utf8");
  return materialPath;
}

function stageEvidencePath(outputDir) {
  return path.join(outputDir, "output", "preprod-e2e", "stage2g-v2", "evidence.json");
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-stage2g-v2-"));
  tempDirs.push(dir);
  return dir;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
