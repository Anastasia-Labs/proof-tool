import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESTINATION_ADDRESS_ENCODING,
  DESTINATION_CIRCUIT_ID,
  DESTINATION_KEY_VERSION,
  RECLAIM_DEPLOYMENT_SCHEMA,
  loadClaimDeployment,
  loadReclaimDeployment,
  validateReclaimDeploymentManifest,
  type ReclaimDeploymentManifest,
} from "./manifest";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe("reclaim deployment manifest validation", () => {
  it("accepts a coherent destination-bound preprod manifest", () => {
    const result = validateReclaimDeploymentManifest(validManifest());

    expect(result.available).toBe(true);
    if (!result.available) {
      throw new Error("expected manifest to validate");
    }
    expect(result.manifest.deployment_id).toBe(`preprod:${hash56("a")}:abcdef1234567890`);
  });

  it("disables readiness for the wrong network id", () => {
    const result = validateReclaimDeploymentManifest({
      ...validManifest(),
      network_id: 1,
    });

    expect(errorCodes(result)).toContain("network_id_mismatch");
  });

  it("disables readiness for the wrong global credential", () => {
    const manifest = validManifest();
    manifest.reclaim_base.required_global_credential = hash56("9");

    expect(errorCodes(validateReclaimDeploymentManifest(manifest))).toContain("global_credential_mismatch");
  });

  it("disables readiness for a verifier hash/proof mismatch", () => {
    const manifest = validManifest();
    manifest.proof.vk_hash = prefixedHash("9");

    expect(errorCodes(validateReclaimDeploymentManifest(manifest))).toContain("verifier_hash_mismatch");
  });

  it("disables readiness for the wrong params datum script hash", () => {
    const manifest = validManifest();
    manifest.params_utxo.datum_reclaim_base_script_hash = hash56("9");

    expect(errorCodes(validateReclaimDeploymentManifest(manifest))).toContain("params_datum_base_hash_mismatch");
  });

  it("disables readiness when the params UTxO outref is missing", () => {
    const manifest = clone(validManifest()) as Record<string, unknown>;
    delete (manifest.params_utxo as Record<string, unknown>).tx_hash;

    const result = validateReclaimDeploymentManifest(manifest);

    expect(errorCodes(result)).toContain("missing");
    expect(errorFields(result)).toContain("params_utxo.tx_hash");
  });

  it("disables readiness for malformed script hashes", () => {
    const manifest = validManifest();
    manifest.reclaim_global.script_hash = "not-a-script-hash";

    const result = validateReclaimDeploymentManifest(manifest);

    expect(errorCodes(result)).toContain("malformed_hex");
    expect(errorFields(result)).toContain("reclaim_global.script_hash");
  });

  it("returns a disabled state when no manifest source is configured", () => {
    const result = loadReclaimDeployment({ env: {} });

    expect(result.available).toBe(false);
    expect(result.deployment).toBeNull();
    expect(result.readiness).toEqual({
      funding: false,
      claiming: false,
      reasons: ["manifest_missing"],
    });
  });

  it("loads a coherent flat RECLAIM env deployment", () => {
    const result = loadReclaimDeployment({ env: envFromManifest(validManifest()) });

    expect(result.available).toBe(true);
    if (!result.available) {
      throw new Error("expected flat env manifest to validate");
    }
    expect(result.deployment.id).toBe(`preprod:${hash56("a")}:abcdef1234567890`);
    expect(result.deployment.paramsUtxo?.tx_hash).toBe(hash64("f"));
  });

  it("disables readiness when RECLAIM env fields disagree with the JSON manifest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-reclaim-manifest-"));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(validManifest()), "utf8");

    const result = loadReclaimDeployment({
      env: {
        RECLAIM_DEPLOYMENT_MANIFEST_PATH: manifestPath,
        RECLAIM_NETWORK: "Mainnet",
      },
    });

    expect(result.available).toBe(false);
    expect(errorCodes(result)).toContain("env_manifest_mismatch");
    expect(errorFields(result)).toContain("RECLAIM_NETWORK");
  });

  it("returns claim deployment capability flags from the same manifest", () => {
    const result = loadClaimDeployment({ env: envFromManifest(validManifest()) });

    expect(result.available).toBe(true);
    if (!result.available) {
      throw new Error("expected claim deployment to validate");
    }
    expect(result.capabilities).toMatchObject({
      proofProfile: "single-destination",
      helperKeyVersion: "ownership-destination-v1",
      destinationAddressEncoding: "destination-address-v1",
      indexerStatus: "not_configured",
      singleGlobalCompatible: true,
    });
  });
});

