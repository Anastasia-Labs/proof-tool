import { describe, expect, it } from "vitest";
import {
  Constr,
  Data,
  credentialToAddress,
  credentialToRewardAddress,
  keyHashToCredential,
  scriptHashToCredential,
} from "@lucid-evolution/lucid";
import { parseReclaimBaseDatum, tryParseReclaimBaseDatum } from "./datum";
import {
  destinationAddressV1,
  extractShelleyPaymentKeyHash,
  findPaymentCredentialOverlap,
} from "./addresses";
import { ClaimValidationError } from "./validation";

const PAYMENT = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const PAYMENT_2 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STAKE = "00000000000000000000000000000000000000000000000000000000";
const ZERO_HASH = "00".repeat(28);

describe("claim datum parsing", () => {
  it("parses strict ReclaimBaseDatum constructor 0 with a 28-byte key hash", () => {
    const datum = Data.to(new Constr(0, [PAYMENT]));

    expect(parseReclaimBaseDatum(datum)).toEqual({
      status: "valid",
      paymentCredential: PAYMENT,
    });
  });

  it("rejects malformed datum CBOR without leaking parser details", () => {
    expect(tryParseReclaimBaseDatum("not-cbor")).toMatchObject({
      status: "malformed_datum",
    });
  });

  it("rejects non-28-byte payment credentials", () => {
    const datum = Data.to(new Constr(0, ["ab".repeat(27)]));

    expect(tryParseReclaimBaseDatum(datum)).toMatchObject({
      status: "invalid_payment_credential",
    });
  });

  it("rejects parseable script-credential-shaped datum fields", () => {
    const datum = Data.to(new Constr(0, [new Constr(1, [PAYMENT])]));

    expect(tryParseReclaimBaseDatum(datum)).toMatchObject({
      status: "unsupported_datum",
    });
  });
});

describe("claim address helpers", () => {
  it("extracts local Shelley payment key credentials and rejects reward-only addresses", () => {
    const address = credentialToAddress("Preprod", keyHashToCredential(PAYMENT));
    expect(extractShelleyPaymentKeyHash(address, 0)).toBe(PAYMENT);

    const rewardAddress = credentialToRewardAddress("Preprod", keyHashToCredential(STAKE));
    expect(() => extractShelleyPaymentKeyHash(rewardAddress, 0)).toThrow(ClaimValidationError);
  });

  it("rejects script payment credentials for ownership proof identity extraction", () => {
    const address = credentialToAddress("Preprod", scriptHashToCredential(PAYMENT));

    expect(() => extractShelleyPaymentKeyHash(address, 0)).toThrow("Only payment key credentials");
  });

  it("computes destination-address-v1 bytes for enterprise and base addresses", () => {
    const enterprise = credentialToAddress("Preprod", keyHashToCredential(PAYMENT));
    expect(destinationAddressV1(enterprise, 0)).toBe(`01${PAYMENT}00${ZERO_HASH}`);

    const base = credentialToAddress("Preprod", keyHashToCredential(PAYMENT), keyHashToCredential(STAKE));
    expect(destinationAddressV1(base, 0)).toBe(`01${PAYMENT}01${STAKE}`);
  });

  it("computes destination-address-v1 bytes for script destination credentials", () => {
    const scriptDestination = credentialToAddress("Preprod", scriptHashToCredential(PAYMENT));

    expect(destinationAddressV1(scriptDestination, 0)).toBe(`02${PAYMENT}00${ZERO_HASH}`);
  });

  it("detects safe-wallet and impacted-wallet payment credential overlap locally", () => {
    const impacted = [
      credentialToAddress("Preprod", keyHashToCredential(PAYMENT)),
      credentialToAddress("Preprod", keyHashToCredential(PAYMENT_2)),
    ];
    const safe = [credentialToAddress("Preprod", keyHashToCredential(PAYMENT_2))];

    expect(findPaymentCredentialOverlap(impacted, safe, 0)).toEqual([PAYMENT_2]);
  });
});
