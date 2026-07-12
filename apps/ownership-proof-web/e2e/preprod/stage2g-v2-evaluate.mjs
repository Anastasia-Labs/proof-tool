#!/usr/bin/env node
/**
 * Stage 2g is a local-material, seven-slot *benchmark* for the V2 scripts.
 * It is deliberately stricter than normal claim eligibility: the supplied
 * benchmark material must contain seven distinct credentials, proofs, and
 * statement digests. It does not make distinctness a normal-flow rule.
 *
 * Required local material shape:
 * {
 *   "schema": "proof-tool-stage2g-v2-distinct-benchmark-material-v1",
 *   "network": "Preprod",
 *   "policy": { "default_utxo_count": 6, "optimization_utxo_count": 6,
 *     "hard_max_utxo_count": 7, "max_tx_cpu_percent": 90,
 *     "max_tx_mem_percent": 80, "distinct_7_opt_in": { ... } },
 *   "cardano_vk_hex": "...", "cardano_vk_blake2b256": "...",
 *   "params": { "policy_id": "...", "token_name": "...", "tx_hash": "...",
 *     "output_index": 0, "address": "addr_test...", "lovelace": "..." },
 *   "bootstrap": { "address": "addr_test...", "utxos": [{ "tx_hash": "...",
 *     "output_index": 0, "lovelace": "..." }, ...] },
 *   "entries": [{ "tx_hash": "...", "output_index": 0, "credential": "...",
 *     "proof_hex": "...", "public_input_digest_hex": "...",
 *     "destination_address": "addr_test...", "value": { "lovelace": "..." } }, ...]
 * }
 *
 * Material stays local. The emitted evidence contains counts, hashes, and
 * execution units only; it never contains proof bytes, credentials, digests,
 * transaction CBOR, or addresses.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { blake2b } from "@noble/hashes/blake2b";
import {
  Blockfrost,
  CML,
  Constr,
  Data,
  Lucid,
  credentialToRewardAddress,
  getAddressDetails,
  scriptHashToCredential,
  validatorToAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";

const execFileAsync = promisify(execFile);

const NETWORK = "Preprod";
const NETWORK_ID = 0;
const MATERIAL_SCHEMA = "proof-tool-stage2g-v2-distinct-benchmark-material-v1";
const EVIDENCE_SCHEMA = "proof-tool-stage2g-v2-distinct-benchmark-evidence-v1";
const MATERIAL_FILE_ENV = "RECLAIM_E2E_STAGE2G_V2_MATERIAL_FILE";
const EVIDENCE_FILE_ENV = "RECLAIM_E2E_STAGE2G_V2_EVIDENCE_FILE";
const LIVE_GATE_ENV = "RECLAIM_E2E_LIVE_PREPROD";
const EVALUATE_GATE_ENV = "RECLAIM_E2E_STAGE2G_V2_EVALUATE";
const SUBMISSION_GATE_ENV = "RECLAIM_E2E_SUBMIT_TRANSACTIONS";
const EVIDENCE_OUTPUT_RELATIVE_ROOT = ["output", "preprod-e2e", "stage2g-v2"];
const PARAMS_TOKEN_NAME = "5245434c41494d504152414d53"; // RECLAIMPARAMS
const PROOF_SLOT_ENCODING = "full-proof-plus-public-input-digest-v2";
const BATCH_TRANSCRIPT = "statement-bound-v2";
const PUBLIC_INPUT_DOMAIN = "ROOT-OWNERSHIP-DESTINATION-v1";
const EXPECTED_POLICY = Object.freeze({
  default_utxo_count: 6,
  optimization_utxo_count: 6,
  hard_max_utxo_count: 7,
  max_tx_cpu_percent: 90,
  max_tx_mem_percent: 80,
  distinct_7_opt_in: Object.freeze({
    request_parameter: "maxUtxos",
    request_value: 7,
    require_explicit_request: true,
    require_measured_execution_units: true,
  }),
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");

export class Stage2gV2EvaluationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "Stage2gV2EvaluationError";
    this.code = code;
  }
}

/**
 * Builds an unsigned, synthetic-input transaction and asks the configured
 * provider for the sole execution-unit measurement. No signing, submission,
 * funding, minting, registration, deployment, or deployment-record write is
 * performed by this stage.
 */
export async function evaluateStage2gV2(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const readTextFile = options.readTextFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  const log = options.log ?? console.log;

  assertEvaluationGate(env);
  const materialPath = resolveMaterialPath(env, repoRoot, options.materialPath);
  const material = loadBenchmarkMaterial(materialPath, readTextFile);
  const evidencePath = resolveEvidencePath(env, repoRoot, options.evidencePath);
  const provider = options.provider ?? createPreprodProvider(env);
  assertProvider(provider);

  const exporter = options.exporter ?? exportAttachedV2Scripts;
  const scripts = await exporter({ material, repoRoot, execFile: options.execFile ?? execFileAsync });
  assertAttachedV2Scripts(scripts, material);

  const bootstrapBuilder = options.bootstrapBuilder ?? buildSyntheticAttachedTx;
  const built = await bootstrapBuilder({
    provider,
    material,
    scripts,
    lucidFactory: options.lucidFactory ?? Lucid,
  });
  assertBuiltTransaction(built);

  try {
    // This is intentionally the only execution-unit measurement in this file.
    const redeemers = await provider.evaluateTx(built.txCbor, built.additionalUtxos);
    const protocolParameters =
      options.protocolParameters ?? built.protocolParameters ?? (await provider.getProtocolParameters());
    const evaluation = summarizeProviderEvaluation(redeemers, protocolParameters);
    assertMeasuredV2Margin(evaluation, material.policy);

    const evidence = buildEvidence({
      materialPath,
      material,
      scripts,
      txCbor: built.txCbor,
      evaluation,
      outcome: "evaluated",
    });
    writeEvidence(evidencePath, evidence, { log, repoRoot });
    return {
      ok: true,
      evidencePath,
      summary: evidence,
    };
  } catch (error) {
    const failure = stageFailure(error);
    if (failure.code === "stage2g_evidence_write_failed") {
      throw failure;
    }
    const evidence = buildEvidence({
      materialPath,
      material,
      scripts,
      txCbor: built.txCbor,
      outcome: "rejected",
      failure,
    });
    writeEvidence(evidencePath, evidence, { log, repoRoot });
    throw failure;
  }
}

