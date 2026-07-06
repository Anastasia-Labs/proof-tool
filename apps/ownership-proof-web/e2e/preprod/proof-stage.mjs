import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blake2b } from "@noble/hashes/blake2b";
import { COMPROMISED_WALLET_ROLE_ENV } from "./funding-stage.mjs";

export const DESTINATION_PROOF_STAGE_NAME = "generate-destination-bound-proofs";
export const CLAIM_BATCH_SIZE_ENV = "RECLAIM_E2E_CLAIM_BATCH_SIZE";

const DEFAULT_COMPROMISED_WALLET_ROLE = "compromised_user";
const SAFE_WALLET_ROLE = "safe_claim_destination";
const DEFAULT_CLAIM_BATCH_SIZE = 4;
const HARD_CLAIM_BATCH_SIZE = 5;
const DESTINATION_PROFILE = "single-destination";
const DESTINATION_CIRCUIT_ID = "root-ownership-destination-v1/bls12-381/groth16";
const DESTINATION_ADDRESS_ENCODING = "destination-address-v1";
const DESTINATION_PUBLIC_INPUT_DOMAIN = "ROOT-OWNERSHIP-DESTINATION-v1";
const DESTINATION_PUBLIC_INPUT_ENCODING = "single-credential-destination-v1";
const CARDANO_PROOF_FORMAT = "groth16-bls12-381-bsb22";
const TOKEN_HEADER = "X-Proof-Tool-Token";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export class PreprodDestinationProofStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodDestinationProofStageError";
    this.code = code;
  }
}

