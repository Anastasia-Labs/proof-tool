import { describe, expect, it } from "vitest";
import {
  Constr,
  Data,
  credentialToAddress,
  keyHashToCredential,
  scriptHashToCredential,
  type OutRef,
  type Provider,
  type UTxO,
} from "@lucid-evolution/lucid";
import type { ReclaimDeployment } from "../reclaim/types";
import { CLAIM_DEFAULT_BATCH_CAP, CLAIM_HARD_BATCH_CAP } from "../claim/types";
import { ClaimValidationError, outRefToString } from "../claim/validation";
import { destinationAddressV1 } from "../claim/addresses";
import { createClaimDraft } from "./draft";
import { getClaimProgress } from "./progress";
import {
  UnsupportedClaimBuildError,
  UnsupportedClaimSubmitError,
  validateClaimBuildRequest,
  validateClaimSubmitRequest,
} from "./build-submit";

const CREDENTIAL_1 = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const CREDENTIAL_2 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CREDENTIAL_3 = "bb".repeat(28);
const CREDENTIAL_4 = "cc".repeat(28);
const CREDENTIAL_5 = "dd".repeat(28);
const CREDENTIAL_6 = "ee".repeat(28);
const SAFE_CREDENTIAL = "00000000000000000000000000000000000000000000000000000001";
const RECLAIM_SCRIPT = "11111111111111111111111111111111111111111111111111111111";
const VK_HASH = "22".repeat(32);
const SAFE_ADDRESS = credentialToAddress("Preprod", keyHashToCredential(SAFE_CREDENTIAL));
const RECLAIM_ADDRESS = credentialToAddress("Preprod", scriptHashToCredential(RECLAIM_SCRIPT));
const DEPLOYMENT: ReclaimDeployment = {
  id: `Preprod:${RECLAIM_SCRIPT}:source`,
  network: "Preprod",
  networkId: 0,
  reclaimBaseAddress: RECLAIM_ADDRESS,
  reclaimBaseScriptHash: RECLAIM_SCRIPT,
  reclaimGlobalCredential: "33".repeat(28),
  reclaimGlobalScriptHash: "44".repeat(28),
  paramsCurrencySymbol: "55".repeat(28),
  paramsTokenName: "00",
  verifierVkHash: VK_HASH,
  contractVersion: "test",
  sourceCommit: "source",
};