export function assertEvaluationGate(env) {
  if (process.platform !== "linux") {
    throw new Stage2gV2EvaluationError(
      "stage2g_secure_output_unsupported",
      "Stage 2g evaluation requires Linux for descriptor-anchored secure output.",
    );
  }
  if ((env[LIVE_GATE_ENV] ?? "").trim() !== "1") {
    throw new Stage2gV2EvaluationError(
      "live_preprod_gate_missing",
      `${LIVE_GATE_ENV}=1 is required before the Stage 2g Preprod benchmark can call a provider.`,
    );
  }
  if ((env[EVALUATE_GATE_ENV] ?? "").trim() !== "1") {
    throw new Stage2gV2EvaluationError(
      "stage2g_evaluate_gate_missing",
      `${EVALUATE_GATE_ENV}=1 is required before the Stage 2g benchmark can run.`,
    );
  }
  if ((env[SUBMISSION_GATE_ENV] ?? "").trim() === "1") {
    throw new Stage2gV2EvaluationError(
      "submission_mode_forbidden",
      `${SUBMISSION_GATE_ENV}=1 is incompatible with the evaluator-only Stage 2g benchmark.`,
    );
  }
  if ((env.NODE_ENV ?? "").trim() === "production") {
    throw new Stage2gV2EvaluationError(
      "production_node_env",
      "Stage 2g Preprod evaluation must not run with NODE_ENV=production.",
    );
  }
}

export function loadBenchmarkMaterial(materialPath, readTextFile = (filePath) => readFileSync(filePath, "utf8")) {
  let parsed;
  try {
    parsed = JSON.parse(readTextFile(materialPath));
  } catch (error) {
    throw new Stage2gV2EvaluationError(
      "benchmark_material_unreadable",
      `Stage 2g benchmark material could not be read as JSON: ${redactError(error)}.`,
    );
  }
  return validateBenchmarkMaterial(parsed);
}

export function validateBenchmarkMaterial(raw) {
  const root = requireObject(raw, "benchmark material");
  if (root.schema !== MATERIAL_SCHEMA) {
    throw new Stage2gV2EvaluationError("benchmark_material_schema", `benchmark material schema must be ${MATERIAL_SCHEMA}.`);
  }
  if (root.network !== NETWORK) {
    throw new Stage2gV2EvaluationError("benchmark_material_network", "benchmark material network must be Preprod.");
  }

  const policy = normalizeV2Policy(root.policy);
  const cardanoVkHex = normalizeHex(root.cardano_vk_hex, "cardano_vk_hex", 672);
  const cardanoVkHash = normalizeBlake2b256(root.cardano_vk_blake2b256, "cardano_vk_blake2b256");
  const actualCardanoVkHash = blake2b256Hex(cardanoVkHex);
  if (cardanoVkHash !== actualCardanoVkHash) {
    throw new Stage2gV2EvaluationError(
      "benchmark_material_vk_hash_mismatch",
      "benchmark material Cardano verifier-key hash does not match its canonical key bytes.",
    );
  }

  const params = normalizeParams(root.params);
  const bootstrap = normalizeBootstrap(root.bootstrap);
  const entries = normalizeBenchmarkEntries(root.entries);
  return {
    policy,
    cardanoVkHex,
    cardanoVkHash,
    params,
    bootstrap,
    entries,
  };
}

function normalizeV2Policy(raw) {
  const policy = requireObject(raw, "policy");
  for (const [field, expected] of Object.entries(EXPECTED_POLICY)) {
    if (field === "distinct_7_opt_in") {
      const suppliedOptIn = requireObject(policy[field], `policy.${field}`);
      for (const [optInField, optInExpected] of Object.entries(expected)) {
        if (suppliedOptIn[optInField] !== optInExpected) {
          throw new Stage2gV2EvaluationError(
            "benchmark_policy_invalid",
            `policy.${field}.${optInField} must be ${JSON.stringify(optInExpected)} for this V2 benchmark.`,
          );
        }
      }
      continue;
    }
    if (policy[field] !== expected) {
      throw new Stage2gV2EvaluationError(
        "benchmark_policy_invalid",
        `policy.${field} must be ${expected} for this V2 benchmark.`,
      );
    }
  }
  return {
    defaultUtxoCount: policy.default_utxo_count,
    optimizationUtxoCount: policy.optimization_utxo_count,
    hardMaxUtxoCount: policy.hard_max_utxo_count,
    maxTxCpuPercent: policy.max_tx_cpu_percent,
    maxTxMemPercent: policy.max_tx_mem_percent,
  };
}

