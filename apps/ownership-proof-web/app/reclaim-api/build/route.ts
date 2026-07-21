import { type NextRequest, NextResponse } from "next/server";
import type { BuildReclaimTxRequest } from "../../../lib/reclaim/types";
import { ReclaimValidationError } from "../../../lib/reclaim/validation";
import { getProvider, getReclaimDeployment } from "../../../lib/reclaim-server/config";
import { buildReclaimTx } from "../../../lib/reclaim-server/transactions";

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

    const body = (await request.json()) as BuildReclaimTxRequest;
    const response = await buildReclaimTx(providerConfig.provider, deploymentConfig.deployment, body);
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
      error: error instanceof Error ? error.message : "Unable to build reclaim transaction.",
      code: "build_failed",
    },
    { status: 500 },
  );
}
