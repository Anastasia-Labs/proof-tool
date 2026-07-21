import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CLAIM_FIRST_BATCH_STAGE_NAME = "claim-first-batch";
export const CLAIM_PROGRESS_POLL_MS_ENV = "RECLAIM_E2E_CLAIM_PROGRESS_POLL_MS";
export const CLAIM_PROGRESS_TIMEOUT_MS_ENV = "RECLAIM_E2E_CLAIM_PROGRESS_TIMEOUT_MS";

const SAFE_WALLET_ROLE = "safe_claim_destination";
const DEFAULT_PROGRESS_POLL_MS = 5000;
const DEFAULT_PROGRESS_TIMEOUT_MS = 180000;

export class PreprodClaimStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodClaimStageError";
    this.code = code;
  }
}

export async function runClaimFirstBatchStage(options = {}) {
  const env = options.env ?? process.env;
  const appTarget = requireOption(options.appTarget, "appTarget");
  const walletHarness = requireOption(options.walletHarness, "walletHarness");
  const outputDir = requireOption(options.outputDir, "outputDir");
  const proofBundle = requireOption(options.proofBundle, "proofBundle");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const progressPollMs = parsePositiveInt(
    env[CLAIM_PROGRESS_POLL_MS_ENV]?.trim(),
    DEFAULT_PROGRESS_POLL_MS,
    CLAIM_PROGRESS_POLL_MS_ENV,
  );
  const progressTimeoutMs = parsePositiveInt(
    env[CLAIM_PROGRESS_TIMEOUT_MS_ENV]?.trim(),
    DEFAULT_PROGRESS_TIMEOUT_MS,
    CLAIM_PROGRESS_TIMEOUT_MS_ENV,
  );
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (typeof fetchFn !== "function") {
    throw new PreprodClaimStageError("fetch_unavailable", "fetch is required for claim-first-batch.");
  }

  const beforeState = walletState(walletHarness, SAFE_WALLET_ROLE);
  if (beforeState.canSign !== true) {
    throw new PreprodClaimStageError(
      "safe_wallet_read_only",
      `${SAFE_WALLET_ROLE} must be able to sign the claim transaction.`,
    );
  }
  const signAttemptsBefore = numberOrZero(beforeState.signAttempts);
  const buildRequest = claimBuildRequest(proofBundle);
  const build = await fetchAppJson(fetchFn, appTarget.baseUrl, "/claim-api/build", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildRequest),
  });
  assertClaimBuild(build, proofBundle.selectedOutrefs);

  const witnessSetCbor = await walletHarness.call?.(SAFE_WALLET_ROLE, "signTx", [build.txCbor, true]);
  if (!isHex(witnessSetCbor)) {
    throw new PreprodClaimStageError(
      "safe_wallet_witness_invalid",
      "Safe wallet did not return a witness set CBOR hex string.",
    );
  }
  const afterState = walletState(walletHarness, SAFE_WALLET_ROLE);
  const signAttemptsAfter = numberOrZero(afterState.signAttempts);
  if (signAttemptsAfter !== signAttemptsBefore + 1) {
    throw new PreprodClaimStageError(
      "safe_wallet_sign_attempt_mismatch",
      "Safe wallet sign attempt count did not change exactly once.",
    );
  }

  const submit = await fetchAppJson(fetchFn, appTarget.baseUrl, "/claim-api/submit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      deploymentId: proofBundle.deploymentId,
      selectedOutrefs: proofBundle.selectedOutrefs,
      review: build.review,
      unsignedTxCbor: build.txCbor,
      witnessSetCbor,
      claimBuildReviewToken: build.reviewToken,
    }),
  });
  assertClaimSubmit(submit, build, proofBundle.selectedOutrefs);
  const progress = await waitForSelectedOutrefsSpent(fetchFn, appTarget.baseUrl, proofBundle.selectedOutrefs, {
    pollMs: progressPollMs,
    timeoutMs: progressTimeoutMs,
    sleep,
  });

  const screenshotPath = options.page ? path.join(outputDir, "screenshots", "claim-first-batch.png") : null;
  if (screenshotPath) {
    mkdir(path.dirname(screenshotPath), { recursive: true });
    await options.page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });
  }

  const artifactPath = path.join(outputDir, "claim-first-batch.json");
  const artifact = {
    schema: "proof-tool-preprod-claim-first-batch-stage-v1",
    stage: CLAIM_FIRST_BATCH_STAGE_NAME,
    deploymentId: proofBundle.deploymentId,
    draftId: proofBundle.draft.draftId,
    selectedOutrefs: proofBundle.selectedOutrefs,
    txHash: build.txHash,
    reviewHash: build.reviewHash,
    submittedTxHash: submit.txHash,
    safeWalletRole: SAFE_WALLET_ROLE,
    safeWalletSignAttempts: {
      before: signAttemptsBefore,
      after: signAttemptsAfter,
    },
    progress: {
      status: "spent_or_unknown",
      polls: progress.polls,
      selectedOutrefs: progress.selectedOutrefs,
    },
    evaluation: summarizeEvaluation(build.evaluation),
    destinationOutputStartIndex: build.review.destinationOutputStartIndex,
    transactionInputOrder: build.review.transactionInputOrder,
    proofDigestSummaries: build.review.proofDigests.map((proof) => ({
      outRefId: proof.outRefId,
      targetCredential: redactCredential(proof.targetCredential),
      destinationAddressSha256: sha256Hex(proof.destinationAddress),
      publicInputDigestSha256: sha256Hex(proof.publicInputDigestHex),
    })),
    destinationValueSummaries: destinationValueSummaries(build.review.destinationOutputs),
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
      stage: CLAIM_FIRST_BATCH_STAGE_NAME,
      deploymentId: proofBundle.deploymentId,
      selectedOutrefs: proofBundle.selectedOutrefs,
      txHash: submit.txHash,
      reviewHash: build.reviewHash,
      progress: artifact.progress,
      evaluation: artifact.evaluation,
      destinationValueSummaries: artifact.destinationValueSummaries,
    },
    claimBundle: {
      deploymentId: proofBundle.deploymentId,
      draftId: proofBundle.draft.draftId,
      selectedOutrefs: proofBundle.selectedOutrefs,
      txHash: submit.txHash,
      reviewHash: build.reviewHash,
      destinationValueSummaries: artifact.destinationValueSummaries,
      evaluation: artifact.evaluation,
    },
  };
}

