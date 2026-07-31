import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blake2b } from "@noble/hashes/blake2b";
import {
  assertProductionDecisionRecordBinding,
  buildPreparationArtifacts,
  inspectMPCRelease,
  prepareReclaimMainnet,
  validatePreparationOptions,
} from "./prepare-reclaim-mainnet.mjs";
import { validateReclaimManifest } from "../../scripts/verify-reclaim-manifest.mjs";

const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("Mainnet deployment preparation guards", () => {
  it.each([
    [{ dryRun: false, network: "Mainnet", networkId: 1 }, "dry_run_required"],
    [{ dryRun: true, network: "Preprod", networkId: 1 }, "mainnet_identity_required"],
    [{ dryRun: true, network: "Mainnet", networkId: 0 }, "mainnet_identity_required"],
  ])("rejects missing dry-run or exact Mainnet identity before touching files", (options, code) => {
    expect(() => validatePreparationOptions(options, "/does/not/matter")).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects an existing output directory", () => {
    const fixture = optionFixture();
    mkdirSync(fixture.options.outDir);

    expect(() => validatePreparationOptions(fixture.options, fixture.root)).toThrowError(
      expect.objectContaining({ code: "output_exists" }),
    );
  });

  it("stops on exact MPC release verification failure before export, decision verification, or output", async () => {
    const fixture = optionFixture();
    const events = [];

    await expect(
      prepareReclaimMainnet({
        ...fixture.options,
        repoRoot: fixture.root,
        assertCleanSignedSourceFn: vi.fn(async () => {
          events.push("source");
          return { commit: "11".repeat(20), signedTag: fixture.options.sourceSignedTag };
        }),
        verifyMPCReleaseFn: vi.fn(async () => {
          events.push("release");
          throw new Error("tampered release");
        }),
        inspectMPCReleaseFn: vi.fn(() => events.push("inspect")),
        exportScriptsFn: vi.fn(() => events.push("export")),
        verifyProductionDecisionFn: vi.fn(() => events.push("decision")),
        publishFn: vi.fn(() => events.push("publish")),
      }),
    ).rejects.toThrow(/tampered release/u);

    expect(events).toEqual(["source", "release"]);
    expect(existsSync(fixture.options.outDir)).toBe(false);
  });

  it("publishes only the disabled template and dry-run plan after two exact release verifications", async () => {
    const options = optionFixture();
    const release = releaseFixture();
    const verifyMPCReleaseFn = vi.fn(async () => ({ ceremonyID: release.ceremonyID }));
    const preparation = await prepareReclaimMainnet({
      ...options.options,
      ceremonyPath: release.expectations.ceremonyPath,
      releaseDir: release.expectations.releaseDir,
      repoRoot: options.root,
      assertCleanSignedSourceFn: vi.fn(async () => ({
        commit: release.sourceCommit,
        signedTag: options.options.sourceSignedTag,
      })),
      verifyMPCReleaseFn,
      exportScriptsFn: vi.fn(async () => scriptFixture()),
      verifyProductionDecisionFn: vi.fn(async () => productionDecisionResult()),
    });

    expect(verifyMPCReleaseFn).toHaveBeenCalledTimes(2);
    expect(preparation).toMatchObject({
      ok: true,
      dryRun: true,
      network: "Mainnet",
      networkId: 1,
      submitted: false,
      unsigned: true,
    });
    expect(
      [path.basename(preparation.outputs.plan), path.basename(preparation.outputs.unsignedManifest)].sort(),
    ).toEqual(["deployment-plan.json", "reclaim-deployment.unsigned-template.json"]);
    const manifest = JSON.parse(readFileSync(preparation.outputs.unsignedManifest, "utf8"));
    expect(manifest.enabled).toBe(false);
    expect(manifest.params_utxo.tx_hash).toBeNull();
  });

  it("rejects public finalization evidence changed after release inspection", async () => {
    const options = optionFixture();
    const release = releaseFixture();
    const publicEvidencePath = path.join(release.expectations.releaseDir, "public-finalization-evidence.json");

    await expect(
      prepareReclaimMainnet({
        ...options.options,
        ceremonyPath: release.expectations.ceremonyPath,
        releaseDir: release.expectations.releaseDir,
        repoRoot: options.root,
        assertCleanSignedSourceFn: vi.fn(async () => ({
          commit: release.sourceCommit,
          signedTag: options.options.sourceSignedTag,
        })),
        verifyMPCReleaseFn: vi.fn(async () => ({ ceremonyID: release.ceremonyID })),
        exportScriptsFn: vi.fn(async () => {
          writeFileSync(publicEvidencePath, `${readFileSync(publicEvidencePath, "utf8")} `);
          return scriptFixture();
        }),
        verifyProductionDecisionFn: vi.fn(async () => productionDecisionResult()),
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "mpc_release_changed" }));

    expect(existsSync(options.options.outDir)).toBe(false);
  });
});

