#!/usr/bin/env node

// Reproduce the current GlobalV2/Base pair in deployer order and require it to
// be byte-identical to the active deployment. The legacy "candidate" artifact
// paths remain as proof-input aliases so existing theorem names stay stable.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const formalDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(formalDir, "..");
const contractDir = path.join(repoRoot, "contracts", "ownership-verifier");
const appDir = path.join(repoRoot, "apps", "ownership-proof-web");
const manifestPath = path.join(
  appDir,
  "public",
  "proof-assets",
  "reclaim-deployment.json",
);
const evidencePath = path.join(
  formalDir,
  "assurance",
  "reclaim-base-evidence.json",
);
const baseCandidateJsonPath = path.join(
  formalDir,
  "artifacts",
  "candidate",
  "reclaim-base.plutus.json",
);
const baseCandidateHexPath = path.join(
  formalDir,
  "artifacts",
  "candidate",
  "reclaim-base.cbor.hex",
);
const chainEvidencePath = path.join(
  formalDir,
  "assurance",
  "public-deployment-chain.json",
);
const activeArtifactDir = path.join(formalDir, "artifacts", "active-preprod");
const verifierKeyPath = path.join(
  contractDir,
  "testdata",
  "ownership-destination-vk.hex",
);
const globalCandidateEvidencePath = path.join(
  formalDir,
  "assurance",
  "reclaim-global-v2-candidate-evidence.json",
);
const globalCandidateJsonPath = path.join(
  formalDir,
  "artifacts",
  "candidate",
  "reclaim-global-v2.plutus.json",
);
const globalCandidateHexPath = path.join(
  formalDir,
  "artifacts",
  "candidate",
  "reclaim-global-v2.cbor.hex",
);

const args = process.argv.slice(2);
expect(
  args.length === 0 || (args.length === 1 && args[0] === "--refresh"),
  "usage: verify-current-candidates.mjs [--refresh]",
);
const refresh = args[0] === "--refresh";

