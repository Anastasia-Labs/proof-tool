#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  Constr,
  Data,
  credentialToRewardAddress,
  mintingPolicyToId,
  scriptHashToCredential,
  validatorToAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";
import { assertReclaimGlobalProofSlotEncoding, reclaimGlobalExportArgs } from "../preprod/deploy-reclaim-preprod.mjs";

const execFileAsync = promisify(execFile);

export const MAINNET_PREPARATION_SCHEMA = "proof-tool-reclaim-mainnet-deployment-preparation-v1";
export const UNSIGNED_MANIFEST_FILENAME = "reclaim-deployment.unsigned-template.json";
export const DEPLOYMENT_PLAN_FILENAME = "deployment-plan.json";

const NETWORK = "Mainnet";
const NETWORK_ID = 1;
const KEY_VERSION = "ownership-destination-v2";
const CIRCUIT_ID = "root-ownership-destination-v2/bls12-381/groth16";
const CURVE = "BLS12-381";
const BACKEND = "groth16";
const CARDANO_VK_FORMAT = "groth16-bls12-381-bsb22";
const CARDANO_VK_BYTES = 672;
const CARDANO_PROOF_BYTES = 336;
const PUBLIC_EVIDENCE_FIXTURE = "repository-golden-destination-v2";
const PUBLIC_INPUT_DOMAIN = "ROOT-OWNERSHIP-DESTINATION-v1";
const GOLDEN_PUBLIC_CREDENTIAL = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const GOLDEN_PUBLIC_DESTINATION =
  "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da111" +
  "0000000000000000000000000000000000000000000000000000000000";
const PARAMS_TOKEN_NAME = "5245434c41494d504152414d53";
const PROOF_SLOT_ENCODING = "full-proof-plus-public-input-digest-v2";
const BATCH_TRANSCRIPT = "statement-bound-v2";
const MAX_RELEASE_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_VK_BYTES = 64 * 1024 * 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CONTRACT_DIR = path.join(REPO_ROOT, "contracts", "ownership-verifier");

export class MainnetPreparationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MainnetPreparationError";
    this.code = code;
  }
}

export async function prepareReclaimMainnet(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const normalized = validatePreparationOptions(options, repoRoot);
  const assertCleanSignedSourceFn = options.assertCleanSignedSourceFn ?? assertCleanSignedSource;
  const verifyMPCReleaseFn = options.verifyMPCReleaseFn ?? verifyMPCRelease;
  const inspectMPCReleaseFn = options.inspectMPCReleaseFn ?? inspectMPCRelease;
  const exportScriptsFn = options.exportScriptsFn ?? exportDeploymentScripts;
  const verifyProductionDecisionFn = options.verifyProductionDecisionFn ?? verifyProductionDecision;
  const publishFn = options.publishFn ?? publishPreparation;
  const trustedInputs = trustedInputSnapshot(normalized);

  const source = await assertCleanSignedSourceFn(repoRoot, normalized.sourceSignedTag);
  const releaseVerification = await verifyMPCReleaseFn({
    ...normalized,
    repoRoot,
  });
  const release = inspectMPCReleaseFn({
    releaseDir: normalized.releaseDir,
    ceremonyPath: normalized.ceremonyPath,
    expectedSourceCommit: source.commit,
    expectedSignatureKeyID: normalized.releaseSignatureKeyID,
    expectedCeremonyID: releaseVerification.ceremonyID,
  });
  const scripts = await exportScriptsFn({
    repoRoot,
    contractDir: path.join(repoRoot, "contracts", "ownership-verifier"),
    seedOutRef: normalized.seedOutRef,
    cardanoVKHex: release.cardanoVKHex,
    cardanoVKBlake2b256: release.cardanoVKBlake2b256,
  });

  const decision = await verifyProductionDecisionFn({
    ...normalized,
    repoRoot,
    expectedCeremonyID: release.ceremonyID,
    expectedCandidateID: release.candidateID,
    expectedReleaseManifestSHA256: release.releaseManifestSHA256,
    expectedSourceCommit: source.commit,
    expectedSignedTag: source.signedTag,
  });

  // Re-run the exact release verifier immediately before publication. This is
  // deliberately expensive: the locally written plan must not be based on a
  // release that changed after the first verification and script export.
  const finalVerification = await verifyMPCReleaseFn({
    ...normalized,
    repoRoot,
  });
  if (finalVerification.ceremonyID !== release.ceremonyID) {
    throw new MainnetPreparationError(
      "mpc_release_changed",
      "The exact MPC release identity changed during Mainnet preparation.",
    );
  }
  assertReleasePlanningSnapshot(normalized.releaseDir, release.snapshot);
  const finalSource = await assertCleanSignedSourceFn(repoRoot, normalized.sourceSignedTag);
  if (finalSource.commit !== source.commit || finalSource.signedTag !== source.signedTag) {
    throw new MainnetPreparationError(
      "source_changed",
      "The clean signed source identity changed during Mainnet preparation.",
    );
  }
  assertTrustedInputSnapshot(normalized, trustedInputs);
  const finalDecision = await verifyProductionDecisionFn({
    ...normalized,
    repoRoot,
    expectedCeremonyID: release.ceremonyID,
    expectedCandidateID: release.candidateID,
    expectedReleaseManifestSHA256: release.releaseManifestSHA256,
    expectedSourceCommit: source.commit,
    expectedSignedTag: source.signedTag,
  });
  if (JSON.stringify(finalDecision) !== JSON.stringify(decision)) {
    throw new MainnetPreparationError(
      "production_decision_changed",
      "The canonical production GO decision changed during preparation.",
    );
  }
  const artifacts = buildPreparationArtifacts({
    source,
    release,
    scripts,
    decision: finalDecision,
    seedOutRef: normalized.seedOutRef,
  });

  const published = publishFn(normalized.outDir, artifacts);
  return {
    ok: true,
    dryRun: true,
    network: NETWORK,
    networkId: NETWORK_ID,
    submitted: false,
    unsigned: true,
    sourceCommit: source.commit,
    ceremonyId: release.ceremonyID,
    candidateId: release.candidateID,
    nativeVkBlake2b256: release.nativeVKBlake2b256,
    cardanoVkBlake2b256: release.cardanoVKBlake2b256,
    paramsPolicyId: scripts.paramsPolicyID,
    reclaimGlobalScriptHash: scripts.reclaimGlobalScriptHash,
    reclaimBaseScriptHash: scripts.reclaimBaseScriptHash,
    decisionId: finalDecision.decisionID,
    releaseId: finalDecision.releaseID,
    outputs: published,
  };
}

