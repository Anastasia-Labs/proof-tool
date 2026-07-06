import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Blockfrost, Koios, Lucid, getAddressDetails, walletFromSeed } from "@lucid-evolution/lucid";
import { masterXprvFromSeedPhrase } from "@proof-zk-recovery/proof-tool-client";
import {
  REQUIRED_WALLET_ROLES,
  redactAddress,
  redactSensitiveValue,
  validatePreprodWalletFile,
} from "./preflight.mjs";

export const CIP30_HARNESS_WINDOW_BRIDGE = "__proofToolPreprodCip30Call";
export const DEFAULT_SIGNING_ROLES = Object.freeze(["deployer", "reclaim_funder", "safe_claim_destination"]);
export const WALLET_DERIVATION_LIMITATION =
  "lucid-default-account-0-payment-0-stake-0-only";

const PREPROD_NETWORK = "Preprod";
const PREPROD_NETWORK_ID = 0;

export class Cip30HarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "Cip30HarnessError";
    this.code = code;
  }
}

export async function loadCip30HarnessFromEnv(options = {}) {
  const env = options.env ?? process.env;
  assertHarnessEnabled(env);
  const walletFile = loadWalletFileFromEnv(env, options);
  const provider = options.provider ?? createPreprodProviderFromEnv(env);
  return createCip30WalletHarness({
    provider,
    walletFile,
    signingRoles: options.signingRoles,
  });
}

export async function createCip30WalletHarness({
  provider,
  walletFile,
  signingRoles = DEFAULT_SIGNING_ROLES,
}) {
  const validation = validatePreprodWalletFile(walletFile);
  if (!validation.ok) {
    throw new Cip30HarnessError(
      "wallet_file_invalid",
      `Preprod wallet file is not valid for CIP-30 harness: ${validation.errors.map((error) => error.message).join("; ")}`,
    );
  }
  if (!provider || typeof provider.getUtxos !== "function" || typeof provider.submitTx !== "function") {
    throw new Cip30HarnessError("provider_missing", "A Lucid-compatible preprod provider is required for the CIP-30 harness.");
  }

  const signers = new Set(signingRoles);
  const roles = new Map();
  for (const role of REQUIRED_WALLET_ROLES) {
    const roleConfig = walletRoleConfig(walletFile, role);
    const mnemonic = normalizeMnemonic(roleConfig.mnemonic ?? roleConfig.seed_phrase ?? roleConfig.recovery_phrase ?? roleConfig.mnemonic_words);
    const derived = walletFromSeed(mnemonic, { network: PREPROD_NETWORK });
    const details = getAddressDetails(derived.address);
    const rewardDetails = derived.rewardAddress ? getAddressDetails(derived.rewardAddress) : null;

    roles.set(role, {
      role,
      mnemonic,
      provider,
      address: derived.address,
      addressHex: details.address.hex,
      rewardAddress: derived.rewardAddress,
      rewardAddressHex: rewardDetails?.address?.hex ?? null,
      paymentCredential: details.paymentCredential?.hash ?? null,
      stakeCredential: details.stakeCredential?.hash ?? null,
      canSign: signers.has(role),
      lucid: null,
      signAttempts: 0,
    });
  }

  return {
    schema: "proof-tool-preprod-cip30-harness-v1",
    network: PREPROD_NETWORK,
    networkId: PREPROD_NETWORK_ID,
    derivation: WALLET_DERIVATION_LIMITATION,
    roles: Object.freeze([...roles.keys()]),
    summary: redactedHarnessSummary(roles),
    providers: Object.fromEntries([...roles.keys()].map((role) => [role, browserProviderDescriptor(role)])),
    async call(role, method, args = []) {
      return callWalletApi(roles, role, method, Array.isArray(args) ? args : []);
    },
    async installOnPage(page) {
      await installCip30WalletHarnessOnPage(page, this);
    },
    roleState(role) {
      const state = roles.get(role);
      if (!state) {
        throw new Cip30HarnessError("wallet_role_unknown", `Unknown preprod wallet role: ${role}`);
      }
      return {
        role: state.role,
        address: state.address,
        paymentCredential: state.paymentCredential,
        stakeCredential: state.stakeCredential,
        canSign: state.canSign,
        signAttempts: state.signAttempts,
      };
    },
    async masterXPrvBase64ForHelper(role) {
      const state = roles.get(role);
      if (!state) {
        throw new Cip30HarnessError("wallet_role_unknown", `Unknown preprod wallet role: ${role}`);
      }
      const masterXPrv = await masterXprvFromSeedPhrase(state.mnemonic);
      return Buffer.from(masterXPrv).toString("base64");
    },
  };
}

