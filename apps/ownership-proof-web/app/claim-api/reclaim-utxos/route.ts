import { NextRequest, NextResponse } from "next/server";
import { ClaimValidationError } from "../../../lib/claim/validation";
import { getProvider, getReclaimDeployment } from "../../../lib/reclaim-server/config";
import { listReclaimUtxos } from "../../../lib/claim-server/indexer";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const deploymentConfig = getReclaimDeployment();
    if (!deploymentConfig.available) {
      return NextResponse.json(
        {
          available: false,
          deploymentId: null,
          network: null,
          indexer: {
            providerBacked: false,
            status: "disabled",
          },
          code: "deployment_unavailable",
          reason: "Reclaim deployment is not configured.",
        },
        { status: 503 },
      );
    }

    const providerConfig = getProvider(deploymentConfig.deployment);
    if (!providerConfig.available) {
      return NextResponse.json(
        {
          available: false,
          deploymentId: deploymentConfig.deployment.id,
          network: deploymentConfig.deployment.network,
          indexer: {
            providerBacked: false,
            status: "disabled",
          },
          code: "provider_unavailable",
          reason: "Cardano provider is not configured.",
        },
        { status: 503 },
      );
    }

    const { searchParams } = request.nextUrl;
    const response = await listReclaimUtxos(providerConfig.provider, deploymentConfig.deployment, {
      cursor: searchParams.get("cursor"),
      limit: parseLimit(searchParams.get("limit")),
      pendingOutrefs: parseOutrefQuery(searchParams.get("pendingOutrefs") ?? searchParams.get("pending")),
    });
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}

function parseLimit(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
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
      error: "Unable to query reclaim UTxOs.",
      code: "claim_index_failed",
    },
    { status: 502 },
  );
}
