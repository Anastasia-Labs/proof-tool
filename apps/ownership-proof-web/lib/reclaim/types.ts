export type ReclaimNetwork = "Mainnet" | "Preprod" | "Preview";

export type ReclaimGlobalProofSlotEncoding = "full-proof-plus-public-input-digest-v2";

export type ReclaimDistinctSevenOptIn = {
  // The serialized field name records the distinct-7 capacity benchmark. It
  // does not require normal seven-slot claims to contain distinct credentials.
  request_parameter: "maxUtxos";
  request_value: 7;
  require_explicit_request: true;
  require_measured_execution_units: true;
};

export type BrowserProvingTuning = {
  worker_count?: number;
  shard_count?: number;
  shard_multiplier?: number;
  range_fetch_concurrency?: number;
  chunk_prefetch_window?: number;
  chunk_readahead?: number;
  pinned_decode?: boolean;
  opt_w1?: boolean;
  opt_w2?: boolean;
  opt_w3?: boolean;
  opt_w5?: boolean;
  opt_w6?: boolean;
  opt_w7?: boolean;
  opt_w8?: boolean;
  gogc?: number;
  gomemlimit?: string;
};

export type BrowserProvingDescriptor = {
  enabled: boolean;
  runtime_base_url: string;
  runtime_manifest_url: string;
  prover_worker_js_url: string;
  wasm_exec_js_url: string;
  manifest_url: string;
  manifest_sig_url: string;
  manifest_public_key_hex: string;
  chunk_manifest_url: string;
  chunk_manifest_sig_url: string;
  chunk_manifest_public_key_hex: string;
  deployment_manifest_url: string;
  vk_url: string;
  pk_url: string;
  pk_index_url: string;
  ccs_url: string;
  ccs_blake2b256: string;
  proof_wasm_url: string;
  worker_js_url: string;
  msm_worker_wasm_url: string;
  tuning?: BrowserProvingTuning;
};

export type ReclaimDeployment = {
  id: string;
  network: ReclaimNetwork;
  networkId: 0 | 1;
  reclaimBaseAddress: string;
  reclaimBaseScriptHash: string;
  reclaimGlobalCredential: string;
  reclaimGlobalScriptHash: string;
  reclaimGlobalProofSlotEncoding: ReclaimGlobalProofSlotEncoding;
  reclaimGlobalBatchTranscriptVkHash: string;
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
    browser_proving?: BrowserProvingDescriptor;
  };
  batching?: {
    default_utxo_count: number;
    optimization_utxo_count: number;
    hard_max_utxo_count: number;
    max_tx_cpu_percent: number;
    max_tx_mem_percent: number;
    distinct_7_opt_in?: ReclaimDistinctSevenOptIn;
  };
  provider?: {
    primary: "blockfrost" | "koios";
    fallback: "blockfrost" | "koios";
  };
  referenceScripts?: {
    reclaimBase: ReclaimReferenceScriptDeployment;
    reclaimGlobal: ReclaimReferenceScriptDeployment;
  };
};

export type ReclaimReferenceScriptDeployment = {
  tx_hash: string;
  output_index: number;
  script_hash: string;
  holder_address?: string;
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
