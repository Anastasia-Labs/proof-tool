import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertReclaimGlobalProofSlotEncoding,
  buildManifest,
  deployReclaimPreprod,
  prepareDestinationKeys,
  reclaimGlobalExportArgs,
} from "./deploy-reclaim-preprod.mjs";

const POLICY_ID = "ab".repeat(28);
const VERIFIER_KEY = "cd".repeat(672);
const RECLAIM_PARAMS_TOKEN_NAME = "5245434c41494d504152414d53";
const MANIFEST_PUBLIC_KEY_FILE_ENV = "RECLAIM_E2E_STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE";
const SIGNATURE_KEY_ID_ENV = "RECLAIM_E2E_STAGE2G_V2_SIGNATURE_KEY_ID";
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("reclaim script exporter invocation", () => {
  it("passes canonical key bytes and their hash to the statement-bound V2 exporter", () => {
    const cardanoVkHash = "ef".repeat(32);
    expect(reclaimGlobalExportArgs("global-v2", POLICY_ID, VERIFIER_KEY, cardanoVkHash)).toEqual([
      "global-v2",
      POLICY_ID,
      RECLAIM_PARAMS_TOKEN_NAME,
      VERIFIER_KEY,
      cardanoVkHash,
    ]);
  });

  it("uses the same policy/name/VK ordering for the multi global exporter", () => {
    expect(reclaimGlobalExportArgs("global-multi", POLICY_ID, VERIFIER_KEY)).toEqual([
      "global-multi",
      POLICY_ID,
      RECLAIM_PARAMS_TOKEN_NAME,
      VERIFIER_KEY,
    ]);
  });

  it("rejects unrelated exporter modes", () => {
    expect(() => reclaimGlobalExportArgs("base", POLICY_ID, VERIFIER_KEY)).toThrow(/unsupported reclaim global export mode/u);
  });

  it.each([
    [undefined, "statement-bound-v2", `blake2b256:${"11".repeat(32)}`],
    ["ambiguous-marker-v0", "statement-bound-v2", `blake2b256:${"11".repeat(32)}`],
    ["full-proof-plus-public-input-digest-v2", "v1", `blake2b256:${"11".repeat(32)}`],
    ["full-proof-plus-public-input-digest-v2", "statement-bound-v2", `blake2b256:${"ff".repeat(32)}`],
  ])(
    "rejects missing or mismatched V2 export metadata",
    (proofSlotEncoding, batchTranscript, exportedVerifierVkHash) => {
      expect(() =>
        assertReclaimGlobalProofSlotEncoding(
          proofSlotEncoding,
          batchTranscript,
          exportedVerifierVkHash,
          `blake2b256:${"11".repeat(32)}`,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "reclaim_global_proof_slot_encoding",
        }),
      );
    },
  );

  it("propagates statement-bound V2 key coherence and the explicit seven-slot capacity policy", () => {
    const manifest = buildManifest({
      sourceCommit: "12".repeat(20),
      baseAddress: "addr_test1_base",
      baseScriptHash: "34".repeat(28),
      globalScriptHash: "56".repeat(28),
      globalRewardAddress: "stake_test1_global",
      holderScriptHash: "78".repeat(28),
      paramsPolicyId: "9a".repeat(28),
      paramsUnit: `${"9a".repeat(28)}${RECLAIM_PARAMS_TOKEN_NAME}`,
      paramsOutRef: {
        tx_hash: "bc".repeat(32),
        output_index: 0,
        holder_address: "addr_test1_holder",
      },
      referenceBase: { tx_hash: "de".repeat(32), output_index: 1 },
      referenceGlobal: { tx_hash: "f0".repeat(32), output_index: 2 },
      destination: {
        vkHash: `blake2b256:${"11".repeat(32)}`,
        cardanoVkBlake2b256: `blake2b256:${"22".repeat(32)}`,
      },
      providerName: "blockfrost",
      globalRewardAccountRegistered: false,
    });

    expect(manifest.reclaim_global.proof_slot_encoding).toBe(
      "full-proof-plus-public-input-digest-v2",
    );
    expect(manifest.reclaim_global.batch_transcript_vk_hash).toBe(
      `blake2b256:${"22".repeat(32)}`,
    );
    expect(manifest.batching).toEqual({
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
    });
  });
});

