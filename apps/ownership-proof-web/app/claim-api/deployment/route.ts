import { NextResponse } from "next/server";
import { loadClaimDeployment } from "../../../lib/reclaim-server/manifest";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(loadClaimDeployment());
}
