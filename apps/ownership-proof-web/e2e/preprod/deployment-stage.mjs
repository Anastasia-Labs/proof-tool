import { writeFileSync } from "node:fs";
import path from "node:path";

export const DEPLOYMENT_STAGE_NAME = "deploy-or-verify-preprod-manifest";

export class PreprodDeploymentStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodDeploymentStageError";
    this.code = code;
  }
}

export async function runDeployOrVerifyPreprodManifest(options = {}) {
  const appTarget = requireOption(options.appTarget, "appTarget");
  const outputDir = requireOption(options.outputDir, "outputDir");
  const preflight = requireOption(options.preflight, "preflight");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const writeFile = options.writeFile ?? writeFileSync;
  if (typeof fetchFn !== "function") {
    throw new PreprodDeploymentStageError("fetch_unavailable", "fetch is required for deploy-or-verify manifest checks.");
  }

  const [reclaim, claim] = await Promise.all([
    fetchJson(fetchFn, appTarget.baseUrl, "/reclaim-api/deployment"),
    fetchJson(fetchFn, appTarget.baseUrl, "/claim-api/deployment"),
  ]);
  const summary = verifyDeploymentPair(reclaim, claim, preflight);
  const artifactPath = path.join(outputDir, "deploy-or-verify-preprod-manifest.json");
  writeFile(
    artifactPath,
    `${JSON.stringify(
      {
        schema: "proof-tool-preprod-deployment-stage-v1",
        stage: DEPLOYMENT_STAGE_NAME,
        ...summary,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    ok: true,
    artifacts: [artifactPath],
    summary,
  };
}

export function verifyDeploymentPair(reclaim, claim, preflight) {
  if (!reclaim?.available || !reclaim.deployment) {
    throw new PreprodDeploymentStageError(
      "reclaim_deployment_unavailable",
      `Reclaim deployment endpoint is unavailable: ${deploymentErrorSummary(reclaim)}`,
    );
  }
  if (!claim?.available || !claim.deployment) {
    throw new PreprodDeploymentStageError(
      "claim_deployment_unavailable",
      `Claim deployment endpoint is unavailable: ${deploymentErrorSummary(claim)}`,
    );
  }

  const reclaimDeployment = reclaim.deployment;
  const claimDeployment = claim.deployment;
  assertEqual("deployment_id", reclaimDeployment.id, claimDeployment.id);
  assertEqual("network", reclaimDeployment.network, claimDeployment.network);
  assertEqual("network_id", reclaimDeployment.networkId, claimDeployment.networkId);
  assertEqual("source_commit", reclaimDeployment.sourceCommit, claimDeployment.sourceCommit);
  assertEqual("verifier_vk_hash", reclaimDeployment.verifierVkHash, claimDeployment.verifierVkHash);

  const expectedSourceCommit = preflight?.context?.manifest?.source_commit;
  if (expectedSourceCommit && reclaimDeployment.sourceCommit !== expectedSourceCommit) {
    throw new PreprodDeploymentStageError(
      "deployment_source_commit_mismatch",
      "Deployment endpoint source commit does not match the preflight deployment manifest.",
    );
  }
  const expectedDeploymentId = preflight?.context?.manifest?.deployment_id;
  if (expectedDeploymentId && reclaimDeployment.id !== expectedDeploymentId) {
    throw new PreprodDeploymentStageError(
      "deployment_id_preflight_mismatch",
      "Deployment endpoint id does not match the clean preflight manifest.",
    );
  }
  if (reclaimDeployment.network !== "Preprod" || reclaimDeployment.networkId !== 0) {
    throw new PreprodDeploymentStageError("deployment_network_not_preprod", "Deployment endpoints must report Preprod network id 0.");
  }

  const capabilities = claim.capabilities;
  if (!capabilities) {
    throw new PreprodDeploymentStageError("claim_capabilities_missing", "Claim deployment endpoint must expose claim capabilities.");
  }
  if (capabilities.proofProfile !== "single-destination") {
    throw new PreprodDeploymentStageError("claim_proof_profile_unsupported", "Claim proof profile must be single-destination.");
  }
  if (capabilities.destinationAddressEncoding !== "destination-address-v1") {
    throw new PreprodDeploymentStageError("destination_encoding_unsupported", "Claim destination encoding must be destination-address-v1.");
  }
  if (capabilities.singleGlobalCompatible !== true) {
    throw new PreprodDeploymentStageError("single_global_incompatible", "ReclaimBase and ReclaimGlobal are not single-global compatible.");
  }
  if (capabilities.transactionBuild?.referenceScriptsConfigured !== true) {
    throw new PreprodDeploymentStageError(
      "reference_scripts_missing",
      `Reference scripts are required before live claim builds: ${(capabilities.transactionBuild?.missing ?? []).join(", ")}`,
    );
  }

  return {
    deploymentId: reclaimDeployment.id,
    network: reclaimDeployment.network,
    networkId: reclaimDeployment.networkId,
    sourceCommit: reclaimDeployment.sourceCommit,
    verifierVkHash: reclaimDeployment.verifierVkHash,
    contractVersion: reclaimDeployment.contractVersion,
    proofProfile: capabilities.proofProfile,
    helperKeyVersion: capabilities.helperKeyVersion,
    destinationAddressEncoding: capabilities.destinationAddressEncoding,
    referenceScriptsConfigured: true,
  };
}

async function fetchJson(fetchFn, baseUrl, endpoint) {
  const url = new URL(endpoint, baseUrl);
  let response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    throw new PreprodDeploymentStageError("deployment_endpoint_fetch_failed", `Could not fetch ${endpoint}: ${error?.message ?? "request failed"}`);
  }
  if (!response || response.status < 200 || response.status >= 300) {
    throw new PreprodDeploymentStageError("deployment_endpoint_http_error", `${endpoint} returned HTTP ${response?.status ?? "unknown"}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new PreprodDeploymentStageError("deployment_endpoint_json_malformed", `${endpoint} did not return valid JSON.`);
  }
}

function requireOption(value, name) {
  if (!value) {
    throw new PreprodDeploymentStageError(`${name}_missing`, `${name} is required for deploy-or-verify manifest checks.`);
  }
  return value;
}

function assertEqual(field, left, right) {
  if (left !== right) {
    throw new PreprodDeploymentStageError(`${field}_mismatch`, `${field} mismatch between reclaim and claim deployment endpoints.`);
  }
}

function deploymentErrorSummary(value) {
  if (!value || typeof value !== "object") {
    return "empty response";
  }
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    return value.errors.map((error) => error.code ?? error.message ?? "unknown_error").join(", ");
  }
  if (Array.isArray(value.missing) && value.missing.length > 0) {
    return `missing ${value.missing.join(", ")}`;
  }
  return "deployment unavailable";
}
