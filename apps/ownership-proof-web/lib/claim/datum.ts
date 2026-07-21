import { Constr, Data } from "@lucid-evolution/lucid";
import { assertPaymentKeyHash, ClaimValidationError } from "./validation";
import type { ParsedReclaimBaseDatum, ReclaimBaseDatumParseResult } from "./types";

export function parseReclaimBaseDatum(datumCbor: unknown): ParsedReclaimBaseDatum {
  if (typeof datumCbor !== "string" || datumCbor.trim() === "") {
    throw new ClaimValidationError("missing_inline_datum", "ReclaimBase UTxO must carry an inline datum.");
  }

  let datum: unknown;
  try {
    datum = Data.from(datumCbor.trim().toLowerCase());
  } catch {
    throw new ClaimValidationError("malformed_datum", "ReclaimBase datum is not valid Plutus data CBOR.");
  }

  if (!(datum instanceof Constr) || datum.index !== 0 || datum.fields.length !== 1) {
    throw new ClaimValidationError("unsupported_datum", "ReclaimBaseDatum must use constructor 0 with one field.");
  }

  const [paymentCredential] = datum.fields;
  if (paymentCredential instanceof Constr) {
    throw new ClaimValidationError(
      "unsupported_datum",
      "ReclaimBaseDatum must contain a payment key hash, not a credential constructor.",
    );
  }

  if (typeof paymentCredential !== "string") {
    throw new ClaimValidationError("unsupported_datum", "ReclaimBaseDatum payment key hash must decode as bytes.");
  }

  return {
    status: "valid",
    paymentCredential: assertPaymentKeyHash(paymentCredential, "paymentCredential"),
  };
}

export function tryParseReclaimBaseDatum(datumCbor: unknown): ReclaimBaseDatumParseResult {
  try {
    return parseReclaimBaseDatum(datumCbor);
  } catch (error) {
    if (error instanceof ClaimValidationError) {
      return {
        status: datumStatusFromCode(error.code),
        reason: error.message,
      };
    }
    return {
      status: "malformed_datum",
      reason: "ReclaimBase datum could not be parsed.",
    };
  }
}

function datumStatusFromCode(code: string): Exclude<ReclaimBaseDatumParseResult["status"], "valid"> {
  if (code === "missing_inline_datum") {
    return "missing_inline_datum";
  }
  if (code === "paymentCredential_length" || code === "paymentCredential_invalid") {
    return "invalid_payment_credential";
  }
  if (code === "unsupported_datum") {
    return "unsupported_datum";
  }
  return "malformed_datum";
}
