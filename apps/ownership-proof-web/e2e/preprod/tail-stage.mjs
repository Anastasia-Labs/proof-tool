import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runClaimFirstBatchStage } from "./claim-stage.mjs";
import { COMPROMISED_WALLET_ROLE_ENV } from "./funding-stage.mjs";
import { CLAIM_BATCH_SIZE_ENV, runDestinationProofStage } from "./proof-stage.mjs";

export const CLAIM_TAIL_RECEIPT_STAGE_NAME = "claim-tail-and-receipt";
export const CLAIM_TAIL_MAX_BATCHES_ENV = "RECLAIM_E2E_CLAIM_TAIL_MAX_BATCHES";

const DEFAULT_COMPROMISED_WALLET_ROLE = "compromised_user";
const DEFAULT_MAX_TAIL_BATCHES = 10;
const DEFAULT_TAIL_BATCH_SIZE = 4;

export class PreprodClaimTailStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodClaimTailStageError";
    this.code = code;
  }
}

export async function runClaimTailAndReceiptStage(options = {}) {
  const env = options.env ?? process.env;
  const appTarget = requireOption(options.appTarget, "appTarget");
  const helperTarget = requireOption(options.helperTarget, "helperTarget");
  const walletHarness = requireOption(options.walletHarness, "walletHarness");
  const outputDir = requireOption(options.outputDir, "outputDir");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const proofStageRunner = options.destinationProofStageRunner ?? runDestinationProofStage;
  const claimStageRunner = options.claimFirstBatchStageRunner ?? runClaimFirstBatchStage;
  const maxTailBatches = parsePositiveInt(
    env[CLAIM_TAIL_MAX_BATCHES_ENV]?.trim(),
    DEFAULT_MAX_TAIL_BATCHES,
    CLAIM_TAIL_MAX_BATCHES_ENV,
  );
  if (typeof fetchFn !== "function") {
    throw new PreprodClaimTailStageError("fetch_unavailable", "fetch is required for claim-tail-and-receipt.");
  }

  const compromisedRole = env[COMPROMISED_WALLET_ROLE_ENV]?.trim() || DEFAULT_COMPROMISED_WALLET_ROLE;
  const impactedCredential = assertCredential(walletHarness.roleState?.(compromisedRole)?.paymentCredential);
  const artifacts = [];
  const firstClaimBundle = options.firstClaimBundle ?? null;
  const claimBundles = firstClaimBundle ? [firstClaimBundle] : [];
  const tailBatches = [];

  for (let batchIndex = 1; batchIndex <= maxTailBatches; batchIndex += 1) {
    const remaining = await loadMatchingReclaimUtxos(fetchFn, appTarget.baseUrl, impactedCredential);
    if (remaining.length === 0) {
      return writeReceipt({
        outputDir,
        mkdir,
        writeFile,
        page: options.page,
        artifacts,
        claimBundles,
        tailBatches,
        remainingMatchingUtxos: 0,
      });
    }

    const batchSize = Math.min(remaining.length, DEFAULT_TAIL_BATCH_SIZE);
    const batchOutputDir = path.join(outputDir, `claim-tail-batch-${batchIndex}`);
    mkdir(batchOutputDir, { recursive: true });
    const batchEnv = {
      ...env,
      [CLAIM_BATCH_SIZE_ENV]: String(batchSize),
    };
    const proofStage = await proofStageRunner({
      ...(options.destinationProofStageOptions ?? {}),
      env: batchEnv,
      page: options.page,
      walletHarness,
      appTarget,
      helperTarget,
      outputDir: batchOutputDir,
      fetch: fetchFn,
    });
    if (Array.isArray(proofStage?.artifacts)) {
      artifacts.push(...proofStage.artifacts);
    }
    const claimStage = await claimStageRunner({
      ...(options.claimFirstBatchStageOptions ?? {}),
      env: batchEnv,
      page: options.page,
      walletHarness,
      appTarget,
      outputDir: batchOutputDir,
      proofBundle: proofStage.proofBundle,
      fetch: fetchFn,
    });
    if (Array.isArray(claimStage?.artifacts)) {
      artifacts.push(...claimStage.artifacts);
    }
    if (!claimStage?.claimBundle) {
      throw new PreprodClaimTailStageError("claim_tail_bundle_missing", "Tail claim stage did not return a claim bundle.");
    }
    claimBundles.push(claimStage.claimBundle);
    tailBatches.push({
      batch: batchIndex,
      selectedOutrefs: claimStage.claimBundle.selectedOutrefs,
      txHash: claimStage.claimBundle.txHash,
      reviewHash: claimStage.claimBundle.reviewHash,
      evaluation: claimStage.claimBundle.evaluation,
    });
  }

  const remaining = await loadMatchingReclaimUtxos(fetchFn, appTarget.baseUrl, impactedCredential);
  if (remaining.length === 0) {
    return writeReceipt({
      outputDir,
      mkdir,
      writeFile,
      page: options.page,
      artifacts,
      claimBundles,
      tailBatches,
      remainingMatchingUtxos: 0,
    });
  }
  throw new PreprodClaimTailStageError(
    "claim_tail_remaining_batches",
    `Claim tail still has ${remaining.length} matching UTxOs after ${maxTailBatches} tail batches.`,
  );
}