export async function installCip30WalletHarnessOnPage(page, harness) {
  if (!page || typeof page.exposeFunction !== "function" || typeof page.addInitScript !== "function") {
    throw new Cip30HarnessError("playwright_page_invalid", "A Playwright page is required to install the CIP-30 harness.");
  }
  const roles = harness.roles.map((role) => browserProviderDescriptor(role));
  await page.exposeFunction(CIP30_HARNESS_WINDOW_BRIDGE, async (role, method, args = []) => {
    return harness.call(role, method, args);
  });
  await page.addInitScript(
    ({ bridgeName, walletRoles }) => {
      const call = (role, method, args = []) => globalThis[bridgeName](role, method, args);
      const cardano = globalThis.cardano && typeof globalThis.cardano === "object" ? globalThis.cardano : {};
      for (const wallet of walletRoles) {
        cardano[wallet.id] = {
          name: wallet.name,
          icon: wallet.icon,
          apiVersion: "1.0.0",
          supportedExtensions: [],
          enable: async () => ({
            getNetworkId: () => call(wallet.id, "getNetworkId"),
            getUtxos: () => call(wallet.id, "getUtxos"),
            getBalance: () => call(wallet.id, "getBalance"),
            getUsedAddresses: () => call(wallet.id, "getUsedAddresses"),
            getUnusedAddresses: () => call(wallet.id, "getUnusedAddresses"),
            getChangeAddress: () => call(wallet.id, "getChangeAddress"),
            getRewardAddresses: () => call(wallet.id, "getRewardAddresses"),
            getCollateral: () => call(wallet.id, "getCollateral"),
            signTx: (txCbor, partialSign = true) => call(wallet.id, "signTx", [txCbor, partialSign]),
            signData: (address, payload) => call(wallet.id, "signData", [address, payload]),
            submitTx: (txCbor) => call(wallet.id, "submitTx", [txCbor]),
            experimental: {
              getCollateral: () => call(wallet.id, "getCollateral"),
              on: () => undefined,
              off: () => undefined,
            },
          }),
        };
      }
      globalThis.cardano = cardano;
    },
    {
      bridgeName: CIP30_HARNESS_WINDOW_BRIDGE,
      walletRoles: roles,
    },
  );
}

export function redactedHarnessSummary(roles) {
  return Object.fromEntries(
    [...roles.entries()].map(([role, state]) => [
      role,
      {
        role,
        address: redactAddress(state.address),
        paymentCredential: redactCredential(state.paymentCredential),
        stakeCredential: redactCredential(state.stakeCredential),
        canSign: state.canSign,
        derivation: WALLET_DERIVATION_LIMITATION,
      },
    ]),
  );
}

export function createPreprodProviderFromEnv(env = process.env) {
  const providerName = (env.RECLAIM_PROVIDER?.trim() || "koios").toLowerCase();
  if (providerName === "blockfrost") {
    const projectId = env.RECLAIM_BLOCKFROST_PROJECT_ID?.trim() || env.BLOCKFROST_PROJECT_ID?.trim();
    if (!projectId) {
      throw new Cip30HarnessError("blockfrost_project_id_missing", "RECLAIM_BLOCKFROST_PROJECT_ID is required for the Blockfrost CIP-30 harness provider.");
    }
    return new Blockfrost(env.RECLAIM_BLOCKFROST_URL?.trim() || "https://cardano-preprod.blockfrost.io/api/v0", projectId);
  }
  if (providerName !== "koios") {
    throw new Cip30HarnessError("provider_unsupported", "RECLAIM_PROVIDER must be koios or blockfrost for the preprod CIP-30 harness.");
  }
  const koiosUrl = env.RECLAIM_KOIOS_URL?.trim() || "https://preprod.koios.rest/api/v1";
  const koiosToken = env.RECLAIM_KOIOS_TOKEN?.trim();
  return koiosToken ? new Koios(koiosUrl, koiosToken) : new Koios(koiosUrl);
}

function assertHarnessEnabled(env) {
  if ((env.RECLAIM_E2E_LIVE_PREPROD ?? "").trim() !== "1") {
    throw new Cip30HarnessError("live_preprod_gate_missing", "Set RECLAIM_E2E_LIVE_PREPROD=1 before loading the CIP-30 harness.");
  }
  if ((env.NODE_ENV ?? "").trim() === "production") {
    throw new Cip30HarnessError("production_node_env", "The CIP-30 preprod harness must not run with NODE_ENV=production.");
  }
}