describe("claim draft server helpers", () => {
  it("orders selected reclaim inputs by oldest confirmation and then outref", async () => {
    const newer = reclaimUtxo("02", 0, CREDENTIAL_1, 20);
    const older = reclaimUtxo("01", 0, CREDENTIAL_2, 10);
    const provider = providerWith({
      reclaimUtxos: [newer, older],
      selectedUtxos: [newer, older],
      safeUtxos: [safeUtxo()],
    });

    const draft = await createClaimDraft(provider, DEPLOYMENT, {
      deploymentId: DEPLOYMENT.id,
      networkId: 0,
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
      selectedOutrefs: [newer, older].map(outRefToString),
    });

    expect(draft.orderedInputs.map((input) => input.outRefId)).toEqual([outRefToString(older), outRefToString(newer)]);
    expect(draft.orderedPaymentCredentials).toEqual([CREDENTIAL_2, CREDENTIAL_1]);
    expect(draft.destinationOutputs.map((output) => output.destinationAddress)).toEqual([
      destinationAddressV1(SAFE_ADDRESS, 0),
      destinationAddressV1(SAFE_ADDRESS, 0),
    ]);
    expect(draft.buildSupported).toBe(false);
  });

  it("requires explicit nextBatch for automatic public selection", async () => {
    const provider = providerWith({
      reclaimUtxos: [reclaimUtxo("01", 0, CREDENTIAL_1, 1)],
      selectedUtxos: [],
      safeUtxos: [safeUtxo()],
    });

    await expect(
      createClaimDraft(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
      }),
    ).rejects.toMatchObject({ code: "claim_batch_selection_required" });
  });

  it("ignores provider-returned outrefs outside an explicit selected set", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const extra = reclaimUtxo("02", 0, CREDENTIAL_2, 2);
    const provider = providerWith({
      reclaimUtxos: [selected, extra],
      selectedUtxos: [selected, extra],
      safeUtxos: [safeUtxo()],
    });

    const draft = await createClaimDraft(provider, DEPLOYMENT, {
      deploymentId: DEPLOYMENT.id,
      networkId: 0,
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
      selectedOutrefs: [outRefToString(selected)],
    });

    expect(draft.orderedInputs.map((input) => input.outRefId)).toEqual([outRefToString(selected)]);
  });

  it("excludes pending outrefs from automatic next-batch selection", async () => {
    const pending = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const available = reclaimUtxo("02", 0, CREDENTIAL_2, 2);
    const provider = providerWith({
      reclaimUtxos: [pending, available],
      selectedUtxos: [pending, available],
      safeUtxos: [safeUtxo()],
    });

    const draft = await createClaimDraft(provider, DEPLOYMENT, {
      deploymentId: DEPLOYMENT.id,
      networkId: 0,
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
      nextBatch: true,
      pendingOutrefs: [outRefToString(pending)],
    });

    expect(draft.orderedInputs.map((input) => input.outRefId)).toEqual([outRefToString(available)]);
  });

  it("rejects explicit selected outrefs that are pending", async () => {
    const pending = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [pending],
      selectedUtxos: [pending],
      safeUtxos: [safeUtxo()],
    });

    await expect(
      createClaimDraft(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        selectedOutrefs: [outRefToString(pending)],
        pendingOutrefs: [outRefToString(pending)],
      }),
    ).rejects.toMatchObject({ code: "selected_outref_pending" });
  });

  it("applies default cap 4 and hard cap 5", async () => {
    const reclaimUtxos = [
      reclaimUtxo("01", 0, CREDENTIAL_1, 1),
      reclaimUtxo("02", 0, CREDENTIAL_2, 2),
      reclaimUtxo("03", 0, CREDENTIAL_3, 3),
      reclaimUtxo("04", 0, CREDENTIAL_4, 4),
      reclaimUtxo("05", 0, CREDENTIAL_5, 5),
      reclaimUtxo("06", 0, CREDENTIAL_6, 6),
    ];
    const provider = providerWith({
      reclaimUtxos,
      selectedUtxos: reclaimUtxos,
      safeUtxos: [safeUtxo()],
    });

    const draft = await createClaimDraft(provider, DEPLOYMENT, {
      deploymentId: DEPLOYMENT.id,
      networkId: 0,
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
      nextBatch: true,
    });

    expect(draft.batchCap).toEqual({
      requested: CLAIM_DEFAULT_BATCH_CAP,
      default: CLAIM_DEFAULT_BATCH_CAP,
      hardMax: CLAIM_HARD_BATCH_CAP,
    });
    expect(draft.orderedInputs).toHaveLength(4);
    expect(draft.reductions).toContain("reduced_to_batch_cap_4");

    await expect(
      createClaimDraft(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        nextBatch: true,
        maxUtxos: 6,
      }),
    ).rejects.toMatchObject({ code: "batch_cap_exceeded" });
  });

  it("rejects selected malformed reclaim datums", async () => {
    const malformed = reclaimUtxo("01", 0, CREDENTIAL_1, 1, { datum: Data.to(new Constr(0, ["ab"])) });
    const provider = providerWith({
      reclaimUtxos: [malformed],
      selectedUtxos: [malformed],
      safeUtxos: [safeUtxo()],
    });

    await expect(
      createClaimDraft(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        selectedOutrefs: [outRefToString(malformed)],
      }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it("requires a conservative safe-wallet ADA buffer", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo({ lovelace: 4_999_999n })],
    });

    await expect(
      createClaimDraft(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        selectedOutrefs: [outRefToString(selected)],
      }),
    ).rejects.toMatchObject({ code: "safe_wallet_lovelace_unavailable" });
  });
});

