import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COMPROMISED_WALLET_ROLE_ENV, FUNDING_WALLET_ROLE_ENV } from "./funding-stage.mjs";
import { runDestinationProofStage } from "./proof-stage.mjs";
import { redactAddress } from "./preflight.mjs";

export const NEGATIVE_GUARDRAILS_STAGE_NAME = "negative-guardrails";
export const INSUFFICIENT_SAFE_WALLET_ADDRESS_ENV = "RECLAIM_E2E_INSUFFICIENT_SAFE_WALLET_ADDRESS";

const DEFAULT_FUNDING_WALLET_ROLE = "reclaim_funder";
const DEFAULT_COMPROMISED_WALLET_ROLE = "compromised_user";
const SAFE_WALLET_ROLE = "safe_claim_destination";
const WRONG_NETWORK_ID = 1;
const EMPTY_PREPROD_ADDRESS = "addr_test1vqv7qlaucathxkwkc503ujw0rv9lfj2rkj96feyst2rs9eqqyas5r";

export class PreprodNegativeGuardrailsStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodNegativeGuardrailsStageError";
    this.code = code;
  }
}

export async function runNegativeGuardrailsStage(options = {}) {
  const env = options.env ?? process.env;
  const page = requireOption(options.page, "page");
  const appTarget = requireOption(options.appTarget, "appTarget");
  const walletHarness = requireOption(options.walletHarness, "walletHarness");
  const outputDir = requireOption(options.outputDir, "outputDir");
  const proofBundle = requireOption(options.proofBundle, "proofBundle");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const destinationProofStageRunner = options.destinationProofStageRunner ?? runDestinationProofStage;
  const fundingRole = env[FUNDING_WALLET_ROLE_ENV]?.trim() || DEFAULT_FUNDING_WALLET_ROLE;
  const compromisedRole = env[COMPROMISED_WALLET_ROLE_ENV]?.trim() || DEFAULT_COMPROMISED_WALLET_ROLE;
  const insufficientSafeWalletAddress = env[INSUFFICIENT_SAFE_WALLET_ADDRESS_ENV]?.trim() || EMPTY_PREPROD_ADDRESS;

  if (typeof fetchFn !== "function") {
    throw new PreprodNegativeGuardrailsStageError("fetch_unavailable", "fetch is required for negative guardrails.");
  }

  const checks = [];
  checks.push(await assertWrongNetworkBlocksReclaimPage(page, appTarget.baseUrl, fundingRole));
  checks.push(await assertWrongNetworkBlocksClaimPage(page, appTarget.baseUrl, compromisedRole));
  checks.push(await assertImpactedWalletCannotSign(walletHarness, compromisedRole));
  checks.push(await assertSafeImpactedOverlapBlocked(destinationProofStageRunner, options, walletHarness, compromisedRole));
  checks.push(await assertTamperedClaimSubmitRejected(fetchFn, appTarget.baseUrl, walletHarness, proofBundle));
  checks.push(await assertWrongDestinationProofRejected(fetchFn, appTarget.baseUrl, proofBundle));
  checks.push(await assertInsufficientSafeWalletAdaRejected(fetchFn, appTarget.baseUrl, proofBundle, insufficientSafeWalletAddress));

  const screenshotPath = options.page
    ? path.join(outputDir, "screenshots", "negative-guardrails.png")
    : null;
  if (screenshotPath) {
    mkdir(path.dirname(screenshotPath), { recursive: true });
    await options.page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });
  }

  const artifactPath = path.join(outputDir, "negative-guardrails.json");
  const artifact = {
    schema: "proof-tool-preprod-negative-guardrails-stage-v1",
    stage: NEGATIVE_GUARDRAILS_STAGE_NAME,
    selectedOutrefCount: Array.isArray(proofBundle.selectedOutrefs) ? proofBundle.selectedOutrefs.length : 0,
    checks,
    insufficientSafeWalletAddress: redactAddress(insufficientSafeWalletAddress),
    txCborWritten: false,
    witnessSetWritten: false,
    reviewTokenWritten: false,
    proofBytesWritten: false,
    screenshots: screenshotPath ? [path.relative(outputDir, screenshotPath)] : [],
  };
  writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  return {
    ok: true,
    artifacts: screenshotPath ? [artifactPath, screenshotPath] : [artifactPath],
    summary: {
      stage: NEGATIVE_GUARDRAILS_STAGE_NAME,
      checks: checks.map((check) => ({
        name: check.name,
        status: check.status,
        code: check.code ?? null,
      })),
    },
  };
}

