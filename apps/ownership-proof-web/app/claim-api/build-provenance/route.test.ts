import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("claim build provenance route", () => {
  it("returns only non-secret Vercel identity fields without caching", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_URL", "proof-tool-deployment.vercel.app");
    vi.stubEnv("VERCEL_BRANCH_URL", "proof-tool-git-feature.vercel.app");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "proof-tool.vercel.app");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feature");
    vi.stubEnv("VERCEL_GIT_PULL_REQUEST_ID", "42");

    const response = GET();

    await expect(response.json()).resolves.toEqual({
      schema: "proof-tool-web-build-provenance-v1",
      localPreviewEmulation: false,
      environment: "preview",
      deploymentUrl: "proof-tool-deployment.vercel.app",
      branchUrl: "proof-tool-git-feature.vercel.app",
      productionUrl: "proof-tool.vercel.app",
      commitSha: "a".repeat(40),
      commitRef: "feature",
      pullRequestId: "42",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("marks local Vercel Preview emulation without exposing configuration values", async () => {
    vi.stubEnv("RECLAIM_LOCAL_VERCEL_PREVIEW_EMULATION", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_URL", "127.0.0.1:3917");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "proof-tool.vercel.app");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "b".repeat(40));
    vi.stubEnv("VERCEL_GIT_PULL_REQUEST_ID", "14");

    const body = await GET().json();

    expect(body).toMatchObject({
      localPreviewEmulation: true,
      environment: "preview",
      deploymentUrl: "127.0.0.1:3917",
      productionUrl: "proof-tool.vercel.app",
      commitSha: "b".repeat(40),
      pullRequestId: "14",
    });
    expect(JSON.stringify(body)).not.toMatch(/SECRET|TOKEN|PASSWORD/u);
  });
});