function claimBuildRequest(proofBundle) {
  const draft = proofBundle?.draft;
  const selectedOutrefs = proofBundle?.selectedOutrefs;
  if (!draft || !Array.isArray(selectedOutrefs) || selectedOutrefs.length === 0) {
    throw new PreprodClaimStageError(
      "proof_bundle_invalid",
      "Destination proof bundle is missing the selected claim batch.",
    );
  }
  if (!Array.isArray(proofBundle.proofArtifacts) || proofBundle.proofArtifacts.length !== selectedOutrefs.length) {
    throw new PreprodClaimStageError(
      "proof_bundle_invalid",
      "Destination proof bundle artifact count does not match the selected claim batch.",
    );
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

async function fetchAppJson(fetchFn, baseUrl, endpoint, init) {
  let response;
  const url = new URL(endpoint, baseUrl);
  try {
    response = await fetchFn(url, init);
  } catch (error) {
    throw new PreprodClaimStageError(
      "fetch_failed",
      `Claim stage request failed: ${error?.message ?? "request failed"}`,
    );
  }
  if (!response || response.status < 200 || response.status >= 300) {
    const detail = response ? await readErrorDetail(response) : "";
    throw new PreprodClaimStageError(
      "http_error",
      `${endpoint} returned HTTP ${response?.status ?? "unknown"}${detail}.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new PreprodClaimStageError("json_malformed", `${endpoint} did not return valid JSON.`);
  }
}

async function readErrorDetail(response) {
  try {
    const body = await response.json();
    const code = typeof body?.code === "string" && /^[a-z0-9_:-]+$/iu.test(body.code) ? body.code : "";
    const message = typeof body?.error === "string" ? sanitizeHttpErrorMessage(body.error) : "";
    const parts = [code, message].filter(Boolean);
    return parts.length > 0 ? `: ${parts.join(": ")}` : "";
  } catch {
    return "";
  }
}

function sanitizeHttpErrorMessage(value) {
  return value
    .replace(/\b(addr(?:_test)?1[0-9a-z]{20,})\b/giu, "[address-redacted]")
    .replace(/\b(stake(?:_test)?1[0-9a-z]{20,})\b/giu, "[address-redacted]")
    .replace(/\b[0-9a-f]{96,}\b/giu, "[hex-redacted]")
    .replace(/\b[A-Za-z0-9_-]{96,}\b/gu, "[token-redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 360);
}

function assertClaimBuild(build, selectedOutrefs) {
  if (!isHex(build?.txCbor) || !isHex(build?.txHash) || build.txHash.length !== 64) {
    throw new PreprodClaimStageError(
      "claim_build_tx_invalid",
      "Claim build response did not include a valid unsigned transaction.",
    );
  }
  if (typeof build.reviewToken !== "string" || build.reviewToken.trim() === "") {
    throw new PreprodClaimStageError(
      "claim_build_review_token_missing",
      "Claim build response did not include a review token.",
    );
  }
  if (!build.review || build.reviewHash !== sha256Stable(build.review)) {
    throw new PreprodClaimStageError("claim_build_review_invalid", "Claim build review hash is inconsistent.");
  }
  if (build.review.selectedOutrefs?.join("|") !== selectedOutrefs.join("|")) {
    throw new PreprodClaimStageError(
      "claim_build_selected_outrefs_mismatch",
      "Claim build selected outrefs do not match the proof bundle.",
    );
  }
  if (!Array.isArray(build.review.proofDigests) || build.review.proofDigests.length !== selectedOutrefs.length) {
    throw new PreprodClaimStageError(
      "claim_build_proof_digests_missing",
      "Claim build review did not include proof digests for the selected batch.",
    );
  }
  const evaluation = summarizeEvaluation(build.evaluation);
  if (
    (evaluation.memoryPercent !== null && evaluation.memoryPercent > 100) ||
    (evaluation.cpuPercent !== null && evaluation.cpuPercent > 100)
  ) {
    throw new PreprodClaimStageError(
      "claim_evaluation_margin_exceeded",
      "Claim build evaluation exceeds protocol limits.",
    );
  }
}

function assertClaimSubmit(submit, build, selectedOutrefs) {
  if (submit?.txHash !== build.txHash) {
    throw new PreprodClaimStageError(
      "claim_submit_tx_hash_mismatch",
      "Claim submit tx hash did not match the reviewed build.",
    );
  }
  if (submit.deploymentId !== build.review.deploymentId) {
    throw new PreprodClaimStageError(
      "claim_submit_deployment_mismatch",
      "Claim submit deployment id did not match the reviewed build.",
    );
  }
  if (submit.selectedOutrefs?.join("|") !== selectedOutrefs.join("|")) {
    throw new PreprodClaimStageError(
      "claim_submit_selected_outrefs_mismatch",
      "Claim submit selected outrefs did not match the selected batch.",
    );
  }
}

async function waitForSelectedOutrefsSpent(fetchFn, baseUrl, selectedOutrefs, options) {
  const startedAt = Date.now();
  let polls = 0;
  while (Date.now() - startedAt <= options.timeoutMs) {
    polls += 1;
    const endpoint = new URL("/claim-api/progress", baseUrl);
    endpoint.searchParams.set("outrefs", selectedOutrefs.join(","));
    const progress = await fetchJson(fetchFn, endpoint);
    const selected = progress?.outrefs;
    if (!Array.isArray(selected)) {
      throw new PreprodClaimStageError(
        "claim_progress_malformed",
        "Claim progress response did not include selected outref statuses.",
      );
    }
    const statuses = new Map(selected.map((item) => [item.outRefId, item.state]));
    const missing = selectedOutrefs.filter((outRef) => !statuses.has(outRef));
    if (missing.length > 0) {
      throw new PreprodClaimStageError("claim_progress_malformed", "Claim progress response omitted selected outrefs.");
    }
    const states = selectedOutrefs.map((outRef) => statuses.get(outRef));
    if (states.every((state) => state === "spent_or_unknown" || state === "confirmed_spent")) {
      return {
        polls,
        selectedOutrefs: selectedOutrefs.map((outRef, index) => ({
          outRefId: outRef,
          state: states[index],
        })),
      };
    }
    if (states.some((state) => state === "dropped" || state === "replaced")) {
      throw new PreprodClaimStageError(
        "claim_progress_terminal_failure",
        "Claim progress reported a dropped or replaced selected outref.",
      );
    }
    await options.sleep(options.pollMs);
  }
  throw new PreprodClaimStageError(
    "claim_progress_timeout",
    "Timed out waiting for selected reclaim outrefs to be spent.",
  );
}

async function fetchJson(fetchFn, url) {
  let response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    throw new PreprodClaimStageError(
      "fetch_failed",
      `Claim stage request failed: ${error?.message ?? "request failed"}`,
    );
  }
  if (!response || response.status < 200 || response.status >= 300) {
    throw new PreprodClaimStageError("http_error", `${url.pathname} returned HTTP ${response?.status ?? "unknown"}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new PreprodClaimStageError("json_malformed", `${url.pathname} did not return valid JSON.`);
  }
}

function summarizeEvaluation(value) {
  if (!value || typeof value !== "object") {
    throw new PreprodClaimStageError("claim_evaluation_missing", "Claim build did not include provider evaluation.");
  }
  const memoryPercent = percentOrNull(value.memoryPercent);
  const cpuPercent = percentOrNull(value.cpuPercent);
  return {
    redeemerCount: Array.isArray(value.redeemers) ? value.redeemers.length : 0,
    totalMemory: String(value.totalMemory ?? ""),
    totalSteps: String(value.totalSteps ?? ""),
    memoryPercent,
    cpuPercent,
  };
}

function destinationValueSummaries(outputs) {
  if (!Array.isArray(outputs)) {
    return [];
  }
  return outputs.map((output) => ({
    outRefId: String(output.outRefId ?? ""),
    destinationAddressSha256: sha256Hex(String(output.destinationAddress ?? "")),
    value: output.value && typeof output.value === "object" ? output.value : {},
  }));
}

function walletState(walletHarness, role) {
  const state = walletHarness.roleState?.(role);
  if (!state) {
    throw new PreprodClaimStageError("safe_wallet_missing", `${role} is not available in the CIP-30 harness.`);
  }
  return state;
}

function requireOption(value, name) {
  if (!value) {
    throw new PreprodClaimStageError(`${name}_missing`, `${name} is required for claim-first-batch.`);
  }
  return value;
}

function parsePositiveInt(value, fallback, field) {
  if (!value) {
    return fallback;
  }
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new PreprodClaimStageError("claim_progress_config_invalid", `${field} must be a positive integer.`);
  }
  return Number(value);
}

function percentOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function numberOrZero(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function isHex(value) {
  return typeof value === "string" && /^[0-9a-f]+$/u.test(value);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Stable(value) {
  return sha256Hex(stableStringify(value));
}

function redactCredential(value) {
  if (typeof value !== "string" || value.length < 16) {
    return "[redacted-credential]";
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
