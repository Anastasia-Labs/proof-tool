import { type NextRequest, NextResponse } from "next/server";
import type { WalletAssetsRequest, WalletAssetsResponse } from "../../../lib/reclaim/types";
import { getProvider, getReclaimDeployment } from "../../../lib/reclaim-server/config";
import { loadWalletAssets } from "../../../lib/reclaim-server/transactions";
import { assertWalletNetwork, assetMapToStringMap, ReclaimValidationError } from "../../../lib/reclaim/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const deploymentConfig = getReclaimDeployment();
    if (!deploymentConfig.available) {
      return NextResponse.json(
        {
          error: "Reclaim deployment is not configured.",
          code: "deployment_unavailable",
          missing: deploymentConfig.missing,
        },
        { status: 503 },
      );
    }

    const providerConfig = getProvider(deploymentConfig.deployment);
    if (!providerConfig.available) {
      return NextResponse.json(
        {
          error: "Cardano provider is not configured.",
          code: "provider_unavailable",
          missing: providerConfig.missing,
        },
        { status: 503 },
      );
    }

    const body = (await request.json()) as WalletAssetsRequest;
    assertWalletNetwork(body.networkId, deploymentConfig.deployment.networkId);
    const wallet = await loadWalletAssets(providerConfig.provider, deploymentConfig.deployment, {
      changeAddress: body.changeAddress,
      walletAddresses: body.walletAddresses,
    });
    const response: WalletAssetsResponse = {
      changeAddress: wallet.changeAddress,
      walletAddresses: wallet.walletAddresses,
      network: deploymentConfig.deployment.network,
      networkId: deploymentConfig.deployment.networkId,
      utxoCount: wallet.utxos.length,
      assets: assetMapToStringMap(wallet.assets),
    };
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof ReclaimValidationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  return NextResponse.json(
    {
      error: error instanceof Error ? error.message : "Unable to load wallet assets.",
      code: "wallet_assets_failed",
    },
    { status: 500 },
  );
}