async function assertWrongNetworkBlocksReclaimPage(page, baseUrl, fundingRole) {
  await page.goto(new URL("/reclaim", baseUrl).toString(), { waitUntil: "domcontentloaded" });
  await forceWalletNetwork(page, fundingRole, WRONG_NETWORK_ID);
  await page.getByLabel("Cardano wallet").selectOption(fundingRole);
  await page.getByRole("button", { name: /connect wallet/iu }).click();
  const evidence = await waitForWrongNetworkReclaimEvidence(page);
  return {
    name: "wrong-network-reclaim-page",
    status: "blocked",
    walletRole: fundingRole,
    observedNetworkId: WRONG_NETWORK_ID,
    expectedNetworkId: 0,
    evidence,
  };
}

async function assertWrongNetworkBlocksClaimPage(page, baseUrl, compromisedRole) {
  await page.goto(new URL("/claim", baseUrl).toString(), { waitUntil: "domcontentloaded" });
  await forceWalletNetwork(page, compromisedRole, WRONG_NETWORK_ID);
  await page.getByRole("button", { name: /^Continue$/iu }).click();
  await page.getByRole("heading", { name: "Connect impacted wallet" }).waitFor();
  await page.getByRole("button", { name: walletButtonName(compromisedRole) }).click();
  await page.getByRole("button", { name: /Connect impacted wallet/iu }).click();
  await page.getByText(/This wallet is not on Preprod/iu).waitFor();
  return {
    name: "wrong-network-claim-page",
    status: "blocked",
    walletRole: compromisedRole,
    observedNetworkId: WRONG_NETWORK_ID,
    expectedNetworkId: 0,
    evidence: "This wallet is not on Preprod",
  };
}

async function assertImpactedWalletCannotSign(walletHarness, compromisedRole) {
  const error = await expectError(() => walletHarness.call?.(compromisedRole, "signTx", ["00", true]));
  if (error.code !== "wallet_role_signing_forbidden") {
    throw new PreprodNegativeGuardrailsStageError(
      "impacted_wallet_signing_guardrail_failed",
      `Expected impacted wallet signing to fail with wallet_role_signing_forbidden, got ${error.code}.`,
    );
  }
  return {
    name: "impacted-wallet-signing",
    status: "blocked",
    walletRole: compromisedRole,
    code: error.code,
  };
}

async function assertSafeImpactedOverlapBlocked(destinationProofStageRunner, options, walletHarness, compromisedRole) {
  const impactedState = walletHarness.roleState?.(compromisedRole);
  const overlappedHarness = {
    ...walletHarness,
    roleState(role) {
      const state = walletHarness.roleState?.(role);
      if (role === SAFE_WALLET_ROLE && state && impactedState?.paymentCredential) {
        return {
          ...state,
          paymentCredential: impactedState.paymentCredential,
        };
      }
      return state;
    },
  };
  const error = await expectError(() =>
    destinationProofStageRunner({
      env: options.env ?? process.env,
      appTarget: options.appTarget,
      helperTarget: options.helperTarget ?? { helperUrl: "http://127.0.0.1:49152", token: "redacted" },
      walletHarness: overlappedHarness,
      outputDir: options.outputDir,
      fetch: () => {
        throw new Error("overlap guardrail must fail before network fetches");
      },
      page: null,
    }),
  );
  if (error.code !== "safe_impacted_wallet_overlap") {
    throw new PreprodNegativeGuardrailsStageError(
      "safe_impacted_overlap_guardrail_failed",
      `Expected safe/impacted overlap to fail with safe_impacted_wallet_overlap, got ${error.code}.`,
    );
  }
  return {
    name: "safe-impacted-wallet-overlap",
    status: "blocked",
    code: error.code,
  };
}

