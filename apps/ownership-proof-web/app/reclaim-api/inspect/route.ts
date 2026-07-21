import { type NextRequest, NextResponse } from "next/server";
import type { InspectReclaimTxRequest } from "../../../lib/reclaim/types";
import { getReclaimDeployment } from "../../../lib/reclaim-server/config";
import { inspectReclaimTx } from "../../../lib/reclaim-server/transactions";

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

    const body = (await request.json()) as InspectReclaimTxRequest;
    return NextResponse.json(inspectReclaimTx(deploymentConfig.deployment, body));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to inspect reclaim transaction.",
        code: "inspect_failed",
      },
      { status: 400 },
    );
  }
}