function normalizeParams(raw) {
  const params = requireObject(raw, "params");
  const policyId = normalizeHex(params.policy_id, "params.policy_id", 28);
  const tokenName = normalizeHex(params.token_name, "params.token_name");
  if (tokenName !== PARAMS_TOKEN_NAME) {
    throw new Stage2gV2EvaluationError("benchmark_params_token_name", "params.token_name must be the RECLAIMPARAMS token name.");
  }
  return {
    policyId,
    tokenName,
    txHash: normalizeHex(params.tx_hash, "params.tx_hash", 32),
    outputIndex: normalizeOutputIndex(params.output_index, "params.output_index"),
    address: normalizePreprodAddress(params.address, "params.address"),
    lovelace: normalizePositiveLovelace(params.lovelace, "params.lovelace"),
  };
}

function normalizeBootstrap(raw) {
  const bootstrap = requireObject(raw, "bootstrap");
  const address = normalizePreprodAddress(bootstrap.address, "bootstrap.address");
  if (!Array.isArray(bootstrap.utxos) || bootstrap.utxos.length < 2) {
    throw new Stage2gV2EvaluationError(
      "benchmark_bootstrap_utxos",
      "bootstrap.utxos must supply at least two local synthetic UTxOs for fees and collateral.",
    );
  }
  const seen = new Set();
  const utxos = bootstrap.utxos.map((rawUtxo, index) => {
    const utxo = requireObject(rawUtxo, `bootstrap.utxos[${index}]`);
    const txHash = normalizeHex(utxo.tx_hash, `bootstrap.utxos[${index}].tx_hash`, 32);
    const outputIndex = normalizeOutputIndex(utxo.output_index, `bootstrap.utxos[${index}].output_index`);
    const outRef = `${txHash}#${outputIndex}`;
    if (seen.has(outRef)) {
      throw new Stage2gV2EvaluationError("benchmark_outref_duplicate", "benchmark bootstrap UTxO outrefs must be unique.");
    }
    seen.add(outRef);
    return {
      txHash,
      outputIndex,
      assets: normalizeAssets(utxo.value ?? { lovelace: utxo.lovelace }, `bootstrap.utxos[${index}].value`),
    };
  });
  return { address, utxos };
}

function normalizeBenchmarkEntries(raw) {
  if (!Array.isArray(raw) || raw.length !== 7) {
    throw new Stage2gV2EvaluationError(
      "benchmark_entry_count",
      "Stage 2g benchmark material must contain exactly seven supplied entries.",
    );
  }
  const outRefs = new Set();
  const credentials = new Set();
  const proofs = new Set();
  const digests = new Set();
  const entries = raw.map((rawEntry, index) => {
    const entry = requireObject(rawEntry, `entries[${index}]`);
    const txHash = normalizeHex(entry.tx_hash, `entries[${index}].tx_hash`, 32);
    const outputIndex = normalizeOutputIndex(entry.output_index, `entries[${index}].output_index`);
    const outRef = `${txHash}#${outputIndex}`;
    const credential = normalizeHex(entry.credential, `entries[${index}].credential`, 28);
    const proofHex = normalizeHex(entry.proof_hex, `entries[${index}].proof_hex`, 336);
    const publicInputDigestHex = normalizeHex(entry.public_input_digest_hex, `entries[${index}].public_input_digest_hex`, 32);
    const destinationAddress = normalizePreprodAddress(entry.destination_address, `entries[${index}].destination_address`);
    const destinationAddressV1 = destinationAddressV1Bytes(destinationAddress, `entries[${index}].destination_address`);
    const expectedDigest = destinationPublicInputDigest(credential, destinationAddressV1);
    if (publicInputDigestHex !== expectedDigest) {
      throw new Stage2gV2EvaluationError(
        "benchmark_digest_mismatch",
        `entries[${index}].public_input_digest_hex does not bind its supplied credential and destination address.`,
      );
    }
    if (outRefs.has(outRef)) {
      throw new Stage2gV2EvaluationError("benchmark_outref_duplicate", "benchmark entry outrefs must be unique.");
    }
    outRefs.add(outRef);
    credentials.add(credential);
    proofs.add(proofHex);
    digests.add(publicInputDigestHex);
    return {
      txHash,
      outputIndex,
      outRef,
      credential,
      proofHex,
      publicInputDigestHex,
      destinationAddress,
      assets: normalizeAssets(entry.value, `entries[${index}].value`),
    };
  });
  if (credentials.size !== 7 || proofs.size !== 7 || digests.size !== 7) {
    throw new Stage2gV2EvaluationError(
      "benchmark_entries_not_distinct",
      "Stage 2g requires seven distinct credential/proof/digest benchmark slots; this is not a normal claim-flow validity rule.",
    );
  }
  return entries.sort(compareOutRefs);
}

export async function exportAttachedV2Scripts({ material, repoRoot = REPO_ROOT, execFile: execFileFn = execFileAsync }) {
  const contractDir = path.join(repoRoot, "contracts", "ownership-verifier");
  const global = await exportScript(execFileFn, contractDir, [
    "global-v2",
    material.params.policyId,
    material.params.tokenName,
    material.cardanoVkHex,
    material.cardanoVkHash,
  ]);
  assertScriptShape(global, "global");
  if (
    global.proof_slot_encoding !== PROOF_SLOT_ENCODING ||
    global.batch_transcript !== BATCH_TRANSCRIPT ||
    normalizeBlake2b256(global.verifier_vk_hash, "global.verifier_vk_hash") !== material.cardanoVkHash
  ) {
    throw new Stage2gV2EvaluationError(
      "stage2g_global_export_invalid",
      "global-v2 exporter did not return statement-bound V2 metadata coherent with the supplied key material.",
    );
  }
  const globalScript = { type: global.type, script: global.script };
  const globalScriptHash = validatorToScriptHash(globalScript).toLowerCase();
  const base = await exportScript(execFileFn, contractDir, ["base", globalScriptHash]);
  assertScriptShape(base, "base");
  return {
    baseScript: { type: base.type, script: base.script },
    globalScript,
    baseScriptHash: validatorToScriptHash({ type: base.type, script: base.script }).toLowerCase(),
    globalScriptHash,
    attachment: "direct",
  };
}

