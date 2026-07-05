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
  reclaimGlobalRewardingCredential?: string;
  paramsUtxo?: {
    tx_hash: string;
    output_index: number;
    policy_id: string;
    token_name: string;
    holder_address: string;
    datum_reclaim_base_script_hash: string;
  };
  proof?: {
    circuit_id: string;
    key_version: string;
    destination_address_encoding: string;
    vk_hash: string;
    cardano_vk_blake2b256: string;
  };
  batching?: {
    default_utxo_count: number;
    optimization_utxo_count: number;
    hard_max_utxo_count: number;
    max_tx_cpu_percent: number;
    max_tx_mem_percent: number;
  };
  provider?: {
    primary: "blockfrost" | "koios";
    fallback: "blockfrost" | "koios";
  };
};

export type DeploymentResponse =
  | {
      available: true;
      deployment: ReclaimDeployment;
      missing: [];
      manifest?: unknown;
      readiness?: unknown;
      provider?: unknown;
      errors?: [];
    }
  | {
      available: false;
      deployment: null;
      missing: string[];
      manifest?: null;
      readiness?: unknown;
      provider?: unknown;
      errors?: Array<{ code: string; field: string; message: string }>;
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
  reviewHash: string;
  reviewToken: string;
  feeLovelace?: string;
  minProtectedLovelace?: string;
};

export type SubmitReclaimTxRequest = {
  reviewToken?: string;
  review?: ReclaimTxReview;
  signedTxCbor?: string;
  unsignedTxCbor?: string;
  witnessSetCbor?: string;
};

export type SubmitReclaimTxResponse = {
  txHash: string;
  review?: ReclaimTxReview;
  reviewHash?: string;
  provider?: {
    submitted: true;
  };
};

export type InspectReclaimTxRequest = {
  reviewToken?: string;
  review?: ReclaimTxReview;
  unsignedTxCbor?: string;
  signedTxCbor?: string;
};

export type InspectReclaimTxResponse = {
  ok: true;
  txHash: string;
  reviewHash: string;
  deploymentId: string;
  reviewed: ReclaimTxReview;
  signed: boolean;
};

export type ReclaimApiError = {
  error: string;
  code?: string;
  missing?: string[];
};

export const LOVELACE_UNIT = "lovelace";
