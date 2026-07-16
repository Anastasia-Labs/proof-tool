import path from "node:path";
import { TRANSACTION_APPROVAL_ENV } from "./run.mjs";
import {
  LACE_EXTENSION_DIR_ENV,
  LACE_WALLET_PASSWORD_ENV,
} from "./real-lace-driver.mjs";

export const PREVIEW_URL_ENV = "RECLAIM_E2E_PREVIEW_URL";
export const TARGET_MODE_ENV = "RECLAIM_E2E_TARGET_MODE";
export const TARGET_MODE_VERCEL_PREVIEW = "vercel-preview";
export const TARGET_MODE_LOCAL_PRODUCTION = "local-production";
export const EXPECTED_COMMIT_SHA_ENV = "RECLAIM_E2E_EXPECTED_COMMIT_SHA";
export const EXPECTED_PR_NUMBER_ENV = "RECLAIM_E2E_EXPECTED_PR_NUMBER";
export const PR_MERGE_SHA_ENV = "RECLAIM_E2E_PR_MERGE_SHA";
export const EXPECTED_CLAIM_OUTREF_ENV = "RECLAIM_E2E_CLAIM_OUTREF";
export const FIXTURE_MODE_ENV = "RECLAIM_E2E_FIXTURE_MODE";
export const FIXTURE_MODE_PREPARE = "prepare";
export const FIXTURE_MODE_EXISTING = "existing";
export const VERCEL_BYPASS_SECRET_ENV = "RECLAIM_E2E_VERCEL_BYPASS_SECRET";
export const OUTPUT_DIR_ENV = "RECLAIM_E2E_OUTPUT_DIR";
export const BUILD_PROVENANCE_PATH = "/claim-api/build-provenance";
export const PRODUCTION_WEB_HOST = "proof-tool.vercel.app";

export const CLAIM_FLOW_SCREENSHOTS = Object.freeze([
  "00-landing.png",
  "01-service-review.png",
  "02-impacted-wallet.png",
  "03-lace-impacted-connect.png",
  "04-impacted-connected.png",
  "05-scanning-claims.png",
  "06-available-claims.png",
  "07-safe-wallet.png",
  "08-lace-impacted-disconnect.png",
  "09-lace-safe-connect.png",
  "10-safe-destination.png",
  "11-proof-method.png",
  "12-create-proofs-ready.png",
  "13-proofs-generating.png",
  "14-proofs-ready.png",
  "15-current-batch.png",
  "16-transaction-review.png",
  "17-lace-signing.png",
  "18-submitted.png",
  "19-recovery-complete.png",
]);

export class WebAppClaimFlowContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WebAppClaimFlowContractError";
    this.code = code;
  }
}

