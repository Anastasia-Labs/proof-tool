import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { blake2b } from "@noble/hashes/blake2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import { destinationPublicInputDigest } from "./stage2g-v2-evaluate.mjs";
import {
  Stage2gV2MaterialError,
  assertMaterialGenerationGate,
  generateStage2gV2Material,
  loadSafeDestination,
} from "./stage2g-v2-material.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("Stage 2g V2 material generator", () => {
  it("passes only public paths and destination data to Go, then emits a redacted local-only summary", async () => {
    const repoRoot = tempDir();
    const walletPath = path.join(repoRoot, "wallets.json");
    const keysDir = path.join(repoRoot, "keys");
    const trustedManifestPublicKeyPath = path.join(repoRoot, "trusted-manifest-public-key.hex");
    const materialPath = path.join(repoRoot, "output", "preprod-e2e", "stage2g-v2", "material.json");
    const wallet = walletFile();
    writeFileSync(walletPath, JSON.stringify(wallet), { mode: 0o600 });
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    writeFileSync(trustedManifestPublicKeyPath, "ab".repeat(32), { mode: 0o600 });
    const destination = loadSafeDestination(walletPath);
    const material = benchmarkMaterial(destination);
    const log = vi.fn();
    const execFile = vi.fn(async (_command, args) => {
      const outputIndex = args.indexOf("--out") + 1;
      const outputPath = path.resolve(repoRoot, args[outputIndex]);
      mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      writeFileSync(outputPath, JSON.stringify(material), { mode: 0o600 });
      return { stdout: "", stderr: "" };
    });

    const result = await generateStage2gV2Material({
      env: gates({
        PREPROD_TEST_WALLETS_FILE: "wallets.json",
        RECLAIM_E2E_STAGE2G_V2_KEYS_DIR: "keys",
        RECLAIM_E2E_STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE: "trusted-manifest-public-key.hex",
        RECLAIM_E2E_STAGE2G_V2_SIGNATURE_KEY_ID: "preprod-stage2g-v2-release-signer",
        RECLAIM_E2E_STAGE2G_V2_MATERIAL_FILE: "output/preprod-e2e/stage2g-v2/material.json",
      }),
      repoRoot,
      execFile,
      log,
    });

    expect(result.ok).toBe(true);
    const args = execFile.mock.calls[0][1];
    expect(args).toContain("generate-stage2g-v2-material");
    expect(args).toContain(walletPath);
    expect(args).toContain(keysDir);
    expect(args).toContain(trustedManifestPublicKeyPath);
    expect(args).toContain("preprod-stage2g-v2-release-signer");
    expect(args).toEqual(
      expect.arrayContaining([
        "--manifest-public-key-file",
        trustedManifestPublicKeyPath,
        "--signature-key-id",
        "preprod-stage2g-v2-release-signer",
      ]),
    );
    expect(args).toContain(destination.address);
    expect(args).toContain(destination.addressV1);
    expect(args).toContain(path.join("output", "preprod-e2e", "stage2g-v2", "material.json"));
    expect(args).not.toContain(materialPath);
    expect(JSON.stringify(args)).not.toContain(wallet.wallets.compromised_user.mnemonic);
    expect(JSON.stringify(args)).not.toMatch(/master.?xprv|seed.?phrase/i);
    const logged = JSON.parse(log.mock.calls[0][0]);
    expect(logged.entries).toBe(7);
    const serializedLog = JSON.stringify(logged);
    expect(serializedLog).not.toContain(wallet.wallets.compromised_user.mnemonic);
    expect(serializedLog).not.toContain(material.entries[0].proof_hex);
    expect(serializedLog).not.toContain(material.entries[0].credential);
  });

  it("requires an independently supplied manifest trust identity before executing Go", async () => {
    const repoRoot = tempDir();
    const walletPath = path.join(repoRoot, "wallets.json");
    const keysDir = path.join(repoRoot, "keys");
    const trustedManifestPublicKeyPath = path.join(repoRoot, "trusted-manifest-public-key.hex");
    writeFileSync(walletPath, JSON.stringify(walletFile()), { mode: 0o600 });
    writeFileSync(trustedManifestPublicKeyPath, "ab".repeat(32), { mode: 0o600 });
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    const execFile = vi.fn();

    await expect(
      generateStage2gV2Material({
        env: gates({
          PREPROD_TEST_WALLETS_FILE: "wallets.json",
          RECLAIM_E2E_STAGE2G_V2_KEYS_DIR: "keys",
          RECLAIM_E2E_STAGE2G_V2_SIGNATURE_KEY_ID: "preprod-stage2g-v2-release-signer",
        }),
        repoRoot,
        execFile,
      }),
    ).rejects.toBeInstanceOf(Stage2gV2MaterialError);
    await expect(
      generateStage2gV2Material({
        env: gates({
          PREPROD_TEST_WALLETS_FILE: "wallets.json",
          RECLAIM_E2E_STAGE2G_V2_KEYS_DIR: "keys",
          RECLAIM_E2E_STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE: "trusted-manifest-public-key.hex",
        }),
        repoRoot,
        execFile,
      }),
    ).rejects.toBeInstanceOf(Stage2gV2MaterialError);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects an existing intermediate material-output symlink before executing Go", async () => {
    const repoRoot = tempDir();
    const walletPath = path.join(repoRoot, "wallets.json");
    const keysDir = path.join(repoRoot, "keys");
    const trustedManifestPublicKeyPath = path.join(repoRoot, "trusted-manifest-public-key.hex");
    const stageRoot = path.join(repoRoot, "output", "preprod-e2e", "stage2g-v2");
    const escapedDirectory = path.join(repoRoot, "outside-stage2g-root");
    writeFileSync(walletPath, JSON.stringify(walletFile()), { mode: 0o600 });
    writeFileSync(trustedManifestPublicKeyPath, "ab".repeat(32), { mode: 0o600 });
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
    mkdirSync(escapedDirectory, { recursive: true, mode: 0o700 });
    symlinkSync(escapedDirectory, path.join(stageRoot, "redirect"), "dir");
    const execFile = vi.fn();

    await expect(
      generateStage2gV2Material({
        env: gates({
          PREPROD_TEST_WALLETS_FILE: "wallets.json",
          RECLAIM_E2E_STAGE2G_V2_KEYS_DIR: "keys",
          RECLAIM_E2E_STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE: "trusted-manifest-public-key.hex",
          RECLAIM_E2E_STAGE2G_V2_SIGNATURE_KEY_ID: "preprod-stage2g-v2-release-signer",
          RECLAIM_E2E_STAGE2G_V2_MATERIAL_FILE: "output/preprod-e2e/stage2g-v2/redirect/material.json",
        }),
        repoRoot,
        execFile,
      }),
    ).rejects.toMatchObject({ code: "stage2g_material_path_unsafe" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects submission mode before accessing local secrets", () => {
    expect(() => assertMaterialGenerationGate({ ...gates(), RECLAIM_E2E_SUBMIT_TRANSACTIONS: "1" })).toThrow(Stage2gV2MaterialError);
    expect(() => assertMaterialGenerationGate({ RECLAIM_E2E_LIVE_PREPROD: "1" })).toThrowError(
      expect.objectContaining({ code: "stage2g_material_gate_missing" }),
    );
  });
});