async function exportScript(execFileFn, contractDir, args) {
  try {
    const result = await execFileFn(
      "cabal",
      ["v2-run", "reclaim-scripts-export", "--", ...args],
      { cwd: contractDir, maxBuffer: 256 * 1024 * 1024 },
    );
    const stdout = typeof result === "string" ? result : result.stdout;
    return JSON.parse(String(stdout).slice(String(stdout).indexOf("{")));
  } catch (error) {
    throw new Stage2gV2EvaluationError("stage2g_script_export_failed", `Unable to export attached Stage 2g scripts: ${redactError(error)}.`);
  }
}

function assertScriptShape(script, label) {
  if (!script || script.type !== "PlutusV3" || !/^[0-9a-f]+$/iu.test(script.script ?? "") || script.script.length % 2 !== 0) {
    throw new Stage2gV2EvaluationError("stage2g_script_export_invalid", `${label} script export is not a Plutus V3 script.`);
  }
}

function assertAttachedV2Scripts(scripts, material) {
  if (!scripts || scripts.attachment !== "direct") {
    throw new Stage2gV2EvaluationError("stage2g_script_attachment", "Stage 2g must use direct attached base and global scripts.");
  }
  assertScriptShape(scripts.baseScript, "base");
  assertScriptShape(scripts.globalScript, "global");
  if (!/^[0-9a-f]{56}$/iu.test(scripts.baseScriptHash ?? "") || !/^[0-9a-f]{56}$/iu.test(scripts.globalScriptHash ?? "")) {
    throw new Stage2gV2EvaluationError("stage2g_script_hash", "Stage 2g exporter did not return canonical base/global script hashes.");
  }
  if (scripts.cardanoVkHash !== undefined && scripts.cardanoVkHash !== material.cardanoVkHash) {
    throw new Stage2gV2EvaluationError("stage2g_script_export_invalid", "Stage 2g exporter key hash does not match benchmark material.");
  }
}

/**
 * The local evaluator below intentionally supplies bounded placeholder units
 * only so Lucid can produce a transaction body. It is never used as a cost
 * measurement; evaluateStage2gV2 subsequently calls provider.evaluateTx.
 */
export async function buildSyntheticAttachedTx({ provider, material, scripts, lucidFactory = Lucid }) {
  const synthetic = buildSyntheticUtxos(material, scripts);
  const lucid = await lucidFactory(provider, NETWORK);
  lucid.selectWallet.fromAddress(material.bootstrap.address, synthetic.bootstrapUtxos);

  const baseOutRefs = new Set(synthetic.baseUtxos.map(outRefId));
  const entryByOutRef = new Map(material.entries.map((entry) => [entry.outRef, entry]));
  const globalRewardAddress = credentialToRewardAddress(NETWORK, scriptHashToCredential(scripts.globalScriptHash));
  const globalRedeemer = (ctx) => {
    const paramsIndex = ctx.referenceInputs.findIndex((utxo) => outRefId(utxo) === outRefId(synthetic.paramsUtxo));
    if (paramsIndex < 0) {
      throw new Stage2gV2EvaluationError("stage2g_params_reference_missing", "Synthetic params UTxO is absent from the final reference-input order.");
    }
    const finalBaseOutRefs = ctx.inputs.filter((utxo) => baseOutRefs.has(outRefId(utxo))).map(outRefId);
    if (finalBaseOutRefs.length !== 7) {
      throw new Stage2gV2EvaluationError("stage2g_base_input_count", "Final transaction does not contain exactly seven synthetic ReclaimBase inputs.");
    }
    const entries = finalBaseOutRefs.map((outRef) => entryByOutRef.get(outRef));
    if (entries.some((entry) => !entry)) {
      throw new Stage2gV2EvaluationError("stage2g_base_input_order", "Final synthetic ReclaimBase input order is not represented in benchmark material.");
    }
    return Data.to(
      new Constr(0, [
        BigInt(paramsIndex),
        0n,
        entries.map((entry) => entry.proofHex),
        entries.map((entry) => entry.publicInputDigestHex),
      ]),
    );
  };

  let tx = lucid
    .newTx()
    .readFrom([synthetic.paramsUtxo])
    .collectFrom(synthetic.baseUtxos, Data.void())
    .withdraw(globalRewardAddress, 0n, globalRedeemer)
    .attach.SpendingValidator(scripts.baseScript)
    .attach.WithdrawalValidator(scripts.globalScript);
  for (const entry of material.entries) {
    tx = tx.pay.ToAddress(entry.destinationAddress, entry.assets);
  }
  const signBuilder = await tx.complete({
    canonical: true,
    changeAddress: material.bootstrap.address,
    presetWalletInputs: synthetic.bootstrapUtxos,
    localUPLCEval: true,
    evaluator: makeBoundedSerializationEvaluator(),
  });
  return {
    txCbor: signBuilder.toCBOR({ canonical: true }),
    additionalUtxos: [synthetic.paramsUtxo, ...synthetic.baseUtxos, ...synthetic.bootstrapUtxos],
    attachment: "direct",
  };
}

