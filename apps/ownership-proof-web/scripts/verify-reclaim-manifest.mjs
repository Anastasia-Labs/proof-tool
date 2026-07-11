#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCHEMA = "proof-tool-reclaim-deployment-v1";
const DESTINATION_CIRCUIT_ID = "root-ownership-destination-v1/bls12-381/groth16";
const DESTINATION_KEY_VERSION = "ownership-destination-v1";
const DESTINATION_ADDRESS_ENCODING = "destination-address-v1";
const SAME_AS_PREVIOUS_PROOF_SLOT_ENCODING = "bytes-empty-same-as-previous-v1";
const FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2 = "full-proof-plus-public-input-digest-v2";
const DISTINCT_7_REQUEST_PARAMETER = "maxUtxos";
const DISTINCT_7_REQUEST_VALUE = 7;
const DISTINCT_7_DEFAULT_UTXO_COUNT = 6;
const DISTINCT_7_OPTIMIZATION_UTXO_COUNT = 6;
const DISTINCT_7_MAX_TX_CPU_PERCENT = 90;
const DISTINCT_7_MAX_TX_MEM_PERCENT = 80;

const manifestPath = process.argv[2] || process.env.RECLAIM_DEPLOYMENT_MANIFEST_PATH;

if (!manifestPath) {
  fail("usage: node scripts/verify-reclaim-manifest.mjs <manifest.json>");
}

const resolved = resolve(process.cwd(), manifestPath);
if (!existsSync(resolved)) {
  fail(`manifest not found: ${resolved}`);
}

const manifest = JSON.parse(readFileSync(resolved, "utf8"));
const errors = validate(manifest);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`${error.field}: ${error.message}`);
  }
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      deployment_id: manifest.deployment_id,
      network: manifest.network,
      source_commit: manifest.source_commit,
      verifier_vk_hash: manifest.reclaim_global.verifier_vk_hash,
      proof_slot_encoding: manifest.reclaim_global.proof_slot_encoding ?? null,
      batch_transcript_vk_hash: manifest.reclaim_global.batch_transcript_vk_hash ?? null,
      distinct_7_opt_in: manifest.batching.distinct_7_opt_in ?? null,
      enabled: manifest.enabled !== false,
    },
    null,
    2,
  ),
);