export function validatePreparationOptions(options, repoRoot = REPO_ROOT) {
  if (options.dryRun !== true) {
    throw new MainnetPreparationError("dry_run_required", "Mainnet preparation requires the explicit --dry-run guard.");
  }
  if (options.network !== NETWORK || Number(options.networkId) !== NETWORK_ID) {
    throw new MainnetPreparationError(
      "mainnet_identity_required",
      "Mainnet preparation requires network Mainnet and network_id 1.",
    );
  }
  const required = {
    sourceSignedTag: "--source-signed-tag",
    mpcCeremonyBin: "--mpc-ceremony-bin",
    ceremonyPath: "--ceremony",
    ceremonySignaturePath: "--ceremony-signature",
    coordinatorPublicKeyPath: "--coordinator-public-key-file",
    releaseDir: "--release-dir",
    releasePublicKeyPath: "--release-public-key-file",
    releaseSignatureKeyID: "--release-signature-key-id",
    decisionRecordPath: "--production-decision",
    decisionEvidenceRoot: "--decision-evidence-root",
    outDir: "--out-dir",
  };
  const normalized = {};
  for (const [field, flag] of Object.entries(required)) {
    const value = typeof options[field] === "string" ? options[field].trim() : "";
    if (!value) {
      throw new MainnetPreparationError("required_option_missing", `${flag} is required.`);
    }
    normalized[field] = field.endsWith("ID") || field === "sourceSignedTag" ? value : resolvePath(repoRoot, value);
  }
  normalized.sourceSignedTag = options.sourceSignedTag.trim();
  normalized.releaseSignatureKeyID = options.releaseSignatureKeyID.trim();
  if (!Array.isArray(options.decisionSignaturePaths) || options.decisionSignaturePaths.length !== 4) {
    throw new MainnetPreparationError(
      "decision_signature_count_invalid",
      "--decision-signature must be supplied exactly four times.",
    );
  }
  normalized.decisionSignaturePaths = options.decisionSignaturePaths.map((value) => {
    const candidate = String(value).trim();
    if (!candidate) {
      throw new MainnetPreparationError("decision_signature_invalid", "--decision-signature paths must be non-empty.");
    }
    return resolvePath(repoRoot, candidate);
  });
  if (new Set(normalized.decisionSignaturePaths).size !== 4) {
    throw new MainnetPreparationError(
      "decision_signature_duplicate",
      "The four production decision signature paths must be distinct.",
    );
  }
  normalized.seedOutRef = parseSeedOutRef(options.seedOutRef);

  requireRegularNoSymlink(normalized.mpcCeremonyBin, "MPC ceremony binary");
  if ((statSync(normalized.mpcCeremonyBin).mode & 0o111) === 0) {
    throw new MainnetPreparationError("mpc_binary_not_executable", "MPC ceremony binary must be executable.");
  }
  requireRealDirectory(normalized.releaseDir, "MPC release directory");
  requireRealDirectory(normalized.decisionEvidenceRoot, "production decision evidence root");
  for (const [file, label] of [
    [normalized.ceremonyPath, "ceremony definition"],
    [normalized.ceremonySignaturePath, "ceremony definition signature"],
    [normalized.coordinatorPublicKeyPath, "coordinator public key"],
    [normalized.releasePublicKeyPath, "release public key"],
    [normalized.decisionRecordPath, "production decision record"],
    ...normalized.decisionSignaturePaths.map((file, index) => [file, `production decision signature ${index + 1}`]),
  ]) {
    requireRegularNoSymlink(file, label);
  }
  requireExternalTrustAnchor(normalized.releasePublicKeyPath, normalized.releaseDir, "release public key");
  requirePathOutside(normalized.outDir, normalized.releaseDir, "output directory", "MPC release directory");
  if (existsSync(normalized.outDir) || isSymlink(normalized.outDir)) {
    throw new MainnetPreparationError("output_exists", "Mainnet preparation output directory must not already exist.");
  }
  requireRealDirectory(path.dirname(normalized.outDir), "output parent");
  return normalized;
}

export async function assertCleanSignedSource(repoRoot, signedTag) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/+@-]{0,159}$/u.test(signedTag)) {
    throw new MainnetPreparationError("source_tag_invalid", "Source signed tag has an unsafe or invalid name.");
  }
  const status = (await execGit(repoRoot, ["status", "--porcelain", "--untracked-files=all"])).trim();
  if (status) {
    throw new MainnetPreparationError(
      "source_not_clean",
      "The Mainnet preparation source checkout must be completely clean.",
    );
  }
  const commit = (await execGit(repoRoot, ["rev-parse", "--verify", "HEAD"])).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new MainnetPreparationError("source_commit_invalid", "HEAD is not an exact 40-character commit.");
  }
  const tagType = (await execGit(repoRoot, ["cat-file", "-t", signedTag])).trim();
  if (tagType !== "tag") {
    throw new MainnetPreparationError(
      "source_tag_not_annotated",
      "The source release tag must be an annotated, signed Git tag.",
    );
  }
  const tagCommit = (await execGit(repoRoot, ["rev-list", "-n", "1", signedTag])).trim().toLowerCase();
  if (tagCommit !== commit) {
    throw new MainnetPreparationError(
      "source_tag_commit_mismatch",
      "The signed source tag does not resolve to the clean checked-out commit.",
    );
  }
  try {
    await execGit(repoRoot, ["verify-tag", signedTag]);
  } catch {
    throw new MainnetPreparationError(
      "source_tag_signature_invalid",
      "Git did not verify the source release tag signature.",
    );
  }
  return { commit, signedTag };
}

export async function verifyMPCRelease(options) {
  const args = [
    "--format",
    "json",
    "--quiet",
    "release",
    "verify",
    "--ceremony",
    options.ceremonyPath,
    "--ceremony-signature",
    options.ceremonySignaturePath,
    "--coordinator-public-key-file",
    options.coordinatorPublicKeyPath,
    "--keys-dir",
    options.releaseDir,
    "--manifest-public-key-file",
    options.releasePublicKeyPath,
    "--signature-key-id",
    options.releaseSignatureKeyID,
  ];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(options.mpcCeremonyBin, args, {
      cwd: options.repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      env: minimalChildEnvironment(),
    }));
  } catch {
    throw new MainnetPreparationError(
      "mpc_release_verification_failed",
      "Exact signed MPC release verification failed.",
    );
  }
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new MainnetPreparationError(
      "mpc_release_verification_malformed",
      "MPC release verification did not emit one valid JSON result.",
    );
  }
  if (
    result?.schema !== "proof-tool-mpc-command-result-v1" ||
    result.ok !== true ||
    result.command !== "release verify" ||
    !/^sha256:[0-9a-f]{64}$/u.test(result.ceremony_id ?? "")
  ) {
    throw new MainnetPreparationError(
      "mpc_release_verification_rejected",
      "MPC release verification did not return an exact successful release result.",
    );
  }
  return { ceremonyID: result.ceremony_id };
}

