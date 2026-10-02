import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { approvalJSONDigest, approvalSigningBytes, verifyOperatorApproval } from "./operator-approval.mjs";

const load = (url) => JSON.parse(readFileSync(new URL(url, import.meta.url), "utf8"));
const committed = {
  approval: load(
    "../../public/proof-releases/proof-assets-ownership-v3-mainnet-8471106-6eff/approval/operator-approval.json",
  ),
  signature: load(
    "../../public/proof-releases/proof-assets-ownership-v3-mainnet-8471106-6eff/approval/operator-approval.sig.json",
  ),
  trust: load("./operator-approval-pins.json"),
  deployment: load("../../public/proof-assets/reclaim-deployment.json"),
  runtimePins: load("../proving/runtime-pins.json"),
};

function resignFixture(change) {
  const fixture = structuredClone(committed);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const keyID = `ed25519:${createHash("sha256").update(rawKey).digest("hex")}`;
  fixture.trust.public_key_hex = rawKey.toString("hex");
  fixture.trust.key_id = keyID;
  fixture.approval.authority.key_id = keyID;
  fixture.signature.key_id = keyID;
  change(fixture);
  fixture.trust.approval_id = approvalJSONDigest(fixture.approval);
  fixture.signature.signature_hex = sign(null, approvalSigningBytes(fixture.approval), privateKey).toString("hex");
  return fixture;
}

describe("operator release approval", () => {
  it("authenticates the actual signed approval against committed application pins", () => {
    expect(verifyOperatorApproval(committed)).toMatchObject({ approval_id: committed.trust.approval_id });
  });

  it("rejects a substituted self-signed authority under the committed trust root", () => {
    const replacement = resignFixture(() => {});
    replacement.trust = committed.trust;
    expect(() => verifyOperatorApproval(replacement)).toThrow(/committed pin/u);
  });

  it("rejects a corrupted signature", () => {
    const fixture = structuredClone(committed);
    fixture.signature.signature_hex = "00".repeat(64);
    expect(() => verifyOperatorApproval(fixture)).toThrow(/signature verification failed/u);
  });

  it("rejects changing approval content even if the signature is retained", () => {
    const fixture = structuredClone(committed);
    fixture.approval.authorization.statement = "replacement";
    expect(() => verifyOperatorApproval(fixture)).toThrow(/committed pin/u);
  });

  it.each([
    [
      "params output",
      (f) => {
        f.deployment.params_utxo.output_index += 1;
      },
    ],
    [
      "destination contract",
      (f) => {
        f.deployment.reclaim_base.script_hash = "00".repeat(28);
      },
    ],
    [
      "native verifier key",
      (f) => {
        f.deployment.proof.vk_hash = `blake2b256:${"00".repeat(32)}`;
      },
    ],
    [
      "bulk asset origin",
      (f) => {
        f.deployment.proof.browser_proving.pk_url = "https://attacker.example/ownership.pk";
      },
    ],
  ])("rejects replay against a changed %s", (_name, change) => {
    const fixture = structuredClone(committed);
    change(fixture);
    expect(() => verifyOperatorApproval(fixture)).toThrow(/descriptor changed/u);
  });

  it("rejects runtime executable drift", () => {
    const fixture = structuredClone(committed);
    fixture.runtimePins.files[0].sha256 = "00".repeat(32);
    expect(() => verifyOperatorApproval(fixture)).toThrow(/runtime pins changed/u);
  });

  it("rejects a correctly signed NO_GO", () => {
    const fixture = resignFixture((f) => {
      f.approval.decision = "NO_GO";
    });
    expect(() => verifyOperatorApproval(fixture)).toThrow(/GO decision/u);
  });

  it("rejects a signed approval that authorizes new Mainnet contract transactions", () => {
    const fixture = resignFixture((f) => {
      f.approval.permissions.deploy_new_mainnet_contracts = true;
    });
    expect(() => verifyOperatorApproval(fixture)).toThrow(/outside approval scope/u);
  });

  it("rejects an evidence file outside the approved release", () => {
    const fixture = resignFixture((f) => {
      f.approval.files[0].path = "/proof-releases/other/secret.json";
    });
    expect(() => verifyOperatorApproval(fixture)).toThrow(/release file path/u);
  });

  it("does not accept a deployment on another network", () => {
    const fixture = structuredClone(committed);
    fixture.deployment.network = "Preprod";
    expect(() => verifyOperatorApproval(fixture)).toThrow(/Mainnet deployment binding/u);
  });
});