export async function runDestinationProofStage(options = {}) {
  const env = options.env ?? process.env;
  const appTarget = requireOption(options.appTarget, "appTarget");
  const helperTarget = requireOption(options.helperTarget, "helperTarget");
  const walletHarness = requireOption(options.walletHarness, "walletHarness");
  const outputDir = requireOption(options.outputDir, "outputDir");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  if (typeof fetchFn !== "function") {
    throw new PreprodDestinationProofStageError("fetch_unavailable", "fetch is required for destination proof generation.");
  }

  const compromisedRole = env[COMPROMISED_WALLET_ROLE_ENV]?.trim() || DEFAULT_COMPROMISED_WALLET_ROLE;
  const batchSize = parseBatchSize(env[CLAIM_BATCH_SIZE_ENV]?.trim() || String(DEFAULT_CLAIM_BATCH_SIZE));
  const appOrigin = originFor(appTarget.baseUrl, "appTarget.baseUrl");
  const helperUrl = loopbackHelperOrigin(helperTarget.helperUrl);
  const token = requiredString(helperTarget.token, "helperTarget.token");
  const compromisedState = walletState(walletHarness, compromisedRole, "impacted_wallet_missing");
  const safeState = walletState(walletHarness, SAFE_WALLET_ROLE, "safe_wallet_missing");
  const impactedCredential = assertCredential(compromisedState.paymentCredential, "impacted_wallet_credential_missing");
  const safeCredential = assertCredential(safeState.paymentCredential, "safe_wallet_credential_missing");
  if (impactedCredential === safeCredential) {
    throw new PreprodDestinationProofStageError(
      "safe_impacted_wallet_overlap",
      "The safe claim destination must not share the impacted payment credential.",
    );
  }
  if (safeState.canSign !== true) {
    throw new PreprodDestinationProofStageError("safe_wallet_read_only", `${SAFE_WALLET_ROLE} must be able to sign later claim transactions.`);
  }

  const networkId = await walletHarness.call?.(SAFE_WALLET_ROLE, "getNetworkId", []);
  if (networkId !== 0) {
    throw new PreprodDestinationProofStageError("safe_wallet_network_mismatch", `${SAFE_WALLET_ROLE} must be connected to preprod network id 0.`);
  }
  const masterXPrvBase64 = await loadMasterXPrvBase64(walletHarness, compromisedRole);
  const claimDeployment = await fetchAppJson(fetchFn, appTarget.baseUrl, "/claim-api/deployment");
  const deployment = assertClaimDeployment(claimDeployment);
  const helperStatus = await fetchHelperJson(fetchFn, helperUrl, "/status", appOrigin, token, "GET");
  const helperProfile = assertHelperDestinationProfile(helperStatus, deployment.verifierVkHash);
  const matchingUtxos = await loadMatchingReclaimUtxos(fetchFn, appTarget.baseUrl, impactedCredential);
  if (matchingUtxos.length < batchSize) {
    throw new PreprodDestinationProofStageError(
      "matching_utxo_count_too_low",
      `Destination proof stage found ${matchingUtxos.length} matching UTxOs; expected at least ${batchSize}.`,
    );
  }

  const selectedOutrefs = matchingUtxos.slice(0, batchSize).map((utxo) => utxo.outRefId);
  const draftRequest = {
    deploymentId: deployment.id,
    networkId: deployment.networkId,
    safeWalletChangeAddress: safeState.address,
    safeWalletAddresses: [safeState.address],
    selectedOutrefs,
    maxUtxos: batchSize,
  };
  const draft = await fetchAppJson(fetchFn, appTarget.baseUrl, "/claim-api/draft", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(draftRequest),
  });
  assertDraft(draft, deployment, selectedOutrefs, batchSize);

  const helperResponse = await fetchHelperJson(fetchFn, helperUrl, "/prove-destination", appOrigin, token, "POST", {
    master_xprv_base64: masterXPrvBase64,
    profile: draft.proofProfile,
    requests: draft.proofRequests,
    search: {
      max_account: 9,
      max_index: 999,
    },
    include_debug_path: false,
  });
  const proofSummaries = assertProofArtifacts(helperResponse, draft, deployment.verifierVkHash);

  const screenshotPath = options.page
    ? path.join(outputDir, "screenshots", "generate-destination-bound-proofs.png")
    : null;
  if (screenshotPath) {
    mkdir(path.dirname(screenshotPath), { recursive: true });
    await options.page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });
  }

  const artifactPath = path.join(outputDir, "generate-destination-bound-proofs.json");
  const artifact = {
    schema: "proof-tool-preprod-destination-proof-stage-v1",
    stage: DESTINATION_PROOF_STAGE_NAME,
    deploymentId: deployment.id,
    network: deployment.network,
    networkId: deployment.networkId,
    proofProfile: draft.proofProfile,
    verifierVkHash: deployment.verifierVkHash,
    helper: {
      helperUrl,
      tokenRequired: true,
      token: "[redacted]",
      sidecarVersion: stringOrNull(helperStatus.sidecar_version),
      protocolVersion: stringOrNull(helperStatus.protocol_version),
      destinationKeyHash: stringOrNull(helperProfile.key_hash),
      destinationKeyVersion: stringOrNull(helperProfile.key_version),
    },
    impactedWalletRole: compromisedRole,
    impactedPaymentCredential: redactCredential(impactedCredential),
    safeWalletRole: SAFE_WALLET_ROLE,
    safePaymentCredential: redactCredential(safeCredential),
    safeWallet: {
      utxoCount: draft.safeWallet?.utxoCount ?? null,
      totalLovelace: draft.safeWallet?.totalLovelace ?? null,
    },
    draftId: draft.draftId,
    selectedOutrefs,
    batchSize: selectedOutrefs.length,
    proofRequestSummaries: draft.proofRequests.map((request) => ({
      outRef: request.out_ref,
      targetCredential: redactCredential(request.target_credential),
      destinationAddressEncoding: request.destination_address_encoding,
      destinationAddressSha256: sha256Hex(request.destination_address),
    })),
    proofArtifactSummaries: proofSummaries,
    pathMetadataPresent: false,
    helperRequestBodyWritten: false,
    proofBytesWritten: false,
    screenshots: screenshotPath ? [path.relative(outputDir, screenshotPath)] : [],
  };
  writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  return {
    ok: true,
    artifacts: screenshotPath ? [artifactPath, screenshotPath] : [artifactPath],
    summary: {
      stage: DESTINATION_PROOF_STAGE_NAME,
      deploymentId: deployment.id,
      draftId: draft.draftId,
      selectedOutrefs,
      batchSize: selectedOutrefs.length,
      helperKeyHash: helperProfile.key_hash,
    },
    proofBundle: {
      deploymentId: deployment.id,
      draft,
      selectedOutrefs,
      safeWalletChangeAddress: safeState.address,
      safeWalletAddresses: [safeState.address],
      proofArtifacts: helperResponse.artifacts.map((item) => item.artifact),
    },
  };
}