async function writeReceipt({ outputDir, mkdir, writeFile, page, artifacts, claimBundles, tailBatches, remainingMatchingUtxos }) {
  const screenshotPath = page ? path.join(outputDir, "screenshots", "claim-tail-and-receipt.png") : null;
  if (screenshotPath) {
    mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });
  }

  const artifactPath = path.join(outputDir, "claim-tail-and-receipt.json");
  const receipt = {
    schema: "proof-tool-preprod-claim-tail-receipt-stage-v1",
    stage: CLAIM_TAIL_RECEIPT_STAGE_NAME,
    receiptReady: true,
    remainingMatchingUtxos,
    claimCount: claimBundles.length,
    claimTxHashes: claimBundles.map((bundle) => bundle.txHash),
    claimedOutrefs: claimBundles.flatMap((bundle) => bundle.selectedOutrefs ?? []),
    tailBatches,
    reviewedDestinationValue: reviewedDestinationValue(claimBundles),
    safeWalletBalanceVerified: false,
    artifacts: artifacts.map((artifact) => path.relative(outputDir, artifact)),
    txCborWritten: false,
    witnessSetWritten: false,
    reviewTokenWritten: false,
    proofBytesWritten: false,
    screenshots: screenshotPath ? [path.relative(outputDir, screenshotPath)] : [],
  };
  writeFile(artifactPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return {
    ok: true,
    artifacts: screenshotPath ? [artifactPath, screenshotPath, ...artifacts] : [artifactPath, ...artifacts],
    summary: {
      stage: CLAIM_TAIL_RECEIPT_STAGE_NAME,
      receiptReady: true,
      remainingMatchingUtxos,
      claimCount: receipt.claimCount,
      claimTxHashes: receipt.claimTxHashes,
      reviewedDestinationValue: receipt.reviewedDestinationValue,
      safeWalletBalanceVerified: receipt.safeWalletBalanceVerified,
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
      throw new PreprodClaimTailStageError("claim_index_unavailable", "Claim index is not available for claim-tail-and-receipt.");
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

async function fetchJson(fetchFn, url) {
  let response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    throw new PreprodClaimTailStageError("fetch_failed", `Claim tail request failed: ${error?.message ?? "request failed"}`);
  }
  if (!response || response.status < 200 || response.status >= 300) {
    throw new PreprodClaimTailStageError("http_error", `${url.pathname} returned HTTP ${response?.status ?? "unknown"}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new PreprodClaimTailStageError("json_malformed", `${url.pathname} did not return valid JSON.`);
  }
}

function reviewedDestinationValue(claimBundles) {
  const totals = new Map();
  for (const bundle of claimBundles) {
    for (const summary of bundle.destinationValueSummaries ?? []) {
      for (const [unit, quantity] of Object.entries(summary.value ?? {})) {
        if (!/^(0|[1-9][0-9]*)$/u.test(String(quantity))) {
          continue;
        }
        totals.set(unit, (totals.get(unit) ?? 0n) + BigInt(quantity));
      }
    }
  }
  return Object.fromEntries([...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([unit, quantity]) => [unit, quantity.toString()]));
}

function assertCredential(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{56}$/u.test(value)) {
    throw new PreprodClaimTailStageError("impacted_wallet_credential_missing", "Impacted wallet role must expose a 28-byte payment credential.");
  }
  return value;
}

function requireOption(value, name) {
  if (!value) {
    throw new PreprodClaimTailStageError(`${name}_missing`, `${name} is required for claim-tail-and-receipt.`);
  }
  return value;
}

function parsePositiveInt(value, fallback, field) {
  if (!value) {
    return fallback;
  }
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new PreprodClaimTailStageError("claim_tail_config_invalid", `${field} must be a positive integer.`);
  }
  return Number(value);
}
