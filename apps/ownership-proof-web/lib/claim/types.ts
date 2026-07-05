import type { AssetMap, ReclaimDeployment, ReclaimNetwork } from "../reclaim/types";

export const CLAIM_DEFAULT_BATCH_CAP = 4;
export const CLAIM_HARD_BATCH_CAP = 5;
export const DESTINATION_ADDRESS_V1_ENCODING = "destination-address-v1";
export const DESTINATION_ADDRESS_V1_BYTES = 58;

export type ClaimOutRef = {
  txHash: string;
  outputIndex: number;
};

export type ClaimOutRefString = `${string}#${number}`;

export type ReclaimBaseDatumParseStatus =
  | "valid"
  | "missing_inline_datum"
  | "malformed_datum"
  | "unsupported_datum"
  | "invalid_payment_credential";

export type ParsedReclaimBaseDatum = {
  status: "valid";
  paymentCredential: string;
};

export type ReclaimBaseDatumParseResult =
  | ParsedReclaimBaseDatum
  | {
      status: Exclude<ReclaimBaseDatumParseStatus, "valid">;
      reason: string;
    };

export type PaymentCredentialKind = "Key" | "Script";

export type PaymentCredential = {
  type: PaymentCredentialKind;
  hash: string;
};

export type IndexedReclaimUtxo = {
  outRef: ClaimOutRef;
  outRefId: string;
  address: string;
  value: AssetMap;
  datum: ReclaimBaseDatumParseResult;
  datumCbor: string | null;
  state: "unspent" | "pending";
  deploymentId: string;
  confirmation: {
    slot: number | null;
  };
};

export type ReclaimUtxosResponse =
  | {
      available: true;
      deploymentId: string;
      network: ReclaimNetwork;
      indexer: {
        providerBacked: true;
        status: "available";
      };
      page: {
        limit: number;
        cursor: string | null;
        nextCursor: string | null;
        total: number;
      };
      utxos: IndexedReclaimUtxo[];
    }
  | {
      available: false;
      deploymentId: string | null;
      network: ReclaimNetwork | null;
      indexer: {
        providerBacked: false;
        status: "disabled";
      };
      code: string;
      reason: string;
    };

export type ClaimDraftRequest = {
  deploymentId?: string;
  networkId?: number;
  safeWalletChangeAddress?: string;
  safeWalletAddresses?: string[];
  selectedOutrefs?: Array<string | ClaimOutRef>;
  nextBatch?: boolean;
  pendingOutrefs?: Array<string | ClaimOutRef>;
  maxUtxos?: number;
};

export type ClaimDraftInput = {
  outRef: ClaimOutRef;
  outRefId: string;
  value: AssetMap;
  paymentCredential: string;
  datumCbor: string;
  confirmation: {
    slot: number | null;
  };
};

export type ClaimDraftDestinationOutput = {
  outRefId: string;
  address: string;
  destinationAddressEncoding: typeof DESTINATION_ADDRESS_V1_ENCODING;
  destinationAddress: string;
  value: AssetMap;
};

export type ClaimProofRequest = {
  out_ref: string;
  target_credential: string;
  destination_address_encoding: typeof DESTINATION_ADDRESS_V1_ENCODING;
  destination_address: string;
};

export type ClaimDraftResponse = {
  draftId: string;
  deploymentId: string;
  network: ReclaimNetwork;
  networkId: 0 | 1;
  proofProfile: "single-destination";
  batchCap: {
    requested: number;
    default: typeof CLAIM_DEFAULT_BATCH_CAP;
    hardMax: typeof CLAIM_HARD_BATCH_CAP;
  };
  orderedInputs: ClaimDraftInput[];
  orderedPaymentCredentials: string[];
  destinationOutputs: ClaimDraftDestinationOutput[];
  proofRequests: ClaimProofRequest[];
  expectedDestinationOutputStartIndex: number;
  safeWallet: {
    changeAddress: string;
    addresses: string[];
    totalLovelace: string;
    minimumRequiredLovelace: string;
    utxoCount: number;
  };
  reductions: string[];
  buildSupported: false;
};

export type ClaimBuildRequest = {
  deploymentId?: string;
  networkId?: number;
  draftId?: string;
  selectedOutrefs?: Array<string | ClaimOutRef>;
  safeWalletChangeAddress?: string;
  safeWalletAddresses?: string[];
  proofArtifacts?: unknown[];
};

export type ClaimSubmitRequest = {
  deploymentId?: string;
  selectedOutrefs?: Array<string | ClaimOutRef>;
  signedTxCbor?: string;
  claimBuildReviewToken?: string;
};

export type ClaimProgressState =
  | "unspent"
  | "pending"
  | "confirmed_spent"
  | "spent_or_unknown"
  | "provider_unavailable";

export type ClaimProgressEntry = {
  outRef: ClaimOutRef;
  outRefId: string;
  state: ClaimProgressState;
};

export type ClaimProgressResponse = {
  deploymentId: string | null;
  providerAvailable: boolean;
  outrefs: ClaimProgressEntry[];
  nextBatch: {
    available: boolean;
    count: number;
  };
};

export type ClaimDeploymentContext = {
  deployment: ReclaimDeployment;
};