export function loadWebAppClaimFlowConfig(env = process.env, options = {}) {
  const targetMode = String(env[TARGET_MODE_ENV] ?? TARGET_MODE_VERCEL_PREVIEW).trim().toLowerCase();
  if (targetMode !== TARGET_MODE_VERCEL_PREVIEW && targetMode !== TARGET_MODE_LOCAL_PRODUCTION) {
    throw new WebAppClaimFlowContractError(
      "target_mode_invalid",
      `${TARGET_MODE_ENV} must be ${TARGET_MODE_VERCEL_PREVIEW} or ${TARGET_MODE_LOCAL_PRODUCTION}.`,
    );
  }
  const previewUrl = targetMode === TARGET_MODE_LOCAL_PRODUCTION
    ? validateLocalProductionUrl(required(env[PREVIEW_URL_ENV], PREVIEW_URL_ENV))
    : validatePreviewUrl(required(env[PREVIEW_URL_ENV], PREVIEW_URL_ENV));
  const expectedCommitSha = required(env[EXPECTED_COMMIT_SHA_ENV], EXPECTED_COMMIT_SHA_ENV).toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(expectedCommitSha)) {
    throw new WebAppClaimFlowContractError(
      "preview_commit_invalid",
      `${EXPECTED_COMMIT_SHA_ENV} must be a full 40-character Git commit SHA.`,
    );
  }
  const prMergeSha = String(env[PR_MERGE_SHA_ENV] ?? "").trim().toLowerCase();
  if (prMergeSha && !/^[0-9a-f]{40}$/u.test(prMergeSha)) {
    throw new WebAppClaimFlowContractError(
      "pr_merge_commit_invalid",
      `${PR_MERGE_SHA_ENV} must be empty or a full 40-character Git commit SHA.`,
    );
  }
  const expectedPrNumber = parsePositiveInteger(required(env[EXPECTED_PR_NUMBER_ENV], EXPECTED_PR_NUMBER_ENV), EXPECTED_PR_NUMBER_ENV);
  const configuredOutref = String(env[EXPECTED_CLAIM_OUTREF_ENV] ?? "")
    .trim()
    .toLowerCase();
  const fixtureMode = String(env[FIXTURE_MODE_ENV] ?? (configuredOutref ? FIXTURE_MODE_EXISTING : FIXTURE_MODE_PREPARE))
    .trim()
    .toLowerCase();
  if (fixtureMode !== FIXTURE_MODE_PREPARE && fixtureMode !== FIXTURE_MODE_EXISTING) {
    throw new WebAppClaimFlowContractError(
      "fixture_mode_invalid",
      `${FIXTURE_MODE_ENV} must be ${FIXTURE_MODE_PREPARE} or ${FIXTURE_MODE_EXISTING}.`,
    );
  }
  if (fixtureMode === FIXTURE_MODE_EXISTING && !configuredOutref) {
    throw new WebAppClaimFlowContractError(
      "fixture_outref_missing",
      `${EXPECTED_CLAIM_OUTREF_ENV} is required when ${FIXTURE_MODE_ENV}=${FIXTURE_MODE_EXISTING}.`,
    );
  }
  if (fixtureMode === FIXTURE_MODE_PREPARE && configuredOutref) {
    throw new WebAppClaimFlowContractError(
      "fixture_configuration_ambiguous",
      `${EXPECTED_CLAIM_OUTREF_ENV} must be unset when ${FIXTURE_MODE_ENV}=${FIXTURE_MODE_PREPARE}.`,
    );
  }
  if (configuredOutref && !/^[0-9a-f]{64}#[0-9]+$/u.test(configuredOutref)) {
    throw new WebAppClaimFlowContractError(
      "fixture_outref_invalid",
      `${EXPECTED_CLAIM_OUTREF_ENV} must be a Cardano transaction hash followed by #output-index.`,
    );
  }
  if (String(env[TRANSACTION_APPROVAL_ENV] ?? "").trim() !== "1") {
    throw new WebAppClaimFlowContractError(
      "live_transaction_gate_missing",
      `${TRANSACTION_APPROVAL_ENV}=1 is required before the real Preprod claim can run.`,
    );
  }
  required(env[LACE_EXTENSION_DIR_ENV], LACE_EXTENSION_DIR_ENV);
  required(env.PW_USER_DATA_DIR, "PW_USER_DATA_DIR");
  required(env.PREPROD_TEST_WALLETS_FILE, "PREPROD_TEST_WALLETS_FILE");
  required(env[LACE_WALLET_PASSWORD_ENV], LACE_WALLET_PASSWORD_ENV);

  const outputRoot = String(env[OUTPUT_DIR_ENV] ?? "output/preprod-web-app-claim-flow-wasm-lace").trim();
  const runId = `${options.now?.().toISOString().replace(/[:.]/gu, "-") ?? new Date().toISOString().replace(/[:.]/gu, "-")}-${expectedCommitSha.slice(0, 12)}`;
  const bypassSecret = String(env[VERCEL_BYPASS_SECRET_ENV] ?? "").trim();
  if (targetMode === TARGET_MODE_LOCAL_PRODUCTION && bypassSecret) {
    throw new WebAppClaimFlowContractError(
      "local_vercel_bypass_forbidden",
      `${VERCEL_BYPASS_SECRET_ENV} must be unset for the localhost production-emulation lane.`,
    );
  }
  return Object.freeze({
    targetMode,
    previewUrl,
    baseUrl: previewUrl.origin,
    expectedCommitSha,
    prMergeSha: prMergeSha || null,
    expectedPrNumber,
    fixtureMode,
    expectedOutref: configuredOutref || null,
    bypassSecret,
    outputDir: path.resolve(options.cwd ?? process.cwd(), outputRoot, runId),
    runId,
  });
}

export function validateLocalProductionUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WebAppClaimFlowContractError("local_url_invalid", `${PREVIEW_URL_ENV} must be a valid localhost URL.`);
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
  ) {
    throw new WebAppClaimFlowContractError(
      "local_url_invalid",
      `${PREVIEW_URL_ENV} must be an origin-only http://127.0.0.1:<port>/ URL for local production emulation.`,
    );
  }
  return url;
}

