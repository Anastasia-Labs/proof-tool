import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { blake2b } from "@noble/hashes/blake2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDestinationProofStage } from "./proof-stage.mjs";

const tempDirs = [];
const verifierVkHash = "b".repeat(64);
const impactedCredential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const safeCredential = "2a".repeat(28);
const safeAddress =
  "addr_test1qzjvktx3h2m6q3zv9n2wp0v8nyk2pyvrgk55l5xv8p0v08y5qtqv0w7wq7fxy8ky5flvypv4h8gnl3w2n2e2djf5qgpsx8x5g";
const masterXPrvBase64 = Buffer.from(new Uint8Array(96).fill(7)).toString("base64");
const destinationAddress = `${"01"}${safeCredential}${"00"}${"00".repeat(28)}`;
const proofHex = "ab".repeat(192);
const publicInputDigestHex = destinationPublicInputDigest(impactedCredential, destinationAddress);

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("destination-bound proof preprod stage", () => {
  it("drafts the first claim batch and calls the loopback helper without writing secrets", async () => {
    const outputDir = tempDir();
    const page = fakePage();
    const fetch = fakeFetch();

    const result = await runDestinationProofStage({
      env: {
        RECLAIM_E2E_SAFE_WALLET_ROLE: "deployer",
      },
      appTarget: { baseUrl: "http://127.0.0.1:3917" },
      helperTarget: {
        helperUrl: "http://127.0.0.1:49152",
        token: "pair-secret",
      },
      walletHarness: fakeWalletHarness(),
      outputDir,
      page,
      fetch,
    });

    expect(result.ok).toBe(true);
    expect(fetch.calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "http://127.0.0.1:3917/claim-api/deployment"],
      ["GET", "http://127.0.0.1:49152/status"],
      ["GET", "http://127.0.0.1:3917/claim-api/reclaim-utxos?limit=100"],
      ["POST", "http://127.0.0.1:3917/claim-api/draft"],
      ["POST", "http://127.0.0.1:49152/prove-destination"],
    ]);
    expect(fetch.draftBody).toEqual({
      deploymentId: deployment().id,
      networkId: 0,
      safeWalletChangeAddress: safeAddress,
      safeWalletAddresses: [safeAddress],
      selectedOutrefs: ["1".repeat(64) + "#0", "2".repeat(64) + "#1", "3".repeat(64) + "#0", "4".repeat(64) + "#0"],
      maxUtxos: 4,
    });
    expect(fetch.helperBody).toMatchObject({
      master_xprv_base64: masterXPrvBase64,
      profile: "single-destination",
      search: {
        max_account: 9,
        max_index: 999,
      },
      include_debug_path: false,
    });
    expect(fetch.helperBody.requests).toHaveLength(4);
    expect(fetch.helperHeaders).toMatchObject({
      Origin: "http://127.0.0.1:3917",
      "X-Proof-Tool-Token": "pair-secret",
      "Content-Type": "application/json",
    });

    const artifact = JSON.parse(readFileSync(result.artifacts[0], "utf8"));
    expect(artifact).toMatchObject({
      schema: "proof-tool-preprod-destination-proof-stage-v1",
      stage: "generate-destination-bound-proofs",
      deploymentId: deployment().id,
      proofProfile: "single-destination",
      helper: {
        helperUrl: "http://127.0.0.1:49152",
        token: "[redacted]",
        destinationKeyHash: verifierVkHash,
      },
      impactedPaymentCredential: "19e07fbc...5a8702e4",
      safePaymentCredential: "2a2a2a2a...2a2a2a2a",
      selectedOutrefs: ["1".repeat(64) + "#0", "2".repeat(64) + "#1", "3".repeat(64) + "#0", "4".repeat(64) + "#0"],
      pathMetadataPresent: false,
      helperRequestBodyWritten: false,
      proofBytesWritten: false,
      screenshots: ["screenshots/generate-destination-bound-proofs.png"],
    });
    const serializedArtifact = JSON.stringify(artifact);
    expect(serializedArtifact).not.toContain(masterXPrvBase64);
    expect(serializedArtifact).not.toContain("pair-secret");
    expect(serializedArtifact).not.toContain(impactedCredential);
    expect(serializedArtifact).not.toContain(safeAddress);
    expect(serializedArtifact).not.toContain(destinationAddress);
    expect(serializedArtifact).not.toContain(proofHex);
    expect(serializedArtifact).not.toContain(publicInputDigestHex);
    expect(page.screenshot).toHaveBeenCalledWith({
      path: path.join(outputDir, "screenshots", "generate-destination-bound-proofs.png"),
      fullPage: true,
    });
    expect(result.proofBundle.proofArtifacts).toHaveLength(4);
  });

  it("rejects helper path metadata before writing a proof artifact summary", async () => {
    const fetch = fakeFetch({
      helperResponseMutator(response) {
        response.artifacts[0].artifact.paths = [{ account: 0, index: 0 }];
      },
    });

    await expect(
      runDestinationProofStage({
        env: {},
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        helperTarget: {
          helperUrl: "http://127.0.0.1:49152",
          token: "pair-secret",
        },
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
        fetch,
      }),
    ).rejects.toMatchObject({
      code: "helper_path_metadata_leaked",
    });
  });

  it("rejects a non-loopback helper URL before loading the master XPrv", async () => {
    const walletHarness = fakeWalletHarness();

    await expect(
      runDestinationProofStage({
        env: {},
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        helperTarget: {
          helperUrl: "https://example.com",
          token: "pair-secret",
        },
        walletHarness,
        outputDir: tempDir(),
        fetch: fakeFetch(),
      }),
    ).rejects.toMatchObject({
      code: "helper_url_not_loopback",
    });
    expect(walletHarness.masterXPrvCalls).toBe(0);
  });

  it("fails when the helper destination key hash does not match the deployment", async () => {
    const fetch = fakeFetch({
      helperStatusMutator(status) {
        status.destination_profile.key_hash = "c".repeat(64);
      },
    });

    await expect(
      runDestinationProofStage({
        env: {},
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        helperTarget: {
          helperUrl: "http://127.0.0.1:49152",
          token: "pair-secret",
        },
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
        fetch,
      }),
    ).rejects.toMatchObject({
      code: "helper_destination_key_mismatch",
    });
  });

  it("fails if the safe and impacted wallet credentials overlap", async () => {
    await expect(
      runDestinationProofStage({
        env: {},
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        helperTarget: {
          helperUrl: "http://127.0.0.1:49152",
          token: "pair-secret",
        },
        walletHarness: fakeWalletHarness({
          safePaymentCredential: impactedCredential,
        }),
        outputDir: tempDir(),
        fetch: fakeFetch(),
      }),
    ).rejects.toMatchObject({
      code: "safe_impacted_wallet_overlap",
    });
  });

  it("rejects a proof artifact with a digest that is not bound to the draft destination", async () => {
    const fetch = fakeFetch({
      helperResponseMutator(response) {
        response.artifacts[0].artifact.cardano.public_input_digest_hex = "00".repeat(32);
      },
    });

    await expect(
      runDestinationProofStage({
        env: {},
        appTarget: { baseUrl: "http://127.0.0.1:3917" },
        helperTarget: {
          helperUrl: "http://127.0.0.1:49152",
          token: "pair-secret",
        },
        walletHarness: fakeWalletHarness(),
        outputDir: tempDir(),
        fetch,
      }),
    ).rejects.toMatchObject({
      code: "helper_artifact_public_input_digest",
    });
  });
});