export async function verifyProductionDecision(options) {
  const args = [
    "--format",
    "json",
    "--quiet",
    "decision",
    "verify",
    "--ceremony",
    options.ceremonyPath,
    "--ceremony-signature",
    options.ceremonySignaturePath,
    "--coordinator-public-key-file",
    options.coordinatorPublicKeyPath,
    "--decision",
    options.decisionRecordPath,
  ];
  for (const signature of options.decisionSignaturePaths) {
    args.push("--signature", signature);
  }
  args.push("--evidence-root", options.decisionEvidenceRoot);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(options.mpcCeremonyBin, args, {
      cwd: options.repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      env: minimalChildEnvironment(),
    }));
  } catch {
    throw new MainnetPreparationError(
      "production_decision_verification_failed",
      "Canonical production GO decision verification failed.",
    );
  }
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new MainnetPreparationError(
      "production_decision_verification_malformed",
      "Production decision verification did not emit one valid JSON result.",
    );
  }
  if (
    result?.schema !== "proof-tool-mpc-command-result-v1" ||
    result.ok !== true ||
    result.command !== "decision verify" ||
    result.decision !== "GO" ||
    !/^sha256:[0-9a-f]{64}$/u.test(result.decision_id ?? "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(result.release_id ?? "")
  ) {
    throw new MainnetPreparationError(
      "production_decision_rejected",
      "Production decision verification did not return an exact successful GO result.",
    );
  }
  exact(result.ceremony_id, options.expectedCeremonyID, "production decision ceremony id");
  exact(result.candidate_id, options.expectedCandidateID, "production decision candidate id");
  exact(result.source_commit, options.expectedSourceCommit, "production decision source commit");
  exact(result.source_signed_tag, options.expectedSignedTag, "production decision signed source tag");

  const decision = assertProductionDecisionRecordBinding({
    decisionBytes: readRegularAbsolute(
      options.decisionRecordPath,
      "production decision record",
      MAX_RELEASE_METADATA_BYTES,
    ),
    result,
    expectedReleaseManifestSHA256: options.expectedReleaseManifestSHA256,
  });
  const tag = await inspectSignedTagProvenance(options.repoRoot, options.expectedSignedTag);
  exact(
    result.source_tag_signer_fingerprint,
    tag.signerFingerprint,
    "production decision source-tag signer fingerprint",
  );
  exact(result.source_tag_object_sha256, tag.objectSHA256, "production decision signed tag object digest");
  return {
    decisionID: result.decision_id,
    releaseID: result.release_id,
    ceremonyID: result.ceremony_id,
    candidateID: result.candidate_id,
    sourceCommit: result.source_commit,
    sourceSignedTag: result.source_signed_tag,
    sourceTagSignerFingerprint: result.source_tag_signer_fingerprint,
    sourceTagObjectSHA256: result.source_tag_object_sha256,
  };
}

export function assertProductionDecisionRecordBinding({ decisionBytes, result, expectedReleaseManifestSHA256 }) {
  const decision = parseJSON(decisionBytes, "production decision record");
  exact(decision.schema, "proof-tool-mpc-production-decision-v1", "production decision schema");
  exact(decision.decision_id, result.decision_id, "production decision id");
  exact(decision.decision, "GO", "production decision outcome");
  exact(decision.ceremony_id, result.ceremony_id, "production decision record ceremony id");
  exact(decision.release?.release_id, result.release_id, "production decision record release id");
  exact(decision.release?.candidate_id, result.candidate_id, "production decision record candidate id");
  exact(
    path.posix.basename(decision.release?.manifest?.artifact?.name ?? ""),
    "manifest.json",
    "production decision release manifest filename",
  );
  exact(
    decision.release?.manifest?.artifact?.digest?.sha256,
    expectedReleaseManifestSHA256,
    "production decision exact release manifest digest",
  );
  exact(decision.source_release?.source_commit, result.source_commit, "production decision record source commit");
  exact(decision.source_release?.signed_tag, result.source_signed_tag, "production decision record signed source tag");
  exact(
    decision.source_release?.signer_fingerprint_hex,
    result.source_tag_signer_fingerprint,
    "production decision record source-tag signer fingerprint",
  );
  exact(
    decision.source_release?.signed_tag_object?.artifact?.digest?.sha256,
    result.source_tag_object_sha256,
    "production decision record signed tag object digest",
  );
  return decision;
}