export function buildSyntheticUtxos(material, scripts) {
  const paramsUnit = `${material.params.policyId}${material.params.tokenName}`;
  const paramsUtxo = {
    txHash: material.params.txHash,
    outputIndex: material.params.outputIndex,
    address: material.params.address,
    assets: { lovelace: material.params.lovelace, [paramsUnit]: 1n },
    datum: Data.to(new Constr(0, [scripts.baseScriptHash])),
  };
  const baseAddress = validatorToAddress(NETWORK, scripts.baseScript);
  const baseUtxos = material.entries.map((entry) => ({
    txHash: entry.txHash,
    outputIndex: entry.outputIndex,
    address: baseAddress,
    assets: entry.assets,
    datum: Data.to(new Constr(0, [entry.credential])),
  }));
  const bootstrapUtxos = material.bootstrap.utxos.map((utxo) => ({
    txHash: utxo.txHash,
    outputIndex: utxo.outputIndex,
    address: material.bootstrap.address,
    assets: utxo.assets,
  }));
  return { paramsUtxo, baseUtxos, bootstrapUtxos };
}

export function makeBoundedSerializationEvaluator() {
  return {
    name: "stage2g-v2-bounded-serialization-only",
    async evaluate({ tx, context }) {
      const redeemers = redeemerKeysFromCbor(tx);
      const spendCount = redeemers.filter((redeemer) => redeemer.redeemer_tag === "spend").length;
      const withdrawalCount = redeemers.filter((redeemer) => redeemer.redeemer_tag === "withdraw").length;
      if (redeemers.length !== 8 || spendCount !== 7 || withdrawalCount !== 1) {
        throw new Stage2gV2EvaluationError(
          "stage2g_serialization_redeemers",
          "Stage 2g serialization transaction must contain seven spends and one script withdrawal.",
        );
      }
      const maxMem = BigInt(context.protocolParameters.maxTxExMem);
      const maxSteps = BigInt(context.protocolParameters.maxTxExSteps);
      const perRedeemerMem = boundedUnits(maxMem);
      const perRedeemerSteps = boundedUnits(maxSteps);
      return redeemers.map((redeemer) => ({
        ...redeemer,
        ex_units: { mem: perRedeemerMem, steps: perRedeemerSteps },
      }));
    },
  };
}

function redeemerKeysFromCbor(txCbor) {
  const transaction = CML.Transaction.from_cbor_hex(txCbor);
  const redeemers = transaction.witness_set().redeemers();
  if (!redeemers) {
    return [];
  }
  const legacy = redeemers.as_arr_legacy_redeemer();
  if (legacy) {
    return Array.from({ length: legacy.len() }, (_, index) => {
      const redeemer = legacy.get(index);
      return {
        redeemer_tag: cmlRedeemerTag(redeemer.tag()),
        redeemer_index: safeRedeemerIndex(redeemer.index()),
      };
    });
  }
  const map = redeemers.as_map_redeemer_key_to_redeemer_val();
  if (!map) {
    return [];
  }
  const keys = map.keys();
  return Array.from({ length: keys.len() }, (_, index) => {
    const key = keys.get(index);
    return {
      redeemer_tag: cmlRedeemerTag(key.tag()),
      redeemer_index: safeRedeemerIndex(key.index()),
    };
  });
}

function cmlRedeemerTag(tag) {
  const tags = new Map([
    [CML.RedeemerTag.Spend, "spend"],
    [CML.RedeemerTag.Mint, "mint"],
    [CML.RedeemerTag.Cert, "publish"],
    [CML.RedeemerTag.Reward, "withdraw"],
    [CML.RedeemerTag.Voting, "vote"],
    [CML.RedeemerTag.Proposing, "propose"],
  ]);
  const normalized = tags.get(tag);
  if (!normalized) {
    throw new Stage2gV2EvaluationError("stage2g_serialization_redeemers", "Lucid produced an unknown redeemer tag.");
  }
  return normalized;
}

function safeRedeemerIndex(value) {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Stage2gV2EvaluationError("stage2g_serialization_redeemers", "Lucid produced an invalid redeemer index.");
  }
  return index;
}

function boundedUnits(maximum) {
  if (maximum <= 0n) {
    throw new Stage2gV2EvaluationError("stage2g_protocol_limits", "Provider protocol limits are unavailable for bounded serialization units.");
  }
  const unit = maximum / 64n;
  if (unit > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Stage2gV2EvaluationError("stage2g_protocol_limits", "Provider protocol limit cannot be represented by Lucid's evaluator adapter.");
  }
  return Math.max(1, Number(unit));
}

export function summarizeProviderEvaluation(redeemers, protocolParameters) {
  if (!Array.isArray(redeemers) || redeemers.length === 0) {
    throw new Stage2gV2EvaluationError(
      "stage2g_evaluation_unavailable",
      "Provider did not return measured execution units for the Stage 2g transaction.",
    );
  }
  const maxMemory = BigInt(protocolParameters?.maxTxExMem ?? 0n);
  const maxSteps = BigInt(protocolParameters?.maxTxExSteps ?? 0n);
  if (maxMemory <= 0n || maxSteps <= 0n) {
    throw new Stage2gV2EvaluationError("stage2g_protocol_limits", "Provider did not return usable transaction execution limits.");
  }
  let totalMemory = 0n;
  let totalSteps = 0n;
  const normalizedRedeemers = redeemers.map((redeemer, index) => {
    const memory = normalizeExecutionUnit(redeemer?.ex_units?.mem, `redeemers[${index}].ex_units.mem`);
    const steps = normalizeExecutionUnit(redeemer?.ex_units?.steps, `redeemers[${index}].ex_units.steps`);
    totalMemory += memory;
    totalSteps += steps;
    return {
      tag: String(redeemer?.redeemer_tag ?? "unknown"),
      index: Number(redeemer?.redeemer_index ?? -1),
      memory: memory.toString(),
      steps: steps.toString(),
    };
  });
  const spendCount = normalizedRedeemers.filter((redeemer) => redeemer.tag === "spend").length;
  const withdrawalCount = normalizedRedeemers.filter((redeemer) => redeemer.tag === "withdraw").length;
  if (normalizedRedeemers.length !== 8 || spendCount !== 7 || withdrawalCount !== 1) {
    throw new Stage2gV2EvaluationError(
      "stage2g_evaluation_redeemers",
      "Provider measurement must cover seven ReclaimBase spends and one ReclaimGlobal withdrawal.",
    );
  }
  return {
    redeemers: normalizedRedeemers,
    totalMemory: totalMemory.toString(),
    totalSteps: totalSteps.toString(),
    memoryPercent: percentCeil(totalMemory, maxMemory),
    cpuPercent: percentCeil(totalSteps, maxSteps),
  };
}

