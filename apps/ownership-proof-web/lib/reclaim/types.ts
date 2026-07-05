export type ReclaimNetwork = "Mainnet" | "Preprod" | "Preview";

export type ReclaimDeployment = {
  id: string;
  network: ReclaimNetwork;
  networkId: 0 | 1;
  reclaimBaseAddress: string;
  reclaimBaseScriptHash: string;
  reclaimGlobalCredential: string;
  reclaimGlobalScriptHash: string;
  paramsCurrencySymbol: string;
  paramsTokenName: string;
  verifierVkHash: string;
  contractVersion: string;
  sourceCommit: string;
};

export type DeploymentResponse =
  | {
      available: true;
      deployment: ReclaimDeployment;
      missing: [];
    }
  | {
      available: false;
      deployment: null;
      missing: string[];
    };

export type AssetMap = Record<string, string>;

export type WalletAssetsRequest = {
  changeAddress: string;
  walletAddresses: string[];
  networkId?: number;
};

export type WalletAssetsResponse = {
  changeAddress: string;
  walletAddresses: string[];
  network: ReclaimNetwork;
  networkId: 0 | 1;
  utxoCount: number;
  assets: AssetMap;
};

export type BuildReclaimTxRequest = {
  changeAddress: string;
  walletAddresses: string[];
  networkId?: number;
  compromisedCredential: string;
  assets: AssetMap;
  deploymentId?: string;
};

export type ReclaimTxReview = {
  changeAddress: string;
  walletAddresses: string[];
  reclaimBaseAddress: string;
  compromisedCredential: string;
  datumCbor: string;
  assets: AssetMap;
  network: ReclaimNetwork;
  deploymentId: string;
};

export type BuildReclaimTxResponse = {
  txCbor: string;
  txHash: string;
  review: ReclaimTxReview;
};

export type SubmitReclaimTxRequest = {
  signedTxCbor?: string;
  unsignedTxCbor?: string;
  witnessSetCbor?: string;
};

export type SubmitReclaimTxResponse = {
  txHash: string;
};

export type ReclaimApiError = {
  error: string;
  code?: string;
  missing?: string[];
};

export const LOVELACE_UNIT = "lovelace";
