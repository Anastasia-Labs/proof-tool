import { describe, expect, it } from "vitest";
import { hashReview, inspectReclaimTx, makeCompromisedCredentialDatum } from "./transactions";

describe("reclaim transaction helpers", () => {
  it("encodes the compromised credential as ReclaimBaseDatum constructor 0", () => {
    const credential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";

    expect(makeCompromisedCredentialDatum(credential)).toBe(
      "d8799f581c19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4ff",
    );
  });

  it("hashes review objects independently of key order", () => {
    expect(hashReview(review())).toBe(hashReview({ ...review(), assets: { lovelace: "1500000" } }));
  });

  it("rejects inspect requests without a signed review token", () => {
    expect(() =>
      inspectReclaimTx(deployment(), {
        review: review(),
        unsignedTxCbor: "84a400",
      }),
    ).toThrow(/reviewToken is required/iu);
  });
});

function deployment() {
  return {
    id: "Preprod:script-hash:commit",
    network: "Preprod" as const,
    networkId: 0 as const,
    reclaimBaseAddress: "addr_test1wreclaimbase00000000000000000000000000000000000000000",
    reclaimBaseScriptHash: "script-hash",
    reclaimGlobalCredential: "global-credential",
    reclaimGlobalScriptHash: "global-script-hash",
    paramsCurrencySymbol: "params-policy",
    paramsTokenName: "params-token",
    verifierVkHash: "vk-hash",
    reclaimGlobalProofSlotEncoding: "full-proof-plus-public-input-digest-v2" as const,
    reclaimGlobalBatchTranscriptVkHash: "vk-hash",
    contractVersion: "v1",
    sourceCommit: "commit",
  };
}

function review() {
  return {
    changeAddress: "addr_test1vqv7qlaucathxkwkc503ujw0rv9lfj2rkj96feyst2rs9eqqyas5r",
    walletAddresses: ["addr_test1vqv7qlaucathxkwkc503ujw0rv9lfj2rkj96feyst2rs9eqqyas5r"],
    reclaimBaseAddress: deployment().reclaimBaseAddress,
    compromisedCredential: "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4",
    datumCbor: "d8799f581c19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4ff",
    assets: { lovelace: "1500000" },
    network: "Preprod" as const,
    deploymentId: deployment().id,
  };
}