describe("destination key-bundle trust anchor", () => {
  it("verifies destination trust before resolving or reading the deployer wallet", async () => {
    const repoRoot = tempDir();
    const events = [];
    const trustFailure = new Error("signed destination bundle rejected");
    const assertCleanPushedSourceFn = vi.fn(async () => {
      events.push("source");
      return { commit: "12".repeat(20) };
    });
    const prepareDestinationKeysFn = vi.fn(async () => {
      events.push("trust");
      throw trustFailure;
    });
    const loadWalletFileFn = vi.fn(() => {
      events.push("wallet");
      throw new Error("wallet must not be read");
    });

    await expect(
      deployReclaimPreprod({
        repoRoot,
        env: {
          RECLAIM_E2E_LIVE_PREPROD: "1",
          RECLAIM_E2E_SUBMIT_TRANSACTIONS: "1",
          RECLAIM_NETWORK: "Preprod",
          RECLAIM_NETWORK_ID: "0",
        },
        assertCleanPushedSourceFn,
        prepareDestinationKeysFn,
        loadWalletFileFn,
      }),
    ).rejects.toBe(trustFailure);

    expect(events).toEqual(["source", "trust"]);
    expect(prepareDestinationKeysFn).toHaveBeenCalledWith({
      env: expect.objectContaining({ RECLAIM_NETWORK: "Preprod" }),
      repoRoot,
      git: { commit: "12".repeat(20) },
    });
    expect(loadWalletFileFn).not.toHaveBeenCalled();
  });

  it("requires the external Stage 2g trust-anchor values before any key tool runs", async () => {
    const fixture = destinationFixture();
    const runGoFn = vi.fn();

    await expect(
      prepareDestinationKeys({
        env: fixture.env({ [MANIFEST_PUBLIC_KEY_FILE_ENV]: undefined }),
        repoRoot: fixture.repoRoot,
        git: {},
        runGoFn,
      }),
    ).rejects.toMatchObject({ code: "stage2g_manifest_public_key_missing" });
    await expect(
      prepareDestinationKeys({
        env: fixture.env({ [SIGNATURE_KEY_ID_ENV]: " " }),
        repoRoot: fixture.repoRoot,
        git: {},
        runGoFn,
      }),
    ).rejects.toMatchObject({ code: "stage2g_signature_key_id_missing" });

    expect(runGoFn).not.toHaveBeenCalled();
  });

  it("rejects a direct bundle-contained trust anchor before verification or key export", async () => {
    const fixture = destinationFixture();
    const runGoFn = vi.fn();

    await expect(
      prepareDestinationKeys({
        env: fixture.env({
          [MANIFEST_PUBLIC_KEY_FILE_ENV]: path.join("destination-keys", "manifest-public-key.hex"),
        }),
        repoRoot: fixture.repoRoot,
        git: {},
        runGoFn,
      }),
    ).rejects.toMatchObject({ code: "stage2g_manifest_public_key_not_external" });

    expect(runGoFn).not.toHaveBeenCalled();
  });

  it("rejects a symlink-contained trust anchor before verification or key export", async () => {
    const fixture = destinationFixture();
    const anchorRoot = path.join(fixture.repoRoot, "external-anchor-root");
    const symlinkedBundle = path.join(anchorRoot, "bundle-link");
    mkdirSync(anchorRoot, { recursive: true });
    symlinkSync(fixture.keysDir, symlinkedBundle, "dir");
    const runGoFn = vi.fn();

    await expect(
      prepareDestinationKeys({
        env: fixture.env({
          [MANIFEST_PUBLIC_KEY_FILE_ENV]: path.join("external-anchor-root", "bundle-link", "manifest-public-key.hex"),
        }),
        repoRoot: fixture.repoRoot,
        git: {},
        runGoFn,
      }),
    ).rejects.toMatchObject({ code: "stage2g_manifest_public_key_not_external" });

    expect(runGoFn).not.toHaveBeenCalled();
  });

  it("fails closed when specialized verification rejects a direct-symlink trust anchor", async () => {
    const fixture = destinationFixture();
    const directSymlink = path.join(fixture.repoRoot, "trusted-manifest-public-key-link.hex");
    symlinkSync(fixture.manifestPublicKeyFile, directSymlink, "file");
    const rawFailure = `direct symlink ${directSymlink} exposes ${fixture.manifestPublicKeyContents}`;
    const runGoFn = failingTrustVerificationRunner(rawFailure);

    await expect(
      prepareDestinationKeys({
        env: fixture.env({ [MANIFEST_PUBLIC_KEY_FILE_ENV]: path.basename(directSymlink) }),
        repoRoot: fixture.repoRoot,
        git: {},
        runGoFn,
      }),
    ).rejects.toMatchObject({
      code: "destination_key_bundle_trust_verification_failed",
      message: "Destination key bundle trust verification failed.",
    });

    expect(runGoFn).toHaveBeenCalledTimes(1);
    expect(runGoFn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["verify-stage2g-v2-key-bundle", "--manifest-public-key-file", directSymlink]),
    );
    expect(runGoFn.mock.calls[0][1]).not.toContain("export-cardano-vk");
  });

  it("fails closed when specialized verification rejects a hard-linked bundle anchor", async () => {
    const fixture = destinationFixture();
    const hardLinkedAnchor = path.join(fixture.repoRoot, "trusted-manifest-public-key-hard-link.hex");
    linkSync(path.join(fixture.keysDir, "manifest-public-key.hex"), hardLinkedAnchor);
    const rawFailure = `hard link ${hardLinkedAnchor} exposes ${fixture.manifestPublicKeyContents}`;
    const runGoFn = failingTrustVerificationRunner(rawFailure);

    await expect(
      prepareDestinationKeys({
        env: fixture.env({ [MANIFEST_PUBLIC_KEY_FILE_ENV]: path.basename(hardLinkedAnchor) }),
        repoRoot: fixture.repoRoot,
        git: {},
        runGoFn,
      }),
    ).rejects.toMatchObject({
      code: "destination_key_bundle_trust_verification_failed",
      message: "Destination key bundle trust verification failed.",
    });

    expect(runGoFn).toHaveBeenCalledTimes(1);
    expect(runGoFn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["verify-stage2g-v2-key-bundle", "--manifest-public-key-file", hardLinkedAnchor]),
    );
    expect(runGoFn.mock.calls[0][1]).not.toContain("export-cardano-vk");
  });

  it("passes the resolved external anchor and key ID only to key-bundle verification without logging either", async () => {
    const fixture = destinationFixture();
    const runGoFn = successfulDestinationKeyRunner();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await prepareDestinationKeys({
      env: fixture.env(),
      repoRoot: fixture.repoRoot,
      git: {},
      runGoFn,
    });

    expect(runGoFn).toHaveBeenCalledTimes(2);
    expect(runGoFn.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "verify-stage2g-v2-key-bundle",
        "--manifest-public-key-file",
        fixture.manifestPublicKeyFile,
        "--signature-key-id",
        fixture.signatureKeyID,
      ]),
    );
    expect(runGoFn.mock.calls[0][1]).not.toContain("verify-key-bundle");
    expect(runGoFn.mock.calls[0][1]).not.toContain("--key-version");
    expect(runGoFn.mock.calls[1][1]).toContain("export-cardano-vk");
    expect(JSON.stringify(result)).not.toContain(fixture.manifestPublicKeyFile);
    expect(JSON.stringify(result)).not.toContain(fixture.signatureKeyID);
    expect(JSON.stringify(result)).not.toContain(fixture.manifestPublicKeyContents);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("fails closed on a mismatched signer ID without exporting keys or leaking trust-anchor details", async () => {
    const fixture = destinationFixture();
    const wrongSignatureKeyID = "wrong-stage2g-release-signer";
    const rawFailure = `signature key ${wrongSignatureKeyID} rejected for ${fixture.manifestPublicKeyFile}: ${fixture.manifestPublicKeyContents}`;
    const runGoFn = vi.fn(async () => {
      throw new Error(rawFailure);
    });

    let failure;
    try {
      await prepareDestinationKeys({
        env: fixture.env({ [SIGNATURE_KEY_ID_ENV]: wrongSignatureKeyID }),
        repoRoot: fixture.repoRoot,
        git: {},
        runGoFn,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "destination_key_bundle_trust_verification_failed",
      message: "Destination key bundle trust verification failed.",
    });
    expect(failure.message).not.toContain(wrongSignatureKeyID);
    expect(failure.message).not.toContain(fixture.manifestPublicKeyFile);
    expect(failure.message).not.toContain(fixture.manifestPublicKeyContents);
    expect(runGoFn).toHaveBeenCalledTimes(1);
    expect(runGoFn.mock.calls[0][1]).toEqual(expect.arrayContaining(["--signature-key-id", wrongSignatureKeyID]));
  });
});

