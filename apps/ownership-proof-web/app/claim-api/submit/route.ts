import { NextRequest, NextResponse } from "next/server";
import type { ClaimSubmitRequest } from "../../../lib/claim/types";
import { ClaimValidationError } from "../../../lib/claim/validation";
import { getProvider, getReclaimDeployment } from "../../../lib/reclaim-server/config";
import { submitClaimTx } from "../../../lib/claim-server/build-submit";

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
          error: "Claim provider is not configured.",
          code: "provider_unavailable",
          missing: providerConfig.missing,
        },
        { status: 503 },
      );
    }

    const body = (await request.json()) as ClaimSubmitRequest;
    const response = await submitClaimTx(providerConfig.provider, deploymentConfig.deployment, body);
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof ClaimValidationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  return NextResponse.json(
    {
      error: "Unable to submit claim transaction.",
      code: "claim_submit_failed",
    },
    { status: 500 },
  );
}
