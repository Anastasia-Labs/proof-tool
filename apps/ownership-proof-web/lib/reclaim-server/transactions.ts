import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { CML, Constr, Data, Lucid, type Assets, type Provider, type UTxO } from "@lucid-evolution/lucid";
import type {
  BuildReclaimTxRequest,
  BuildReclaimTxResponse,
  InspectReclaimTxRequest,
  InspectReclaimTxResponse,
  ReclaimDeployment,
  ReclaimTxReview,
  SubmitReclaimTxRequest,
  SubmitReclaimTxResponse,
} from "../reclaim/types";
import {
  assertAssetMap,
  assertPaymentCredential,
  assertRequestedAssetsAvailable,
  assertWalletAddress,
  assertWalletAddresses,
  assertWalletNetwork,
  assetMapToStringMap,
  sumUtxoAssets,
} from "../reclaim/validation";
import { assembleTransactionWithWitnessSet } from "../cardano/transactions";

export async function loadWalletAssets(
  provider: Provider,
  deployment: ReclaimDeployment,
  input: { changeAddress: unknown; walletAddresses: unknown },
) {
  const changeAddress = assertWalletAddress(input.changeAddress, deployment.network);
  const walletAddresses = assertWalletAddresses(input.walletAddresses, deployment.network);
  const queryAddresses = walletAddresses.includes(changeAddress)
    ? walletAddresses
    : [changeAddress, ...walletAddresses];
  const utxoGroups = await Promise.all(queryAddresses.map((address) => provider.getUtxos(address)));
  const utxos = dedupeUtxos(utxoGroups.flat());
  return {
    changeAddress,
    walletAddresses: queryAddresses,
    utxos,
    assets: sumUtxoAssets(utxos),
  };
}

export async function buildReclaimTx(
  provider: Provider,
  deployment: ReclaimDeployment,
  request: BuildReclaimTxRequest,
): Promise<BuildReclaimTxResponse> {
  assertWalletNetwork(request.networkId, deployment.networkId);
  if (request.deploymentId && request.deploymentId !== deployment.id) {
    throw new Error("Selected reclaim deployment is no longer current. Refresh the page and try again.");
  }

  const compromisedCredential = assertPaymentCredential(request.compromisedCredential);
  const wallet = await loadWalletAssets(provider, deployment, {
    changeAddress: request.changeAddress,
    walletAddresses: request.walletAddresses,
  });
  const requestedAssets = assertAssetMap(request.assets);
  assertRequestedAssetsAvailable(requestedAssets, wallet.assets);

  const lucid = await Lucid(provider, deployment.network);
  lucid.selectWallet.fromAddress(wallet.changeAddress, wallet.utxos as UTxO[]);

  const datumCbor = makeCompromisedCredentialDatum(compromisedCredential);
  const signBuilder = await lucid
    .newTx()
    .pay.ToAddressWithData(
      deployment.reclaimBaseAddress,
      {
        kind: "inline",
        value: datumCbor,
      },
      requestedAssets as Assets,
    )
    .complete({
      canonical: true,
      presetWalletInputs: wallet.utxos as UTxO[],
    });

  const review: ReclaimTxReview = {
    changeAddress: wallet.changeAddress,
    walletAddresses: wallet.walletAddresses,
    reclaimBaseAddress: deployment.reclaimBaseAddress,
    compromisedCredential,
    datumCbor,
    assets: assetMapToStringMap(requestedAssets),
    network: deployment.network,
    deploymentId: deployment.id,
  };
  const txCbor = signBuilder.toCBOR({ canonical: true });
  const txHash = signBuilder.toHash();
  const reviewHash = hashReview(review);

  return {
    txCbor,
    txHash,
    review,
    reviewHash,
    reviewToken: signReviewToken(deployment, {
      txHash,
      txCborHash: sha256Hex(txCbor),
      reviewHash,
    }),
  };
}

export async function submitReclaimTx(
  provider: Provider,
  deployment: ReclaimDeployment,
  request: SubmitReclaimTxRequest,
): Promise<SubmitReclaimTxResponse> {
  const inspection = inspectReclaimTx(deployment, request);
  if (request.signedTxCbor) {
    const submittedHash = await provider.submitTx(assertCbor(request.signedTxCbor, "signedTxCbor"));
    return submitResponse(submittedHash, inspection);
  }

  const unsignedTxCbor = assertCbor(request.unsignedTxCbor, "unsignedTxCbor");
  const witnessSetCbor = assertCbor(request.witnessSetCbor, "witnessSetCbor");
  const signedTxCbor = assembleTransactionWithWitnessSet(unsignedTxCbor, witnessSetCbor);
  inspectReclaimTx(deployment, {
    reviewToken: request.reviewToken,
    review: request.review,
    unsignedTxCbor,
    signedTxCbor,
  });
  const submittedHash = await provider.submitTx(signedTxCbor);
  return submitResponse(submittedHash, inspection);
}

