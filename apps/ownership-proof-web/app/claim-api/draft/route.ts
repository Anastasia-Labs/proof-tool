import { NextRequest, NextResponse } from "next/server";
import type { ClaimDraftRequest } from "../../../lib/claim/types";
import { ClaimValidationError } from "../../../lib/claim/validation";
import { getProvider, getReclaimDeployment } from "../../../lib/reclaim-server/config";
import { createClaimDraft } from "../../../lib/claim-server/draft";
import { ReclaimValidationError } from "../../../lib/reclaim/validation";

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

    const body = (await request.json()) as ClaimDraftRequest;
    const response = await createClaimDraft(providerConfig.provider, deploymentConfig.deployment, body);
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof ClaimValidationError || error instanceof ReclaimValidationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  return NextResponse.json(
    {
      error: "Unable to create claim draft.",
      code: "claim_draft_failed",
    },
    { status: 502 },
  );
}
