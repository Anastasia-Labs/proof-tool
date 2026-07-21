export const WALLET_MODE_ENV = "RECLAIM_E2E_WALLET_MODE";
export const WALLET_MODE_HARNESS = "harness";
export const WALLET_MODE_LACE = "lace";

export class PreprodWalletDriverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodWalletDriverError";
    this.code = code;
  }
}

export function walletModeFromEnv(env = process.env) {
  const mode = (env[WALLET_MODE_ENV]?.trim() || WALLET_MODE_HARNESS).toLowerCase();
  if (mode !== WALLET_MODE_HARNESS && mode !== WALLET_MODE_LACE) {
    throw new PreprodWalletDriverError(
      "wallet_mode_unsupported",
      `${WALLET_MODE_ENV} must be ${WALLET_MODE_HARNESS} or ${WALLET_MODE_LACE}.`,
    );
  }
  return mode;
}

export function createInjectedCip30HarnessDriver(harness) {
  if (!harness || typeof harness !== "object") {
    throw new PreprodWalletDriverError("wallet_harness_missing", "A CIP-30 harness object is required.");
  }
  return {
    ...harness,
    mode: WALLET_MODE_HARNESS,
    providerIdForRole(role) {
      return role;
    },
    providerNameForRole(role) {
      return `Proof Tool Preprod ${role.replaceAll("_", " ")}`;
    },
    async connectRole(page, role, purpose) {
      if (purpose === "funding") {
        await page.getByLabel("Cardano wallet").selectOption(role);
        await page.getByRole("button", { name: /connect wallet/iu }).click();
        await page.getByText(/CIP-30 wallet address/iu).waitFor();
        return;
      }
      if (purpose === "claim-wallet-option") {
        await page.getByRole("button", { name: walletButtonName(role, this) }).click();
        return;
      }
      throw new PreprodWalletDriverError(
        "wallet_connect_purpose_unknown",
        `Unknown wallet connect purpose: ${purpose}.`,
      );
    },
    async probeWalletRoles(page) {
      return probeInjectedCip30Roles(page, this.roles);
    },
  };
}

export async function installWalletDriverOnPage(page, walletDriver) {
  if (walletDriver && typeof walletDriver.installOnPage === "function") {
    await walletDriver.installOnPage(page);
  }
}

export async function probeWalletRoles(page, walletDriver) {
  if (walletDriver && typeof walletDriver.probeWalletRoles === "function") {
    return walletDriver.probeWalletRoles(page);
  }
  return probeInjectedCip30Roles(page, walletDriver?.roles ?? []);
}

export async function connectFundingRole(page, walletDriver, role) {
  if (walletDriver && typeof walletDriver.connectRole === "function") {
    await walletDriver.connectRole(page, role, "funding");
    return;
  }
  await page.getByLabel("Cardano wallet").selectOption(role);
  await page.getByRole("button", { name: /connect wallet/iu }).click();
  await page.getByText(/CIP-30 wallet address/iu).waitFor();
}

export async function selectClaimRole(page, walletDriver, role) {
  if (walletDriver && typeof walletDriver.connectRole === "function") {
    await walletDriver.connectRole(page, role, "claim-wallet-option");
    return;
  }
  await page.getByRole("button", { name: walletButtonName(role, walletDriver) }).click();
}

export async function approveWalletConnection(walletDriver, role) {
  if (walletDriver && typeof walletDriver.approveDappConnection === "function") {
    await walletDriver.approveDappConnection(role);
  }
}

export async function approveWalletSigning(walletDriver, role, purpose) {
  if (walletDriver && typeof walletDriver.approveWalletSigning === "function") {
    await walletDriver.approveWalletSigning(role, purpose);
  }
}

export function walletButtonName(role, walletDriver = null) {
  const providerName =
    typeof walletDriver?.providerNameForRole === "function"
      ? walletDriver.providerNameForRole(role)
      : `Proof Tool Preprod ${role.replaceAll("_", " ")}`;
  return new RegExp(escapeRegex(providerName), "iu");
}

async function probeInjectedCip30Roles(page, roles) {
  return page.evaluate(async (requiredRoles) => {
    const cardano = globalThis.cardano && typeof globalThis.cardano === "object" ? globalThis.cardano : {};
    const roleStates = {};
    for (const role of requiredRoles) {
      const provider = cardano[role];
      const api = provider && typeof provider.enable === "function" ? await provider.enable() : null;
      roleStates[role] = {
        present: Boolean(provider),
        canEnable: Boolean(api),
        networkId: api && typeof api.getNetworkId === "function" ? await api.getNetworkId() : null,
      };
    }
    return roleStates;
  }, roles);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
