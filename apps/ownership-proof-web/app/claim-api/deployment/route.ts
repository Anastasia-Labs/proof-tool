import { NextResponse } from "next/server";
import { getClaimDeployment } from "../../../lib/reclaim-server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getClaimDeployment(), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