export function assertMeasuredV2Margin(evaluation, policy) {
  if (evaluation.memoryPercent > policy.maxTxMemPercent) {
    throw new Stage2gV2EvaluationError(
      "stage2g_memory_margin_exceeded",
      `Provider-measured memory is ${evaluation.memoryPercent}%, above the V2 benchmark ceiling of ${policy.maxTxMemPercent}%.`,
    );
  }
  if (evaluation.cpuPercent > policy.maxTxCpuPercent) {
    throw new Stage2gV2EvaluationError(
      "stage2g_cpu_margin_exceeded",
      `Provider-measured CPU is ${evaluation.cpuPercent}%, above the V2 benchmark ceiling of ${policy.maxTxCpuPercent}%.`,
    );
  }
}

function assertBuiltTransaction(built) {
  if (!built || typeof built.txCbor !== "string" || !/^[0-9a-f]+$/iu.test(built.txCbor) || built.txCbor.length % 2 !== 0) {
    throw new Stage2gV2EvaluationError("stage2g_tx_serialization", "Stage 2g bootstrap builder did not return unsigned transaction CBOR.");
  }
  if (!Array.isArray(built.additionalUtxos) || built.additionalUtxos.length < 10) {
    throw new Stage2gV2EvaluationError(
      "stage2g_additional_utxos",
      "Stage 2g must provide synthetic params, seven base, and bootstrap UTxOs to provider evaluation.",
    );
  }
  if (built.attachment !== "direct") {
    throw new Stage2gV2EvaluationError("stage2g_script_attachment", "Stage 2g bootstrap builder did not use directly attached scripts.");
  }
}

function createPreprodProvider(env) {
  const projectId = env.RECLAIM_BLOCKFROST_PROJECT_ID?.trim() || env.BLOCKFROST_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Stage2gV2EvaluationError("blockfrost_project_id_missing", "RECLAIM_BLOCKFROST_PROJECT_ID is required for Stage 2g Preprod evaluation.");
  }
  const url = env.RECLAIM_BLOCKFROST_URL?.trim() || "https://cardano-preprod.blockfrost.io/api/v0";
  return new Blockfrost(url, projectId);
}

function assertProvider(provider) {
  if (!provider || typeof provider.evaluateTx !== "function" || typeof provider.getProtocolParameters !== "function") {
    throw new Stage2gV2EvaluationError("stage2g_provider_invalid", "Stage 2g requires a provider with evaluateTx and getProtocolParameters.");
  }
}

function resolveMaterialPath(env, repoRoot, explicitPath) {
  const configured = explicitPath ?? env[MATERIAL_FILE_ENV]?.trim();
  if (!configured) {
    throw new Stage2gV2EvaluationError("benchmark_material_missing", `${MATERIAL_FILE_ENV} must point to local Stage 2g benchmark material.`);
  }
  const resolved = path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
  if (!existsSync(resolved)) {
    throw new Stage2gV2EvaluationError("benchmark_material_missing", "Configured Stage 2g benchmark material file does not exist.");
  }
  return resolved;
}

function resolveEvidencePath(env, repoRoot, explicitPath) {
  const configured = explicitPath ?? env[EVIDENCE_FILE_ENV]?.trim() ?? path.join(...EVIDENCE_OUTPUT_RELATIVE_ROOT, "evaluation.local.json");
  const resolved = path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(repoRoot, configured);
  assertSafeEvidencePath(resolved, repoRoot);
  return resolved;
}

