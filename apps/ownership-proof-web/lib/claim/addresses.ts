import { getAddressDetails, type AddressDetails } from "@lucid-evolution/lucid";
import type { ReclaimNetwork } from "../reclaim/types";
import { assertPaymentKeyHash, ClaimValidationError } from "./validation";
import { DESTINATION_ADDRESS_V1_BYTES, type PaymentCredential } from "./types";

const ZERO_CREDENTIAL_HASH = "00".repeat(28);

export function extractShelleyPaymentCredential(address: string, expectedNetworkId: 0 | 1): PaymentCredential {
  const details = getCheckedAddressDetails(address, expectedNetworkId);
  if (!details.paymentCredential) {
    throw new ClaimValidationError("payment_credential_missing", "Address does not contain a payment credential.");
  }
  return {
    type: details.paymentCredential.type,
    hash: assertPaymentKeyHash(details.paymentCredential.hash, "paymentCredential"),
  };
}

export function extractShelleyPaymentKeyHash(address: string, expectedNetworkId: 0 | 1): string {
  const credential = extractShelleyPaymentCredential(address, expectedNetworkId);
  if (credential.type !== "Key") {
    throw new ClaimValidationError("payment_credential_script", "Only payment key credentials can prove reclaim ownership.");
  }
  return credential.hash;
}

export function destinationAddressV1(address: string, expectedNetworkId: 0 | 1): string {
  const details = getCheckedAddressDetails(address, expectedNetworkId);
  if (details.type === "Pointer") {
    throw new ClaimValidationError("destination_stake_pointer", "Stake pointer destinations are unsupported for destination-address-v1.");
  }
  if (!details.paymentCredential) {
    throw new ClaimValidationError("destination_payment_missing", "Destination address must contain a payment credential.");
  }

  const paymentBytes = credentialBytes(details.paymentCredential, "destination.paymentCredential");
  const stakeBytes = details.stakeCredential
    ? credentialBytes(details.stakeCredential, "destination.stakeCredential")
    : `00${ZERO_CREDENTIAL_HASH}`;
  const encoded = `${paymentBytes}${stakeBytes}`;
  if (encoded.length !== DESTINATION_ADDRESS_V1_BYTES * 2) {
    throw new ClaimValidationError("destination_address_v1_length", "destination-address-v1 must be 58 bytes.");
  }
  return encoded;
}

export function assertSafeWalletAddress(address: string, expectedNetworkId: 0 | 1): string {
  const credential = extractShelleyPaymentCredential(address, expectedNetworkId);
  if (credential.type !== "Key") {
    throw new ClaimValidationError("safe_wallet_script_address", "Safe wallet addresses must use payment key credentials.");
  }
  return getCheckedAddressDetails(address, expectedNetworkId).address.bech32;
}

export function findPaymentCredentialOverlap(left: string[], right: string[], expectedNetworkId: 0 | 1): string[] {
  const leftCredentials = new Set(left.map((address) => extractShelleyPaymentKeyHash(address, expectedNetworkId)));
  return [...new Set(right.map((address) => extractShelleyPaymentKeyHash(address, expectedNetworkId)))].filter((credential) =>
    leftCredentials.has(credential),
  );
}

export function networkIdFor(network: ReclaimNetwork): 0 | 1 {
  return network === "Mainnet" ? 1 : 0;
}

function credentialBytes(credential: PaymentCredential, field: string): string {
  const tag = credential.type === "Key" ? "01" : "02";
  return `${tag}${assertPaymentKeyHash(credential.hash, field)}`;
}

function getCheckedAddressDetails(address: string, expectedNetworkId: 0 | 1): AddressDetails {
  if (typeof address !== "string" || address.trim() === "") {
    throw new ClaimValidationError("address_invalid", "Address is required.");
  }

  let details: AddressDetails;
  try {
    details = getAddressDetails(address.trim());
  } catch {
    throw new ClaimValidationError("address_invalid", "Address must be a valid Shelley bech32 or hex address.");
  }

  if (details.networkId !== expectedNetworkId) {
    throw new ClaimValidationError(
      "address_network_mismatch",
      expectedNetworkId === 1 ? "Address is not a mainnet address." : "Address is not on the expected testnet.",
    );
  }
  return details;
}
