import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyProofRelease, waitForExpectedBuildProvenance } from "./verify-proof-release.mjs";

const publicRoot = path.resolve("public");
const deploymentPath = path.join(publicRoot, "proof-assets/reclaim-deployment.json");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("proof release coherence verifier", () => {
  it("accepts the staged release and stable pointer", async () => {
    await expect(
      verifyProofRelease({
        webRoot: publicRoot,
        deployment: deploymentPath,
      }),
    ).resolves.toMatchObject({
      ok: true,
      mode: "local",
      release: "proof-assets-ownership-destination-v2-preprod-9fac96b-g3a-2m-explicit-path-r1",
    });
  });

  it("rejects a key manifest changed after signing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "proof-release-test-"));
    temporaryRoots.push(root);
    await cp(publicRoot, root, { recursive: true });
    const deployment = JSON.parse(await readFile(path.join(root, "proof-assets/reclaim-deployment.json"), "utf8"));
    const manifestPath = path.join(root, deployment.proof.browser_proving.manifest_url.slice(1));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.published_at = "tampered";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      verifyProofRelease({
        webRoot: root,
        deployment: path.join(root, "proof-assets/reclaim-deployment.json"),
      }),
    ).rejects.toThrow(/signature verification failed/u);
  });

  it("waits for the production alias to serve the expected deployment commit", async () => {
    const expectedCommitSha = "a".repeat(40);
    const responses = ["b".repeat(40), expectedCommitSha];
    let now = 0;

    await expect(
      waitForExpectedBuildProvenance({
        baseURL: "https://proof-tool.example",
        expectedCommitSha,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              schema: "proof-tool-web-build-provenance-v1",
              environment: "production",
              commitSha: responses.shift(),
              deploymentUrl: "proof-tool-deployment.example",
            }),
            { status: 200 },
          ),
        timeoutMs: 10,
        retryIntervalMs: 1,
        nowImpl: () => now,
        sleepImpl: async (ms) => {
          now += ms;
        },
      }),
    ).resolves.toMatchObject({ attempts: 2, commitSha: expectedCommitSha, environment: "production" });
  });

  it("fails closed when the production alias never reaches the expected commit", async () => {
    const expectedCommitSha = "a".repeat(40);
    await expect(
      waitForExpectedBuildProvenance({
        baseURL: "https://proof-tool.example",
        expectedCommitSha,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              schema: "proof-tool-web-build-provenance-v1",
              environment: "production",
              commitSha: "b".repeat(40),
            }),
            { status: 200 },
          ),
        timeoutMs: 0,
      }),
    ).rejects.toThrow(/did not serve expected commit/u);
  });
});