async function assertTamperedClaimSubmitRejected(fetchFn, baseUrl, walletHarness, proofBundle) {
  const build = await postAppJson(fetchFn, baseUrl, "/claim-api/build", claimBuildRequest(proofBundle));
  assertClaimBuild(build);
  const witnessSetCbor = await walletHarness.call?.(SAFE_WALLET_ROLE, "signTx", [build.txCbor, true]);
  if (!isHex(witnessSetCbor)) {
    throw new PreprodNegativeGuardrailsStageError("safe_wallet_witness_invalid", "Safe wallet did not return witness set CBOR.");
  }
  const tamperedUnsignedTxCbor = tamperHex(build.txCbor);
  const failure = await postAppFailure(fetchFn, baseUrl, "/claim-api/submit", {
    deploymentId: proofBundle.deploymentId,
    selectedOutrefs: proofBundle.selectedOutrefs,
    review: build.review,
    unsignedTxCbor: tamperedUnsignedTxCbor,
    witnessSetCbor,
    claimBuildReviewToken: build.reviewToken,
  });
  if (failure.code !== "claim_submit_review_mismatch") {
    throw new PreprodNegativeGuardrailsStageError(
      "tampered_claim_submit_guardrail_failed",
      `Expected tampered claim submit to fail before provider submission, got ${failure.code}.`,
    );
  }
  return {
    name: "tampered-claim-submit",
    status: "blocked",
    endpoint: "/claim-api/submit",
    httpStatus: failure.status,
    code: failure.code,
    reviewedTxHash: build.txHash,
    tamper: "unsigned_tx_cbor_review_hash_mismatch",
  };
}

async function assertWrongDestinationProofRejected(fetchFn, baseUrl, proofBundle) {
  const request = claimBuildRequest(proofBundle);
  const tampered = cloneJson(request);
  const firstProof = tampered.proofArtifacts?.[0]?.artifact ?? tampered.proofArtifacts?.[0];
  if (!firstProof || typeof firstProof !== "object") {
    throw new PreprodNegativeGuardrailsStageError("proof_bundle_invalid", "Proof bundle did not include a proof artifact to tamper.");
  }
  firstProof.destination_address = tamperHex(firstProof.destination_address);
  const failure = await postAppFailure(fetchFn, baseUrl, "/claim-api/build", tampered);
  if (failure.code !== "proof_artifact_destination") {
    throw new PreprodNegativeGuardrailsStageError(
      "wrong_destination_proof_guardrail_failed",
      `Expected wrong destination proof to fail with proof_artifact_destination, got ${failure.code}.`,
    );
  }
  return {
    name: "wrong-destination-proof",
    status: "blocked",
    endpoint: "/claim-api/build",
    httpStatus: failure.status,
    code: failure.code,
  };
}

async function assertInsufficientSafeWalletAdaRejected(fetchFn, baseUrl, proofBundle, safeWalletAddress) {
  const draft = proofBundle.draft;
  const selectedOutrefs = selectedOutrefsFromProofBundle(proofBundle);
  const failure = await postAppFailure(fetchFn, baseUrl, "/claim-api/draft", {
    deploymentId: proofBundle.deploymentId,
    networkId: draft.networkId,
    safeWalletChangeAddress: safeWalletAddress,
    safeWalletAddresses: [safeWalletAddress],
    selectedOutrefs,
    maxUtxos: selectedOutrefs.length,
  });
  if (failure.code !== "safe_wallet_lovelace_unavailable") {
    throw new PreprodNegativeGuardrailsStageError(
      "insufficient_safe_wallet_ada_guardrail_failed",
      `Expected insufficient safe-wallet ADA to fail with safe_wallet_lovelace_unavailable, got ${failure.code}.`,
    );
  }
  return {
    name: "insufficient-safe-wallet-fee-ada",
    status: "blocked",
    endpoint: "/claim-api/draft",
    httpStatus: failure.status,
    code: failure.code,
  };
}

function claimBuildRequest(proofBundle) {
  const draft = proofBundle?.draft;
  const selectedOutrefs = selectedOutrefsFromProofBundle(proofBundle);
  if (!draft || !Array.isArray(proofBundle.proofArtifacts) || proofBundle.proofArtifacts.length !== selectedOutrefs.length) {
    throw new PreprodNegativeGuardrailsStageError("proof_bundle_invalid", "Destination proof bundle is missing buildable proof artifacts.");
  }
  return {
    deploymentId: proofBundle.deploymentId,
    networkId: draft.networkId,
    draftId: draft.draftId,
    selectedOutrefs,
    safeWalletChangeAddress: proofBundle.safeWalletChangeAddress,
    safeWalletAddresses: proofBundle.safeWalletAddresses,
    proofArtifacts: proofBundle.proofArtifacts,
  };
}

function selectedOutrefsFromProofBundle(proofBundle) {
  if (!Array.isArray(proofBundle?.selectedOutrefs) || proofBundle.selectedOutrefs.length === 0) {
    throw new PreprodNegativeGuardrailsStageError("proof_bundle_invalid", "Destination proof bundle is missing selected outrefs.");
  }
  return proofBundle.selectedOutrefs;
}