async function loadMatchingReclaimUtxos(fetchFn, baseUrl, impactedCredential) {
  const matching = [];
  let cursor = null;
  do {
    const endpoint = new URL("/claim-api/reclaim-utxos", baseUrl);
    endpoint.searchParams.set("limit", "100");
    if (cursor) {
      endpoint.searchParams.set("cursor", cursor);
    }
    const response = await fetchJson(fetchFn, endpoint);
    if (response?.available !== true) {
      throw new PreprodDestinationProofStageError("claim_index_unavailable", "Claim index is not available for destination proof generation.");
    }
    const pageUtxos = Array.isArray(response.utxos) ? response.utxos : [];
    matching.push(
      ...pageUtxos.filter((utxo) =>
        utxo?.state === "unspent" &&
        utxo?.datum?.status === "valid" &&
        utxo.datum.paymentCredential === impactedCredential &&
        typeof utxo.outRefId === "string",
      ),
    );
    cursor = response.page?.nextCursor ?? null;
  } while (cursor);
  return matching;
}

async function fetchAppJson(fetchFn, baseUrl, endpoint, init) {
  return fetchJson(fetchFn, new URL(endpoint, baseUrl), init);
}

async function fetchHelperJson(fetchFn, helperUrl, endpoint, appOrigin, token, method, body) {
  const init = {
    method,
    headers: {
      Origin: appOrigin,
      [TOKEN_HEADER]: token,
    },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetchJson(fetchFn, new URL(endpoint, helperUrl), init);
}

async function fetchJson(fetchFn, url, init) {
  let response;
  try {
    response = await fetchFn(url, init);
  } catch (error) {
    throw new PreprodDestinationProofStageError("fetch_failed", `Destination proof stage request failed: ${error?.message ?? "request failed"}`);
  }
  if (!response || response.status < 200 || response.status >= 300) {
    throw new PreprodDestinationProofStageError("http_error", `${url.pathname} returned HTTP ${response?.status ?? "unknown"}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new PreprodDestinationProofStageError("json_malformed", `${url.pathname} did not return valid JSON.`);
  }
}

function assertClaimDeployment(response) {
  const deployment = response?.deployment;
  if (response?.available !== true || !deployment) {
    throw new PreprodDestinationProofStageError("claim_deployment_unavailable", "Claim deployment endpoint is unavailable.");
  }
  if (deployment.network !== "Preprod" || deployment.networkId !== 0) {
    throw new PreprodDestinationProofStageError("claim_deployment_not_preprod", "Destination proof stage requires a Preprod claim deployment.");
  }
  if (response.capabilities?.proofProfile !== DESTINATION_PROFILE) {
    throw new PreprodDestinationProofStageError("claim_proof_profile_unsupported", "Claim deployment must use single-destination proofs.");
  }
  if (response.capabilities?.destinationAddressEncoding !== DESTINATION_ADDRESS_ENCODING) {
    throw new PreprodDestinationProofStageError("destination_encoding_unsupported", "Claim deployment must use destination-address-v1.");
  }
  if (typeof deployment.id !== "string" || typeof deployment.verifierVkHash !== "string") {
    throw new PreprodDestinationProofStageError("claim_deployment_malformed", "Claim deployment is missing id or verifier hash.");
  }
  return deployment;
}

function assertHelperDestinationProfile(status, expectedVkHash) {
  const profile = status?.destination_profile;
  if (!profile) {
    throw new PreprodDestinationProofStageError("helper_destination_profile_missing", "Proof Helper did not report a destination profile.");
  }
  if (profile.profile !== DESTINATION_PROFILE) {
    throw new PreprodDestinationProofStageError("helper_destination_profile_unsupported", "Proof Helper destination profile must be single-destination.");
  }
  if (profile.key_ready !== true || profile.compatibility !== "ready") {
    throw new PreprodDestinationProofStageError("helper_destination_key_not_ready", "Proof Helper destination key is not ready.");
  }
  if (profile.key_hash !== expectedVkHash) {
    throw new PreprodDestinationProofStageError("helper_destination_key_mismatch", "Proof Helper destination key hash does not match the claim deployment.");
  }
  return profile;
}

function assertDraft(draft, deployment, selectedOutrefs, batchSize) {
  if (draft?.deploymentId !== deployment.id || draft.networkId !== deployment.networkId) {
    throw new PreprodDestinationProofStageError("draft_deployment_mismatch", "Claim draft does not match the selected deployment.");
  }
  if (draft.proofProfile !== DESTINATION_PROFILE) {
    throw new PreprodDestinationProofStageError("draft_profile_unsupported", "Claim draft must use single-destination proofs.");
  }
  if (!Array.isArray(draft.orderedInputs) || !Array.isArray(draft.proofRequests)) {
    throw new PreprodDestinationProofStageError("draft_malformed", "Claim draft is missing ordered inputs or proof requests.");
  }
  if (
    draft.orderedInputs.length !== selectedOutrefs.length ||
    draft.proofRequests.length !== draft.orderedInputs.length ||
    draft.orderedInputs.length > batchSize
  ) {
    throw new PreprodDestinationProofStageError("draft_batch_mismatch", "Claim draft batch does not match selected reclaim inputs.");
  }
  const draftOutrefs = draft.orderedInputs.map((input) => input.outRefId);
  for (const outRef of selectedOutrefs) {
    if (!draftOutrefs.includes(outRef)) {
      throw new PreprodDestinationProofStageError("draft_outref_mismatch", "Claim draft omitted a selected reclaim outref.");
    }
  }
  for (const [index, request] of draft.proofRequests.entries()) {
    const input = draft.orderedInputs[index];
    if (!input || request.out_ref !== input.outRefId) {
      throw new PreprodDestinationProofStageError("draft_proof_order_mismatch", "Draft proof requests must follow backend input order.");
    }
    if (request.destination_address_encoding !== DESTINATION_ADDRESS_ENCODING) {
      throw new PreprodDestinationProofStageError("draft_destination_encoding_mismatch", "Draft proof request used the wrong destination encoding.");
    }
  }
}

function assertProofArtifacts(response, draft, expectedVkHash) {
  if (response?.profile !== draft.proofProfile || !Array.isArray(response.artifacts)) {
    throw new PreprodDestinationProofStageError("helper_response_malformed", "Proof Helper returned a malformed destination proof response.");
  }
  const pathLocation = findPathMetadata(response);
  if (pathLocation) {
    throw new PreprodDestinationProofStageError("helper_path_metadata_leaked", `Proof Helper response included path metadata at ${pathLocation}.`);
  }
  if (response.artifacts.length !== draft.proofRequests.length) {
    throw new PreprodDestinationProofStageError("helper_artifact_count_mismatch", "Proof Helper artifact count does not match the draft.");
  }
  return response.artifacts.map((item, index) => {
    const request = draft.proofRequests[index];
    const artifact = item?.artifact;
    const cardano = artifact?.cardano;
    if (item?.out_ref !== request.out_ref) {
      throw new PreprodDestinationProofStageError("helper_artifact_order_mismatch", "Proof Helper artifacts must preserve draft request order.");
    }
    if (artifact?.schema !== "root-ownership-proof-artifact-v1") {
      throw new PreprodDestinationProofStageError("helper_artifact_schema_mismatch", "Proof Helper artifact schema is unsupported.");
    }
    if (artifact.circuit_id !== DESTINATION_CIRCUIT_ID) {
      throw new PreprodDestinationProofStageError("helper_artifact_circuit_mismatch", "Proof Helper artifact is not destination-bound.");
    }
    if (artifact.vk_hash !== expectedVkHash) {
      throw new PreprodDestinationProofStageError("helper_artifact_vk_mismatch", "Proof Helper artifact verifier hash does not match deployment.");
    }
    if (artifact.target_credential !== request.target_credential) {
      throw new PreprodDestinationProofStageError("helper_artifact_credential_mismatch", "Proof Helper artifact target credential does not match draft.");
    }
    if (artifact.destination_address_encoding !== request.destination_address_encoding || artifact.destination_address !== request.destination_address) {
      throw new PreprodDestinationProofStageError("helper_artifact_destination_mismatch", "Proof Helper artifact destination does not match draft.");
    }
    if (artifact.public_input_encoding !== DESTINATION_PUBLIC_INPUT_ENCODING) {
      throw new PreprodDestinationProofStageError("helper_artifact_public_input_encoding", "Proof Helper artifact public input encoding is unsupported.");
    }
    if (cardano?.format !== CARDANO_PROOF_FORMAT) {
      throw new PreprodDestinationProofStageError("helper_artifact_cardano_format", "Proof Helper artifact Cardano proof format is unsupported.");
    }
    if (!isHex(cardano?.proof_hex) || !isHex(cardano?.public_input_digest_hex)) {
      throw new PreprodDestinationProofStageError("helper_artifact_cardano_missing", "Proof Helper artifact is missing Cardano proof export fields.");
    }
    const expectedDigest = destinationPublicInputDigest(request.target_credential, request.destination_address);
    if (cardano.public_input_digest_hex !== expectedDigest) {
      throw new PreprodDestinationProofStageError(
        "helper_artifact_public_input_digest",
        "Proof Helper artifact public input digest does not match credential and destination.",
      );
    }
    return {
      outRef: request.out_ref,
      targetCredential: redactCredential(request.target_credential),
      destinationAddressEncoding: request.destination_address_encoding,
      destinationAddressSha256: sha256Hex(request.destination_address),
      publicInputDigestSha256: sha256Hex(cardano.public_input_digest_hex),
      proofHexLength: cardano.proof_hex.length,
    };
  });
}

function findPathMetadata(value, location = "$") {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findPathMetadata(item, `${location}[${index}]`);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "path" || key === "paths") {
      return `${location}.${key}`;
    }
    const found = findPathMetadata(item, `${location}.${key}`);
    if (found) {
      return found;
    }
  }
  return null;
}

async function loadMasterXPrvBase64(walletHarness, role) {
  if (typeof walletHarness.masterXPrvBase64ForHelper !== "function") {
    throw new PreprodDestinationProofStageError(
      "master_xprv_loader_missing",
      "CIP-30 harness must expose a local helper-only master XPrv loader.",
    );
  }
  const value = await walletHarness.masterXPrvBase64ForHelper(role);
  if (typeof value !== "string" || Buffer.from(value, "base64").length !== 96) {
    throw new PreprodDestinationProofStageError("master_xprv_invalid", "CIP-30 harness returned an invalid helper master XPrv.");
  }
  return value;
}

function walletState(walletHarness, role, code) {
  const state = walletHarness.roleState?.(role);
  if (!state) {
    throw new PreprodDestinationProofStageError(code, `${role} is not available in the CIP-30 harness.`);
  }
  return state;
}

function assertCredential(value, code) {
  if (typeof value !== "string" || !/^[0-9a-f]{56}$/u.test(value)) {
    throw new PreprodDestinationProofStageError(code, "Wallet role must expose a 28-byte payment credential.");
  }
  return value;
}

function parseBatchSize(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new PreprodDestinationProofStageError("claim_batch_size_invalid", `${CLAIM_BATCH_SIZE_ENV} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (parsed > HARD_CLAIM_BATCH_SIZE) {
    throw new PreprodDestinationProofStageError("claim_batch_size_too_large", `${CLAIM_BATCH_SIZE_ENV} cannot exceed ${HARD_CLAIM_BATCH_SIZE}.`);
  }
  return parsed;
}

function originFor(value, label) {
  try {
    return new URL(value).origin;
  } catch {
    throw new PreprodDestinationProofStageError("url_invalid", `${label} must be a valid URL.`);
  }
}

function loopbackHelperOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PreprodDestinationProofStageError("helper_url_invalid", "helperTarget.helperUrl must be a valid URL.");
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new PreprodDestinationProofStageError("helper_url_not_loopback", "Destination proof generation requires an HTTP loopback Proof Helper URL.");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new PreprodDestinationProofStageError(
      "helper_url_unsafe",
      "Destination proof generation requires the helper origin without credentials, path, query, or fragment.",
    );
  }
  return url.origin;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PreprodDestinationProofStageError("helper_token_missing", `${label} is required for destination proof generation.`);
  }
  return value;
}

function requireOption(value, name) {
  if (!value) {
    throw new PreprodDestinationProofStageError(`${name}_missing`, `${name} is required for destination proof generation.`);
  }
  return value;
}

function isHex(value) {
  return typeof value === "string" && /^[0-9a-f]+$/u.test(value);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function destinationPublicInputDigest(credentialHex, destinationAddressHex) {
  const preimage = Buffer.concat([
    Buffer.from(DESTINATION_PUBLIC_INPUT_DOMAIN, "utf8"),
    Buffer.from(credentialHex, "hex"),
    Buffer.from(destinationAddressHex, "hex"),
  ]);
  return Buffer.from(blake2b(new Uint8Array(preimage), { dkLen: 32 })).toString("hex");
}

function redactCredential(value) {
  if (typeof value !== "string" || value.length < 16) {
    return "[redacted-credential]";
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}
