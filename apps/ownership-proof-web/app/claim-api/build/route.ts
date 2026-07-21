import { type NextRequest, NextResponse } from "next/server";
import type { ClaimBuildRequest } from "../../../lib/claim/types";
import { ClaimValidationError } from "../../../lib/claim/validation";
import { getProvider, getReclaimDeployment } from "../../../lib/reclaim-server/config";
import { ReclaimValidationError } from "../../../lib/reclaim/validation";
import { UnsupportedClaimBuildError, buildClaimTx } from "../../../lib/claim-server/build-submit";

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

    const body = (await request.json()) as ClaimBuildRequest;
    const response = await buildClaimTx(providerConfig.provider, deploymentConfig.deployment, body);
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof UnsupportedClaimBuildError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        reason: error.reason,
        missingBuildArtifacts: error.missingBuildArtifacts,
        preflight: error.preflight,
      },
      { status: 501 },
    );
  }
  if (error instanceof ClaimValidationError || error instanceof ReclaimValidationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  return NextResponse.json(
    {
      error: "Unable to build claim transaction.",
      code: "claim_build_failed",
    },
    { status: 500 },
  );
}
