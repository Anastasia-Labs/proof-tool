#!/usr/bin/env node
/**
 * Provider-only N=7 comparison of the current proof-only V1 transcript and the
 * selected statement-bound V2 transcript. Both profiles use the same local
 * all-distinct material and direct scripts. This tool never signs or submits.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildSyntheticAttachedTx,
  createPreprodProvider,
  exportAttachedBaselineScripts,
  exportAttachedV2Scripts,
  loadBenchmarkMaterial,
  summarizeProviderEvaluation,
} from "./stage2g-v2-evaluate.mjs";

const LIVE_GATE_ENV = "RECLAIM_E2E_LIVE_PREPROD";
const COMPARE_GATE_ENV = "RECLAIM_E2E_STAGE2G_V2_COMPARE";
const SUBMISSION_GATE_ENV = "RECLAIM_E2E_SUBMIT_TRANSACTIONS";
const MATERIAL_FILE_ENV = "RECLAIM_E2E_STAGE2G_V2_MATERIAL_FILE";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");

export class Stage2gV2ComparisonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "Stage2gV2ComparisonError";
    this.code = code;
  }
}

export async function compareStage2gV2ToBaseline(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const log = options.log ?? console.log;
  assertComparisonGate(env);

  const material =
    options.material ??
    loadBenchmarkMaterial(resolveMaterialPath(env, repoRoot, options.materialPath), options.readTextFile);
  const provider = options.provider ?? createPreprodProvider(env);
  const protocolParameters = options.protocolParameters ?? (await provider.getProtocolParameters());
  const build = options.builder ?? buildSyntheticAttachedTx;
  const profiles = [
    {
      name: "current-proof-only-v1",
      exporter: options.baselineExporter ?? exportAttachedBaselineScripts,
    },
    {
      name: "statement-bound-v2",
      exporter: options.candidateExporter ?? exportAttachedV2Scripts,
    },
  ];

  const results = {};
  for (const profile of profiles) {
    const scripts = await profile.exporter({
      material,
      repoRoot,
      execFile: options.execFile,
    });
    const built = await build({
      provider,
      material,
      scripts,
      lucidFactory: options.lucidFactory,
    });
    const redeemers = await provider.evaluateTx(built.txCbor, built.additionalUtxos);
    const evaluation = summarizeProviderEvaluation(redeemers, protocolParameters);
    results[profile.name] = {
      scripts: {
        attachment: scripts.attachment,
        base_script_hash: scripts.baseScriptHash,
        base_script_bytes: scripts.baseScript.script.length / 2,
        global_script_hash: scripts.globalScriptHash,
        global_script_bytes: scripts.globalScript.script.length / 2,
        proof_slot_encoding: scripts.proofSlotEncoding,
        batch_transcript: scripts.batchTranscript,
      },
      transaction: {
        unsigned: true,
        tx_cbor_written: false,
        tx_cbor_bytes: built.txCbor.length / 2,
        tx_fingerprint: `sha256:${createHash("sha256").update(built.txCbor, "hex").digest("hex")}`,
      },
      evaluation,
    };
  }

  const baseline = results["current-proof-only-v1"];
  const candidate = results["statement-bound-v2"];
  const maxMemory = normalizeLimit(protocolParameters.maxTxExMem, "maxTxExMem");
  const maxSteps = normalizeLimit(protocolParameters.maxTxExSteps, "maxTxExSteps");
  const baselineMemory = BigInt(baseline.evaluation.totalMemory);
  const baselineSteps = BigInt(baseline.evaluation.totalSteps);
  const candidateMemory = BigInt(candidate.evaluation.totalMemory);
  const candidateSteps = BigInt(candidate.evaluation.totalSteps);
  const evidence = {
    schema: "proof-tool-stage2g-v2-baseline-comparison-v1",
    stage: "stage2g-v2-baseline-comparison",
    outcome: "evaluated",
    network: "Preprod",
    benchmark_scope: "same all-distinct-7 material and canonical input order; capacity comparison only",
    policy: {
      default_utxo_count: material.policy.defaultUtxoCount,
      optimization_utxo_count: material.policy.optimizationUtxoCount,
      hard_max_utxo_count: material.policy.hardMaxUtxoCount,
      max_tx_cpu_percent: material.policy.maxTxCpuPercent,
      max_tx_mem_percent: material.policy.maxTxMemPercent,
    },
    protocol_limits: {
      memory: maxMemory.toString(),
      cpu: maxSteps.toString(),
    },
    profiles: results,
    delta_candidate_minus_baseline: {
      memory: (candidateMemory - baselineMemory).toString(),
      cpu: (candidateSteps - baselineSteps).toString(),
      tx_cbor_bytes:
        candidate.transaction.tx_cbor_bytes - baseline.transaction.tx_cbor_bytes,
      memory_percent: signedPercent(candidateMemory - baselineMemory, baselineMemory),
      cpu_percent: signedPercent(candidateSteps - baselineSteps, baselineSteps),
    },
    headroom: {
      baseline: {
        memory: (maxMemory - baselineMemory).toString(),
        cpu: (maxSteps - baselineSteps).toString(),
      },
      candidate: {
        memory: (maxMemory - candidateMemory).toString(),
        cpu: (maxSteps - candidateSteps).toString(),
      },
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
  };
  log(JSON.stringify(evidence));
  return { ok: true, summary: evidence };
}

export function assertComparisonGate(env) {
  if (process.platform !== "linux") {
    throw new Stage2gV2ComparisonError(
      "stage2g_secure_output_unsupported",
      "Stage 2g comparison requires Linux.",
    );
  }
  if ((env[LIVE_GATE_ENV] ?? "").trim() !== "1") {
    throw new Stage2gV2ComparisonError(
      "live_preprod_gate_missing",
      `${LIVE_GATE_ENV}=1 is required before provider comparison.`,
    );
  }
  if ((env[COMPARE_GATE_ENV] ?? "").trim() !== "1") {
    throw new Stage2gV2ComparisonError(
      "stage2g_compare_gate_missing",
      `${COMPARE_GATE_ENV}=1 is required before provider comparison.`,
    );
  }
  if ((env[SUBMISSION_GATE_ENV] ?? "").trim() === "1") {
    throw new Stage2gV2ComparisonError(
      "submission_mode_forbidden",
      `${SUBMISSION_GATE_ENV}=1 is incompatible with provider-only comparison.`,
    );
  }
  if ((env.NODE_ENV ?? "").trim() === "production") {
    throw new Stage2gV2ComparisonError(
      "production_node_env",
      "Stage 2g comparison must not run with NODE_ENV=production.",
    );
  }
}

function resolveMaterialPath(env, repoRoot, explicitPath) {
  const configured = explicitPath ?? env[MATERIAL_FILE_ENV]?.trim();
  if (!configured) {
    throw new Stage2gV2ComparisonError(
      "benchmark_material_missing",
      `${MATERIAL_FILE_ENV} must point to local benchmark material.`,
    );
  }
  const resolved = path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(repoRoot, configured);
  if (!existsSync(resolved)) {
    throw new Stage2gV2ComparisonError(
      "benchmark_material_missing",
      "Configured benchmark material file does not exist.",
    );
  }
  return resolved;
}

function normalizeLimit(value, field) {
  const normalized = typeof value === "bigint" ? value : BigInt(value ?? 0);
  if (normalized <= 0n) {
    throw new Stage2gV2ComparisonError("protocol_limits_invalid", `${field} must be positive.`);
  }
  return normalized;
}

function signedPercent(delta, baseline) {
  const basisPoints = (delta * 1_000_000n) / baseline;
  return Number(basisPoints) / 10_000;
}

export function comparisonFailureSummary(error) {
  const code = error instanceof Stage2gV2ComparisonError ? error.code : "stage2g_comparison_failed";
  return {
    outcome: "failed",
    code,
    message: redactComparisonError(error),
  };
}

function redactComparisonError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(
      /\b(?:authorization|bearer)\b(?:\s*[:=]\s*|\s+)(?:Bearer\s+)?[A-Za-z0-9._~+/-]{20,}={0,2}/giu,
      "[authorization-redacted]",
    )
    .replace(
      /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{20,})+\b/gu,
      "[token-redacted]",
    )
    .replace(/\b[0-9a-f]{56,}\b/giu, "[hex-redacted]")
    .replace(/\b[A-Za-z0-9+/_=-]{128,}\b/gu, "[token-redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return (redacted || "Stage 2g comparison failed.").slice(0, 512);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  compareStage2gV2ToBaseline().catch((error) => {
    console.error(JSON.stringify(comparisonFailureSummary(error)));
    process.exitCode = 1;
  });
}