export function inspectReclaimTx(
  deployment: ReclaimDeployment,
  request: InspectReclaimTxRequest,
): InspectReclaimTxResponse {
  if (!request.review) {
    throw new Error("review is required.");
  }
  if (!request.reviewToken) {
    throw new Error("reviewToken is required.");
  }
  const unsignedTxCbor = request.unsignedTxCbor ? assertCbor(request.unsignedTxCbor, "unsignedTxCbor") : "";
  const signedTxCbor = request.signedTxCbor ? assertCbor(request.signedTxCbor, "signedTxCbor") : "";
  const txCbor = signedTxCbor || unsignedTxCbor;
  if (!txCbor) {
    throw new Error("unsignedTxCbor or signedTxCbor is required.");
  }
  if (request.review.deploymentId !== deployment.id) {
    throw new Error("review deployment does not match the active deployment.");
  }

  const reviewedUnsignedHash = unsignedTxCbor ? parseTransactionHash(unsignedTxCbor, "unsignedTxCbor") : "";
  const inspectedHash = parseTransactionHash(txCbor, signedTxCbor ? "signedTxCbor" : "unsignedTxCbor");
  if (reviewedUnsignedHash && reviewedUnsignedHash !== inspectedHash) {
    throw new Error("signed transaction body does not match the reviewed unsigned transaction.");
  }

  const reviewHash = hashReview(request.review);
  const token = verifyReviewToken(deployment, request.reviewToken);
  if (token.reviewHash !== reviewHash) {
    throw new Error("review token does not match the reviewed protected output.");
  }
  if (token.txHash !== inspectedHash) {
    throw new Error("review token does not match the transaction body.");
  }
  if (unsignedTxCbor && token.txCborHash !== sha256Hex(unsignedTxCbor)) {
    throw new Error("review token does not match the reviewed unsigned transaction.");
  }

  return {
    ok: true,
    txHash: inspectedHash,
    reviewHash,
    deploymentId: deployment.id,
    reviewed: request.review,
    signed: Boolean(signedTxCbor),
  };
}

export function makeCompromisedCredentialDatum(compromisedCredential: string): string {
  return Data.to(new Constr(0, [compromisedCredential]));
}

function submitResponse(txHash: string, inspection: InspectReclaimTxResponse): SubmitReclaimTxResponse {
  return {
    txHash,
    review: inspection.reviewed,
    reviewHash: inspection.reviewHash,
    provider: { submitted: true },
  };
}

function dedupeUtxos(utxos: UTxO[]): UTxO[] {
  const seen = new Set<string>();
  const deduped: UTxO[] = [];
  for (const utxo of utxos) {
    const key = `${utxo.txHash}#${utxo.outputIndex}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(utxo);
  }
  return deduped;
}

function assertCbor(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  const cbor = value.trim().toLowerCase();
  if (!/^[0-9a-f]+$/u.test(cbor)) {
    throw new Error(`${field} must be hex CBOR.`);
  }
  return cbor;
}

function parseTransactionHash(txCbor: string, field: string): string {
  try {
    const tx = CML.Transaction.from_cbor_hex(txCbor);
    const hash = CML.hash_transaction(tx.body()).to_hex();
    tx.free();
    return hash;
  } catch {
    throw new Error(`${field} must be valid Cardano transaction CBOR.`);
  }
}

function signReviewToken(
  deployment: ReclaimDeployment,
  payload: { txHash: string; txCborHash: string; reviewHash: string },
): string {
  const secret = reviewTokenSecret();
  const body = stableStringify({
    v: 1,
    deploymentId: deployment.id,
    network: deployment.network,
    ...payload,
  });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return `v1.${Buffer.from(body, "utf8").toString("base64url")}.${signature}`;
}

function verifyReviewToken(
  deployment: ReclaimDeployment,
  token: string,
): { txHash: string; txCborHash: string; reviewHash: string } {
  const [version, encoded, signature, extra] = token.split(".");
  if (version !== "v1" || !encoded || !signature || extra !== undefined) {
    throw new Error("reviewToken is malformed.");
  }
  const body = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = createHmac("sha256", reviewTokenSecret()).update(body).digest("hex");
  if (!safeEqualHex(signature, expected)) {
    throw new Error("reviewToken signature is invalid.");
  }
  const parsed = JSON.parse(body) as {
    v?: unknown;
    deploymentId?: unknown;
    network?: unknown;
    txHash?: unknown;
    txCborHash?: unknown;
    reviewHash?: unknown;
  };
  if (parsed.v !== 1 || parsed.deploymentId !== deployment.id || parsed.network !== deployment.network) {
    throw new Error("reviewToken was issued for a different reclaim deployment.");
  }
  if (
    typeof parsed.txHash !== "string" ||
    typeof parsed.txCborHash !== "string" ||
    typeof parsed.reviewHash !== "string"
  ) {
    throw new Error("reviewToken payload is malformed.");
  }
  return {
    txHash: parsed.txHash,
    txCborHash: parsed.txCborHash,
    reviewHash: parsed.reviewHash,
  };
}

export function hashReview(review: ReclaimTxReview): string {
  return sha256Hex(stableStringify(review));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reviewTokenSecret(): string {
  const secret = process.env.RECLAIM_REVIEW_TOKEN_SECRET?.trim();
  if (!secret) {
    throw new Error("RECLAIM_REVIEW_TOKEN_SECRET is required for reclaim transaction review tokens.");
  }
  return secret;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/iu.test(left) || !/^[0-9a-f]+$/iu.test(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
