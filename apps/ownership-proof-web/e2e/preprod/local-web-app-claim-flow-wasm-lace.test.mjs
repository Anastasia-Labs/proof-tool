import { describe, expect, it } from "vitest";
import {
  assertLocalPrContext,
  assertRemoteProofAssets,
  createLocalRunnerEnv,
  createLocalVercelEmulationEnv,
  githubRepositoryFromRemote,
  pinLocalDeploymentManifest,
  resolveOpenPullRequest,
} from "./local-web-app-claim-flow-wasm-lace.mjs";
import { disposePageRoutes, prepareLaceRoleBeforeNavigation } from "./web-app-claim-flow-wasm-lace.mjs";

const commitSha = "a".repeat(40);

describe("local production PR claim flow", () => {
  it("creates honest local Vercel Preview provenance without forwarding bypass secrets", () => {
    const env = createLocalVercelEmulationEnv({
      baseEnv: {
        RECLAIM_E2E_CLAIM_OUTREF: `${"b".repeat(64)}#0`,
        RECLAIM_E2E_PR_MERGE_SHA: "c".repeat(40),
        RECLAIM_E2E_VERCEL_BYPASS_SECRET: "must-not-reach-localhost",
      },
      branch: "colll78/feature",
      commitSha,
      port: 3917,
      prNumber: 14,
    });

    expect(env).toMatchObject({
      NODE_ENV: "production",
      RECLAIM_E2E_TARGET_MODE: "local-production",
      RECLAIM_E2E_PREVIEW_URL: "http://127.0.0.1:3917/",
      RECLAIM_E2E_EXPECTED_COMMIT_SHA: commitSha,
      RECLAIM_E2E_EXPECTED_PR_NUMBER: "14",
      RECLAIM_E2E_FIXTURE_MODE: "prepare",
      RECLAIM_E2E_SUBMIT_TRANSACTIONS: "1",
      RECLAIM_LOCAL_VERCEL_PREVIEW_EMULATION: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "127.0.0.1:3917",
      VERCEL_PROJECT_PRODUCTION_URL: "proof-tool.vercel.app",
      VERCEL_GIT_COMMIT_REF: "colll78/feature",
    });
    expect(env.RECLAIM_E2E_CLAIM_OUTREF).toBeUndefined();
    expect(env.RECLAIM_E2E_PR_MERGE_SHA).toBeUndefined();
    expect(env.RECLAIM_E2E_VERCEL_BYPASS_SECRET).toBeUndefined();
  });

  it("requires the canonical remote R2-backed proving-key and constraint assets", () => {
    const manifest = {
      proof: {
        browser_proving: {
          enabled: true,
          pk_url: "https://proof-assets.reclaim-proof.com/proof-assets/release/ownership.pk",
          ccs_url: "https://proof-assets-2m.reclaim-proof.com/proof-assets/release/ownership-destination.ccs",
        },
      },
    };
    expect(assertRemoteProofAssets(manifest)).toEqual({
      pkHost: "proof-assets.reclaim-proof.com",
      ccsHost: "proof-assets-2m.reclaim-proof.com",
    });
    expect(() =>
      assertRemoteProofAssets({
        proof: {
          browser_proving: {
            enabled: true,
            pk_url: "http://127.0.0.1/ownership.pk",
            ccs_url: manifest.proof.browser_proving.ccs_url,
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "local_remote_proof_assets_missing" }));
  });

  it("pins the committed Vercel stable-pointer manifest over stale local aliases", () => {
    const env = pinLocalDeploymentManifest(
      {
        RECLAIM_DEPLOYMENT_MANIFEST: "/old/manifest.json",
        RECLAIM_DEPLOYMENT_MANIFEST_JSON: '{"stale":true}',
        RECLAIM_MANIFEST_PATH: "/old/alias.json",
      },
      "/repo/apps/ownership-proof-web/public/proof-assets/reclaim-deployment.json",
    );
    expect(env.RECLAIM_DEPLOYMENT_MANIFEST_PATH).toBe(
      "/repo/apps/ownership-proof-web/public/proof-assets/reclaim-deployment.json",
    );
    expect(env.RECLAIM_DEPLOYMENT_MANIFEST).toBeUndefined();
    expect(env.RECLAIM_DEPLOYMENT_MANIFEST_JSON).toBeUndefined();
    expect(env.RECLAIM_MANIFEST_PATH).toBeUndefined();
  });

  it("keeps the app server in production while the external fixture driver stays non-production", () => {
    const serverEnv = {
      NODE_ENV: "production",
      RECLAIM_E2E_TARGET_MODE: "local-production",
    };
    expect(createLocalRunnerEnv(serverEnv)).toEqual({ RECLAIM_E2E_TARGET_MODE: "local-production" });
    expect(serverEnv.NODE_ENV).toBe("production");
  });

  it("resets the local origin and initializes the compromised Lace role before page creation", async () => {
    const actions = [];
    await prepareLaceRoleBeforeNavigation(
      {
        disconnectDappOrigin: async (origin, options) => actions.push(["disconnect", origin, options]),
        switchActiveWallet: async (role) => actions.push(["switch", role]),
      },
      "compromised_user",
      "http://127.0.0.1:3917/claim",
    );
    expect(actions).toEqual([
      ["disconnect", "http://127.0.0.1:3917/claim", { required: false }],
      ["switch", "compromised_user"],
    ]);
    await expect(
      prepareLaceRoleBeforeNavigation({}, "compromised_user", "http://127.0.0.1:3917"),
    ).rejects.toMatchObject({
      code: "lace_role_preload_unavailable",
    });
  });

  it("ignores in-flight route errors before closing a failed browser journey", async () => {
    const calls = [];
    await disposePageRoutes({
      unrouteAll: async (options) => calls.push(options),
    });
    expect(calls).toEqual([{ behavior: "ignoreErrors" }]);
    await expect(
      disposePageRoutes({
        unrouteAll: async () => {
          throw new Error("page already closed");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("requires a clean named branch with an existing open PR", () => {
    const valid = {
      branch: "colll78/feature",
      commitSha,
      status: "",
      pr: { number: 14, state: "OPEN", headRefName: "colll78/feature" },
    };
    expect(assertLocalPrContext(valid)).toMatchObject({ prNumber: 14 });
    expect(() =>
      assertLocalPrContext({ ...valid, branch: "main", pr: { ...valid.pr, headRefName: "main" } }),
    ).toThrowError(expect.objectContaining({ code: "local_pr_branch_invalid" }));
    expect(() => assertLocalPrContext({ ...valid, status: " M changed.ts" })).toThrowError(
      expect.objectContaining({ code: "local_worktree_dirty" }),
    );
    expect(() => assertLocalPrContext({ ...valid, pr: { ...valid.pr, state: "CLOSED" } })).toThrowError(
      expect.objectContaining({ code: "local_open_pr_missing" }),
    );
  });

  it("resolves the exact open PR from SSH or HTTPS GitHub remotes without requiring gh", async () => {
    expect(githubRepositoryFromRemote("git@github.com:Anastasia-Labs/proof-tool.git")).toEqual({
      owner: "Anastasia-Labs",
      repo: "proof-tool",
    });
    expect(githubRepositoryFromRemote("https://github.com/Anastasia-Labs/proof-tool.git")).toEqual({
      owner: "Anastasia-Labs",
      repo: "proof-tool",
    });
    expect(() => githubRepositoryFromRemote("https://example.com/proof-tool.git")).toThrowError(
      expect.objectContaining({ code: "local_github_remote_invalid" }),
    );

    const requests = [];
    const pr = await resolveOpenPullRequest({
      branch: "colll78/feature",
      env: {},
      fetch: async (url, options) => {
        requests.push({ options, url: String(url) });
        return {
          json: async () => [{ head: { ref: "colll78/feature" }, number: 14, state: "open" }],
          ok: true,
          status: 200,
        };
      },
      repository: { owner: "Anastasia-Labs", repo: "proof-tool" },
    });
    expect(pr).toEqual({ headRefName: "colll78/feature", number: 14, state: "OPEN" });
    expect(requests[0].url).toContain("head=Anastasia-Labs%3Acolll78%2Ffeature");
    expect(requests[0].options.headers.Authorization).toBeUndefined();
  });
});
