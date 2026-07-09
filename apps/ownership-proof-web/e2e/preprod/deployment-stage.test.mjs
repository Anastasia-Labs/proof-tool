import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDeployOrVerifyPreprodManifest, verifyDeploymentPair } from "./deployment-stage.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("deploy-or-verify preprod manifest stage", () => {
  it("accepts coherent reclaim and claim deployment endpoints", () => {
    const result = verifyDeploymentPair(
      validDeploymentResponse(),
      validClaimDeploymentResponse(),
      preflight({ gitCommit: "fedcba9876543210fedcba9876543210fedcba98" }),
    );

    expect(result).toMatchObject({
      deploymentId: "preprod:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1234567890abcdef1234567890abcdef12345678",
      network: "Preprod",
      networkId: 0,
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      verifierVkHash: "b".repeat(64),
      proofProfile: "single-destination",
      destinationAddressEncoding: "destination-address-v1",
      referenceScriptsConfigured: true,
    });
  });

  it("rejects disabled deployment endpoints", () => {
    expect(() =>
      verifyDeploymentPair(
        {
          available: false,
          deployment: null,
          missing: ["RECLAIM_DEPLOYMENT_MANIFEST_PATH"],
        },
        validClaimDeploymentResponse(),
        preflight(),
      ),
    ).toThrow(/Reclaim deployment endpoint is unavailable/u);
  });

  it("rejects reclaim and claim endpoint mismatches", () => {
    const claim = validClaimDeploymentResponse();
    claim.deployment.verifierVkHash = "c".repeat(64);

    expect(() => verifyDeploymentPair(validDeploymentResponse(), claim, preflight())).toThrow(/verifier_vk_hash mismatch/u);
  });

  it("rejects app endpoints for a stale deployment with the current source commit", () => {
    const reclaim = validDeploymentResponse();
    const claim = validClaimDeploymentResponse();
    reclaim.deployment.id = "preprod:ffffffffffffffffffffffffffffffffffffffffffffffffffffffff:1234567890abcdef1234567890abcdef12345678";
    claim.deployment.id = reclaim.deployment.id;

    expect(() => verifyDeploymentPair(reclaim, claim, preflight())).toThrow(/Deployment endpoint id does not match/u);
  });

  it("rejects an endpoint source commit that differs from the deployment manifest", () => {
    const expectedSourceCommit = "ffffffffffffffffffffffffffffffffffffffff";

    expect(() =>
      verifyDeploymentPair(
        validDeploymentResponse(),
        validClaimDeploymentResponse(),
        preflight({ sourceCommit: expectedSourceCommit }),
      ),
    ).toThrow(/source commit does not match the preflight deployment manifest/u);
  });

  it("rejects unsupported claim capabilities", () => {
    const claim = validClaimDeploymentResponse();
    claim.capabilities.transactionBuild.referenceScriptsConfigured = false;
    claim.capabilities.transactionBuild.missing = ["reference_scripts.reclaim_base"];

    expect(() => verifyDeploymentPair(validDeploymentResponse(), claim, preflight())).toThrow(/Reference scripts are required/u);
  });

  it("fetches both app endpoints and writes a redacted stage artifact", async () => {
    const outputDir = tempDir();
    const fetch = vi.fn(async (url) => ({
      status: 200,
      async json() {
        return String(url).endsWith("/claim-api/deployment") ? validClaimDeploymentResponse() : validDeploymentResponse();
      },
    }));

    const result = await runDeployOrVerifyPreprodManifest({
      appTarget: {
        baseUrl: "http://127.0.0.1:3917",
      },
      preflight: preflight(),
      outputDir,
      fetch,
    });

    expect(result.ok).toBe(true);
    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:3917/reclaim-api/deployment",
      "http://127.0.0.1:3917/claim-api/deployment",
    ]);
    const artifact = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(artifact.schema).toBe("proof-tool-preprod-deployment-stage-v1");
    expect(artifact.stage).toBe("deploy-or-verify-preprod-manifest");
    expect(JSON.stringify(artifact)).not.toContain("mnemonic");
  });
});

function validDeploymentResponse() {
  return {
    available: true,
    deployment: deployment(),
    missing: [],
    errors: [],
  };
}

function validClaimDeploymentResponse() {
  return {
    ...validDeploymentResponse(),
    capabilities: {
      proofProfile: "single-destination",
      batchCaps: {
        default_utxo_count: 4,
        optimization_utxo_count: 5,
        hard_max_utxo_count: 5,
        max_tx_cpu_percent: 80,
        max_tx_mem_percent: 80,
      },
      helperKeyVersion: "ownership-destination-v1",
      destinationAddressEncoding: "destination-address-v1",
      indexerStatus: "not_configured",
      singleGlobalCompatible: true,
      transactionBuild: {
        referenceScriptsConfigured: true,
        missing: [],
      },
    },
  };
}

function deployment() {
  return {
    id: "preprod:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1234567890abcdef1234567890abcdef12345678",
    network: "Preprod",
    networkId: 0,
    reclaimBaseAddress: "addr_test1base",
    reclaimBaseScriptHash: "a".repeat(56),
    reclaimGlobalCredential: "c".repeat(56),
    reclaimGlobalScriptHash: "d".repeat(56),
    paramsCurrencySymbol: "e".repeat(56),
    paramsTokenName: "00",
    verifierVkHash: "b".repeat(64),
    contractVersion: "test-contract",
    sourceCommit: "1234567890abcdef1234567890abcdef12345678",
  };
}

function preflight({
  gitCommit = "1234567890abcdef1234567890abcdef12345678",
  sourceCommit = "1234567890abcdef1234567890abcdef12345678",
} = {}) {
  return {
    context: {
      git: {
        commit: gitCommit,
      },
      manifest: {
        deployment_id: `preprod:${"a".repeat(56)}:${sourceCommit}`,
        source_commit: sourceCommit,
      },
    },
  };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-deployment-stage-"));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}