async function inspectSignedTagProvenance(repoRoot, signedTag) {
  let fingerprint;
  try {
    fingerprint = (await execGit(repoRoot, ["verify-tag", "--format=%GF", signedTag])).trim().toLowerCase();
  } catch {
    throw new MainnetPreparationError(
      "source_tag_signature_invalid",
      "Git did not verify the pinned source tag signature.",
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(fingerprint)) {
    throw new MainnetPreparationError(
      "source_tag_fingerprint_invalid",
      "The verified source tag did not expose one full OpenPGP primary-key fingerprint.",
    );
  }
  let tagObject;
  try {
    ({ stdout: tagObject } = await execFileAsync("git", ["cat-file", "tag", signedTag], {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      env: minimalChildEnvironment(),
    }));
  } catch {
    throw new MainnetPreparationError(
      "source_tag_object_invalid",
      "The exact annotated signed tag object could not be read.",
    );
  }
  return {
    signerFingerprint: fingerprint,
    objectSHA256: `sha256:${createHash("sha256").update(tagObject).digest("hex")}`,
  };
}

export function inspectMPCRelease({
  releaseDir,
  ceremonyPath,
  expectedSourceCommit,
  expectedSignatureKeyID,
  expectedCeremonyID,
}) {
  const manifestBytes = readRegular(releaseDir, "manifest.json", MAX_RELEASE_METADATA_BYTES);
  const candidateBytes = readRegular(releaseDir, "candidate.json", MAX_RELEASE_METADATA_BYTES);
  const transcriptBytes = readRegular(releaseDir, "setup-transcript.json", MAX_RELEASE_METADATA_BYTES);
  const reportBytes = readRegular(releaseDir, "verification-report.json", MAX_RELEASE_METADATA_BYTES);
  const publicEvidenceBytes = readRegular(releaseDir, "public-finalization-evidence.json", MAX_RELEASE_METADATA_BYTES);
  const nativeVK = readRegular(releaseDir, "ownership.vk", MAX_NATIVE_VK_BYTES);
  const cardanoVK = readRegular(releaseDir, "cardano-vk.bin", CARDANO_VK_BYTES);
  const cardanoVKHexBytes = readRegular(releaseDir, "cardano-vk.hex", CARDANO_VK_BYTES * 2 + 2);
  const cardanoVKFormatBytes = readRegular(releaseDir, "cardano-vk-format.txt", 128);
  const ceremonyBytes = readRegularAbsolute(ceremonyPath, "ceremony definition", MAX_RELEASE_METADATA_BYTES);
  const manifest = parseJSON(manifestBytes, "MPC release manifest");
  const candidate = parseJSON(candidateBytes, "MPC release candidate");
  const transcript = parseJSON(transcriptBytes, "MPC final transcript");
  const report = parseJSON(reportBytes, "MPC verification report");
  const publicEvidence = parseJSON(publicEvidenceBytes, "MPC public finalization evidence");
  const ceremony = parseJSON(ceremonyBytes, "MPC ceremony definition");

  exact(manifest.schema, "proof-tool-key-manifest-v1", "release manifest schema");
  exact(manifest.key_version, KEY_VERSION, "release key version");
  exact(manifest.circuit_id, CIRCUIT_ID, "release circuit id");
  exact(manifest.curve, CURVE, "release curve");
  exact(manifest.backend, BACKEND, "release backend");
  exact(manifest.circuit_source_commit, expectedSourceCommit, "release source commit");
  exact(manifest.signature_key_id, expectedSignatureKeyID, "release signature key id");

  exact(candidate.schema, "proof-tool-mpc-release-candidate-v2", "candidate schema");
  if (!/^sha256:[0-9a-f]{64}$/u.test(candidate.candidate_id ?? "")) {
    throw new MainnetPreparationError("coherence_mismatch", "candidate id is not an exact SHA-256 identity.");
  }
  exact(candidate.ceremony_id, expectedCeremonyID, "candidate ceremony id");
  exact(candidate.circuit?.key_version, KEY_VERSION, "candidate key version");
  exact(candidate.circuit?.circuit_id, CIRCUIT_ID, "candidate circuit id");
  exact(candidate.circuit?.curve, CURVE, "candidate curve");
  exact(candidate.circuit?.backend, BACKEND, "candidate backend");
  exact(transcript.schema, "proof-tool-mpc-final-transcript-v1", "final transcript schema");
  exact(transcript.ceremony_id, expectedCeremonyID, "final transcript ceremony id");
  if (!Array.isArray(transcript.audits) || transcript.audits.length < 2) {
    throw new MainnetPreparationError(
      "independent_audits_missing",
      "MPC final transcript must bind at least two independent audits.",
    );
  }
  exact(ceremony.schema, "proof-tool-mpc-ceremony-definition-v1", "ceremony definition schema");
  exact(ceremony.ceremony_id, expectedCeremonyID, "ceremony definition id");
  exact(ceremony.mode, "production", "ceremony mode");
  exact(ceremony.software?.source_commit, expectedSourceCommit, "ceremony source commit");
  exact(ceremony.software?.source_dirty, false, "ceremony clean-source flag");
  exact(ceremony.release_signer?.key_id, expectedSignatureKeyID, "ceremony release signer key id");

  exact(report.schema, "proof-tool-mpc-verification-report-v2", "verification report schema");
  exact(report.ceremony_id, expectedCeremonyID, "verification report ceremony id");
  exact(report.fixture, PUBLIC_EVIDENCE_FIXTURE, "verification report public fixture");
  exact(report.native_proof_verified, true, "native positive proof evidence");
  exact(report.wrong_credential_rejected, true, "negative credential proof evidence");
  exact(report.wrong_destination_rejected, true, "negative destination proof evidence");
  exact(report.wrong_digest_rejected, true, "negative public-input digest evidence");
  exact(report.wrong_proof_rejected, true, "negative proof evidence");
  exact(report.wrong_vk_rejected, true, "negative verifying-key evidence");
  exact(report.proof_truncation_rejected, true, "proof truncation evidence");
  exact(report.proof_append_rejected, true, "proof append evidence");
  exact(report.cardano_proof_format, CARDANO_VK_FORMAT, "verification report Cardano proof format");
  exact(report.cardano_proof_bytes, CARDANO_PROOF_BYTES, "verification report Cardano proof size");
  exact(report.cardano_vk_format, CARDANO_VK_FORMAT, "verification report Cardano VK format");
  exact(report.cardano_vk_bytes, CARDANO_VK_BYTES, "verification report Cardano VK size");
  exact(publicEvidence.schema, "proof-tool-mpc-public-finalization-evidence-v1", "public evidence schema");
  exact(publicEvidence.ceremony_id, expectedCeremonyID, "public evidence ceremony id");
  exact(publicEvidence.fixture, PUBLIC_EVIDENCE_FIXTURE, "public evidence fixture");
  exact(publicEvidence.credential_hex, GOLDEN_PUBLIC_CREDENTIAL, "public evidence credential");
  exact(publicEvidence.destination_hex, GOLDEN_PUBLIC_DESTINATION, "public evidence destination");
  exact(publicEvidence.cardano_proof_format, CARDANO_VK_FORMAT, "public evidence Cardano proof format");
  if (cardanoVK.length !== CARDANO_VK_BYTES) {
    throw new MainnetPreparationError(
      "cardano_vk_size_invalid",
      `Cardano verifier key is ${cardanoVK.length} bytes, want ${CARDANO_VK_BYTES}.`,
    );
  }
  const cardanoVKHex = cardanoVKHexBytes.toString("utf8").trim();
  if (!/^[0-9a-f]{1344}$/u.test(cardanoVKHex) || !Buffer.from(cardanoVKHex, "hex").equals(cardanoVK)) {
    throw new MainnetPreparationError(
      "cardano_vk_hex_mismatch",
      "Cardano verifier-key hex does not exactly encode cardano-vk.bin.",
    );
  }
  exact(cardanoVKFormatBytes.toString("utf8").trim(), CARDANO_VK_FORMAT, "Cardano VK format file");

  const nativeVKDigest = digest(nativeVK);
  const cardanoVKDigest = digest(cardanoVK);
  const reportDigest = digest(reportBytes);
  const publicEvidenceDigest = digest(publicEvidenceBytes);
  const cardanoProof = decodeExactHex(
    publicEvidence.cardano_proof_hex,
    CARDANO_PROOF_BYTES,
    "public evidence Cardano proof",
  );
  const credential = decodeExactHex(publicEvidence.credential_hex, 28, "public evidence credential");
  const destination = decodeExactHex(publicEvidence.destination_hex, 58, "public evidence destination");
  const expectedPublicInputDigest = Buffer.from(
    blake2b(Uint8Array.from(Buffer.concat([Buffer.from(PUBLIC_INPUT_DOMAIN, "utf8"), credential, destination])), {
      dkLen: 32,
    }),
  ).toString("hex");
  exact(publicEvidence.public_input_digest_hex, expectedPublicInputDigest, "public evidence public-input digest");
  assertArtifactDigest(candidate.verifying_key, "ownership.vk", nativeVKDigest, "candidate native VK");
  assertArtifactDigest(candidate.cardano_verifying_key, "cardano-vk.bin", cardanoVKDigest, "candidate Cardano VK");
  assertArtifactDigest(
    candidate.verification_report,
    "verification-report.json",
    reportDigest,
    "candidate verification report",
  );
  assertArtifactDigest(
    candidate.public_finalization_evidence,
    "public-finalization-evidence.json",
    publicEvidenceDigest,
    "candidate public evidence",
  );
  assertArtifactDigest(
    report.public_evidence,
    "public-finalization-evidence.json",
    publicEvidenceDigest,
    "verification report public evidence",
  );
  assertArtifactDigest(
    publicEvidence.cardano_verifying_key,
    "cardano-vk.bin",
    cardanoVKDigest,
    "public evidence Cardano VK",
  );
  assertArtifactDigest(transcript.verifying_key, "ownership.vk", nativeVKDigest, "transcript native VK");
  assertArtifactDigest(transcript.cardano_verifying_key, "cardano-vk.bin", cardanoVKDigest, "transcript Cardano VK");
  exact(manifest.vk_hash, nativeVKDigest.blake2b256, "manifest native VK hash");
  assertExactDigest(report.cardano_vk_raw_digest, cardanoVKDigest, "verification report Cardano VK");
  assertExactDigest(report.cardano_proof_raw_digest, digest(cardanoProof), "verification report Cardano proof");
  assertExactDigest(publicEvidence.cardano_proof_raw_digest, digest(cardanoProof), "public evidence Cardano proof");
  if (nativeVKDigest.blake2b256 === cardanoVKDigest.blake2b256) {
    throw new MainnetPreparationError(
      "vk_semantics_ambiguous",
      "Native gnark and Cardano wire-format verifier-key hashes must remain distinct.",
    );
  }
  const snapshot = planningSnapshot(releaseDir);
  return {
    ceremonyID: expectedCeremonyID,
    candidateID: candidate.candidate_id,
    releaseManifestSHA256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
    candidateSchema: candidate.schema,
    verificationReportSchema: report.schema,
    verificationReportSHA256: reportDigest.sha256,
    publicEvidenceSchema: publicEvidence.schema,
    publicEvidenceSHA256: publicEvidenceDigest.sha256,
    cardanoProofBlake2b256: digest(cardanoProof).blake2b256,
    nativeVKBlake2b256: nativeVKDigest.blake2b256,
    cardanoVKBlake2b256: cardanoVKDigest.blake2b256,
    cardanoVKHex,
    manifest,
    candidate,
    transcript,
    snapshot,
  };
}

export async function exportDeploymentScripts({
  contractDir = CONTRACT_DIR,
  seedOutRef,
  cardanoVKHex,
  cardanoVKBlake2b256,
}) {
  const exportScript = async (mode, ...args) => {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        "cabal",
        ["v2-run", "--offline", "reclaim-scripts-export", "--", mode, ...args],
        {
          cwd: contractDir,
          maxBuffer: 256 * 1024 * 1024,
          env: minimalChildEnvironment(),
        },
      ));
    } catch {
      throw new MainnetPreparationError("script_export_failed", `Offline ${mode} script export failed.`);
    }
    return parseScriptExport(stdout, mode);
  };

  const oneShot = await exportScript("one-shot", seedOutRef.txHash, String(seedOutRef.outputIndex));
  const paramsPolicyID = mintingPolicyToId(oneShot).toLowerCase();
  const global = await exportScript(
    ...reclaimGlobalExportArgs("global-v2", paramsPolicyID, cardanoVKHex, normalizeBlake2b256(cardanoVKBlake2b256)),
  );
  assertReclaimGlobalProofSlotEncoding(
    global.proofSlotEncoding,
    global.batchTranscript,
    global.verifierVKHash,
    cardanoVKBlake2b256,
  );
  const reclaimGlobalScriptHash = validatorToScriptHash(global).toLowerCase();
  const base = await exportScript("base", reclaimGlobalScriptHash);
  const reclaimBaseScriptHash = validatorToScriptHash(base).toLowerCase();
  const holder = await exportScript("params-holder");
  const paramsHolderScriptHash = validatorToScriptHash(holder).toLowerCase();

  return {
    paramsPolicyID,
    paramsTokenName: PARAMS_TOKEN_NAME,
    paramsUnit: `${paramsPolicyID}${PARAMS_TOKEN_NAME}`,
    oneShot,
    global,
    base,
    holder,
    reclaimGlobalScriptHash,
    reclaimBaseScriptHash,
    paramsHolderScriptHash,
    reclaimBaseAddress: validatorToAddress(NETWORK, base),
    paramsHolderAddress: validatorToAddress(NETWORK, holder),
    reclaimGlobalRewardAddress: credentialToRewardAddress(NETWORK, scriptHashToCredential(reclaimGlobalScriptHash)),
  };
}