function fakeFetch(options = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const urlText = String(url);
    const method = init.method ?? "GET";
    calls.push({ method, url: urlText });
    if (urlText === "http://127.0.0.1:3917/claim-api/deployment") {
      return jsonResponse({
        available: true,
        deployment: deployment(),
        capabilities: {
          proofProfile: "single-destination",
          destinationAddressEncoding: "destination-address-v1",
        },
      });
    }
    if (urlText === "http://127.0.0.1:49152/status") {
      const status = helperStatus();
      options.helperStatusMutator?.(status);
      return jsonResponse(status);
    }
    if (urlText === "http://127.0.0.1:3917/claim-api/reclaim-utxos?limit=100") {
      return jsonResponse({
        available: true,
        deploymentId: deployment().id,
        network: "Preprod",
        page: {
          nextCursor: null,
        },
        utxos: reclaimUtxos(),
      });
    }
    if (urlText === "http://127.0.0.1:3917/claim-api/draft") {
      fetch.draftBody = JSON.parse(init.body);
      return jsonResponse(draftResponse(fetch.draftBody.selectedOutrefs));
    }
    if (urlText === "http://127.0.0.1:49152/prove-destination") {
      fetch.helperHeaders = init.headers;
      fetch.helperBody = JSON.parse(init.body);
      const response = helperProofResponse(fetch.helperBody.requests);
      options.helperResponseMutator?.(response);
      return jsonResponse(response);
    }
    throw new Error(`unexpected fetch ${method} ${urlText}`);
  });
  fetch.calls = calls;
  return fetch;
}

