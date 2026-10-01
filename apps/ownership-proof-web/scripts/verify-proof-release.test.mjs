import { generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadClaimDeployment } from "../lib/reclaim-server/manifest";
import { verifyProofRelease, waitForExpectedBuildProvenance } from "./verify-proof-release.mjs";

const publicRoot = path.resolve("public");
const deploymentPath = path.join(publicRoot, "proof-assets/reclaim-deployment.json");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("proof release coherence verifier", () => {
  it("accepts the live Mainnet response produced by the server normalizer", { timeout: 30_000 }, async () => {
    const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
    const runtime = loadClaimDeployment({ manifest: deployment, env: {}, enforceEnvCoherence: false });
    expect(runtime.available).toBe(true);
    const fetchImpl = async (location) => {
      const pathname = new URL(location).pathname;
      const body =
        pathname === "/claim-api/deployment"
          ? JSON.stringify(runtime)
          : pathname === "/claim"
            ? "<html><body>Claim</body></html>"
            : await readFile(path.join(publicRoot, pathname.slice(1)));
      return new Response(body, {
        status: 200,
        headers: {
          "cache-control": pathname.startsWith("/proof-releases/") ? "public, max-age=31536000, immutable" : "no-store",
          "cross-origin-resource-policy": "same-origin",
          "permissions-policy": "loopback-network=(self)",
        },
      });
    };
    await expect(verifyProofRelease({ baseURL: "https://proof-tool.example", fetchImpl })).resolves.toMatchObject({
      ok: true,
      mode: "live",
      deployment_id: deployment.deployment_id,
    });
  });

  it("accepts the staged release and stable pointer", async () => {
    await expect(
      verifyProofRelease({
        webRoot: publicRoot,
        deployment: deploymentPath,
      }),
    ).resolves.toMatchObject({
      ok: true,
      mode: "local",
      release: "proof-assets-ownership-v3-mainnet-8471106-6eff",
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

  it("rejects a deployment that uses the native gnark VK hash as its on-chain hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "proof-release-test-"));
    temporaryRoots.push(root);
    await cp(publicRoot, root, { recursive: true });
    const deploymentPath = path.join(root, "proof-assets/reclaim-deployment.json");
    const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
    deployment.reclaim_global.verifier_vk_hash = deployment.proof.vk_hash;
    const versionedDeploymentPath = path.join(root, deployment.proof.browser_proving.deployment_manifest_url.slice(1));
    await Promise.all([
      writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`),
      writeFile(versionedDeploymentPath, `${JSON.stringify(deployment, null, 2)}\n`),
    ]);

    await expect(
      verifyProofRelease({
        webRoot: root,
        deployment: deploymentPath,
      }),
    ).rejects.toThrow(/on-chain Cardano VK hash/u);
  });

  it("rejects Mainnet proof assets whose GO-approved release manifest digest drifted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "proof-release-test-"));
    temporaryRoots.push(root);
    await cp(publicRoot, root, { recursive: true });
    const deploymentPath = path.join(root, "proof-assets/reclaim-deployment.json");
    const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
    const chunkPath = path.join(root, deployment.proof.browser_proving.chunk_manifest_url.slice(1));
    const chunkSignaturePath = path.join(root, deployment.proof.browser_proving.chunk_manifest_sig_url.slice(1));
    const chunk = JSON.parse(await readFile(chunkPath, "utf8"));
    const keyManifestPath = path.join(root, deployment.proof.browser_proving.manifest_url.slice(1));
    const keyManifest = JSON.parse(await readFile(keyManifestPath, "utf8"));
    const ceremonyID = `sha256:${"11".repeat(32)}`;
    const candidateID = `sha256:${"22".repeat(32)}`;
    const decisionID = `sha256:${"33".repeat(32)}`;
    const releaseID = `sha256:${"44".repeat(32)}`;

    deployment.network = "Mainnet";
    deployment.proof.setup_transcript_hash = keyManifest.setup_transcript_hash;
    deployment.proof.mpc_ceremony_id = ceremonyID;
    deployment.proof.mpc_candidate_id = candidateID;
    deployment.planning = {
      production_decision_id: decisionID,
      mpc_release_id: releaseID,
      release_manifest_sha256: `sha256:${"ff".repeat(32)}`,
    };
    Object.assign(chunk.coherence, {
      mpc_ceremony_id: ceremonyID,
      mpc_candidate_id: candidateID,
      production_decision_id: decisionID,
      mpc_release_id: releaseID,
      release_manifest_sha256: chunk.coherence.key_manifest_sha256,
    });

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    deployment.proof.browser_proving.chunk_manifest_public_key_hex = publicKeyHex;
    const chunkBytes = Buffer.from(`${JSON.stringify(chunk, null, 2)}\n`);
    const versionedDeploymentPath = path.join(root, deployment.proof.browser_proving.deployment_manifest_url.slice(1));
    const chunkPublicKeyPath = path.join(path.dirname(chunkPath), "chunk-manifest-public-key.hex");
    await Promise.all([
      writeFile(chunkPath, chunkBytes),
      writeFile(chunkSignaturePath, `${sign(null, chunkBytes, privateKey).toString("hex")}\n`),
      writeFile(chunkPublicKeyPath, `${publicKeyHex}\n`),
      writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`),
      writeFile(versionedDeploymentPath, `${JSON.stringify(deployment, null, 2)}\n`),
    ]);

    await expect(
      verifyProofRelease({
        webRoot: root,
        deployment: deploymentPath,
      }),
    ).rejects.toThrow(/Mainnet release manifest SHA-256/u);
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
