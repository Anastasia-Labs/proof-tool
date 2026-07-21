import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateReclaimManifest } from "./verify-reclaim-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const publicManifestPath = path.join(
  repoRoot,
  "apps",
  "ownership-proof-web",
  "public",
  "proof-assets",
  "reclaim-deployment.json",
);
describe("verify-reclaim-manifest V2 coherence", () => {
  it("accepts matched statement-bound V2 metadata", () => {
    const manifest = statementBoundV2Manifest();
    manifest.reclaim_global.proof_slot_encoding =
      "full-proof-plus-public-input-digest-v2";
    manifest.reclaim_global.batch_transcript_vk_hash =
      manifest.proof.cardano_vk_blake2b256;

    expect(validateReclaimManifest(manifest)).toEqual([]);
    expect(manifest.reclaim_global.proof_slot_encoding).toBe("full-proof-plus-public-input-digest-v2");
  });

  it("rejects a mismatched V2 transcript verifier-key hash", () => {
    const manifest = publicManifest();
    manifest.reclaim_global.proof_slot_encoding =
      "full-proof-plus-public-input-digest-v2";
    manifest.reclaim_global.batch_transcript_vk_hash =
      "blake2b256:" + "00".repeat(32);

    expect(errorFields(manifest)).toContain("reclaim_global.batch_transcript_vk_hash");
  });

  it("accepts the explicit seven-slot V2 capacity policy", () => {
    const manifest = statementBoundV2Manifest();
    manifest.batching = {
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
    };

    expect(validateReclaimManifest(manifest)).toEqual([]);
  });

  it("rejects an automatic or unevaluated explicit seven-slot V2 batch", () => {
    const manifest = statementBoundV2Manifest();
    manifest.batching = {
      default_utxo_count: 6,
      optimization_utxo_count: 6,
      hard_max_utxo_count: 7,
      max_tx_cpu_percent: 90,
      max_tx_mem_percent: 80,
      distinct_7_opt_in: {
        request_parameter: "maxUtxos",
        request_value: 7,
        require_explicit_request: false,
        require_measured_execution_units: false,
      },
    };

    expect(errorFields(manifest)).toContain("batching.distinct_7_opt_in.require_explicit_request");
    expect(errorFields(manifest)).toContain("batching.distinct_7_opt_in.require_measured_execution_units");
  });

  it("rejects missing or unsupported proof-slot metadata", () => {
    const manifest = statementBoundV2Manifest();
    delete manifest.reclaim_global.proof_slot_encoding;
    expect(errorFields(manifest)).toContain("reclaim_global.proof_slot_encoding");
    manifest.reclaim_global.proof_slot_encoding = "unsupported";
    expect(errorFields(manifest)).toContain("reclaim_global.proof_slot_encoding");
  });
});

function publicManifest() {
  return JSON.parse(readFileSync(publicManifestPath, "utf8"));
}

function statementBoundV2Manifest() {
  const manifest = publicManifest();
  manifest.reclaim_global.proof_slot_encoding =
    "full-proof-plus-public-input-digest-v2";
  manifest.reclaim_global.batch_transcript_vk_hash =
    manifest.proof.cardano_vk_blake2b256;
  manifest.batching = {
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
  };
  return manifest;
}

function errorFields(manifest) {
  return validateReclaimManifest(manifest).map((error) => error.field);
}
