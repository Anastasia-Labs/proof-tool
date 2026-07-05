import { Constr, Data, Lucid, type Assets, type Provider, type TransactionWitnesses, type UTxO } from "@lucid-evolution/lucid";
import type {
  BuildReclaimTxRequest,
  BuildReclaimTxResponse,
  ReclaimDeployment,
  ReclaimTxReview,
  SubmitReclaimTxRequest,
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

export async function loadWalletAssets(
  provider: Provider,
  deployment: ReclaimDeployment,
  input: { changeAddress: unknown; walletAddresses: unknown },
) {
  const changeAddress = assertWalletAddress(input.changeAddress, deployment.network);
  const walletAddresses = assertWalletAddresses(input.walletAddresses, deployment.network);
  const queryAddresses = walletAddresses.includes(changeAddress) ? walletAddresses : [changeAddress, ...walletAddresses];
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

  return {
    txCbor: signBuilder.toCBOR({ canonical: true }),
    txHash: signBuilder.toHash(),
    review,
  };
}

export async function submitReclaimTx(
  provider: Provider,
  deployment: ReclaimDeployment,
  request: SubmitReclaimTxRequest,
): Promise<string> {
  if (request.signedTxCbor) {
    return provider.submitTx(assertCbor(request.signedTxCbor, "signedTxCbor"));
  }

  const unsignedTxCbor = assertCbor(request.unsignedTxCbor, "unsignedTxCbor");
  const witnessSetCbor = assertCbor(request.witnessSetCbor, "witnessSetCbor");
  const lucid = await Lucid(provider, deployment.network);
  const signedTx = await lucid.fromTx(unsignedTxCbor).assemble([witnessSetCbor as TransactionWitnesses]).complete();
  return provider.submitTx(signedTx.toCBOR({ canonical: true }));
}

export function makeCompromisedCredentialDatum(compromisedCredential: string): string {
  return Data.to(new Constr(0, [compromisedCredential]));
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