export function validatePreviewUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WebAppClaimFlowContractError("preview_url_invalid", `${PREVIEW_URL_ENV} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new WebAppClaimFlowContractError(
      "preview_url_invalid",
      `${PREVIEW_URL_ENV} must be a credential-free HTTPS deployment URL without query parameters or a fragment.`,
    );
  }
  if (url.pathname !== "/") {
    throw new WebAppClaimFlowContractError("preview_url_invalid", `${PREVIEW_URL_ENV} must identify the deployment origin, not an app path.`);
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === PRODUCTION_WEB_HOST) {
    throw new WebAppClaimFlowContractError("preview_is_production", "The production Proof Tool deployment must never be used by this lane.");
  }
  if (!hostname.endsWith(".vercel.app")) {
    throw new WebAppClaimFlowContractError("preview_url_invalid", `${PREVIEW_URL_ENV} must be a Vercel Preview deployment hostname.`);
  }
  return url;
}

export function validatePreviewProvenance(provenance, config) {
  if (!provenance || provenance.schema !== "proof-tool-web-build-provenance-v1") {
    throw new WebAppClaimFlowContractError("preview_provenance_unavailable", "Preview build provenance is missing or has an unsupported schema.");
  }
  if (config.targetMode === TARGET_MODE_LOCAL_PRODUCTION) {
    return validateLocalProductionProvenance(provenance, config);
  }
  if (provenance.localPreviewEmulation === true) {
    throw new WebAppClaimFlowContractError(
      "preview_local_emulation_rejected",
      "Local Preview emulation can never satisfy the deployed Vercel acceptance lane.",
    );
  }
  if (provenance.environment !== "preview") {
    throw new WebAppClaimFlowContractError("preview_is_production", "The target deployment did not report the Vercel Preview environment.");
  }
  const suppliedHost = config.previewUrl.hostname.toLowerCase();
  const deploymentHost = normalizeVercelHost(provenance.deploymentUrl);
  if (!deploymentHost || suppliedHost !== deploymentHost) {
    throw new WebAppClaimFlowContractError(
      "preview_url_not_immutable_deployment",
      "The supplied URL does not match this build's immutable VERCEL_URL deployment hostname.",
    );
  }
  const productionHost = normalizeVercelHost(provenance.productionUrl);
  if (productionHost && suppliedHost === productionHost) {
    throw new WebAppClaimFlowContractError("preview_is_production", "The supplied URL resolves to the Vercel production hostname.");
  }
  const branchHost = normalizeVercelHost(provenance.branchUrl);
  if (branchHost && branchHost !== deploymentHost && suppliedHost === branchHost) {
    throw new WebAppClaimFlowContractError("preview_url_is_branch_alias", "A mutable Vercel branch alias cannot be used as acceptance evidence.");
  }
  if (String(provenance.commitSha ?? "").toLowerCase() !== config.expectedCommitSha) {
    throw new WebAppClaimFlowContractError("preview_commit_mismatch", "The Vercel Preview commit does not match the expected PR head SHA.");
  }
  if (String(provenance.pullRequestId ?? "") !== String(config.expectedPrNumber)) {
    throw new WebAppClaimFlowContractError("preview_pr_mismatch", "The Vercel Preview PR id does not match the expected pull request.");
  }
  return Object.freeze({
    environment: provenance.environment,
    deploymentHost,
    commitSha: provenance.commitSha,
    commitRef: provenance.commitRef ?? null,
    pullRequestId: String(provenance.pullRequestId),
  });
}

function validateLocalProductionProvenance(provenance, config) {
  if (provenance.localPreviewEmulation !== true || provenance.environment !== "preview") {
    throw new WebAppClaimFlowContractError(
      "local_provenance_unavailable",
      "The localhost target must explicitly report local Vercel Preview emulation.",
    );
  }
  const suppliedHost = config.previewUrl.host.toLowerCase();
  const deploymentHost = normalizeVercelHost(provenance.deploymentUrl);
  if (!deploymentHost || suppliedHost !== deploymentHost) {
    throw new WebAppClaimFlowContractError(
      "local_provenance_host_mismatch",
      "The localhost origin does not match the production server's emulated VERCEL_URL.",
    );
  }
  if (normalizeVercelHost(provenance.productionUrl) !== PRODUCTION_WEB_HOST) {
    throw new WebAppClaimFlowContractError(
      "local_provenance_project_mismatch",
      "The local build does not emulate the Proof Tool Vercel project identity.",
    );
  }
  if (String(provenance.commitSha ?? "").toLowerCase() !== config.expectedCommitSha) {
    throw new WebAppClaimFlowContractError(
      "preview_commit_mismatch",
      "The local production build does not match the current PR-push commit.",
    );
  }
  if (String(provenance.pullRequestId ?? "") !== String(config.expectedPrNumber)) {
    throw new WebAppClaimFlowContractError(
      "preview_pr_mismatch",
      "The local production build does not match the current pull request.",
    );
  }
  return Object.freeze({
    environment: provenance.environment,
    deploymentHost,
    commitSha: provenance.commitSha,
    commitRef: provenance.commitRef ?? null,
    pullRequestId: String(provenance.pullRequestId),
    localPreviewEmulation: true,
  });
}

export function validateBrowserWasmClaimDeployment(response) {
  if (!response?.available || !response.deployment) {
    throw new WebAppClaimFlowContractError("preprod_manifest_incoherent", "The claim deployment endpoint is unavailable.");
  }
  const deployment = response.deployment;
  if (deployment.network !== "Preprod" || deployment.networkId !== 0) {
    throw new WebAppClaimFlowContractError("preprod_manifest_incoherent", "The target claim deployment must be Cardano Preprod network id 0.");
  }
  if (!deployment.proof?.browser_proving?.enabled) {
    throw new WebAppClaimFlowContractError("browser_wasm_unavailable", "The target deployment does not enable browser-WASM proving.");
  }
  if (!/^(?:blake2b256:)?[0-9a-f]{64}$/u.test(String(deployment.verifierVkHash ?? ""))) {
    throw new WebAppClaimFlowContractError("preprod_manifest_incoherent", "The target deployment does not expose a valid pinned verifier-key hash.");
  }
  return Object.freeze({
    deploymentId: deployment.id,
    network: deployment.network,
    networkId: deployment.networkId,
    sourceCommit: deployment.sourceCommit,
    verifierVkHash: deployment.verifierVkHash,
    proofAssetId: deployment.proof.browser_proving.id ?? null,
  });
}

export function browserContextHeaders(config) {
  if (!config.bypassSecret) {
    return {};
  }
  return {
    "x-vercel-protection-bypass": config.bypassSecret,
    "x-vercel-set-bypass-cookie": "true",
  };
}

export function assertCompleteScreenshotLedger(capturedNames) {
  const captured = new Set(capturedNames);
  const missing = CLAIM_FLOW_SCREENSHOTS.filter((name) => !captured.has(name));
  const unexpected = [...captured].filter((name) => !CLAIM_FLOW_SCREENSHOTS.includes(name));
  if (missing.length > 0 || unexpected.length > 0 || captured.size !== CLAIM_FLOW_SCREENSHOTS.length) {
    throw new WebAppClaimFlowContractError(
      "screenshot_ledger_incomplete",
      `Screenshot ledger mismatch${missing.length ? `; missing ${missing.join(", ")}` : ""}${unexpected.length ? `; unexpected ${unexpected.join(", ")}` : ""}.`,
    );
  }
}

export function validateClaimBuildReview(build, expectedOutref, safeAddress) {
  if (!build || build.review?.selectedOutrefs?.length !== 1 || build.review.selectedOutrefs[0] !== expectedOutref) {
    throw new WebAppClaimFlowContractError("transaction_review_mismatch", "The built transaction does not contain exactly the prepared claim input.");
  }
  if (!Array.isArray(build.review.destinationOutputs) || build.review.destinationOutputs.length !== 1) {
    throw new WebAppClaimFlowContractError("transaction_review_mismatch", "The built transaction does not contain exactly one claim destination output.");
  }
  if (build.review.destinationOutputs[0].address !== safeAddress) {
    throw new WebAppClaimFlowContractError("transaction_review_mismatch", "The built transaction destination is not the verified safe Lace address.");
  }
  if (!/^[0-9a-f]{64}$/u.test(String(build.txHash ?? ""))) {
    throw new WebAppClaimFlowContractError("transaction_review_mismatch", "The build response did not contain a valid transaction hash.");
  }
  return build;
}

export function validateClaimSubmit(submit, build, expectedOutref) {
  if (submit?.txHash !== build.txHash || submit?.selectedOutrefs?.length !== 1 || submit.selectedOutrefs[0] !== expectedOutref) {
    throw new WebAppClaimFlowContractError("receipt_transaction_mismatch", "The submitted transaction does not match the reviewed build and prepared outref.");
  }
  return submit;
}

export function redactedProvenanceArtifact(provenance) {
  return {
    environment: provenance.environment,
    deploymentHost: provenance.deploymentHost,
    commitSha: provenance.commitSha,
    commitRef: provenance.commitRef,
    pullRequestId: provenance.pullRequestId,
  };
}

function normalizeVercelHost(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/^https?:\/\//u, "").replace(/\/$/u, "");
  if (!normalized || normalized.includes("/") || normalized.includes("?") || normalized.includes("#")) {
    return null;
  }
  return normalized;
}

function required(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new WebAppClaimFlowContractError(`${field.toLowerCase()}_missing`, `${field} is required.`);
  }
  return normalized;
}

function parsePositiveInteger(value, field) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new WebAppClaimFlowContractError(`${field.toLowerCase()}_invalid`, `${field} must be a positive integer.`);
  }
  return Number(value);
}