function gates(overrides = {}) {
  return {
    RECLAIM_E2E_LIVE_PREPROD: "1",
    RECLAIM_E2E_STAGE2G_V2_MATERIAL: "1",
    ...overrides,
  };
}

function walletFile() {
  return {
    schema: "proof-tool-preprod-test-wallets-v1",
    network: "Preprod",
    wallets: {
      deployer: { mnemonic: "drip announce dwarf dose culture friend nasty large foam boy estate fault scan bar banner index swarm nut horse law sick swift cherry enough" },
      reclaim_funder: { mnemonic: "fix kite shoot check image divert armor receive long mind meat version grid robot green crucial couple object curtain soft scorpion main discover return" },
      compromised_user: { mnemonic: "enrich next used cinnamon rug warrior maid maple grocery video remind program govern fat journey abuse fish thunder capital smoke ensure crater firm column" },
      safe_claim_destination: { mnemonic: "current salt affair theory oil acoustic fun evidence present dose cook bicycle warrior arch real pluck surprise dice enlist same echo pulp tooth record" },
    },
  };
}

function benchmarkMaterial(destination) {
  const cardanoVkHex = "cd".repeat(672);
  const cardanoVkHash = Buffer.from(blake2b(hexToBytes(cardanoVkHex), { dkLen: 32 })).toString("hex");
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
      address: destination.address,
      lovelace: "3000000",
    },
    bootstrap: {
      address: destination.address,
      utxos: [
        { tx_hash: "03".repeat(32), output_index: 0, lovelace: "50000000" },
        { tx_hash: "04".repeat(32), output_index: 0, lovelace: "50000000" },
      ],
    },
    entries: Array.from({ length: 7 }, (_, index) => {
      const credential = `${(index + 1).toString(16).padStart(2, "0")}${"ab".repeat(27)}`;
      return {
        tx_hash: `${(index + 1).toString(16)}`.repeat(64),
        output_index: index,
        credential,
        proof_hex: `${(index + 1).toString(16).padStart(2, "0")}`.repeat(336),
        public_input_digest_hex: destinationPublicInputDigest(credential, destination.addressV1),
        destination_address: destination.address,
        value: { lovelace: "3000000" },
      };
    }),
  };
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-stage2g-material-"));
  tempDirs.push(dir);
  return dir;
}