function destinationFixture() {
  const repoRoot = tempDir();
  const keysDir = path.join(repoRoot, "destination-keys");
  const manifestPublicKeyFile = path.join(repoRoot, "trusted-stage2g-manifest-public-key.hex");
  const manifestPublicKeyContents = "ab".repeat(32);
  const signatureKeyID = "preprod-stage2g-v2-release-signer";
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(path.join(keysDir, "manifest.json"), JSON.stringify({ vk_hash: `blake2b256:${"11".repeat(32)}` }));
  for (const fileName of ["ownership.pk", "ownership.vk", "manifest.sig", "manifest-public-key.hex"]) {
    writeFileSync(path.join(keysDir, fileName), "fixture");
  }
  writeFileSync(manifestPublicKeyFile, manifestPublicKeyContents);
  return {
    repoRoot,
    keysDir,
    manifestPublicKeyFile,
    manifestPublicKeyContents,
    signatureKeyID,
    env(overrides = {}) {
      return {
        RECLAIM_DESTINATION_KEYS_DIR: "destination-keys",
        [MANIFEST_PUBLIC_KEY_FILE_ENV]: "trusted-stage2g-manifest-public-key.hex",
        [SIGNATURE_KEY_ID_ENV]: signatureKeyID,
        ...overrides,
      };
    },
  };
}

function successfulDestinationKeyRunner() {
  return vi.fn(async (_repoRoot, args) => {
    if (args.includes("export-cardano-vk")) {
      const outputPath = args[args.indexOf("--out") + 1];
      writeFileSync(outputPath, "cd".repeat(672));
      return { stdout: `cardano_vk_blake2b256: blake2b256:${"ef".repeat(32)}\n` };
    }
    return { stdout: "verified key bundle\n" };
  });
}

function failingTrustVerificationRunner(message) {
  return vi.fn(async () => {
    throw new Error(message);
  });
}

function tempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), "proof-tool-deploy-reclaim-"));
  tempDirs.push(directory);
  return directory;
}
