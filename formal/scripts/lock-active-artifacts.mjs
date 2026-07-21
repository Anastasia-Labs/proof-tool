#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const formalDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(formalDir, "..");
const contractDir = path.join(repoRoot, "contracts", "ownership-verifier");
const appDir = path.join(repoRoot, "apps", "ownership-proof-web");
const artifactDir = path.join(formalDir, "artifacts", "active-preprod");
const manifestPath = path.join(appDir, "public", "proof-assets", "reclaim-deployment.json");
const chainEvidencePath = path.join(formalDir, "assurance", "public-deployment-chain.json");
const vkPath = path.join(contractDir, "testdata", "ownership-destination-vk.hex");
const reportPath = path.join(formalDir, "assurance", "artifact-regeneration.json");
const cabalBuildSummary = "/tmp/proof-tool-formal-exporter-build-summary.log";
const cabalBuildLog = "/tmp/proof-tool-formal-exporter-build.log";

const requireFromApp = createRequire(path.join(appDir, "package.json"));
const { mintingPolicyToId, validatorToScriptHash } = requireFromApp("@lucid-evolution/lucid");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function runFile(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${file} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  // The managed Codex sandbox can attach EPERM to a completed nested spawn
  // while still returning status 0 and complete stdout. Status and output are
  // authoritative here; ordinary environments leave result.error undefined.
  if (result.error && result.error.code !== "EPERM") {
    throw result.error;
  }
  return result.stdout ?? "";
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function git(args) {
  return runFile("git", args, { cwd: repoRoot }).trim();
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runBinaryFile(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stderr?.toString("utf8")]
      .filter(Boolean)
      .join("\n");
    throw new Error(`${file} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  if (result.error && result.error.code !== "EPERM") {
    throw result.error;
  }
  return result.stdout ?? Buffer.alloc(0);
}

function materializeDeploymentSource(commit) {
  const root = mkdtempSync(path.join(tmpdir(), "proof-tool-formal-deployment-"));
  const archive = runBinaryFile(
    "git",
    ["archive", "--format=tar", commit, "contracts/ownership-verifier"],
    { cwd: repoRoot },
  );
  runFile("tar", ["-xf", "-", "-C", root], { input: archive });
  return root;
}

function buildExporter(exporterContractDir) {
  runFile(
    "cabal",
    [
      "build",
      `--build-summary=${cabalBuildSummary}`,
      `--build-log=${cabalBuildLog}`,
      "exe:reclaim-scripts-export",
    ],
    { cwd: exporterContractDir },
  );
  return runFile(
    "cabal",
    ["list-bin", "exe:reclaim-scripts-export"],
    { cwd: exporterContractDir },
  ).trim();
}

function exportScript(mode, ...args) {
  const stdout = runFile(
    exporterPath,
    [mode, ...args],
    { cwd: deploymentContractDir, maxBuffer: 256 * 1024 * 1024 },
  );
  const jsonStart = stdout.indexOf("{");
  expect(jsonStart >= 0, `exporter produced no JSON for ${mode}`);
  const artifact = JSON.parse(stdout.slice(jsonStart));
  expect(artifact.schema === "proof-tool-reclaim-script-export-v1", `${mode}: unexpected exporter schema`);
  expect(artifact.type === "PlutusV3", `${mode}: expected PlutusV3`);
  expect(/^(?:[0-9a-f]{2})+$/u.test(artifact.script), `${mode}: script is not canonical lowercase hex`);
  return artifact;
}

function validatorIdentity(artifact) {
  return validatorToScriptHash({ type: artifact.type, script: artifact.script }).toLowerCase();
}

function policyIdentity(artifact) {
  return mintingPolicyToId({ type: artifact.type, script: artifact.script }).toLowerCase();
}

function artifactRecord(file, artifact, identityKind, actualIdentity, expectedIdentity, extra = {}) {
  const scriptBytes = Buffer.from(artifact.script, "hex");
  return {
    file: path.relative(repoRoot, file),
    exporter_name: artifact.name,
    type: artifact.type,
    import_format: "single_cbor_hex",
    script_cbor_bytes: scriptBytes.length,
    script_cbor_sha256: sha256Bytes(scriptBytes),
    identity_kind: identityKind,
    actual_identity: actualIdentity,
    expected_identity: expectedIdentity,
    identity_matches: actualIdentity === expectedIdentity,
    ...extra,
  };
}

const manifest = readJson(manifestPath);
const chainEvidence = readJson(chainEvidencePath);
const verifierKeyHex = readFileSync(vkPath, "utf8").trim().toLowerCase();
const verifierKeyHash = manifest.proof.cardano_vk_blake2b256.replace(/^blake2b256:/u, "");
const seed = chainEvidence.one_shot_seed;

expect(manifest.enabled === true, "active reclaim deployment is not enabled");
expect(manifest.network === "Preprod", "artifact lock is intentionally Preprod-only");
expect(/^[0-9a-f]{1344}$/u.test(verifierKeyHex), "Cardano verifier key must be exactly 672 bytes");
expect(/^[0-9a-f]{64}$/u.test(verifierKeyHash), "Cardano verifier-key hash must be exactly 32 bytes");
expect(
  chainEvidence.deployment_transaction.tx_hash === manifest.params_utxo.tx_hash,
  "public chain evidence and active manifest refer to different deployments",
);

const sourcePaths = [
  "contracts/ownership-verifier/src",
  "contracts/ownership-verifier/export",
  "contracts/ownership-verifier/ownership-verifier.cabal",
];
const sourceIdentity = Object.fromEntries(
  sourcePaths.map((sourcePath) => {
    const deploymentIdentity = git(["rev-parse", `${manifest.source_commit}:${sourcePath}`]);
    const headIdentity = git(["rev-parse", `HEAD:${sourcePath}`]);
    return [sourcePath, {
      deployment: deploymentIdentity,
      contract_baseline: headIdentity,
      match: deploymentIdentity === headIdentity,
    }];
  }),
);

const contractBaselineCommit = git([
  "log",
  "-1",
  "--format=%H",
  "--",
  ...sourcePaths,
]);
const deploymentSourceRoot = materializeDeploymentSource(manifest.source_commit);
process.on("exit", () => rmSync(deploymentSourceRoot, { recursive: true, force: true }));
const deploymentContractDir = path.join(
  deploymentSourceRoot,
  "contracts",
  "ownership-verifier",
);
const exporterPath = buildExporter(deploymentContractDir);

const oneShot = exportScript("one-shot", seed.tx_hash, String(seed.output_index));
const paramsHolder = exportScript("params-holder");
const reclaimGlobalV2 = exportScript(
  "global-v2",
  manifest.params_utxo.policy_id,
  manifest.params_utxo.token_name,
  verifierKeyHex,
  verifierKeyHash,
);
const reclaimBase = exportScript("base", manifest.reclaim_global.script_hash);

expect(
  reclaimGlobalV2.proof_slot_encoding === manifest.reclaim_global.proof_slot_encoding,
  "global-v2 proof-slot encoding differs from manifest",
);
expect(reclaimGlobalV2.batch_transcript === "statement-bound-v2", "global-v2 transcript is not statement-bound-v2");
const embeddedVerifierKeyHash = reclaimGlobalV2.verifier_vk_hash.replace(/^blake2b256:/u, "");
expect(embeddedVerifierKeyHash === verifierKeyHash, "global-v2 embedded verifier-key hash differs");

const artifactFiles = {
  one_shot_params_nft: path.join(artifactDir, "one-shot-params-nft.plutus.json"),
  params_holder: path.join(artifactDir, "reclaim-params-holder.plutus.json"),
  reclaim_global_v2: path.join(artifactDir, "reclaim-global-v2.plutus.json"),
  reclaim_base: path.join(artifactDir, "reclaim-base.plutus.json"),
};
const leanImportFiles = {
  one_shot_params_nft: path.join(artifactDir, "one-shot-params-nft.cbor.hex"),
  params_holder: path.join(artifactDir, "reclaim-params-holder.cbor.hex"),
  reclaim_global_v2: path.join(artifactDir, "reclaim-global-v2.cbor.hex"),
  reclaim_base: path.join(artifactDir, "reclaim-base.cbor.hex"),
};

const artifacts = {
  one_shot_params_nft: artifactRecord(
    artifactFiles.one_shot_params_nft,
    oneShot,
    "policy_id",
    policyIdentity(oneShot),
    manifest.params_utxo.policy_id,
    {
      lean_import_file: path.relative(repoRoot, leanImportFiles.one_shot_params_nft),
      seed_tx_out_ref: seed.out_ref,
      chain_script_cbor_bytes: chainEvidence.deployment_transaction.mint.script_size_bytes,
      chain_script_cbor_sha256: chainEvidence.deployment_transaction.mint.script_cbor_sha256,
    },
  ),
  params_holder: artifactRecord(
    artifactFiles.params_holder,
    paramsHolder,
    "script_hash",
    validatorIdentity(paramsHolder),
    chainEvidence.deployment_transaction.outputs.params.holder_script_hash,
    { lean_import_file: path.relative(repoRoot, leanImportFiles.params_holder) },
  ),
  reclaim_global_v2: artifactRecord(
    artifactFiles.reclaim_global_v2,
    reclaimGlobalV2,
    "script_hash",
    validatorIdentity(reclaimGlobalV2),
    manifest.reclaim_global.script_hash,
    {
      lean_import_file: path.relative(repoRoot, leanImportFiles.reclaim_global_v2),
      chain_script_cbor_bytes: chainEvidence.deployment_transaction.outputs.reclaim_global_reference.script_size_bytes,
      chain_script_cbor_sha256: chainEvidence.deployment_transaction.outputs.reclaim_global_reference.script_cbor_sha256,
      proof_slot_encoding: reclaimGlobalV2.proof_slot_encoding,
      batch_transcript: reclaimGlobalV2.batch_transcript,
      verifier_vk_hash: embeddedVerifierKeyHash,
    },
  ),
  reclaim_base: artifactRecord(
    artifactFiles.reclaim_base,
    reclaimBase,
    "script_hash",
    validatorIdentity(reclaimBase),
    manifest.reclaim_base.script_hash,
    {
      lean_import_file: path.relative(repoRoot, leanImportFiles.reclaim_base),
      chain_script_cbor_bytes: chainEvidence.deployment_transaction.outputs.reclaim_base_reference.script_size_bytes,
      chain_script_cbor_sha256: chainEvidence.deployment_transaction.outputs.reclaim_base_reference.script_cbor_sha256,
    },
  ),
};

for (const [name, artifact] of Object.entries(artifacts)) {
  expect(artifact.identity_matches, `${name}: regenerated identity differs from the active deployment`);
  if (artifact.chain_script_cbor_bytes !== undefined) {
    expect(
      artifact.script_cbor_bytes === artifact.chain_script_cbor_bytes,
      `${name}: regenerated byte length differs from the public reference script`,
    );
    expect(
      artifact.script_cbor_sha256 === artifact.chain_script_cbor_sha256,
      `${name}: regenerated bytes differ from the public on-chain script`,
    );
  }
}

const report = {
  schema: "proof-tool-active-artifact-regeneration-v1",
  network: manifest.network,
  deployment_transaction: manifest.params_utxo.tx_hash,
  deployment_source_commit: manifest.source_commit,
  workspace_contract_baseline_commit: contractBaselineCommit,
  source_identity: sourceIdentity,
  inputs: {
    active_manifest: path.relative(repoRoot, manifestPath),
    active_manifest_sha256: sha256File(manifestPath),
    public_chain_evidence: path.relative(repoRoot, chainEvidencePath),
    public_chain_evidence_sha256: sha256File(chainEvidencePath),
    cardano_verifier_key: path.relative(repoRoot, vkPath),
    cardano_verifier_key_file_sha256: sha256File(vkPath),
    cardano_verifier_key_blake2b256: verifierKeyHash,
  },
  exporter: {
    source: `git archive ${manifest.source_commit}:contracts/ownership-verifier`,
    cwd: "<temporary deployment-source archive>/contracts/ownership-verifier",
    executable: "<cabal list-bin exe:reclaim-scripts-export>",
    command_shape: "<deployment-source exporter> <mode> <public parameters>",
  },
  artifacts,
  all_identities_match: Object.values(artifacts).every((artifact) => artifact.identity_matches),
};

mkdirSync(artifactDir, { recursive: true });
for (const [name, artifact] of Object.entries({
  one_shot_params_nft: oneShot,
  params_holder: paramsHolder,
  reclaim_global_v2: reclaimGlobalV2,
  reclaim_base: reclaimBase,
})) {
  writeFileSync(artifactFiles[name], `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(leanImportFiles[name], `${artifact.script}\n`, { mode: 0o644 });
}
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
