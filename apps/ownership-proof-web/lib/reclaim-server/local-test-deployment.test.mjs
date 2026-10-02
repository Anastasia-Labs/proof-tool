import path from "node:path";
import { describe, expect, it } from "vitest";
import { PREPROD_CLAIM_MANIFEST, isLocalPreprodClaimDeployment } from "./local-test-deployment.mjs";

const cwd = "/repo/apps/ownership-proof-web";
const local = {
  NODE_ENV: "production",
  RECLAIM_LOCAL_VERCEL_PREVIEW_EMULATION: "1",
  RECLAIM_E2E_TARGET_MODE: "local-production",
  VERCEL_URL: "127.0.0.1:3917",
  RECLAIM_E2E_LOCAL_MANIFEST_PATH: path.join(cwd, PREPROD_CLAIM_MANIFEST),
};

describe("committed local Preprod claim deployment", () => {
  it("allows the exact committed Preprod release for localhost production rehearsal", () => {
    expect(isLocalPreprodClaimDeployment(local, cwd)).toBe(true);
  });

  it.each([
    { VERCEL: "1" },
    { VERCEL_URL: "preview.vercel.app" },
    { VERCEL_URL: "127.0.0.1:3917.example.com" },
    { NODE_ENV: "development" },
    { RECLAIM_LOCAL_VERCEL_PREVIEW_EMULATION: "0" },
    { RECLAIM_E2E_TARGET_MODE: "vercel-preview" },
    { RECLAIM_E2E_LOCAL_MANIFEST_PATH: "/tmp/unreviewed-manifest.json" },
    { RECLAIM_E2E_LOCAL_MANIFEST_PATH: "" },
  ])("keeps the bundled release when rehearsal requirements fail: %j", (override) => {
    expect(isLocalPreprodClaimDeployment({ ...local, ...override }, cwd)).toBe(false);
  });
});
