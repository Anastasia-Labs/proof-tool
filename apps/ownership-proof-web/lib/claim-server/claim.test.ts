import type { Provider, UTxO } from "@lucid-evolution/lucid";
import { Constr, Data } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import type { ReclaimDeployment } from "../reclaim/types";
import { makeCompromisedCredentialDatum } from "../reclaim-server/transactions";
import { parseReclaimBaseDatum, tryParseReclaimBaseDatum } from "../claim/datum";
import { ClaimValidationError } from "../claim/validation";
import { createClaimDraft } from "./draft";
import { UnsupportedClaimBuildError, UnsupportedClaimSubmitError, validateClaimBuildRequest, validateClaimSubmitRequest } from "./build-submit";

const credentialA = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const credentialB = "22222222222222222222222222222222222222222222222222222222";
const safeAddress = "addr_test1vqv7qlaucathxkwkc503ujw0rv9lfj2rkj96feyst2rs9eqqyas5r";

describe("claim datum parsing", () => {
  it("parses ReclaimBaseDatum constructor 0 payment key hashes", () => {
    expect(parseReclaimBaseDatum(makeCompromisedCredentialDatum(credentialA))).toEqual({
      status: "valid",
      paymentCredential: credentialA,
    });
  });

  it("classifies malformed, short, and credential-constructor datums", () => {
    expect(tryParseReclaimBaseDatum("not-cbor").status).toBe("malformed_datum");
    expect(tryParseReclaimBaseDatum(Data.to(new Constr(0, ["aa"]))).status).toBe("invalid_payment_credential");
    expect(tryParseReclaimBaseDatum(Data.to(new Constr(0, [new Constr(1, [credentialA])]))).status).toBe("unsupported_datum");
  });
});

describe("claim drafts", () => {
  it("orders public reclaim UTxOs by confirmation then outref and returns destination-bound proof requests", async () => {
    const provider = fakeProvider({
      safe: [utxo("f".repeat(64), 0, safeAddress, { lovelace: 5_000_000n })],
      reclaim: [
        reclaimUtxo("b".repeat(64), 1, credentialB, 200),
        reclaimUtxo("a".repeat(64), 0, credentialA, 100),
      ],
    });

    const draft = await createClaimDraft(provider, deployment(), {
      deploymentId: deployment().id,
      networkId: 0,
      safeWalletChangeAddress: safeAddress,
      safeWalletAddresses: [safeAddress],
      nextBatch: true,
    });

    expect(draft.orderedPaymentCredentials).toEqual([credentialA, credentialB]);
    expect(draft.proofRequests.map((request) => request.out_ref)).toEqual([`${"a".repeat(64)}#0`, `${"b".repeat(64)}#1`]);
    expect(draft.proofRequests.every((request) => request.destination_address_encoding === "destination-address-v1")).toBe(true);
    expect(draft.proofRequests.every((request) => request.destination_address.length === 116)).toBe(true);
  });

  it("excludes pending outrefs and enforces the hard batch cap", async () => {
    const provider = fakeProvider({
      safe: [utxo("f".repeat(64), 0, safeAddress, { lovelace: 5_000_000n })],
      reclaim: [
        reclaimUtxo("a".repeat(64), 0, credentialA, 100),
        reclaimUtxo("b".repeat(64), 0, credentialB, 101),
      ],
    });

    const draft = await createClaimDraft(provider, deployment(), {
      deploymentId: deployment().id,
      networkId: 0,
      safeWalletChangeAddress: safeAddress,
      safeWalletAddresses: [safeAddress],
      pendingOutrefs: [`${"a".repeat(64)}#0`],
      nextBatch: true,
    });

    expect(draft.orderedInputs.map((input) => input.outRefId)).toEqual([`${"b".repeat(64)}#0`]);
    await expect(
      createClaimDraft(provider, deployment(), {
        deploymentId: deployment().id,
        networkId: 0,
        safeWalletChangeAddress: safeAddress,
        safeWalletAddresses: [safeAddress],
        maxUtxos: 10,
      }),
    ).rejects.toMatchObject({ code: "batch_cap_exceeded" });
  });
});

