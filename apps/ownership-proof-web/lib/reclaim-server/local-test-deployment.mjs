import path from "node:path";

export const PREPROD_CLAIM_MANIFEST =
  "public/proof-releases/proof-assets-ownership-destination-v3-preprod-191ca93-opt-reclaim-07d48bc5-r1/assets/reclaim-deployment.json";

// This selects one committed rehearsal deployment for the local production
// lane. Hosted releases never accept an environment-selected manifest.
export function isLocalPreprodClaimDeployment(env, cwd) {
  return (
    env.NODE_ENV === "production" &&
    !env.VERCEL &&
    env.RECLAIM_LOCAL_VERCEL_PREVIEW_EMULATION === "1" &&
    env.RECLAIM_E2E_TARGET_MODE === "local-production" &&
    /^127\.0\.0\.1:[0-9]+$/u.test(env.VERCEL_URL ?? "") &&
    Boolean(env.RECLAIM_E2E_LOCAL_MANIFEST_PATH) &&
    path.resolve(env.RECLAIM_E2E_LOCAL_MANIFEST_PATH) === path.resolve(cwd, PREPROD_CLAIM_MANIFEST)
  );
}