const requireFromApp = createRequire(path.join(appDir, "package.json"));
const { validatorToScriptHash } = requireFromApp("@lucid-evolution/lucid");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function runFile(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stderr]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${file} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`,
    );
  }
  if (result.error && result.error.code !== "EPERM") throw result.error;
  return result.stdout ?? "";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const manifest = readJson(manifestPath);
const evidence = readJson(evidencePath);
const chainEvidence = readJson(chainEvidencePath);
const activeParameter = manifest.reclaim_base.required_global_credential;

expect(
  activeParameter === manifest.reclaim_global.script_hash,
  "active manifest Base parameter and GlobalV2 identity disagree",
);

runFile(
  "cabal",
  [
    "build",
    "--build-summary=/tmp/proof-tool-formal-candidate-build-summary.log",
    "--build-log=/tmp/proof-tool-formal-candidate-build.log",
    "exe:reclaim-scripts-export",
  ],
  { cwd: contractDir },
);
const exporter = runFile(
  "cabal",
  ["list-bin", "exe:reclaim-scripts-export"],
  { cwd: contractDir },
).trim();

function exportCurrent(args) {
  const stdout = runFile(exporter, args, {
    cwd: contractDir,
    maxBuffer: 256 * 1024 * 1024,
  });
  const jsonStart = stdout.indexOf("{");
  expect(jsonStart >= 0, `current exporter produced no JSON for ${args[0]}`);
  return JSON.parse(stdout.slice(jsonStart));
}

function expectActiveBytes(label, exported, artifactFile) {
  const active = readJson(path.join(activeArtifactDir, artifactFile));
  expect(exported.type === "PlutusV3", `${label} is not PlutusV3`);
  const currentBytes = Buffer.from(exported.script, "hex");
  const activeBytes = Buffer.from(active.script, "hex");
  expect(
    exported.script === active.script,
    `${label} current-source bytes differ from the active artifact: current sha256=${sha256(currentBytes)}, active sha256=${sha256(activeBytes)}`,
  );
  return {
    script_cbor_sha256: sha256(currentBytes),
    byte_identical_to_active: true,
  };
}

const verifierKeyHex = readFileSync(verifierKeyPath, "utf8").trim();
const verifierKeyHash = manifest.proof.cardano_vk_blake2b256.replace(/^blake2b256:/u, "");
const contractBaselineCommit = runFile(
  "git",
  [
    "log",
    "-1",
    "--format=%H",
    "--",
    "contracts/ownership-verifier/src",
    "contracts/ownership-verifier/export",
    "contracts/ownership-verifier/ownership-verifier.cabal",
  ],
  { cwd: repoRoot },
).trim();
const seed = chainEvidence.one_shot_seed;
const currentOneShot = exportCurrent([
  "one-shot",
  seed.tx_hash,
  String(seed.output_index),
]);
const currentParamsHolder = exportCurrent(["params-holder"]);
const currentGlobalV2 = exportCurrent([
  "global-v2",
  manifest.params_utxo.policy_id,
  manifest.params_utxo.token_name,
  verifierKeyHex,
  verifierKeyHash,
]);
expect(
  currentGlobalV2.proof_slot_encoding === manifest.reclaim_global.proof_slot_encoding,
  "current GlobalV2 proof-slot encoding differs from the active manifest",
);
expect(
  currentGlobalV2.batch_transcript === "statement-bound-v2",
  "current GlobalV2 transcript is not statement-bound-v2",
);
expect(
  currentGlobalV2.verifier_vk_hash === `blake2b256:${verifierKeyHash}`,
  "current GlobalV2 verifier-key hash differs from the active manifest",
);
const unchangedActiveArtifacts = {
  one_shot_params_nft: expectActiveBytes(
    "OneShotNFT",
    currentOneShot,
    "one-shot-params-nft.plutus.json",
  ),
  params_holder: expectActiveBytes(
    "ParamsHolder",
    currentParamsHolder,
    "reclaim-params-holder.plutus.json",
  ),
};

const activeGlobalIdentity = expectActiveBytes(
  "ReclaimGlobalV2",
  currentGlobalV2,
  "reclaim-global-v2.plutus.json",
);
const globalCandidateBytes = Buffer.from(currentGlobalV2.script, "hex");
const globalCandidateRecord = {
  schema: "proof-tool-reclaim-global-v2-active-alias-evidence-v1",
  recorded_at: "2026-07-21",
  deployment_status:
    "active Preprod deployment; current source and active reference-script bytes are identical",
  contract_baseline_commit: contractBaselineCommit,
  applied_parameters: {
    params_policy_id: manifest.params_utxo.policy_id,
    params_token_name: manifest.params_utxo.token_name,
    verifier_key_blake2b256: manifest.proof.cardano_vk_blake2b256,
  },
  artifact_file: path.relative(repoRoot, globalCandidateHexPath),
  artifact_json_file: path.relative(repoRoot, globalCandidateJsonPath),
  script_cbor_bytes: globalCandidateBytes.length,
  script_cbor_sha256: sha256(globalCandidateBytes),
  script_hash: validatorToScriptHash({
    type: currentGlobalV2.type,
    script: currentGlobalV2.script,
  }).toLowerCase(),
  active_preprod_script_hash: manifest.reclaim_global.script_hash,
  active_preprod_script_cbor_sha256: activeGlobalIdentity.script_cbor_sha256,
  artifact_alias_note:
    "The candidate-named path and theorem names are retained for proof-history stability; the bytes and identity are exactly the active Preprod deployment.",
  concrete_replays: [
    {
      fixture: "candidate-reclaim-global-v2-success",
      expected: "successfulHalt",
      lean_theorem:
        "ProofToolFormal.ReclaimGlobalV2Candidate.exact_candidate_real_proof_succeeds",
    },
    {
      fixture: "candidate-reclaim-global-v2-substituted-digest",
      expected: "validatorError",
      lean_theorem:
        "ProofToolFormal.ReclaimGlobalV2Candidate.exact_candidate_substituted_digest_rejects_within_fuel",
    },
    {
      fixture: "candidate-reclaim-global-v2-noncanonical-param-datum-tag",
      expected: "successfulHalt",
      lean_theorem:
        "ProofToolFormal.ReclaimGlobalV2Candidate.exact_candidate_noncanonical_param_datum_tag_succeeds",
    },
    {
      fixture: "candidate-reclaim-global-v2-noncanonical-base-datum-tag",
      expected: "successfulHalt",
      lean_theorem:
        "ProofToolFormal.ReclaimGlobalV2Candidate.exact_candidate_noncanonical_base_datum_tag_succeeds",
    },
    {
      fixture: "candidate-reclaim-global-v2-malformed-redeemer",
      expected: "validatorError",
      lean_theorem:
        "ProofToolFormal.ReclaimGlobalV2Candidate.exact_candidate_unit_redeemer_rejects_within_fuel",
    },
  ],
};
if (refresh) {
  mkdirSync(path.dirname(globalCandidateJsonPath), { recursive: true });
  writeFileSync(
    globalCandidateJsonPath,
    `${JSON.stringify(currentGlobalV2, null, 2)}\n`,
    { mode: 0o644 },
  );
  writeFileSync(globalCandidateHexPath, `${currentGlobalV2.script}\n`, {
    mode: 0o644,
  });
  writeFileSync(
    globalCandidateEvidencePath,
    `${JSON.stringify(globalCandidateRecord, null, 2)}\n`,
    { mode: 0o644 },
  );
}
const lockedGlobalCandidate = readJson(globalCandidateEvidencePath);
expect(
  readFileSync(globalCandidateHexPath, "utf8").trim() === currentGlobalV2.script,
  "current GlobalV2 bytes differ from the locked candidate artifact",
);
expect(
  readJson(globalCandidateJsonPath).script === currentGlobalV2.script,
  "current GlobalV2 JSON differs from the locked candidate artifact",
);
expect(
  JSON.stringify(lockedGlobalCandidate) === JSON.stringify(globalCandidateRecord),
  "current GlobalV2 evidence differs from the locked candidate record",
);

// Deployment constructs GlobalV2 first and applies its resulting credential to
// ReclaimBase. Lock the pair in that same order.
const parameter = globalCandidateRecord.script_hash;
const exported = exportCurrent(["base", parameter]);

expect(exported.type === "PlutusV3", "candidate is not PlutusV3");
const bytes = Buffer.from(exported.script, "hex");
const digest = sha256(bytes);
const identity = validatorToScriptHash({
  type: exported.type,
  script: exported.script,
}).toLowerCase();
expect(
  identity === manifest.reclaim_base.script_hash,
  "current ReclaimBase identity differs from the active deployed Base",
);
const activeBaseIdentity = expectActiveBytes(
  "ReclaimBase",
  exported,
  "reclaim-base.plutus.json",
);

const baseCandidateRecord = {
  ...evidence.current_source_candidate,
  deployment_status:
    "active Preprod deployment; current source and active reference-script bytes are identical",
  artifact_file: path.relative(repoRoot, baseCandidateHexPath),
  export_json: path.relative(repoRoot, baseCandidateJsonPath),
  contract_baseline_commit: contractBaselineCommit,
  applied_global_credential: parameter,
  script_hash: identity,
  script_cbor_bytes: bytes.length,
  script_cbor_sha256: digest,
};
const refreshedBaseEvidence = {
  ...evidence,
  recorded_at: "2026-07-21",
  current_source_candidate: baseCandidateRecord,
};
if (refresh) {
  writeFileSync(
    baseCandidateJsonPath,
    `${JSON.stringify(exported, null, 2)}\n`,
    { mode: 0o644 },
  );
  writeFileSync(baseCandidateHexPath, `${exported.script}\n`, { mode: 0o644 });
  writeFileSync(evidencePath, `${JSON.stringify(refreshedBaseEvidence, null, 2)}\n`, {
    mode: 0o644,
  });
}
const lockedBaseEvidence = readJson(evidencePath);
expect(
  readFileSync(baseCandidateHexPath, "utf8").trim() === exported.script,
  "current ReclaimBase bytes differ from the locked coherent candidate artifact",
);
expect(
  readJson(baseCandidateJsonPath).script === exported.script,
  "current ReclaimBase JSON differs from the locked coherent candidate artifact",
);
expect(
  JSON.stringify(lockedBaseEvidence.current_source_candidate) ===
    JSON.stringify(baseCandidateRecord),
  "current ReclaimBase evidence differs from the locked coherent candidate record",
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    deployment_status: baseCandidateRecord.deployment_status,
    applied_global_credential: parameter,
    script_cbor_bytes: bytes.length,
    script_cbor_sha256: digest,
    script_hash: identity,
    active_preprod_script_hash: manifest.reclaim_base.script_hash,
    active_preprod_script_cbor_sha256: activeBaseIdentity.script_cbor_sha256,
    reclaim_global_v2_candidate: globalCandidateRecord,
    unchanged_active_artifacts: unchangedActiveArtifacts,
  }, null, 2)}\n`,
);