function loadWalletFileFromEnv(env, options) {
  const walletPath = env.PREPROD_TEST_WALLETS_FILE?.trim();
  if (!walletPath) {
    throw new Cip30HarnessError("wallet_file_env_missing", "PREPROD_TEST_WALLETS_FILE is required for the CIP-30 harness.");
  }
  const exists = options.fileExists ?? existsSync;
  const readTextFile = options.readTextFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  const resolvedPath = resolveExistingLocalPath(walletPath, options, exists);
  if (!exists(resolvedPath)) {
    throw new Cip30HarnessError("wallet_file_missing", "PREPROD_TEST_WALLETS_FILE does not exist.");
  }
  try {
    return JSON.parse(readTextFile(resolvedPath));
  } catch {
    throw new Cip30HarnessError("wallet_file_json_malformed", "PREPROD_TEST_WALLETS_FILE must be valid JSON.");
  }
}

function resolveExistingLocalPath(configuredPath, options, exists) {
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  const candidates = [
    options.cwd ? path.resolve(options.cwd, configuredPath) : null,
    options.repoRoot ? path.resolve(options.repoRoot, configuredPath) : null,
    path.resolve(process.cwd(), configuredPath),
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0];
}

function walletRoleConfig(walletFile, role) {
  const rolesRoot = walletFile.roles ?? walletFile.wallets ?? walletFile;
  return rolesRoot[role];
}

function browserProviderDescriptor(role) {
  return {
    id: role,
    name: `Proof Tool Preprod ${role.replaceAll("_", " ")}`,
    icon: "",
  };
}

async function callWalletApi(roles, role, method, args) {
  const state = roles.get(role);
  if (!state) {
    throw new Cip30HarnessError("wallet_role_unknown", `Unknown preprod wallet role: ${role}`);
  }
  switch (method) {
    case "getNetworkId":
      return PREPROD_NETWORK_ID;
    case "getUsedAddresses":
      return [state.addressHex];
    case "getUnusedAddresses":
      return [];
    case "getChangeAddress":
      return state.addressHex;
    case "getRewardAddresses":
      return state.rewardAddressHex ? [state.rewardAddressHex] : [];
    case "getUtxos":
      return undefined;
    case "getCollateral":
      return [];
    case "getBalance":
      return "00";
    case "signTx":
      return signTx(state, args);
    case "signData":
      throw new Cip30HarnessError("sign_data_unsupported", "The preprod CIP-30 harness does not support signData.");
    case "submitTx":
      return submitTx(state, args);
    default:
      throw new Cip30HarnessError("wallet_method_unknown", `Unsupported CIP-30 harness method: ${method}`);
  }
}

async function signTx(state, args) {
  state.signAttempts += 1;
  if (!state.canSign) {
    throw new Cip30HarnessError("wallet_role_signing_forbidden", `${state.role} is read-only in the preprod CIP-30 harness.`);
  }
  const [txCbor, partialSign = true] = args;
  if (typeof txCbor !== "string" || !/^[0-9a-f]+$/iu.test(txCbor)) {
    throw new Cip30HarnessError("tx_cbor_invalid", "signTx requires transaction CBOR hex.");
  }
  const lucid = await walletLucid(state);
  const tx = lucid.fromTx(txCbor);
  if (partialSign !== false) {
    return tx.partialSign.withWallet();
  }
  const signed = await tx.sign.withWallet().complete();
  return signed.toCBOR();
}

async function submitTx(state, args) {
  const [txCbor] = args;
  if (typeof txCbor !== "string" || !/^[0-9a-f]+$/iu.test(txCbor)) {
    throw new Cip30HarnessError("tx_cbor_invalid", "submitTx requires signed transaction CBOR hex.");
  }
  const lucid = await walletLucid(state);
  return lucid.wallet().submitTx(txCbor);
}

async function walletLucid(state) {
  if (state.lucid) {
    return state.lucid;
  }
  const lucid = await Lucid(state.provider, PREPROD_NETWORK);
  lucid.selectWallet.fromSeed(state.mnemonic, {
    addressType: "Base",
    accountIndex: 0,
  });
  state.lucid = lucid;
  return lucid;
}

function normalizeMnemonic(value) {
  if (Array.isArray(value)) {
    return value.map((word) => String(word).trim()).filter(Boolean).join(" ");
  }
  return String(value ?? "").trim().replace(/\s+/gu, " ");
}

function redactCredential(value) {
  if (typeof value !== "string" || value.length < 16) {
    return "[redacted-credential]";
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

export function redactHarnessArtifact(value) {
  return redactSensitiveValue(value);
}
