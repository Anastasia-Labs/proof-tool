import { NextResponse } from "next/server";
import { getReclaimDeployment } from "../../../lib/reclaim-server/config";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(getReclaimDeployment());
}