function assertSafeEvidencePath(evidencePath, repoRoot) {
  const root = path.resolve(repoRoot, ...EVIDENCE_OUTPUT_RELATIVE_ROOT);
  if (evidencePath !== root && !evidencePath.startsWith(`${root}${path.sep}`)) {
    throw new Stage2gV2EvaluationError(
      "stage2g_evidence_path_unsafe",
      "Stage 2g evidence must remain inside output/preprod-e2e/stage2g-v2/.",
    );
  }
  const relative = path.relative(path.resolve(repoRoot), evidencePath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Stage2gV2EvaluationError(
      "stage2g_evidence_path_unsafe",
      "Stage 2g evidence path is outside the repository output directory.",
    );
  }
  let current = path.resolve(repoRoot);
  for (const part of relative.split(path.sep)) {
    if (!part || part === ".") {
      continue;
    }
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Stage2gV2EvaluationError(
          "stage2g_evidence_path_unsafe",
          "Stage 2g evidence path traverses a symbolic link.",
        );
      }
    } catch (error) {
      if (error instanceof Stage2gV2EvaluationError || error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function buildEvidence({ materialPath, material, scripts, txCbor, evaluation, outcome, failure }) {
  return {
    schema: EVIDENCE_SCHEMA,
    stage: "stage2g-v2-distinct-benchmark",
    benchmark_scope: "seven all-distinct credential/proof/digest slots only; not a normal claim-flow eligibility rule",
    outcome,
    network: NETWORK,
    material: {
      source: "local-material-file",
      supplied_entry_count: material.entries.length,
      distinct_credentials: material.entries.length,
      distinct_proofs: material.entries.length,
      distinct_public_input_digests: material.entries.length,
    },
    policy: {
      default_utxo_count: material.policy.defaultUtxoCount,
      optimization_utxo_count: material.policy.optimizationUtxoCount,
      hard_max_utxo_count: material.policy.hardMaxUtxoCount,
      max_tx_cpu_percent: material.policy.maxTxCpuPercent,
      max_tx_mem_percent: material.policy.maxTxMemPercent,
    },
    scripts: {
      attachment: "direct",
      base_type: scripts.baseScript.type,
      global_type: scripts.globalScript.type,
      base_script_hash: scripts.baseScriptHash,
      global_script_hash: scripts.globalScriptHash,
      proof_slot_encoding: PROOF_SLOT_ENCODING,
      batch_transcript: BATCH_TRANSCRIPT,
    },
    transaction: {
      unsigned: true,
      tx_cbor_written: false,
      tx_fingerprint: `sha256:${createHash("sha256").update(txCbor, "hex").digest("hex")}`,
      synthetic_inputs: true,
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
    ...(evaluation ? { evaluation } : {}),
    ...(failure ? { failure: { code: failure.code, message: failure.message } } : {}),
  };
}

function writeEvidence(evidencePath, evidence, { log, repoRoot }) {
  try {
    assertSafeEvidencePath(evidencePath, repoRoot);
    writeStage2gEvidenceExclusive(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, repoRoot);
  } catch {
    throw new Stage2gV2EvaluationError(
      "stage2g_evidence_write_failed",
      "Stage 2g refused to overwrite an existing evidence path; choose a new file name under output/preprod-e2e/stage2g-v2/.",
    );
  }
  log(JSON.stringify(evidence));
}

// Keep every path lookup after the repository root fd-relative. A lexical
// symlink check alone can be bypassed by replacing a parent directory between
// that check and the final pathname write.
function writeStage2gEvidenceExclusive(evidencePath, contents, repoRoot) {
  if (process.platform !== "linux") {
    throw new Error("secure Stage 2g evidence output requires Linux");
  }
  const root = path.resolve(repoRoot);
  const relative = path.relative(root, evidencePath);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("unsafe Stage 2g evidence output path");
  }
  const components = relative.split(path.sep).filter((part) => part && part !== ".");
  const fileName = components.pop();
  if (!fileName || components.some((part) => part === "..")) {
    throw new Error("unsafe Stage 2g evidence output path");
  }

	let directoryFd = openAbsoluteStage2gDirectory(root);
  try {
    for (const component of components) {
      const childPath = procFdPath(directoryFd, component);
      try {
        mkdirSync(childPath, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }
      const childFd = openStage2gDirectory(childPath);
      closeSync(directoryFd);
      directoryFd = childFd;
    }

    const fileFd = openSync(
      procFdPath(directoryFd, fileName),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const data = Buffer.from(contents, "utf8");
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(fileFd, data, offset, data.length - offset);
        if (written <= 0) {
          throw new Error("short Stage 2g evidence write");
        }
        offset += written;
      }
      fsyncSync(fileFd);
    } finally {
      closeSync(fileFd);
    }
  } finally {
    closeSync(directoryFd);
  }
}

function openStage2gDirectory(directoryPath) {
  return openSync(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
}

function openAbsoluteStage2gDirectory(directoryPath) {
  if (!path.isAbsolute(directoryPath)) {
    throw new Error("unsafe Stage 2g output root");
  }
  let directoryFd = openStage2gDirectory(path.parse(directoryPath).root);
  try {
    for (const component of directoryPath.split(path.sep)) {
      if (!component) {
        continue;
      }
      const childFd = openStage2gDirectory(procFdPath(directoryFd, component));
      closeSync(directoryFd);
      directoryFd = childFd;
    }
    return directoryFd;
  } catch (error) {
    closeSync(directoryFd);
    throw error;
  }
}

function procFdPath(directoryFd, childName) {
  if (!childName || childName === "." || childName === ".." || childName.includes(path.sep)) {
    throw new Error("unsafe Stage 2g output component");
  }
  return `/proc/self/fd/${directoryFd}/${childName}`;
}

function stageFailure(error) {
  if (error instanceof Stage2gV2EvaluationError) {
    return error;
  }
  const message = redactError(error);
  if (/(stake|reward|withdrawal).{0,100}(not registered|unknown|missing|unregistered)|(?:not registered|unknown|missing|unregistered).{0,100}(stake|reward|withdrawal)/iu.test(message)) {
    return new Stage2gV2EvaluationError(
      "synthetic_stake_state_rejected",
      "Provider rejected the synthetic script reward-account state. This stage intentionally does not register stake state; use an evaluator that accepts the supplied synthetic state or stop here.",
    );
  }
  return new Stage2gV2EvaluationError("stage2g_provider_evaluation_failed", `Provider evaluation failed: ${message}.`);
}

function normalizeAssets(raw, field) {
  const assets = requireObject(raw, field);
  const normalized = {};
  for (const [unit, quantity] of Object.entries(assets)) {
    if (unit !== "lovelace" && !/^[0-9a-f]{56,120}$/iu.test(unit)) {
      throw new Stage2gV2EvaluationError("benchmark_asset_unit", `${field}.${unit} is not a valid Cardano asset unit.`);
    }
    normalized[unit] = normalizePositiveLovelace(quantity, `${field}.${unit}`);
  }
  if ((normalized.lovelace ?? 0n) <= 0n) {
    throw new Stage2gV2EvaluationError("benchmark_lovelace_missing", `${field}.lovelace must be positive.`);
  }
  return normalized;
}

function normalizePositiveLovelace(value, field) {
  const normalized = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^\d+$/u.test(normalized) || BigInt(normalized) <= 0n) {
    throw new Stage2gV2EvaluationError("benchmark_quantity_invalid", `${field} must be a positive integer quantity.`);
  }
  return BigInt(normalized);
}

function normalizeExecutionUnit(value, field) {
  let normalized;
  try {
    normalized = typeof value === "bigint" ? value : BigInt(value ?? -1);
  } catch {
    throw new Stage2gV2EvaluationError("stage2g_evaluation_invalid", `${field} must be a non-negative integer.`);
  }
  if (normalized < 0n) {
    throw new Stage2gV2EvaluationError("stage2g_evaluation_invalid", `${field} must be a non-negative integer.`);
  }
  return normalized;
}

function normalizePreprodAddress(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Stage2gV2EvaluationError("benchmark_address_invalid", `${field} must be a Preprod Shelley address.`);
  }
  try {
    const details = getAddressDetails(value.trim());
    if (details.networkId !== NETWORK_ID || !details.address?.bech32) {
      throw new Error("wrong network");
    }
    return details.address.bech32;
  } catch {
    throw new Stage2gV2EvaluationError("benchmark_address_invalid", `${field} must be a Preprod Shelley address.`);
  }
}

function destinationAddressV1Bytes(address, field) {
  const details = getAddressDetails(address);
  if (details.networkId !== NETWORK_ID || details.type === "Pointer" || !details.paymentCredential) {
    throw new Stage2gV2EvaluationError("benchmark_destination_invalid", `${field} is not a supported Preprod destination.`);
  }
  const payment = credentialV1Bytes(details.paymentCredential, `${field}.paymentCredential`);
  const stake = details.stakeCredential
    ? credentialV1Bytes(details.stakeCredential, `${field}.stakeCredential`)
    : `00${"00".repeat(28)}`;
  return `${payment}${stake}`;
}

function credentialV1Bytes(credential, field) {
  const hash = normalizeHex(credential.hash, field, 28);
  if (credential.type === "Key") {
    return `01${hash}`;
  }
  if (credential.type === "Script") {
    return `02${hash}`;
  }
  throw new Stage2gV2EvaluationError("benchmark_destination_invalid", `${field} has an unsupported credential type.`);
}

export function destinationPublicInputDigest(credential, destinationAddressV1) {
  const preimage = concatBytes([
    new TextEncoder().encode(PUBLIC_INPUT_DOMAIN),
    hexToBytes(credential),
    hexToBytes(destinationAddressV1),
  ]);
  return Buffer.from(blake2b(preimage, { dkLen: 32 })).toString("hex");
}

function blake2b256Hex(hex) {
  return Buffer.from(blake2b(hexToBytes(hex), { dkLen: 32 })).toString("hex");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function normalizeBlake2b256(value, field) {
  const normalized = typeof value === "string" ? value.trim().replace(/^blake2b256:/iu, "") : "";
  return normalizeHex(normalized, field, 32);
}

function normalizeHex(value, field, byteLength) {
  const normalized = typeof value === "string" ? value.trim().replace(/^0x/iu, "").toLowerCase() : "";
  if (!/^[0-9a-f]+$/u.test(normalized) || normalized.length % 2 !== 0 || (byteLength !== undefined && normalized.length !== byteLength * 2)) {
    const suffix = byteLength === undefined ? "even-length hexadecimal" : `${byteLength} bytes of hexadecimal`;
    throw new Stage2gV2EvaluationError("benchmark_hex_invalid", `${field} must be ${suffix}.`);
  }
  return normalized;
}

function normalizeOutputIndex(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Stage2gV2EvaluationError("benchmark_output_index", `${field} must be a non-negative integer.`);
  }
  return value;
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Stage2gV2EvaluationError("benchmark_material_shape", `${field} must be an object.`);
  }
  return value;
}