function assertClaimBuild(build) {
  if (!isHex(build?.txCbor) || !isHex(build?.txHash) || build.txHash.length !== 64) {
    throw new PreprodNegativeGuardrailsStageError("claim_build_tx_invalid", "Claim build response did not include a valid unsigned transaction.");
  }
  if (typeof build.reviewToken !== "string" || build.reviewToken.trim() === "") {
    throw new PreprodNegativeGuardrailsStageError("claim_build_review_token_missing", "Claim build response did not include a review token.");
  }
  if (!build.review || typeof build.review !== "object") {
    throw new PreprodNegativeGuardrailsStageError("claim_build_review_missing", "Claim build response did not include review material.");
  }
}

async function postAppJson(fetchFn, baseUrl, endpoint, body) {
  const response = await fetchApp(fetchFn, baseUrl, endpoint, body);
  const payload = await response.json();
  if (response.status < 200 || response.status >= 300) {
    throw new PreprodNegativeGuardrailsStageError(
      "unexpected_http_error",
      `${endpoint} returned HTTP ${response.status}: ${payload?.code ?? "unknown"}.`,
    );
  }
  return payload;
}

async function postAppFailure(fetchFn, baseUrl, endpoint, body) {
  const response = await fetchApp(fetchFn, baseUrl, endpoint, body);
  const payload = await safeJson(response);
  if (response.status >= 200 && response.status < 300) {
    throw new PreprodNegativeGuardrailsStageError(`${guardrailName(endpoint)}_not_rejected`, `${endpoint} accepted a negative guardrail request.`);
  }
  return {
    status: response.status,
    code: typeof payload?.code === "string" ? payload.code : "unknown_error",
  };
}

async function fetchApp(fetchFn, baseUrl, endpoint, body) {
  let response;
  try {
    response = await fetchFn(new URL(endpoint, baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new PreprodNegativeGuardrailsStageError("fetch_failed", `Negative guardrail request failed: ${error?.message ?? "request failed"}`);
  }
  if (!response || !Number.isInteger(response.status) || typeof response.json !== "function") {
    throw new PreprodNegativeGuardrailsStageError("response_malformed", `${endpoint} did not return a JSON response.`);
  }
  return response;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function forceWalletNetwork(page, role, networkId) {
  await page.evaluate(
    ({ role: walletRole, networkId: forcedNetworkId }) => {
      const provider = globalThis.cardano?.[walletRole];
      if (!provider || typeof provider.enable !== "function") {
        throw new Error(`CIP-30 provider missing for ${walletRole}`);
      }
      const originalEnable = provider.enable.bind(provider);
      provider.enable = async () => {
        const api = await originalEnable();
        return {
          ...api,
          getNetworkId: async () => forcedNetworkId,
        };
      };
    },
    { role, networkId },
  );
}

async function waitForWrongNetworkReclaimEvidence(page) {
  return Promise.race([
    page.getByText("Network mismatch").waitFor().then(() => "Network mismatch"),
    page
      .getByText(/Wallet address network does not match/iu)
      .waitFor()
      .then(() => "Wallet address network does not match the connected wallet."),
  ]);
}

async function expectError(fn) {
  try {
    await fn();
  } catch (error) {
    return {
      code: typeof error?.code === "string" ? error.code : "unknown_error",
      message: typeof error?.message === "string" ? error.message : "Unknown error.",
    };
  }
  throw new PreprodNegativeGuardrailsStageError("guardrail_not_rejected", "Negative guardrail operation unexpectedly succeeded.");
}

function walletButtonName(role) {
  return new RegExp(`Proof Tool Preprod ${escapeRegex(role.replaceAll("_", " "))}`, "iu");
}

function guardrailName(endpoint) {
  if (endpoint === "/claim-api/submit") {
    return "tampered_claim_submit";
  }
  if (endpoint === "/claim-api/build") {
    return "wrong_destination_proof";
  }
  if (endpoint === "/claim-api/draft") {
    return "insufficient_safe_wallet_ada";
  }
  return "guardrail";
}

function tamperHex(value) {
  if (!isHex(value)) {
    throw new PreprodNegativeGuardrailsStageError("hex_tamper_input_invalid", "Expected hex input to tamper.");
  }
  const last = value[value.length - 1];
  const replacement = last === "0" ? "1" : "0";
  return `${value.slice(0, -1)}${replacement}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isHex(value) {
  return typeof value === "string" && /^[0-9a-f]+$/iu.test(value);
}

function requireOption(value, name) {
  if (!value) {
    throw new PreprodNegativeGuardrailsStageError(`${name}_missing`, `${name} is required for negative guardrails.`);
  }
  return value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
