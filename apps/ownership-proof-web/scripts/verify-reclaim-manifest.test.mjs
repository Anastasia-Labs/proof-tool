import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const verifierPath = path.join(__dirname, "verify-reclaim-manifest.mjs");
const publicManifestPath = path.join(
  repoRoot,
  "apps",
  "ownership-proof-web",
  "public",
  "proof-assets",
  "reclaim-deployment.json",
);
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("verify-reclaim-manifest V2 coherence", () => {
  it("accepts matched statement-bound V2 metadata", async () => {
    const manifest = statementBoundV2Manifest();
    manifest.reclaim_global.proof_slot_encoding =
      "full-proof-plus-public-input-digest-v2";
    manifest.reclaim_global.batch_transcript_vk_hash =
      manifest.proof.cardano_vk_blake2b256;

    const { stdout } = await verify(manifest);
    const result = JSON.parse(stdout);
    expect(result.proof_slot_encoding).toBe(
      "full-proof-plus-public-input-digest-v2",
    );
  });

  it("rejects a mismatched V2 transcript verifier-key hash", async () => {
    const manifest = publicManifest();
    manifest.reclaim_global.proof_slot_encoding =
      "full-proof-plus-public-input-digest-v2";
    manifest.reclaim_global.batch_transcript_vk_hash =
      "blake2b256:" + "00".repeat(32);

    await expect(verify(manifest)).rejects.toMatchObject({
      stderr: expect.stringContaining("reclaim_global.batch_transcript_vk_hash"),
    });
  });

  it("accepts the explicit distinct-7 V2 capacity policy", async () => {
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

    const { stdout } = await verify(manifest);
    expect(JSON.parse(stdout).distinct_7_opt_in).toEqual(
      manifest.batching.distinct_7_opt_in,
    );
  });

  it("rejects an automatic or unevaluated distinct-7 V2 batch", async () => {
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

    await expect(verify(manifest)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "batching.distinct_7_opt_in.require_explicit_request",
      ),
    });
  });

  it("keeps non-V2 manifests with higher historical capacity valid", async () => {
    const manifest = publicManifest();
    manifest.batching.hard_max_utxo_count = 35;

    await expect(verify(manifest)).resolves.toMatchObject({});
  });

  it("rejects distinct-7 opt-in metadata on a non-V2 profile", async () => {
    const manifest = publicManifest();
    manifest.batching.distinct_7_opt_in = {
      request_parameter: "maxUtxos",
      request_value: 7,
      require_explicit_request: true,
      require_measured_execution_units: true,
    };

    await expect(verify(manifest)).rejects.toMatchObject({
      stderr: expect.stringContaining("batching.distinct_7_opt_in"),
    });
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

async function verify(manifest) {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-v2-manifest-"));
  tempDirs.push(dir);
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  return execFileAsync(process.execPath, [verifierPath, manifestPath], {
    cwd: repoRoot,
  });
}