function compareOutRefs(left, right) {
  const txHashCompare = left.txHash.localeCompare(right.txHash);
  return txHashCompare === 0 ? left.outputIndex - right.outputIndex : txHashCompare;
}

function outRefId(utxo) {
  return `${utxo.txHash}#${utxo.outputIndex}`;
}

function percentCeil(value, maximum) {
  return Number((value * 100n + maximum - 1n) / maximum);
}

export function redactError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "provider error");
  return message
    .replace(/\b(addr(?:_test)?1[0-9a-z]{20,})\b/giu, "[address-redacted]")
    .replace(/\b(stake(?:_test)?1[0-9a-z]{20,})\b/giu, "[address-redacted]")
    .replace(/\b[0-9a-f]{56,}\b/giu, "[hex-redacted]")
    .replace(/\b[A-Za-z0-9_-]{96,}\b/gu, "[token-redacted]")
    .replace(/(project_id|api[-_ ]?key|authorization|bearer)\s*[:=]\s*\S+/giu, "$1=[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 360) || "provider error";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  evaluateStage2gV2().catch((error) => {
    const code = error instanceof Stage2gV2EvaluationError ? error.code : "stage2g_unexpected_error";
    console.error(JSON.stringify({ schema: EVIDENCE_SCHEMA, outcome: "failed", code, message: redactError(error) }));
    process.exitCode = 1;
  });
}
