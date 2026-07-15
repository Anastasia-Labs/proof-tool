import { Blockfrost, Koios, type Provider } from "@lucid-evolution/lucid";
import type { ReclaimDeployment, ReclaimNetwork } from "../reclaim/types";
import bundledReclaimDeployment from "../../public/proof-assets/reclaim-deployment.json";
import {
  loadClaimDeployment,
  loadReclaimDeployment,
  type ClaimDeploymentConfigResult,
  type DeploymentConfigResult,
} from "./manifest";

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

export function getReclaimDeployment(): DeploymentConfigResult {
  return loadReclaimDeployment({
    manifest: bundledReclaimDeployment,
    // The committed descriptor is the release-coherence root for Vercel.
    // Provider credentials still come from process.env, but stale deployment
    // selector/pin variables must not override a merge-reviewed release.
    enforceEnvCoherence: false,
  });
}

export function getClaimDeployment(): ClaimDeploymentConfigResult {
  return loadClaimDeployment({
    manifest: bundledReclaimDeployment,
    enforceEnvCoherence: false,
  });
}

export function getProvider(deployment: ReclaimDeployment): ProviderConfigResult {
  const providerName = (env("RECLAIM_PROVIDER") || deployment.provider?.primary || "koios").toLowerCase();
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
