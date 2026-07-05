import { NextRequest, NextResponse } from "next/server";
import { ClaimValidationError } from "../../../lib/claim/validation";
import { getProvider, getReclaimDeployment } from "../../../lib/reclaim-server/config";
import { getClaimProgress } from "../../../lib/claim-server/progress";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const deploymentConfig = getReclaimDeployment();
    if (!deploymentConfig.available) {
      const response = await getClaimProgress(null, null, {
        outrefs: parseOutrefQuery(request.nextUrl.searchParams.get("outrefs")),
        pendingOutrefs: parseOutrefQuery(request.nextUrl.searchParams.get("pendingOutrefs") ?? request.nextUrl.searchParams.get("pending")),
      });
      return NextResponse.json(response, { status: 503 });
    }

    const providerConfig = getProvider(deploymentConfig.deployment);
    const response = await getClaimProgress(providerConfig.available ? providerConfig.provider : null, deploymentConfig.deployment, {
      outrefs: parseOutrefQuery(request.nextUrl.searchParams.get("outrefs")),
      pendingOutrefs: parseOutrefQuery(request.nextUrl.searchParams.get("pendingOutrefs") ?? request.nextUrl.searchParams.get("pending")),
    });
    return NextResponse.json(response, { status: providerConfig.available ? 200 : 503 });
  } catch (error) {
    return errorResponse(error);
  }
}

function parseOutrefQuery(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((outRef) => outRef.trim())
    .filter(Boolean);
}

function errorResponse(error: unknown) {
  if (error instanceof ClaimValidationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  return NextResponse.json(
    {
      error: "Unable to load claim progress.",
      code: "claim_progress_failed",
    },
    { status: 502 },
  );
}