describe("MPC release key semantics", () => {
  it("keeps the native gnark VK hash separate from the Cardano wire-format VK hash", () => {
    const fixture = releaseFixture();
    const inspected = inspectMPCRelease(fixture.expectations);

    expect(inspected.nativeVKBlake2b256).toBe(fixture.nativeDigest.blake2b256);
    expect(inspected.cardanoVKBlake2b256).toBe(fixture.cardanoDigest.blake2b256);
    expect(inspected.nativeVKBlake2b256).not.toBe(inspected.cardanoVKBlake2b256);
  });

  it("rejects a release whose signed manifest substitutes the Cardano hash for the native VK hash", () => {
    const fixture = releaseFixture();
    const manifestPath = path.join(fixture.expectations.releaseDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.vk_hash = fixture.cardanoDigest.blake2b256;
    writeJSON(manifestPath, manifest);

    expect(() => inspectMPCRelease(fixture.expectations)).toThrowError(
      expect.objectContaining({ code: "coherence_mismatch" }),
    );
  });

  it("rejects a Cardano hex export that does not encode the signed 672-byte artifact", () => {
    const fixture = releaseFixture();
    writeFileSync(path.join(fixture.expectations.releaseDir, "cardano-vk.hex"), `${"00".repeat(672)}\n`);

    expect(() => inspectMPCRelease(fixture.expectations)).toThrowError(
      expect.objectContaining({ code: "cardano_vk_hex_mismatch" }),
    );
  });

  it.each([
    ["candidate.json", "schema", "proof-tool-mpc-release-candidate-v1"],
    ["verification-report.json", "schema", "proof-tool-mpc-verification-report-v1"],
  ])("rejects stale pre-public-evidence schema in %s", (filename, field, value) => {
    const fixture = releaseFixture();
    const file = path.join(fixture.expectations.releaseDir, filename);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record[field] = value;
    writeJSON(file, record);

    expect(() => inspectMPCRelease(fixture.expectations)).toThrowError(
      expect.objectContaining({ code: "coherence_mismatch" }),
    );
  });

  it("rejects a candidate that does not hash-bind the exact v2 report", () => {
    const fixture = releaseFixture();
    const file = path.join(fixture.expectations.releaseDir, "candidate.json");
    const candidate = JSON.parse(readFileSync(file, "utf8"));
    candidate.verification_report.digest.sha256 = `sha256:${"00".repeat(32)}`;
    writeJSON(file, candidate);

    expect(() => inspectMPCRelease(fixture.expectations)).toThrowError(
      expect.objectContaining({ code: "coherence_mismatch" }),
    );
  });

  it("rejects public evidence whose exact Cardano proof digest was substituted", () => {
    const fixture = releaseFixture();
    const evidencePath = path.join(fixture.expectations.releaseDir, "public-finalization-evidence.json");
    const candidatePath = path.join(fixture.expectations.releaseDir, "candidate.json");
    const reportPath = path.join(fixture.expectations.releaseDir, "verification-report.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    evidence.cardano_proof_hex = `${"7c".repeat(336)}`;
    const changedEvidenceBytes = writeJSON(evidencePath, evidence);
    const changedEvidenceDigest = artifactDigest(changedEvidenceBytes);
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
    candidate.public_finalization_evidence.digest = changedEvidenceDigest;
    writeJSON(candidatePath, candidate);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.public_evidence.digest = changedEvidenceDigest;
    const changedReportBytes = writeJSON(reportPath, report);
    candidate.verification_report.digest = artifactDigest(changedReportBytes);
    writeJSON(candidatePath, candidate);

    expect(() => inspectMPCRelease(fixture.expectations)).toThrowError(
      expect.objectContaining({ code: "coherence_mismatch" }),
    );
  });

  it("rejects any missing native negative verification result", () => {
    const fixture = releaseFixture();
    const reportPath = path.join(fixture.expectations.releaseDir, "verification-report.json");
    const candidatePath = path.join(fixture.expectations.releaseDir, "candidate.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.wrong_vk_rejected = false;
    const changedReportBytes = writeJSON(reportPath, report);
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
    candidate.verification_report.digest = artifactDigest(changedReportBytes);
    writeJSON(candidatePath, candidate);

    expect(() => inspectMPCRelease(fixture.expectations)).toThrowError(
      expect.objectContaining({ code: "coherence_mismatch" }),
    );
  });
});

describe("production GO decision release and source provenance", () => {
  it("binds the verified decision output to the exact local release manifest and full tag provenance", () => {
    const releaseManifestSHA256 = `sha256:${"44".repeat(32)}`;
    const result = decisionCommandResult();
    const decision = decisionRecord(result, releaseManifestSHA256);

    expect(
      assertProductionDecisionRecordBinding({
        decisionBytes: jsonBytes(decision),
        result,
        expectedReleaseManifestSHA256: releaseManifestSHA256,
      }),
    ).toEqual(decision);
  });

  it.each([
    [
      "release manifest",
      (decision) => (decision.release.manifest.artifact.digest.sha256 = `sha256:${"ff".repeat(32)}`),
    ],
    ["tag fingerprint", (decision) => (decision.source_release.signer_fingerprint_hex = "ff".repeat(20))],
    [
      "tag object",
      (decision) => (decision.source_release.signed_tag_object.artifact.digest.sha256 = `sha256:${"ff".repeat(32)}`),
    ],
  ])("rejects authenticated decision drift in %s", (_label, mutate) => {
    const releaseManifestSHA256 = `sha256:${"44".repeat(32)}`;
    const result = decisionCommandResult();
    const decision = decisionRecord(result, releaseManifestSHA256);
    mutate(decision);

    expect(() =>
      assertProductionDecisionRecordBinding({
        decisionBytes: jsonBytes(decision),
        result,
        expectedReleaseManifestSHA256: releaseManifestSHA256,
      }),
    ).toThrowError(expect.objectContaining({ code: "coherence_mismatch" }));
  });
});

describe("unsigned plan artifacts", () => {
  it("emits an inactive manifest template and a reference-output plan without transaction bytes", () => {
    const nativeHash = `blake2b256:${"11".repeat(32)}`;
    const cardanoHash = `blake2b256:${"22".repeat(32)}`;
    const artifacts = buildPreparationArtifacts({
      source: { commit: "33".repeat(20), signedTag: "v1.0.0-mainnet" },
      release: {
        ceremonyID: `sha256:${"44".repeat(32)}`,
        candidateID: `sha256:${"55".repeat(32)}`,
        releaseManifestSHA256: `sha256:${"66".repeat(32)}`,
        candidateSchema: "proof-tool-mpc-release-candidate-v2",
        verificationReportSchema: "proof-tool-mpc-verification-report-v2",
        verificationReportSHA256: `sha256:${"67".repeat(32)}`,
        publicEvidenceSchema: "proof-tool-mpc-public-finalization-evidence-v1",
        publicEvidenceSHA256: `sha256:${"68".repeat(32)}`,
        cardanoProofBlake2b256: `blake2b256:${"69".repeat(32)}`,
        nativeVKBlake2b256: nativeHash,
        cardanoVKBlake2b256: cardanoHash,
        manifest: {
          signature_key_id: "release-2026",
          setup_transcript_hash: `blake2b256:${"77".repeat(32)}`,
        },
      },
      scripts: scriptFixture(),
      decision: productionDecisionResult(),
      seedOutRef: {
        txHash: "88".repeat(32),
        outputIndex: 3,
        canonical: `${"88".repeat(32)}#3`,
      },
    });
    const plan = JSON.parse(artifacts["deployment-plan.json"]);
    const manifest = JSON.parse(artifacts["reclaim-deployment.unsigned-template.json"]);

    expect(plan.network).toBe("Mainnet");
    expect(plan.network_id).toBe(1);
    expect(plan.submitted).toBe(false);
    expect(plan.signed_transaction_created).toBe(false);
    expect(plan.unsigned_transaction_cbor).toBeNull();
    expect(plan.reference_output_plan.outputs.map((output) => output.output_index)).toEqual([0, 1, 2]);
    expect(manifest.enabled).toBe(false);
    expect(manifest.params_utxo.tx_hash).toBeNull();
    expect(manifest.proof.vk_hash).toBe(nativeHash);
    expect(manifest.proof.cardano_vk_blake2b256).toBe(cardanoHash);
    expect(manifest.planning.mpc_candidate_schema).toBe("proof-tool-mpc-release-candidate-v2");
    expect(manifest.planning.mpc_verification_report_schema).toBe("proof-tool-mpc-verification-report-v2");
    expect(manifest.planning.mpc_public_evidence_sha256).toBe(`sha256:${"68".repeat(32)}`);
    expect(manifest.reclaim_global.verifier_vk_hash).toBe(cardanoHash);
    expect(manifest.reclaim_global.verifier_vk_hash).not.toBe(manifest.proof.vk_hash);
    const activationErrors = validateReclaimManifest(manifest);
    expect(activationErrors.map((error) => error.field)).toEqual(
      expect.arrayContaining(["params_utxo.tx_hash", "enabled"]),
    );
    expect(JSON.stringify({ plan, manifest })).not.toMatch(/mnemonic|xprv|private_key|signed_tx/iu);
  });
});

function optionFixture() {
  const root = tempDir("proof-tool-mainnet-options-");
  const releaseDir = path.join(root, "release");
  const trustDir = path.join(root, "trust");
  mkdirSync(releaseDir);
  mkdirSync(trustDir);
  const decisionEvidenceRoot = path.join(root, "decision-evidence");
  mkdirSync(decisionEvidenceRoot);
  const files = {
    mpcCeremonyBin: path.join(root, "mpc-ceremony"),
    ceremonyPath: path.join(root, "ceremony.json"),
    ceremonySignaturePath: path.join(root, "ceremony.sig.json"),
    coordinatorPublicKeyPath: path.join(trustDir, "coordinator.pub"),
    releasePublicKeyPath: path.join(trustDir, "release.pub"),
    decisionRecordPath: path.join(trustDir, "production-decision.json"),
  };
  for (const file of Object.values(files)) writeFileSync(file, "fixture\n");
  const decisionSignaturePaths = Array.from({ length: 4 }, (_, index) => {
    const file = path.join(trustDir, `production-decision-${index + 1}.sig.json`);
    writeFileSync(file, "fixture\n");
    return file;
  });
  chmodSync(files.mpcCeremonyBin, 0o700);
  return {
    root,
    options: {
      dryRun: true,
      network: "Mainnet",
      networkId: 1,
      sourceSignedTag: "v1.0.0-mainnet",
      ...files,
      releaseDir,
      releaseSignatureKeyID: "release-2026",
      decisionSignaturePaths,
      decisionEvidenceRoot,
      seedOutRef: `${"99".repeat(32)}#0`,
      outDir: path.join(root, "output"),
    },
  };
}

function releaseFixture() {
  const root = tempDir("proof-tool-mainnet-release-");
  const releaseDir = path.join(root, "release");
  mkdirSync(releaseDir);
  const ceremonyID = `sha256:${"aa".repeat(32)}`;
  const candidateID = `sha256:${"bb".repeat(32)}`;
  const sourceCommit = "cc".repeat(20);
  const signatureKeyID = "release-2026";
  const nativeVK = Buffer.from("native-gnark-vk-fixture");
  const cardanoVK = Buffer.alloc(672, 0x5a);
  const cardanoProof = Buffer.alloc(336, 0x6b);
  const nativeDigest = artifactDigest(nativeVK);
  const cardanoDigest = artifactDigest(cardanoVK);
  const ref = (name, value) => ({ name, digest: artifactDigest(value) });
  const credentialHex = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
  const destinationHex =
    "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da111" +
    "0000000000000000000000000000000000000000000000000000000000";
  const publicInputDigestHex = Buffer.from(
    blake2b(
      Uint8Array.from(
        Buffer.concat([
          Buffer.from("ROOT-OWNERSHIP-DESTINATION-v1", "utf8"),
          Buffer.from(credentialHex, "hex"),
          Buffer.from(destinationHex, "hex"),
        ]),
      ),
      { dkLen: 32 },
    ),
  ).toString("hex");
  const publicEvidence = {
    schema: "proof-tool-mpc-public-finalization-evidence-v1",
    ceremony_id: ceremonyID,
    fixture: "repository-golden-destination-v2",
    credential_hex: credentialHex,
    destination_hex: destinationHex,
    public_input_digest_hex: publicInputDigestHex,
    cardano_proof_hex: cardanoProof.toString("hex"),
    cardano_proof_format: "groth16-bls12-381-bsb22",
    cardano_proof_raw_digest: artifactDigest(cardanoProof),
    cardano_verifying_key: ref("cardano-vk.bin", cardanoVK),
  };
  const publicEvidenceBytes = jsonBytes(publicEvidence);
  const report = {
    schema: "proof-tool-mpc-verification-report-v2",
    ceremony_id: ceremonyID,
    fixture: "repository-golden-destination-v2",
    native_proof_verified: true,
    wrong_credential_rejected: true,
    wrong_destination_rejected: true,
    wrong_digest_rejected: true,
    wrong_proof_rejected: true,
    wrong_vk_rejected: true,
    proof_truncation_rejected: true,
    proof_append_rejected: true,
    cardano_proof_format: "groth16-bls12-381-bsb22",
    cardano_proof_bytes: 336,
    cardano_proof_raw_digest: artifactDigest(cardanoProof),
    cardano_vk_format: "groth16-bls12-381-bsb22",
    cardano_vk_bytes: 672,
    cardano_vk_raw_digest: cardanoDigest,
    public_evidence: ref("public-finalization-evidence.json", publicEvidenceBytes),
    checked_at: "2026-07-23T00:00:00Z",
  };
  const reportBytes = jsonBytes(report);
  const candidate = {
    schema: "proof-tool-mpc-release-candidate-v2",
    candidate_id: candidateID,
    ceremony_id: ceremonyID,
    circuit: {
      key_version: "ownership-destination-v2",
      circuit_id: "root-ownership-destination-v2/bls12-381/groth16",
      curve: "BLS12-381",
      backend: "groth16",
    },
    verifying_key: ref("ownership.vk", nativeVK),
    cardano_verifying_key: ref("cardano-vk.bin", cardanoVK),
    verification_report: ref("verification-report.json", reportBytes),
    public_finalization_evidence: ref("public-finalization-evidence.json", publicEvidenceBytes),
  };
  const transcript = {
    schema: "proof-tool-mpc-final-transcript-v1",
    ceremony_id: ceremonyID,
    audits: [{ name: "audit-1.json" }, { name: "audit-2.json" }],
    verifying_key: candidate.verifying_key,
    cardano_verifying_key: candidate.cardano_verifying_key,
  };
  const manifest = {
    schema: "proof-tool-key-manifest-v1",
    key_version: "ownership-destination-v2",
    circuit_id: "root-ownership-destination-v2/bls12-381/groth16",
    curve: "BLS12-381",
    backend: "groth16",
    circuit_source_commit: sourceCommit,
    signature_key_id: signatureKeyID,
    vk_hash: nativeDigest.blake2b256,
  };
  const ceremony = {
    schema: "proof-tool-mpc-ceremony-definition-v1",
    ceremony_id: ceremonyID,
    mode: "production",
    software: { source_commit: sourceCommit, source_dirty: false },
    release_signer: { key_id: signatureKeyID },
  };
  const ceremonyPath = path.join(root, "ceremony.json");
  writeJSON(ceremonyPath, ceremony);
  writeJSON(path.join(releaseDir, "manifest.json"), manifest);
  writeJSON(path.join(releaseDir, "candidate.json"), candidate);
  writeJSON(path.join(releaseDir, "setup-transcript.json"), transcript);
  writeJSON(path.join(releaseDir, "verification-report.json"), report);
  writeJSON(path.join(releaseDir, "public-finalization-evidence.json"), publicEvidence);
  writeFileSync(path.join(releaseDir, "ownership.vk"), nativeVK);
  writeFileSync(path.join(releaseDir, "cardano-vk.bin"), cardanoVK);
  writeFileSync(path.join(releaseDir, "cardano-vk.hex"), `${cardanoVK.toString("hex")}\n`);
  writeFileSync(path.join(releaseDir, "cardano-vk-format.txt"), "groth16-bls12-381-bsb22\n");
  for (const name of [
    "manifest.sig",
    "manifest-public-key.hex",
    "candidate.sig.json",
    "candidate-checksums.sha256",
    "checksums.sha256",
  ]) {
    writeFileSync(path.join(releaseDir, name), `${name}\n`);
  }
  return {
    expectations: {
      releaseDir,
      ceremonyPath,
      expectedSourceCommit: sourceCommit,
      expectedSignatureKeyID: signatureKeyID,
      expectedCeremonyID: ceremonyID,
    },
    nativeDigest,
    cardanoDigest,
    ceremonyID,
    sourceCommit,
  };
}

function productionDecisionResult() {
  return {
    decisionID: `sha256:${"10".repeat(32)}`,
    releaseID: `sha256:${"20".repeat(32)}`,
    ceremonyID: `sha256:${"22".repeat(32)}`,
    candidateID: `sha256:${"33".repeat(32)}`,
    sourceCommit: "11".repeat(20),
    sourceSignedTag: "v1.0.0-mainnet",
    sourceTagSignerFingerprint: "aa".repeat(20),
    sourceTagObjectSHA256: `sha256:${"bb".repeat(32)}`,
  };
}

function decisionCommandResult() {
  return {
    decision_id: `sha256:${"10".repeat(32)}`,
    release_id: `sha256:${"20".repeat(32)}`,
    ceremony_id: `sha256:${"22".repeat(32)}`,
    candidate_id: `sha256:${"33".repeat(32)}`,
    source_commit: "11".repeat(20),
    source_signed_tag: "v1.0.0-mainnet",
    source_tag_signer_fingerprint: "aa".repeat(20),
    source_tag_object_sha256: `sha256:${"bb".repeat(32)}`,
  };
}

function decisionRecord(result, releaseManifestSHA256) {
  return {
    schema: "proof-tool-mpc-production-decision-v1",
    decision_id: result.decision_id,
    ceremony_id: result.ceremony_id,
    release: {
      release_id: result.release_id,
      candidate_id: result.candidate_id,
      manifest: {
        uri: "https://example.invalid/release/manifest.json",
        artifact: {
          name: "release/manifest.json",
          digest: {
            sha256: releaseManifestSHA256,
            blake2b256: `blake2b256:${"55".repeat(32)}`,
            size: 123,
          },
        },
      },
    },
    source_release: {
      source_commit: result.source_commit,
      signed_tag: result.source_signed_tag,
      signature_format: "openpgp-primary-key-v4",
      signer_fingerprint_hex: result.source_tag_signer_fingerprint,
      signed_tag_object: {
        uri: "https://example.invalid/source/tag.object",
        artifact: {
          name: "source/tag.object",
          digest: {
            sha256: result.source_tag_object_sha256,
            blake2b256: `blake2b256:${"66".repeat(32)}`,
            size: 456,
          },
        },
      },
    },
    decision: "GO",
  };
}

function scriptFixture() {
  return {
    paramsPolicyID: "88".repeat(28),
    paramsTokenName: "5245434c41494d504152414d53",
    paramsUnit: `${"88".repeat(28)}5245434c41494d504152414d53`,
    reclaimGlobalScriptHash: "99".repeat(28),
    reclaimBaseScriptHash: "aa".repeat(28),
    paramsHolderScriptHash: "bb".repeat(28),
    reclaimBaseAddress: "addr1reclaimbase",
    paramsHolderAddress: "addr1paramsholder",
    reclaimGlobalRewardAddress: "stake1reclaimglobal",
    oneShot: { type: "PlutusV3", script: "0102" },
    global: { type: "PlutusV3", script: "0304" },
    base: { type: "PlutusV3", script: "0506" },
    holder: { type: "PlutusV3", script: "0708" },
  };
}

function artifactDigest(bytes) {
  return {
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    blake2b256: `blake2b256:${Buffer.from(blake2b(Uint8Array.from(bytes), { dkLen: 32 })).toString("hex")}`,
    size: bytes.length,
  };
}

function writeJSON(file, value) {
  const bytes = jsonBytes(value);
  writeFileSync(file, bytes);
  return bytes;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