function deployment() {
  return {
    id: "preprod:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1234567890abcdef1234567890abcdef12345678",
    network: "Preprod",
    networkId: 0,
    verifierVkHash,
  };
}

function helperStatus() {
  return {
    connected: true,
    sidecar_version: "0.1.0",
    protocol_version: "proof-helper-v1",
    destination_profile: {
      profile: "single-destination",
      key_version: "ownership-destination-v1",
      key_hash: verifierVkHash,
      key_ready: true,
      compatibility: "ready",
    },
  };
}

function reclaimUtxos() {
  return [
    reclaimUtxo("1".repeat(64), 0, impactedCredential),
    reclaimUtxo("2".repeat(64), 1, impactedCredential),
    reclaimUtxo("3".repeat(64), 0, impactedCredential),
    reclaimUtxo("4".repeat(64), 0, impactedCredential),
    reclaimUtxo("5".repeat(64), 0, impactedCredential),
    reclaimUtxo("6".repeat(64), 0, "00".repeat(28)),
  ];
}

function reclaimUtxo(txHash, outputIndex, paymentCredential) {
  return {
    outRef: { txHash, outputIndex },
    outRefId: `${txHash}#${outputIndex}`,
    state: "unspent",
    datum: {
      status: "valid",
      paymentCredential,
    },
  };
}

function draftResponse(selectedOutrefs) {
  return {
    draftId: "d".repeat(64),
    deploymentId: deployment().id,
    network: "Preprod",
    networkId: 0,
    proofProfile: "single-destination",
    orderedInputs: selectedOutrefs.map((outRefId) => ({
      outRefId,
    })),
    proofRequests: selectedOutrefs.map((outRefId) => ({
      out_ref: outRefId,
      target_credential: impactedCredential,
      destination_address_encoding: "destination-address-v1",
      destination_address: destinationAddress,
    })),
    safeWallet: {
      totalLovelace: "10000000",
      utxoCount: 2,
    },
  };
}

function helperProofResponse(requests) {
  return {
    profile: "single-destination",
    artifacts: requests.map((request) => ({
      out_ref: request.out_ref,
      artifact: {
        schema: "root-ownership-proof-artifact-v1",
        circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
        vk_hash: verifierVkHash,
        target_credential: request.target_credential,
        destination_address_encoding: request.destination_address_encoding,
        destination_address: request.destination_address,
        public_input_encoding: "single-credential-destination-v1",
        public_input: "03".repeat(32),
        proof: "04".repeat(64),
        cardano: {
          format: "groth16-bls12-381-bsb22",
          proof_hex: proofHex,
          public_input_digest_hex: publicInputDigestHex,
        },
      },
    })),
  };
}

function fakeWalletHarness(options = {}) {
  const effectiveSafeCredential = options.safePaymentCredential ?? safeCredential;
  return {
    masterXPrvCalls: 0,
    async call(role, method) {
      if (role !== "safe_claim_destination" || method !== "getNetworkId") {
        throw new Error(`unexpected wallet call: ${role}.${method}`);
      }
      return 0;
    },
    roleState(role) {
      if (role === "compromised_user") {
        return {
          role,
          address: "addr_test1compromised",
          paymentCredential: impactedCredential,
          canSign: false,
          signAttempts: 0,
        };
      }
      if (role === "safe_claim_destination") {
        return {
          role,
          address: safeAddress,
          paymentCredential: effectiveSafeCredential,
          canSign: true,
          signAttempts: 0,
        };
      }
      throw new Error(`unexpected role: ${role}`);
    },
    async masterXPrvBase64ForHelper(role) {
      this.masterXPrvCalls += 1;
      if (role !== "compromised_user") {
        throw new Error(`unexpected secret role: ${role}`);
      }
      return masterXPrvBase64;
    },
  };
}

function fakePage() {
  return {
    screenshot: vi.fn(async ({ path: screenshotPath }) => {
      mkdirSync(path.dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, "fake png", "utf8");
    }),
  };
}

function jsonResponse(value) {
  return {
    status: 200,
    async json() {
      return value;
    },
  };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-destination-proof-stage-"));
  tempDirs.push(dir);
  return dir;
}

function destinationPublicInputDigest(credentialHex, destinationAddressHex) {
  const preimage = Buffer.concat([
    Buffer.from("ROOT-OWNERSHIP-DESTINATION-v1", "utf8"),
    Buffer.from(credentialHex, "hex"),
    Buffer.from(destinationAddressHex, "hex"),
  ]);
  return Buffer.from(blake2b(new Uint8Array(preimage), { dkLen: 32 })).toString("hex");
}