function validate(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [{ field: "manifest", message: "manifest must be a JSON object" }];
  }
  const base = object(raw.reclaim_base, "reclaim_base", errors);
  const global = object(raw.reclaim_global, "reclaim_global", errors);
  const params = object(raw.params_utxo, "params_utxo", errors);
  const proof = object(raw.proof, "proof", errors);
  const batching = object(raw.batching, "batching", errors);
  object(raw.provider, "provider", errors);

  exact(raw.schema, SCHEMA, "schema", errors);
  oneOf(raw.network, ["Preprod", "Mainnet", "Preview"], "network", errors);
  integer(raw.network_id, "network_id", errors);
  string(raw.source_commit, "source_commit", errors);
  string(raw.contract_version, "contract_version", errors);
  string(raw.deployment_id, "deployment_id", errors);

  hex(base.script_hash, 56, "reclaim_base.script_hash", errors);
  hex(base.required_global_credential, 56, "reclaim_base.required_global_credential", errors);
  hex(global.script_hash, 56, "reclaim_global.script_hash", errors);
  hex(global.rewarding_credential, 56, "reclaim_global.rewarding_credential", errors);
  hex(global.params_currency_symbol, 56, "reclaim_global.params_currency_symbol", errors);
  hash(global.verifier_vk_hash, "reclaim_global.verifier_vk_hash", errors);
  exact(global.proof_profile, "single-destination", "reclaim_global.proof_profile", errors);
  if (global.proof_slot_encoding === undefined && global.batch_transcript_vk_hash !== undefined) {
    errors.push({
      field: "reclaim_global.proof_slot_encoding",
      message: "is required when batch_transcript_vk_hash is present",
    });
  } else if (global.proof_slot_encoding === FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2) {
    hash(global.batch_transcript_vk_hash, "reclaim_global.batch_transcript_vk_hash", errors);
    exact(
      global.batch_transcript_vk_hash,
      proof.cardano_vk_blake2b256,
      "reclaim_global.batch_transcript_vk_hash",
      errors,
    );
  } else if (global.proof_slot_encoding === SAME_AS_PREVIOUS_PROOF_SLOT_ENCODING) {
    if (global.batch_transcript_vk_hash !== undefined) {
      errors.push({
        field: "reclaim_global.batch_transcript_vk_hash",
        message: "must be absent for the V1 same-as-previous encoding",
      });
    }
  } else if (global.proof_slot_encoding !== undefined) {
    errors.push({
      field: "reclaim_global.proof_slot_encoding",
      message: "must be a supported reclaim proof-slot encoding",
    });
  }

  hex(params.tx_hash, 64, "params_utxo.tx_hash", errors);
  integer(params.output_index, "params_utxo.output_index", errors);
  hex(params.policy_id, 56, "params_utxo.policy_id", errors);
  hex(params.token_name, null, "params_utxo.token_name", errors);
  hex(params.datum_reclaim_base_script_hash, 56, "params_utxo.datum_reclaim_base_script_hash", errors);

  exact(proof.circuit_id, DESTINATION_CIRCUIT_ID, "proof.circuit_id", errors);
  exact(proof.key_version, DESTINATION_KEY_VERSION, "proof.key_version", errors);
  exact(proof.destination_address_encoding, DESTINATION_ADDRESS_ENCODING, "proof.destination_address_encoding", errors);
  hash(proof.vk_hash, "proof.vk_hash", errors);
  hash(proof.cardano_vk_blake2b256, "proof.cardano_vk_blake2b256", errors);

  integer(batching.default_utxo_count, "batching.default_utxo_count", errors);
  integer(batching.optimization_utxo_count, "batching.optimization_utxo_count", errors);
  integer(batching.hard_max_utxo_count, "batching.hard_max_utxo_count", errors);

  if (raw.network === "Mainnet" && raw.network_id !== 1) {
    errors.push({ field: "network_id", message: "mainnet must use network_id 1" });
  }
  if ((raw.network === "Preprod" || raw.network === "Preview") && raw.network_id !== 0) {
    errors.push({ field: "network_id", message: "test networks must use network_id 0" });
  }
  if (raw.deployment_id && raw.network && base.script_hash && raw.source_commit) {
    const expected = `${raw.network.toLowerCase()}:${base.script_hash}:${raw.source_commit}`;
    exact(raw.deployment_id, expected, "deployment_id", errors);
  }
  if (/dirty|uncommitted/iu.test(String(raw.source_commit || ""))) {
    errors.push({ field: "source_commit", message: "source_commit must be a clean tag or commit" });
  }
  exact(base.required_global_credential, global.rewarding_credential, "reclaim_base.required_global_credential", errors);
  exact(global.verifier_vk_hash, proof.vk_hash, "proof.vk_hash", errors);
  exact(params.datum_reclaim_base_script_hash, base.script_hash, "params_utxo.datum_reclaim_base_script_hash", errors);
  exact(params.policy_id, global.params_currency_symbol, "params_utxo.policy_id", errors);
  if (batching.default_utxo_count > batching.optimization_utxo_count || batching.optimization_utxo_count > batching.hard_max_utxo_count) {
    errors.push({ field: "batching", message: "batch caps must satisfy default <= optimization <= hard max" });
  }
  if (global.proof_slot_encoding === FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2) {
    if (batching.hard_max_utxo_count > DISTINCT_7_REQUEST_VALUE) {
      errors.push({
        field: "batching.hard_max_utxo_count",
        message: "statement-bound V2 hard_max_utxo_count must not exceed the distinct-7 capacity policy",
      });
    }
    distinctSevenOptIn(batching.distinct_7_opt_in, "batching.distinct_7_opt_in", errors);
    exact(
      batching.default_utxo_count,
      DISTINCT_7_DEFAULT_UTXO_COUNT,
      "batching.default_utxo_count",
      errors,
    );
    exact(
      batching.optimization_utxo_count,
      DISTINCT_7_OPTIMIZATION_UTXO_COUNT,
      "batching.optimization_utxo_count",
      errors,
    );
    exact(
      batching.hard_max_utxo_count,
      DISTINCT_7_REQUEST_VALUE,
      "batching.hard_max_utxo_count",
      errors,
    );
    exact(
      batching.max_tx_cpu_percent,
      DISTINCT_7_MAX_TX_CPU_PERCENT,
      "batching.max_tx_cpu_percent",
      errors,
    );
    exact(
      batching.max_tx_mem_percent,
      DISTINCT_7_MAX_TX_MEM_PERCENT,
      "batching.max_tx_mem_percent",
      errors,
    );
  } else if (batching.distinct_7_opt_in !== undefined) {
    errors.push({
      field: "batching.distinct_7_opt_in",
      message: "distinct-7 opt-in metadata is only valid for statement-bound V2",
    });
  }
  if (raw.enabled === false) {
    errors.push({ field: "enabled", message: "manifest is explicitly disabled" });
  }
  return errors;
}

function object(value, field, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push({ field, message: "must be an object" });
    return {};
  }
  return value;
}

function string(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ field, message: "must be a non-empty string" });
  }
}

function exact(value, expected, field, errors) {
  if (value !== expected) {
    errors.push({ field, message: `must equal ${expected}` });
  }
}

function oneOf(value, allowed, field, errors) {
  if (!allowed.includes(value)) {
    errors.push({ field, message: `must be one of ${allowed.join(", ")}` });
  }
}

function integer(value, field, errors) {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    errors.push({ field, message: "must be a non-negative safe integer" });
  }
}

function hex(value, length, field, errors) {
  if (typeof value !== "string" || !/^[0-9a-f]*$/u.test(value) || value.length % 2 !== 0) {
    errors.push({ field, message: "must be lowercase even-length hex" });
    return;
  }
  if (length !== null && value.length !== length) {
    errors.push({ field, message: `must be ${length / 2} bytes` });
  }
}

function hash(value, field, errors) {
  if (typeof value !== "string" || !/^blake2b256:[0-9a-f]{64}$/u.test(value)) {
    errors.push({ field, message: "must be blake2b256:<32-byte-hex>" });
  }
}

function distinctSevenOptIn(value, field, errors) {
  const policy = object(value, field, errors);
  const allowedFields = new Set([
    "request_parameter",
    "request_value",
    "require_explicit_request",
    "require_measured_execution_units",
  ]);
  for (const key of Object.keys(policy)) {
    if (!allowedFields.has(key)) {
      errors.push({ field: `${field}.${key}`, message: "is not part of the distinct-7 opt-in policy" });
    }
  }
  exact(
    policy.request_parameter,
    DISTINCT_7_REQUEST_PARAMETER,
    `${field}.request_parameter`,
    errors,
  );
  exact(policy.request_value, DISTINCT_7_REQUEST_VALUE, `${field}.request_value`, errors);
  exact(
    policy.require_explicit_request,
    true,
    `${field}.require_explicit_request`,
    errors,
  );
  exact(
    policy.require_measured_execution_units,
    true,
    `${field}.require_measured_execution_units`,
    errors,
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
