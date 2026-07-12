import { createHash } from 'node:crypto';

import { equalJSON, requiredString } from './common.mjs';

const artifactIdentityPaths = [
  'schema',
  'circuit_id',
  'vk_hash',
  'target_credential',
  'destination_address_encoding',
  'destination_address',
  'public_input_encoding',
  'public_input',
  'cardano.format',
  'cardano.public_input_digest_hex',
];

const assetIdentityFields = [
  'key_manifest_sha256',
  'key_manifest_blake2b256',
  'chunk_manifest_sha256',
  'deployment_manifest_sha256',
  'proving_key_sha256',
  'proving_key_blake2b256',
  'constraint_system_hash',
  'verifying_key_sha256',
  'vk_hash',
  'circuit_id',
  'key_version',
];

export function compareRuntimeProofs(
  baseline,
  candidate,
  { expectedCardanoProofBytes = 336, requireIntermediateDigests = false, exactProof = false } = {},
) {
  const checks = [];
  for (const [label, run] of [
    ['baseline', baseline],
    ['candidate', candidate],
  ]) {
    if (run?.verified_locally !== true) throw new Error(`${label}: verified_locally is not true`);
    const proofHex = requiredString(run?.artifact?.cardano?.proof_hex, `${label}.artifact.cardano.proof_hex`);
    if (!/^[0-9a-f]+$/i.test(proofHex) || proofHex.length % 2 !== 0) {
      throw new Error(`${label}: Cardano proof is not even-length hex`);
    }
    if (proofHex.length / 2 !== expectedCardanoProofBytes) {
      throw new Error(
        `${label}: Cardano proof is ${proofHex.length / 2} bytes, want ${expectedCardanoProofBytes}`,
      );
    }
    checks.push(`${label}:local-verify`, `${label}:cardano-${expectedCardanoProofBytes}-bytes`);
  }

  for (const path of artifactIdentityPaths) {
    compareRequiredPath(baseline.artifact, candidate.artifact, path, `artifact.${path}`);
  }
  for (const field of assetIdentityFields) {
    const left = requiredString(baseline?.asset_identity?.[field], `baseline.asset_identity.${field}`);
    const right = requiredString(candidate?.asset_identity?.[field], `candidate.asset_identity.${field}`);
    if (left !== right) throw new Error(`asset identity mismatch for ${field}: ${left} != ${right}`);
  }
  checks.push('deterministic-artifact-identity', 'pk-ccs-vk-manifest-identity');

  const leftDigests = baseline.intermediate_digests;
  const rightDigests = candidate.intermediate_digests;
  if (leftDigests || rightDigests || requireIntermediateDigests) {
    if (!leftDigests || !rightDigests) throw new Error('both runs must record intermediate_digests');
    validateIntermediateDigests(leftDigests, 'baseline.intermediate_digests');
    validateIntermediateDigests(rightDigests, 'candidate.intermediate_digests');
    if (!equalJSON(leftDigests, rightDigests)) throw new Error('intermediate MSM/stage digests differ');
    checks.push('intermediate-digests');
  }

  if (exactProof) {
    if (baseline.deterministic_randomness !== true || candidate.deterministic_randomness !== true) {
      throw new Error('exact proof comparison requires deterministic_randomness=true in both runs');
    }
    if (baseline.artifact.proof !== candidate.artifact.proof) throw new Error('deterministic proof bytes differ');
    if (baseline.artifact.cardano.proof_hex !== candidate.artifact.cardano.proof_hex) {
      throw new Error('deterministic Cardano proof bytes differ');
    }
    checks.push('deterministic-proof-bytes');
  }

  return {
    schema: 'wasm-prover-runtime-equivalence-v1',
    ok: true,
    raw_proof_compared: exactProof,
    randomized_proof_bytes_intentionally_ignored: !exactProof,
    intermediate_digests: leftDigests && rightDigests ? 'compared' : 'not-recorded',
    checks,
  };
}

export const requiredIntermediateStages = Object.freeze(['Basis', 'BasisExpSigma', 'G2B', 'A', 'B', 'Z', 'K']);

export function validateIntermediateDigests(value, label = 'intermediate_digests') {
  if (value?.schema !== 'wasm-prover-intermediate-digests-v1') {
    throw new Error(`${label}.schema must be wasm-prover-intermediate-digests-v1`);
  }
  const stages = value.stages;
  if (!stages || typeof stages !== 'object') throw new Error(`${label}.stages is required`);
  const records = [];
  for (const stage of requiredIntermediateStages) {
    const record = stages[stage];
    if (!record || typeof record !== 'object') throw new Error(`${label}.stages.${stage} is required`);
    for (const field of ['scalar_inputs', 'point_inputs', 'result']) {
      if (!/^(?:sha256|blake2b256):[0-9a-f]{64}$/i.test(record[field] || '')) {
        throw new Error(`${label}.stages.${stage}.${field} must be a versioned 256-bit digest`);
      }
    }
    records.push(JSON.stringify(record));
  }
  if (new Set(records).size !== records.length) {
    throw new Error(`${label} contains duplicate stage records; placeholder digests are forbidden`);
  }
}

export function digestIntermediateValue(stage, field, value) {
  if (!requiredIntermediateStages.includes(stage)) throw new Error(`unknown intermediate stage ${stage}`);
  if (!['scalar_inputs', 'point_inputs', 'result'].includes(field)) {
    throw new Error(`unknown intermediate field ${field}`);
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const domain = Buffer.from(`wasm-prover-intermediate-digests-v1\0${stage}\0${field}\0`, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain).update(length).update(bytes).digest('hex')}`;
}

export function selectABRepeat(report, repeat) {
  if (report?.schema !== 'wasm-prover-runtime-ab-v1' || !Array.isArray(report.runs)) {
    throw new Error('A/B report must use wasm-prover-runtime-ab-v1 with runs[]');
  }
  if (!Number.isSafeInteger(repeat) || repeat <= 0) throw new Error('repeat must be a positive integer');
  const matching = report.runs.filter((run) => run.repeat === repeat);
  const baseline = matching.find((run) => run.role === 'baseline');
  const candidate = matching.find((run) => run.role === 'candidate');
  if (!baseline || !candidate) throw new Error(`A/B report has no complete baseline/candidate pair for repeat ${repeat}`);
  return { baseline, candidate };
}

export function assertContractVerifierResult(value, label) {
  if (value !== true && value?.ok !== true) {
    throw new Error(`${label}: contract verifier must return true or {ok:true}`);
  }
}

function compareRequiredPath(left, right, path, label) {
  const leftValue = getPath(left, path);
  const rightValue = getPath(right, path);
  if (leftValue === undefined || leftValue === null || leftValue === '') {
    throw new Error(`baseline ${label} is missing`);
  }
  if (rightValue === undefined || rightValue === null || rightValue === '') {
    throw new Error(`candidate ${label} is missing`);
  }
  if (!equalJSON(leftValue, rightValue)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(leftValue)} != ${JSON.stringify(rightValue)}`);
  }
}

function getPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}