function validManifest(): ReclaimDeploymentManifest {
  const baseScriptHash = hash56("a");
  const sourceCommit = "abcdef1234567890";
  const globalCredential = hash56("b");
  const paramsPolicy = hash56("d");
  const verifierHash = prefixedHash("e");

  return {
    schema: RECLAIM_DEPLOYMENT_SCHEMA,
    deployment_id: `preprod:${baseScriptHash}:${sourceCommit}`,
    network: "Preprod",
    network_id: 0,
    source_commit: sourceCommit,
    contract_version: "v1.0.0-preprod",
    reclaim_base: {
      address: "addr_test1wreclaimbase00000000000000000000000000000000000000000",
      script_hash: baseScriptHash,
      required_global_credential: globalCredential,
    },
    reclaim_global: {
      script_hash: hash56("c"),
      rewarding_credential: globalCredential,
      params_currency_symbol: paramsPolicy,
      verifier_vk_hash: verifierHash,
      proof_profile: "single-destination",
    },
    params_utxo: {
      tx_hash: hash64("f"),
      output_index: 0,
      policy_id: paramsPolicy,
      token_name: "5245434c41494d",
      holder_address: "addr_test1wparamholder00000000000000000000000000000000000000000",
      datum_reclaim_base_script_hash: baseScriptHash,
    },
    proof: {
      circuit_id: DESTINATION_CIRCUIT_ID,
      key_version: DESTINATION_KEY_VERSION,
      destination_address_encoding: DESTINATION_ADDRESS_ENCODING,
      vk_hash: verifierHash,
      cardano_vk_blake2b256: prefixedHash("1"),
    },
    batching: {
      default_utxo_count: 4,
      optimization_utxo_count: 5,
      hard_max_utxo_count: 5,
      max_tx_cpu_percent: 80,
      max_tx_mem_percent: 80,
    },
    provider: {
      primary: "koios",
      fallback: "blockfrost",
    },
  };
}

function envFromManifest(manifest: ReclaimDeploymentManifest): Record<string, string> {
  return {
    RECLAIM_DEPLOYMENT_ID: manifest.deployment_id,
    RECLAIM_NETWORK: manifest.network,
    RECLAIM_NETWORK_ID: String(manifest.network_id),
    RECLAIM_SOURCE_COMMIT: manifest.source_commit,
    RECLAIM_CONTRACT_VERSION: manifest.contract_version,
    RECLAIM_BASE_ADDRESS: manifest.reclaim_base.address,
    RECLAIM_BASE_SCRIPT_HASH: manifest.reclaim_base.script_hash,
    RECLAIM_BASE_REQUIRED_GLOBAL_CREDENTIAL: manifest.reclaim_base.required_global_credential,
    RECLAIM_GLOBAL_CREDENTIAL: manifest.reclaim_global.rewarding_credential,
    RECLAIM_GLOBAL_SCRIPT_HASH: manifest.reclaim_global.script_hash,
    RECLAIM_PARAMS_CURRENCY_SYMBOL: manifest.reclaim_global.params_currency_symbol,
    RECLAIM_PARAMS_TOKEN_NAME: manifest.params_utxo.token_name,
    RECLAIM_PARAMS_UTXO_TX_HASH: manifest.params_utxo.tx_hash,
    RECLAIM_PARAMS_UTXO_OUTPUT_INDEX: String(manifest.params_utxo.output_index),
    RECLAIM_PARAMS_POLICY_ID: manifest.params_utxo.policy_id,
    RECLAIM_PARAMS_HOLDER_ADDRESS: manifest.params_utxo.holder_address,
    RECLAIM_PARAMS_DATUM_RECLAIM_BASE_SCRIPT_HASH: manifest.params_utxo.datum_reclaim_base_script_hash,
    RECLAIM_VERIFIER_VK_HASH: manifest.reclaim_global.verifier_vk_hash,
    RECLAIM_PROOF_VK_HASH: manifest.proof.vk_hash,
    RECLAIM_PROOF_CARDANO_VK_BLAKE2B256: manifest.proof.cardano_vk_blake2b256,
    RECLAIM_PROOF_CIRCUIT_ID: manifest.proof.circuit_id,
    RECLAIM_PROOF_KEY_VERSION: manifest.proof.key_version,
    RECLAIM_DESTINATION_ADDRESS_ENCODING: manifest.proof.destination_address_encoding,
    RECLAIM_DEFAULT_UTXO_COUNT: String(manifest.batching.default_utxo_count),
    RECLAIM_OPTIMIZATION_UTXO_COUNT: String(manifest.batching.optimization_utxo_count),
    RECLAIM_HARD_MAX_UTXO_COUNT: String(manifest.batching.hard_max_utxo_count),
    RECLAIM_MAX_TX_CPU_PERCENT: String(manifest.batching.max_tx_cpu_percent),
    RECLAIM_MAX_TX_MEM_PERCENT: String(manifest.batching.max_tx_mem_percent),
    RECLAIM_PROVIDER: manifest.provider.primary,
    RECLAIM_PROVIDER_FALLBACK: manifest.provider.fallback,
  };
}

function errorCodes(result: { available: boolean; errors: Array<{ code: string }> }): string[] {
  expect(result.available).toBe(false);
  return result.errors.map((error) => error.code);
}

function errorFields(result: { available: boolean; errors: Array<{ field: string }> }): string[] {
  expect(result.available).toBe(false);
  return result.errors.map((error) => error.field);
}

function hash56(char: string): string {
  return char.repeat(56);
}

function hash64(char: string): string {
  return char.repeat(64);
}

function prefixedHash(char: string): string {
  return `blake2b256:${hash64(char)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