export function buildPreparationArtifacts({ source, release, scripts, decision, seedOutRef }) {
  const paramsDatum = Data.to(new Constr(0, [scripts.reclaimBaseScriptHash]));
  const voidDatum = Data.void();
  const manifest = {
    schema: "proof-tool-reclaim-deployment-v1",
    deployment_id: `mainnet:${scripts.reclaimBaseScriptHash}:${source.commit}`,
    network: NETWORK,
    network_id: NETWORK_ID,
    source_commit: source.commit,
    contract_version: "ownership-verifier-0.1.0.0",
    reclaim_base: {
      address: scripts.reclaimBaseAddress,
      script_hash: scripts.reclaimBaseScriptHash,
      required_global_credential: scripts.reclaimGlobalScriptHash,
    },
    reclaim_global: {
      script_hash: scripts.reclaimGlobalScriptHash,
      rewarding_credential: scripts.reclaimGlobalScriptHash,
      params_currency_symbol: scripts.paramsPolicyID,
      verifier_vk_hash: release.cardanoVKBlake2b256,
      proof_profile: "single-destination",
      proof_slot_encoding: PROOF_SLOT_ENCODING,
      batch_transcript_vk_hash: release.cardanoVKBlake2b256,
    },
    params_utxo: {
      tx_hash: null,
      output_index: 0,
      policy_id: scripts.paramsPolicyID,
      token_name: PARAMS_TOKEN_NAME,
      holder_address: scripts.paramsHolderAddress,
      datum_reclaim_base_script_hash: scripts.reclaimBaseScriptHash,
    },
    proof: {
      circuit_id: CIRCUIT_ID,
      key_version: KEY_VERSION,
      destination_address_encoding: "destination-address-v1",
      vk_hash: release.nativeVKBlake2b256,
      cardano_vk_blake2b256: release.cardanoVKBlake2b256,
      setup_transcript_hash: release.manifest.setup_transcript_hash,
      mpc_ceremony_id: release.ceremonyID,
      mpc_candidate_id: release.candidateID,
    },
    batching: {
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
    reference_scripts: {
      reclaim_base: {
        tx_hash: null,
        output_index: 1,
        script_hash: scripts.reclaimBaseScriptHash,
        holder_address: scripts.paramsHolderAddress,
      },
      reclaim_global: {
        tx_hash: null,
        output_index: 2,
        script_hash: scripts.reclaimGlobalScriptHash,
        holder_address: scripts.paramsHolderAddress,
      },
    },
    enabled: false,
    planning: {
      status: "unsigned-template-only",
      production_decision_id: decision.decisionID,
      mpc_release_id: decision.releaseID,
      source_signed_tag: source.signedTag,
      release_manifest_sha256: release.releaseManifestSHA256,
      mpc_candidate_schema: release.candidateSchema,
      mpc_verification_report_schema: release.verificationReportSchema,
      mpc_verification_report_sha256: release.verificationReportSHA256,
      mpc_public_evidence_schema: release.publicEvidenceSchema,
      mpc_public_evidence_sha256: release.publicEvidenceSHA256,
      mpc_cardano_proof_blake2b256: release.cardanoProofBlake2b256,
      unresolved_fields: [
        "params_utxo.tx_hash",
        "reference_scripts.reclaim_base.tx_hash",
        "reference_scripts.reclaim_global.tx_hash",
        "minimum_lovelace",
        "reward_account_registration_state",
        "provider_configuration",
      ],
    },
    provider: {
      primary: null,
      fallback: null,
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const plan = {
    schema: MAINNET_PREPARATION_SCHEMA,
    status: "dry-run-only",
    network: NETWORK,
    network_id: NETWORK_ID,
    submitted: false,
    ledger_network_access_used: false,
    signed_transaction_created: false,
    unsigned_transaction_cbor: null,
    wallet_secrets_used: false,
    source: {
      commit: source.commit,
      signed_tag: source.signedTag,
      clean: true,
    },
    mpc_release: {
      ceremony_id: release.ceremonyID,
      candidate_id: release.candidateID,
      manifest_sha256: release.releaseManifestSHA256,
      signature_key_id: release.manifest.signature_key_id,
      candidate_schema: release.candidateSchema,
      verification_report_schema: release.verificationReportSchema,
      verification_report_sha256: release.verificationReportSHA256,
      public_evidence_schema: release.publicEvidenceSchema,
      public_evidence_sha256: release.publicEvidenceSHA256,
      cardano_proof_blake2b256: release.cardanoProofBlake2b256,
      native_vk_blake2b256: release.nativeVKBlake2b256,
      cardano_vk_format: CARDANO_VK_FORMAT,
      cardano_vk_blake2b256: release.cardanoVKBlake2b256,
      exact_release_verification_passes: 2,
    },
    production_decision: {
      decision: "GO",
      decision_id: decision.decisionID,
      release_id: decision.releaseID,
      four_role_signatures_verified: true,
      source_tag_signer_fingerprint: decision.sourceTagSignerFingerprint,
      source_tag_object_sha256: decision.sourceTagObjectSHA256,
    },
    parameterization: {
      seed_out_ref: seedOutRef.canonical,
      params_policy_id: scripts.paramsPolicyID,
      params_token_name: PARAMS_TOKEN_NAME,
      params_unit: scripts.paramsUnit,
      reclaim_global_script_hash: scripts.reclaimGlobalScriptHash,
      reclaim_base_script_hash: scripts.reclaimBaseScriptHash,
      params_holder_script_hash: scripts.paramsHolderScriptHash,
      reclaim_base_address: scripts.reclaimBaseAddress,
      params_holder_address: scripts.paramsHolderAddress,
      reclaim_global_reward_address: scripts.reclaimGlobalRewardAddress,
      scripts: {
        one_shot_params_nft: {
          type: scripts.oneShot.type,
          script_cbor_hex: scripts.oneShot.script,
          policy_id: scripts.paramsPolicyID,
        },
        reclaim_global_v2: {
          type: scripts.global.type,
          script_cbor_hex: scripts.global.script,
          script_hash: scripts.reclaimGlobalScriptHash,
        },
        reclaim_base: {
          type: scripts.base.type,
          script_cbor_hex: scripts.base.script,
          script_hash: scripts.reclaimBaseScriptHash,
        },
        params_holder: {
          type: scripts.holder.type,
          script_cbor_hex: scripts.holder.script,
          script_hash: scripts.paramsHolderScriptHash,
        },
      },
      global_v2: {
        proof_slot_encoding: PROOF_SLOT_ENCODING,
        batch_transcript: BATCH_TRANSCRIPT,
        verifier_vk_hash: release.cardanoVKBlake2b256,
      },
    },
    reference_output_plan: {
      fixed_order_required: true,
      inputs: [
        {
          purpose: "one-shot params NFT seed",
          out_ref: seedOutRef.canonical,
          live_unspent_status: "must be rechecked immediately before transaction construction",
        },
      ],
      certificates: [
        {
          purpose: "register ReclaimGlobal rewarding credential when not already registered",
          credential: scripts.reclaimGlobalScriptHash,
          decision: "must be resolved from a fresh Mainnet ledger snapshot",
        },
      ],
      outputs: [
        {
          output_index: 0,
          purpose: "params NFT and ReclaimBase hash datum",
          address: scripts.paramsHolderAddress,
          assets: { [scripts.paramsUnit]: "1" },
          inline_datum_cbor: paramsDatum,
          reference_script_hash: null,
          minimum_lovelace: null,
        },
        {
          output_index: 1,
          purpose: "ReclaimBase reference script",
          address: scripts.paramsHolderAddress,
          assets: {},
          inline_datum_cbor: voidDatum,
          reference_script_hash: scripts.reclaimBaseScriptHash,
          reference_script_cbor_hex: scripts.base.script,
          minimum_lovelace: null,
        },
        {
          output_index: 2,
          purpose: "ReclaimGlobal reference script",
          address: scripts.paramsHolderAddress,
          assets: {},
          inline_datum_cbor: voidDatum,
          reference_script_hash: scripts.reclaimGlobalScriptHash,
          reference_script_cbor_hex: scripts.global.script,
          minimum_lovelace: null,
        },
      ],
      build_gate:
        "Resolve protocol parameters, registration state, seed UTxO status, min lovelace, fees, collateral, change, and output indexes in a separately reviewed transaction-building step.",
    },
    unsigned_manifest: {
      filename: UNSIGNED_MANIFEST_FILENAME,
      sha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
      enabled: false,
      unresolved_transaction_fields: true,
    },
    prohibited_actions: [
      "wallet secret loading",
      "transaction signing",
      "transaction submission",
      "provider mutation",
      "deployment manifest activation",
    ],
  };
  return {
    [DEPLOYMENT_PLAN_FILENAME]: Buffer.from(`${JSON.stringify(plan, null, 2)}\n`),
    [UNSIGNED_MANIFEST_FILENAME]: manifestBytes,
  };
}

export function publishPreparation(outDir, artifacts) {
  const parent = path.dirname(outDir);
  let staging = "";
  try {
    staging = mkdtempSync(path.join(parent, ".mainnet-preparation.partial."), { encoding: "utf8" });
    chmodPrivateDirectory(staging);
  } catch {
    if (staging) rmSync(staging, { recursive: true, force: true });
    throw new MainnetPreparationError(
      "preparation_publication_failed",
      "Could not create a private Mainnet preparation staging directory.",
    );
  }
  let destinationCreated = false;
  try {
    for (const [name, bytes] of Object.entries(artifacts)) {
      writeFileSync(path.join(staging, name), bytes, { flag: "wx", mode: 0o600 });
    }
    // mkdir is the no-replacement publication boundary. Move each complete
    // file only after this process exclusively owns the fresh destination.
    // A crash can leave an incomplete, disabled preparation directory, but it
    // cannot replace any prior artifact and cannot create an active manifest.
    mkdirSync(outDir, { mode: 0o700 });
    destinationCreated = true;
    for (const name of Object.keys(artifacts)) {
      renameSync(path.join(staging, name), path.join(outDir, name));
    }
    rmSync(staging, { recursive: true });
  } catch (error) {
    if (destinationCreated) {
      rmSync(outDir, { recursive: true, force: true });
    }
    throw new MainnetPreparationError(
      "preparation_publication_failed",
      `Could not publish the fresh Mainnet preparation: ${error?.code ?? "write_failed"}.`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return {
    plan: path.join(outDir, DEPLOYMENT_PLAN_FILENAME),
    unsignedManifest: path.join(outDir, UNSIGNED_MANIFEST_FILENAME),
  };
}

function parseScriptExport(stdout, mode) {
  let parsed;
  try {
    const start = stdout.indexOf("{");
    if (start < 0) throw new Error("missing JSON");
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    throw new MainnetPreparationError("script_export_malformed", `Offline ${mode} export was not valid JSON.`);
  }
  const expectedName = {
    "one-shot": "one-shot-params-nft",
    "global-v2": "reclaim-global-v2",
    base: "reclaim-base",
    "params-holder": "reclaim-params-holder",
  }[mode];
  if (
    parsed.schema !== "proof-tool-reclaim-script-export-v1" ||
    parsed.name !== expectedName ||
    parsed.type !== "PlutusV3" ||
    !/^[0-9a-f]+$/u.test(parsed.script ?? "") ||
    parsed.script.length % 2 !== 0
  ) {
    throw new MainnetPreparationError(
      "script_export_identity_invalid",
      `Offline ${mode} export has unexpected identity or script bytes.`,
    );
  }
  return {
    type: parsed.type,
    script: parsed.script,
    proofSlotEncoding: parsed.proof_slot_encoding,
    batchTranscript: parsed.batch_transcript,
    verifierVKHash: parsed.verifier_vk_hash,
  };
}

function parseSeedOutRef(value) {
  const match = /^([0-9a-f]{64})#(0|[1-9][0-9]*)$/u.exec(typeof value === "string" ? value.trim() : "");
  if (!match) {
    throw new MainnetPreparationError(
      "seed_out_ref_invalid",
      "--seed-out-ref must be a lowercase 32-byte transaction hash and non-negative index joined by #.",
    );
  }
  const outputIndex = Number(match[2]);
  if (!Number.isSafeInteger(outputIndex)) {
    throw new MainnetPreparationError("seed_out_ref_invalid", "Seed output index exceeds the safe integer range.");
  }
  return { txHash: match[1], outputIndex, canonical: `${match[1]}#${outputIndex}` };
}

function planningSnapshot(releaseDir) {
  const names = [
    "manifest.json",
    "manifest.sig",
    "manifest-public-key.hex",
    "candidate.json",
    "candidate.sig.json",
    "candidate-checksums.sha256",
    "setup-transcript.json",
    "verification-report.json",
    "public-finalization-evidence.json",
    "ownership.vk",
    "cardano-vk.bin",
    "cardano-vk.hex",
    "cardano-vk-format.txt",
    "checksums.sha256",
  ];
  return Object.fromEntries(names.map((name) => [name, fileIdentity(path.join(releaseDir, name))]));
}

function assertReleasePlanningSnapshot(releaseDir, expected) {
  const actual = planningSnapshot(releaseDir);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new MainnetPreparationError(
      "mpc_release_changed",
      "MPC release planning artifacts changed during Mainnet preparation.",
    );
  }
}

function trustedInputSnapshot(options) {
  return Object.fromEntries(
    [
      ["ceremony", options.ceremonyPath],
      ["ceremony_signature", options.ceremonySignaturePath],
      ["coordinator_public_key", options.coordinatorPublicKeyPath],
      ["release_public_key", options.releasePublicKeyPath],
      ["production_decision", options.decisionRecordPath],
      ...options.decisionSignaturePaths.map((file, index) => [`production_decision_signature_${index + 1}`, file]),
    ].map(([name, file]) => [name, fileIdentity(file)]),
  );
}

function assertTrustedInputSnapshot(options, expected) {
  if (JSON.stringify(trustedInputSnapshot(options)) !== JSON.stringify(expected)) {
    throw new MainnetPreparationError(
      "trusted_input_changed",
      "A ceremony or production-decision trust input changed during Mainnet preparation.",
    );
  }
}

function fileIdentity(file) {
  requireRegularNoSymlink(file, "MPC release artifact");
  const bytes = readFileSync(file);
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function assertArtifactDigest(ref, expectedName, actual, label) {
  exact(ref?.name, expectedName, `${label} filename`);
  exact(ref?.digest?.sha256, actual.sha256, `${label} sha256`);
  exact(ref?.digest?.blake2b256, actual.blake2b256, `${label} blake2b256`);
  exact(ref?.digest?.size, actual.size, `${label} size`);
}

function assertExactDigest(actual, expected, label) {
  exact(actual?.sha256, expected.sha256, `${label} sha256`);
  exact(actual?.blake2b256, expected.blake2b256, `${label} blake2b256`);
  exact(actual?.size, expected.size, `${label} size`);
}

function decodeExactHex(value, expectedBytes, label) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${expectedBytes * 2}}$`, "u").test(value)) {
    throw new MainnetPreparationError(
      "coherence_mismatch",
      `${label} is not exactly ${expectedBytes} lowercase hexadecimal bytes.`,
    );
  }
  return Buffer.from(value, "hex");
}

function digest(bytes) {
  return {
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    blake2b256: `blake2b256:${Buffer.from(blake2b(Uint8Array.from(bytes), { dkLen: 32 })).toString("hex")}`,
    size: bytes.length,
  };
}

function parseJSON(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new MainnetPreparationError("release_json_malformed", `${label} is not valid JSON.`);
  }
}

function exact(actual, expected, label) {
  if (actual !== expected) {
    throw new MainnetPreparationError("coherence_mismatch", `${label} does not match the required value.`);
  }
}

function readRegular(root, name, maximum) {
  const file = path.join(root, name);
  requireRegularNoSymlink(file, `MPC release ${name}`);
  requireBoundedSize(file, maximum, `MPC release ${name}`);
  return readFileSync(file);
}

function readRegularAbsolute(file, label, maximum) {
  requireRegularNoSymlink(file, label);
  requireBoundedSize(file, maximum, label);
  return readFileSync(file);
}

function requireBoundedSize(file, maximum, label) {
  const size = statSync(file).size;
  if (!Number.isSafeInteger(size) || size <= 0 || size > maximum) {
    throw new MainnetPreparationError(
      "required_file_size_invalid",
      `${label} size must be within 1..${maximum} bytes.`,
    );
  }
}

function chmodPrivateDirectory(dir) {
  try {
    chmodSync(dir, 0o700);
  } catch {
    throw new MainnetPreparationError(
      "preparation_publication_failed",
      "Could not create preparation staging directory.",
    );
  }
}

function requireRegularNoSymlink(file, label) {
  let info;
  try {
    info = lstatSync(file);
  } catch {
    throw new MainnetPreparationError("required_file_invalid", `${label} must be an existing regular file.`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new MainnetPreparationError("required_file_invalid", `${label} must be a non-symlink regular file.`);
  }
}

function requireRealDirectory(dir, label) {
  let info;
  try {
    info = lstatSync(dir);
  } catch {
    throw new MainnetPreparationError("required_directory_invalid", `${label} must be an existing real directory.`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new MainnetPreparationError("required_directory_invalid", `${label} must be a non-symlink directory.`);
  }
}

function requireExternalTrustAnchor(file, releaseDir, label) {
  const canonicalFile = realpathSync(file);
  const canonicalRelease = realpathSync(releaseDir);
  const relative = path.relative(canonicalRelease, canonicalFile);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw new MainnetPreparationError(
      "trust_anchor_not_external",
      `The out-of-band ${label} must be outside the MPC release directory.`,
    );
  }
}

function requirePathOutside(target, protectedRoot, targetLabel, protectedLabel) {
  const canonicalProtected = realpathSync(protectedRoot);
  const canonicalTarget = path.join(realpathSync(path.dirname(target)), path.basename(target));
  const relative = path.relative(canonicalProtected, canonicalTarget);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw new MainnetPreparationError("unsafe_output_path", `${targetLabel} must be outside the ${protectedLabel}.`);
  }
}

function isSymlink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolvePath(root, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

async function execGit(repoRoot, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
      env: minimalChildEnvironment(),
    });
    return stdout;
  } catch {
    throw new MainnetPreparationError("git_verification_failed", "Git source verification failed.");
  }
}

function minimalChildEnvironment() {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "GNUPGHOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "CABAL_CONFIG",
    "CABAL_DIR",
    "GHC_ENVIRONMENT",
    "LD_LIBRARY_PATH",
  ];
  const env = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.LC_ALL = "C";
  env.TZ = "UTC";
  return env;
}

function normalizeBlake2b256(value) {
  return String(value).replace(/^blake2b256:/u, "");
}

function parseCLI(argv) {
  const values = {};
  const booleanFlags = new Set(["--dry-run"]);
  const mapping = {
    "--network": "network",
    "--network-id": "networkId",
    "--source-signed-tag": "sourceSignedTag",
    "--mpc-ceremony-bin": "mpcCeremonyBin",
    "--ceremony": "ceremonyPath",
    "--ceremony-signature": "ceremonySignaturePath",
    "--coordinator-public-key-file": "coordinatorPublicKeyPath",
    "--release-dir": "releaseDir",
    "--release-public-key-file": "releasePublicKeyPath",
    "--release-signature-key-id": "releaseSignatureKeyID",
    "--seed-out-ref": "seedOutRef",
    "--production-decision": "decisionRecordPath",
    "--decision-evidence-root": "decisionEvidenceRoot",
    "--decision-signature": "decisionSignaturePaths",
    "--out-dir": "outDir",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (booleanFlags.has(flag)) {
      if (values.dryRun) throw new MainnetPreparationError("usage_error", `${flag} was supplied more than once.`);
      values.dryRun = true;
      continue;
    }
    const field = mapping[flag];
    if (!field || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new MainnetPreparationError("usage_error", `Unknown or incomplete option: ${flag}`);
    }
    if (field === "decisionSignaturePaths") {
      values[field] ??= [];
      values[field].push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (values[field] !== undefined) {
      throw new MainnetPreparationError("usage_error", `${flag} was supplied more than once.`);
    }
    values[field] = argv[index + 1];
    index += 1;
  }
  return values;
}

async function main() {
  try {
    const result = await prepareReclaimMainnet(parseCLI(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error?.code ?? "mainnet_preparation_failed";
    const message = error?.message ?? String(error);
    process.stderr.write(`Mainnet deployment preparation failed closed: ${code}: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
