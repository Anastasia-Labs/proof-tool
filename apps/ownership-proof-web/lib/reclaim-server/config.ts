import { Blockfrost, Koios, type Provider } from "@lucid-evolution/lucid";
import type { ReclaimDeployment, ReclaimNetwork } from "../reclaim/types";

const NETWORK_IDS: Record<ReclaimNetwork, 0 | 1> = {
  Mainnet: 1,
  Preprod: 0,
  Preview: 0,
};

const KOIOS_URLS: Record<ReclaimNetwork, string> = {
  Mainnet: "https://api.koios.rest/api/v1",
  Preprod: "https://preprod.koios.rest/api/v1",
  Preview: "https://preview.koios.rest/api/v1",
};

const BLOCKFROST_URLS: Record<ReclaimNetwork, string> = {
  Mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
  Preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  Preview: "https://cardano-preview.blockfrost.io/api/v0",
};

const DEPLOYMENT_FIELDS = {
  network: "RECLAIM_NETWORK",
  reclaimBaseAddress: "RECLAIM_BASE_ADDRESS",
  reclaimBaseScriptHash: "RECLAIM_BASE_SCRIPT_HASH",
  reclaimGlobalCredential: "RECLAIM_GLOBAL_CREDENTIAL",
  reclaimGlobalScriptHash: "RECLAIM_GLOBAL_SCRIPT_HASH",
  paramsCurrencySymbol: "RECLAIM_PARAMS_CURRENCY_SYMBOL",
  paramsTokenName: "RECLAIM_PARAMS_TOKEN_NAME",
  verifierVkHash: "RECLAIM_VERIFIER_VK_HASH",
  contractVersion: "RECLAIM_CONTRACT_VERSION",
  sourceCommit: "RECLAIM_SOURCE_COMMIT",
} as const;

export type DeploymentConfigResult =
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

export function getReclaimDeployment(): DeploymentConfigResult {
  const missing: string[] = Object.values(DEPLOYMENT_FIELDS).filter((field) => !env(field));
  const rawNetwork = env(DEPLOYMENT_FIELDS.network);
  if (rawNetwork && !isReclaimNetwork(rawNetwork)) {
    missing.push(`${DEPLOYMENT_FIELDS.network}=Mainnet|Preprod|Preview`);
  }
  if (missing.length > 0 || !rawNetwork || !isReclaimNetwork(rawNetwork)) {
    return {
      available: false,
      deployment: null,
      missing,
    };
  }

  const network = rawNetwork;
  const deployment: ReclaimDeployment = {
    id: [network, env(DEPLOYMENT_FIELDS.reclaimBaseScriptHash), env(DEPLOYMENT_FIELDS.sourceCommit)]
      .filter(Boolean)
      .join(":"),
    network,
    networkId: NETWORK_IDS[network],
    reclaimBaseAddress: envRequired(DEPLOYMENT_FIELDS.reclaimBaseAddress),
    reclaimBaseScriptHash: envRequired(DEPLOYMENT_FIELDS.reclaimBaseScriptHash),
    reclaimGlobalCredential: envRequired(DEPLOYMENT_FIELDS.reclaimGlobalCredential),
    reclaimGlobalScriptHash: envRequired(DEPLOYMENT_FIELDS.reclaimGlobalScriptHash),
    paramsCurrencySymbol: envRequired(DEPLOYMENT_FIELDS.paramsCurrencySymbol),
    paramsTokenName: envRequired(DEPLOYMENT_FIELDS.paramsTokenName),
    verifierVkHash: envRequired(DEPLOYMENT_FIELDS.verifierVkHash),
    contractVersion: envRequired(DEPLOYMENT_FIELDS.contractVersion),
    sourceCommit: envRequired(DEPLOYMENT_FIELDS.sourceCommit),
  };
  return {
    available: true,
    deployment,
    missing: [],
  };
}

export function getProvider(deployment: ReclaimDeployment): ProviderConfigResult {
  const providerName = (env("RECLAIM_PROVIDER") || "koios").toLowerCase();
  if (providerName === "blockfrost") {
    const projectId = env("RECLAIM_BLOCKFROST_PROJECT_ID") || env("BLOCKFROST_PROJECT_ID");
    if (!projectId) {
      return {
        available: false,
        provider: null,
        missing: ["RECLAIM_BLOCKFROST_PROJECT_ID"],
      };
    }
    return {
      available: true,
      provider: new Blockfrost(env("RECLAIM_BLOCKFROST_URL") || BLOCKFROST_URLS[deployment.network], projectId),
      missing: [],
    };
  }

  if (providerName !== "koios") {
    return {
      available: false,
      provider: null,
      missing: ["RECLAIM_PROVIDER=koios|blockfrost"],
    };
  }

  const koiosUrl = env("RECLAIM_KOIOS_URL") || KOIOS_URLS[deployment.network];
  const koiosToken = env("RECLAIM_KOIOS_TOKEN");
  return {
    available: true,
    provider: koiosToken ? new Koios(koiosUrl, koiosToken) : new Koios(koiosUrl),
    missing: [],
  };
}

export type ProviderConfigResult =
  | {
      available: true;
      provider: Provider;
      missing: [];
    }
  | {
      available: false;
      provider: null;
      missing: string[];
    };

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function envRequired(name: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isReclaimNetwork(value: string): value is ReclaimNetwork {
  return value === "Mainnet" || value === "Preprod" || value === "Preview";
}
