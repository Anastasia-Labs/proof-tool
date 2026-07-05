import { LOVELACE_UNIT, type AssetMap, type ReclaimNetwork } from "./types";

const HEX_RE = /^[0-9a-f]+$/u;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/u;

export function normalizeCredential(value: string): string {
  return value.trim().replace(/^0x/iu, "").toLowerCase();
}

export function isPaymentCredential(value: string): boolean {
  const normalized = normalizeCredential(value);
  return normalized.length === 56 && HEX_RE.test(normalized);
}

export function assertPaymentCredential(value: unknown): string {
  if (typeof value !== "string") {
    throw new ReclaimValidationError("compromised_credential_invalid", "Compromised credential must be a hex string.");
  }
  const normalized = normalizeCredential(value);
  if (!isPaymentCredential(normalized)) {
    throw new ReclaimValidationError(
      "compromised_credential_invalid",
      "Compromised credential must be a 28-byte payment key hash.",
    );
  }
  return normalized;
}

export function assertWalletAddress(value: unknown, network: ReclaimNetwork): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReclaimValidationError("wallet_address_invalid", "Wallet address is required.");
  }
  const walletAddress = value.trim();
  const isMainnet = network === "Mainnet";
  if (isMainnet && !walletAddress.startsWith("addr1")) {
    throw new ReclaimValidationError("wallet_address_network", "Wallet address must be a mainnet bech32 address.");
  }
  if (!isMainnet && !walletAddress.startsWith("addr_test1")) {
    throw new ReclaimValidationError("wallet_address_network", "Wallet address must be a testnet bech32 address.");
  }
  return walletAddress;
}

export function assertWalletAddresses(value: unknown, network: ReclaimNetwork): string[] {
  if (!Array.isArray(value)) {
    throw new ReclaimValidationError("wallet_addresses_invalid", "Wallet addresses must be provided by the connected wallet.");
  }
  const addresses = [...new Set(value.map((address) => assertWalletAddress(address, network)))];
  if (addresses.length === 0) {
    throw new ReclaimValidationError("wallet_addresses_empty", "Connected wallet did not provide any payment addresses.");
  }
  if (addresses.length > 50) {
    throw new ReclaimValidationError("wallet_addresses_too_many", "Connected wallet returned too many addresses for one build request.");
  }
  return addresses;
}

export function assertWalletNetwork(value: unknown, expectedNetworkId: 0 | 1): void {
  if (value === undefined || value === null) {
    return;
  }
  if (value !== expectedNetworkId) {
    throw new ReclaimValidationError(
      "wallet_network_mismatch",
      expectedNetworkId === 1 ? "Wallet is not connected to mainnet." : "Wallet is not connected to the expected testnet.",
    );
  }
}

export function assertAssetMap(value: unknown): Record<string, bigint> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReclaimValidationError("assets_invalid", "At least one ADA or native token amount is required.");
  }

  const normalized: Record<string, bigint> = {};
  for (const [rawUnit, rawQuantity] of Object.entries(value as Record<string, unknown>)) {
    const unit = rawUnit.trim();
    if (unit === "") {
      throw new ReclaimValidationError("asset_unit_invalid", "Asset unit cannot be empty.");
    }
    if (unit !== LOVELACE_UNIT && (!HEX_RE.test(unit) || unit.length < 56)) {
      throw new ReclaimValidationError("asset_unit_invalid", "Native token unit must be policy id plus token name hex.");
    }
    if (typeof rawQuantity !== "string" || !DECIMAL_RE.test(rawQuantity.trim())) {
      throw new ReclaimValidationError("asset_quantity_invalid", "Asset quantities must be non-negative decimal strings.");
    }
    const quantity = BigInt(rawQuantity.trim());
    if (quantity <= 0n) {
      continue;
    }
    normalized[unit] = (normalized[unit] ?? 0n) + quantity;
  }

  if (Object.keys(normalized).length === 0) {
    throw new ReclaimValidationError("assets_empty", "At least one ADA or native token amount is required.");
  }
  return normalized;
}

export function assetMapToStringMap(assets: Record<string, bigint>): AssetMap {
  return Object.fromEntries(Object.entries(assets).map(([unit, quantity]) => [unit, quantity.toString()]));
}

export function sumUtxoAssets(utxos: Array<{ assets: Record<string, bigint> }>): Record<string, bigint> {
  const totals: Record<string, bigint> = {};
  for (const utxo of utxos) {
    for (const [unit, quantity] of Object.entries(utxo.assets)) {
      totals[unit] = (totals[unit] ?? 0n) + quantity;
    }
  }
  return totals;
}

export function assertRequestedAssetsAvailable(
  requested: Record<string, bigint>,
  available: Record<string, bigint>,
): void {
  const missing = Object.entries(requested).filter(([unit, quantity]) => (available[unit] ?? 0n) < quantity);
  if (missing.length > 0) {
    throw new ReclaimValidationError(
      "assets_unavailable",
      `Wallet UTxOs do not contain enough ${missing.map(([unit]) => unit).join(", ")}.`,
    );
  }
}

export class ReclaimValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReclaimValidationError";
  }
}