describe("claim build and submit fail closed", () => {
  it("validates proof shape and refuses unsupported live build", () => {
    expect(() =>
      validateClaimBuildRequest(DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: "aa".repeat(32),
        selectedOutrefs: [`${"01".repeat(32)}#0`],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [proofArtifact()],
      }),
    ).toThrow(UnsupportedClaimBuildError);
  });

  it("rejects wrong verifier hash before the unsupported build boundary", () => {
    expect(() =>
      validateClaimBuildRequest(DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: "aa".repeat(32),
        selectedOutrefs: [`${"01".repeat(32)}#0`],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [proofArtifact({ vk_hash: "ff".repeat(32) })],
      }),
    ).toThrow(ClaimValidationError);
  });

  it("does not act as a generic signed transaction relay", () => {
    expect(() =>
      validateClaimSubmitRequest(DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        selectedOutrefs: [`${"01".repeat(32)}#0`],
        signedTxCbor: "84a1",
      }),
    ).toThrow("reviewed claim build token");
  });

  it("refuses live submit even when shape is present", () => {
    expect(() =>
      validateClaimSubmitRequest(DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        selectedOutrefs: [`${"01".repeat(32)}#0`],
        signedTxCbor: "84a1",
        claimBuildReviewToken: "reviewed",
      }),
    ).toThrow(UnsupportedClaimSubmitError);
  });
});

describe("claim progress", () => {
  it("returns provider-aware pending and confirmed-spent states", async () => {
    const stillUnspent = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const spent = reclaimUtxo("02", 0, CREDENTIAL_2, 2);
    const provider = providerWith({
      reclaimUtxos: [stillUnspent],
      selectedUtxos: [stillUnspent],
      safeUtxos: [safeUtxo()],
    });

    const progress = await getClaimProgress(provider, DEPLOYMENT, {
      outrefs: [outRefToString(stillUnspent), outRefToString(spent)],
      pendingOutrefs: [outRefToString(stillUnspent), outRefToString(spent)],
    });

    expect(progress.outrefs.map((entry) => entry.state)).toEqual(["pending", "spent_or_unknown"]);
    expect(progress.nextBatch.available).toBe(false);
  });

  it("returns typed provider-unavailable states", async () => {
    const progress = await getClaimProgress(null, DEPLOYMENT, {
      outrefs: [`${"01".repeat(32)}#0`],
    });

    expect(progress.providerAvailable).toBe(false);
    expect(progress.outrefs[0]?.state).toBe("provider_unavailable");
  });
});

function reclaimUtxo(
  txByte: string,
  outputIndex: number,
  credential: string,
  slot: number,
  overrides: Partial<UTxO> = {},
): UTxO {
  return {
    txHash: txByte.repeat(32),
    outputIndex,
    address: RECLAIM_ADDRESS,
    assets: { lovelace: 2_000_000n },
    datum: Data.to(new Constr(0, [credential])),
    slot,
    ...overrides,
  } as UTxO;
}

function safeUtxo(assets = { lovelace: 10_000_000n }): UTxO {
  return {
    txHash: "99".repeat(32),
    outputIndex: 0,
    address: SAFE_ADDRESS,
    assets,
  };
}

function providerWith(input: { reclaimUtxos: UTxO[]; selectedUtxos: UTxO[]; safeUtxos: UTxO[] }): Provider {
  return {
    getUtxos: async (addressOrCredential: string) => {
      if (addressOrCredential === RECLAIM_ADDRESS) {
        return input.reclaimUtxos;
      }
      if (addressOrCredential === SAFE_ADDRESS) {
        return input.safeUtxos;
      }
      return [];
    },
    getUtxosByOutRef: async (outrefs: OutRef[]) => {
      const requested = new Set(outrefs.map(outRefToString));
      return input.selectedUtxos.filter((utxo) => requested.has(outRefToString(utxo)));
    },
  } as unknown as Provider;
}

function proofArtifact(overrides: Record<string, unknown> = {}) {
  return {
    artifact: {
      schema: "root-ownership-proof-artifact-v1",
      circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
      vk_hash: VK_HASH,
      cardano: {
        proof_hex: "aa",
        public_input_digest_hex: "bb",
      },
      ...overrides,
    },
  };
}
