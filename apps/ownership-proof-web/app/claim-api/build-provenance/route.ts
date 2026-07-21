import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      schema: "proof-tool-web-build-provenance-v1",
      localPreviewEmulation: process.env.RECLAIM_LOCAL_VERCEL_PREVIEW_EMULATION === "1",
      environment: stringOrNull(process.env.VERCEL_ENV),
      deploymentUrl: stringOrNull(process.env.VERCEL_URL),
      branchUrl: stringOrNull(process.env.VERCEL_BRANCH_URL),
      productionUrl: stringOrNull(process.env.VERCEL_PROJECT_PRODUCTION_URL),
      commitSha: stringOrNull(process.env.VERCEL_GIT_COMMIT_SHA),
      commitRef: stringOrNull(process.env.VERCEL_GIT_COMMIT_REF),
      pullRequestId: stringOrNull(process.env.VERCEL_GIT_PULL_REQUEST_ID),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

function stringOrNull(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
