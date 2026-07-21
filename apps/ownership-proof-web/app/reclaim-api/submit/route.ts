import { type NextRequest, NextResponse } from "next/server";
import type { SubmitReclaimTxRequest } from "../../../lib/reclaim/types";
import { getProvider, getReclaimDeployment } from "../../../lib/reclaim-server/config";
import { submitReclaimTx } from "../../../lib/reclaim-server/transactions";

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

    const body = (await request.json()) as SubmitReclaimTxRequest;
    return NextResponse.json(await submitReclaimTx(providerConfig.provider, deploymentConfig.deployment, body));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to submit reviewed reclaim transaction.",
        code: "submit_failed",
      },
      { status: 400 },
    );
  }
}