describe("claim build and submit guardrails", () => {
  it("validates destination proof artifacts before fail-closed unsupported build", () => {
    expect(() =>
      validateClaimBuildRequest(deployment(), {
        deploymentId: deployment().id,
        networkId: 0,
        draftId: "ab".repeat(32),
        selectedOutrefs: [`${"a".repeat(64)}#0`],
        safeWalletChangeAddress: safeAddress,
        safeWalletAddresses: [safeAddress],
        proofArtifacts: [
          {
            out_ref: `${"a".repeat(64)}#0`,
            artifact: {
              circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
              vk_hash: deployment().verifierVkHash,
              cardano: {
                proof_hex: "aa",
                public_input_digest_hex: "bb",
              },
            },
          },
        ],
      }),
    ).toThrow(UnsupportedClaimBuildError);

    expect(() =>
      validateClaimBuildRequest(deployment(), {
        deploymentId: deployment().id,
        networkId: 0,
        draftId: "ab".repeat(32),
        selectedOutrefs: [`${"a".repeat(64)}#0`],
        safeWalletChangeAddress: safeAddress,
        safeWalletAddresses: [safeAddress],
        proofArtifacts: [
          {
            artifact: {
              circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
              vk_hash: "wrong",
              cardano: {
                proof_hex: "aa",
                public_input_digest_hex: "bb",
              },
            },
          },
        ],
      }),
    ).toThrow(ClaimValidationError);
  });

  it("requires reviewed signed CBOR before fail-closed unsupported submit", () => {
    expect(() =>
      validateClaimSubmitRequest(deployment(), {
        deploymentId: deployment().id,
        selectedOutrefs: [`${"a".repeat(64)}#0`],
        signedTxCbor: "84a400",
        claimBuildReviewToken: "review-token",
      }),
    ).toThrow(UnsupportedClaimSubmitError);

    expect(() =>
      validateClaimSubmitRequest(deployment(), {
        deploymentId: deployment().id,
        selectedOutrefs: [`${"a".repeat(64)}#0`],
        signedTxCbor: "84a400",
      }),
    ).toThrow(ClaimValidationError);
  });
});

function deployment(): ReclaimDeployment {
  return {
    id: "preprod:base:commit",
    network: "Preprod",
    networkId: 0,
    reclaimBaseAddress: "addr_test1wreclaimbase00000000000000000000000000000000000000000",
    reclaimBaseScriptHash: "a".repeat(56),
    reclaimGlobalCredential: "b".repeat(56),
    reclaimGlobalScriptHash: "c".repeat(56),
    paramsCurrencySymbol: "d".repeat(56),
    paramsTokenName: "5245434c41494d",
    verifierVkHash: "blake2b256:" + "e".repeat(64),
    contractVersion: "v1",
    sourceCommit: "commit",
  };
}

function fakeProvider(groups: { safe: UTxO[]; reclaim: UTxO[] }): Provider {
  return {
    getUtxos: async (address: string) => (address === deployment().reclaimBaseAddress ? groups.reclaim : groups.safe),
    getUtxosByOutRef: async (outrefs: Array<{ txHash: string; outputIndex: number }>) => {
      const byOutref = new Map([...groups.safe, ...groups.reclaim].map((item) => [`${item.txHash}#${item.outputIndex}`, item]));
      return outrefs.flatMap((outref) => {
        const item = byOutref.get(`${outref.txHash}#${outref.outputIndex}`);
        return item ? [item] : [];
      });
    },
  } as unknown as Provider;
}

function reclaimUtxo(txHash: string, outputIndex: number, credential: string, slot: number): UTxO {
  return utxo(txHash, outputIndex, deployment().reclaimBaseAddress, { lovelace: 2_000_000n }, makeCompromisedCredentialDatum(credential), slot);
}

function utxo(
  txHash: string,
  outputIndex: number,
  address: string,
  assets: Record<string, bigint>,
  datum?: string,
  slot?: number,
): UTxO {
  return {
    txHash,
    outputIndex,
    address,
    assets,
    datum,
    slot,
  } as UTxO;
}
