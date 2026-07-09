import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAddressDetails, walletFromSeed } from "@lucid-evolution/lucid";
import { masterXprvFromSeedPhrase } from "@proof-zk-recovery/proof-tool-client";
import {
  REQUIRED_WALLET_ROLES,
  normalizePreprodWalletRoles,
  redactAddress,
  validatePreprodWalletFile,
} from "./preflight.mjs";

export const LACE_EXTENSION_DIR_ENV = "RECLAIM_E2E_LACE_EXTENSION_DIR";
export const LACE_WALLET_PASSWORD_ENV = "RECLAIM_E2E_LACE_WALLET_PASSWORD";
export const LACE_ROLE_LABELS_JSON_ENV = "RECLAIM_E2E_LACE_ROLE_LABELS_JSON";
export const LACE_PROVIDER_ID_ENV = "RECLAIM_E2E_LACE_PROVIDER_ID";
export const LACE_PROVIDER_NAME_ENV = "RECLAIM_E2E_LACE_PROVIDER_NAME";
export const LACE_BROWSER_CHANNEL_ENV = "RECLAIM_E2E_LACE_BROWSER_CHANNEL";
export const LACE_BROWSER_ROLES = Object.freeze(["reclaim_funder", "compromised_user", "safe_claim_destination"]);

const DEFAULT_LACE_PROVIDER_ID = "lace";
const DEFAULT_LACE_PROVIDER_NAME = "Lace";
const DEFAULT_ROLE_LABEL_PREFIX = "Proof Tool Preprod";
const EXTENSION_POLL_MS = 250;
const EXTENSION_TIMEOUT_MS = 30_000;
const PREPROD_NETWORK_ID = 0;

export class PreprodRealLaceDriverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodRealLaceDriverError";
    this.code = code;
  }
}

export async function createRealLaceProfileDriverFromEnv(options = {}) {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const readTextFile = options.readTextFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const extensionDir = requiredExistingDirectory(env[LACE_EXTENSION_DIR_ENV], LACE_EXTENSION_DIR_ENV, fileExists);
  const manifestPath = path.join(extensionDir, "manifest.json");
  if (!fileExists(manifestPath)) {
    throw new PreprodRealLaceDriverError("lace_manifest_missing", `${LACE_EXTENSION_DIR_ENV} must contain manifest.json.`);
  }
  const manifest = readLaceManifest(manifestPath, readTextFile);
  const userDataDir = requiredString(env.PW_USER_DATA_DIR, "PW_USER_DATA_DIR");
  const walletFile = loadWalletFile(env.PREPROD_TEST_WALLETS_FILE, { cwd, repoRoot, fileExists, readTextFile });
  const validation = validatePreprodWalletFile(walletFile);
  if (!validation.ok) {
    throw new PreprodRealLaceDriverError(
      "lace_wallet_file_invalid",
      `Preprod wallet file is not valid for Lace mode: ${validation.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const roleLabels = roleLabelsFromEnv(env);
  const roleStates = await deriveRoleStates(walletFile, {
    roleLabels,
    deriveRoleState: options.deriveRoleState,
  });

  return new RealLaceProfileDriver({
    browserChannel: env[LACE_BROWSER_CHANNEL_ENV]?.trim() || "chromium",
    extensionDir,
    extensionRoute: resolveLaceExtensionRoute(manifest),
    manifestPath,
    providerId: env[LACE_PROVIDER_ID_ENV]?.trim() || DEFAULT_LACE_PROVIDER_ID,
    providerName: env[LACE_PROVIDER_NAME_ENV]?.trim() || DEFAULT_LACE_PROVIDER_NAME,
    roleLabels,
    roleStates,
    userDataDir,
    walletPassword: env[LACE_WALLET_PASSWORD_ENV]?.trim() || "",
  });
}

export class RealLaceProfileDriver {
  constructor(config) {
    this.mode = "lace";
    this.network = "Preprod";
    this.networkId = PREPROD_NETWORK_ID;
    this.derivation = "lace-preprod-profile-local-secret-file";
    this.roles = Object.freeze([...REQUIRED_WALLET_ROLES]);
    this.extensionDir = config.extensionDir;
    this.extensionRoute = config.extensionRoute;
    this.manifestPath = config.manifestPath;
    this.userDataDir = config.userDataDir;
    this.browserChannel = config.browserChannel;
    this.providerId = config.providerId;
    this.providerName = config.providerName;
    this.roleLabels = config.roleLabels;
    this.roleStates = config.roleStates;
    this.walletPassword = config.walletPassword;
    this.context = null;
    this.extensionId = null;
    this.summary = redactedRoleSummary(config.roleStates);
  }

  providerIdForRole() {
    return this.providerId;
  }

  providerNameForRole() {
    return this.providerName;
  }

  roleState(role) {
    return publicRoleState(this.roleStates.get(role));
  }

  async masterXPrvBase64ForHelper(role) {
    const state = this.requireRoleState(role);
    const masterXPrv = await masterXprvFromSeedPhrase(state.mnemonic);
    return Buffer.from(masterXPrv).toString("base64");
  }

  async recoveryPhraseForBrowserUi(role) {
    return this.requireRoleState(role).mnemonic;
  }

  async call(role, method) {
    this.requireRoleState(role);
    if (method === "getNetworkId") {
      return PREPROD_NETWORK_ID;
    }
    throw new PreprodRealLaceDriverError(
      "lace_direct_wallet_call_unsupported",
      `Real Lace mode does not support direct walletHarness.call(${method}); drive the browser wallet UI instead.`,
    );
  }

  async installOnPage() {
    // Lace injects its provider through the browser extension.
  }

  async launchBrowserContext(browserLauncher, { headless = false } = {}) {
    if (!browserLauncher || typeof browserLauncher.launchPersistentContext !== "function") {
      throw new PreprodRealLaceDriverError("lace_persistent_context_unavailable", "Lace mode requires chromium.launchPersistentContext.");
    }
    this.context = await browserLauncher.launchPersistentContext(this.userDataDir, {
      channel: this.browserChannel,
      headless: false,
      args: [
        `--disable-extensions-except=${this.extensionDir}`,
        `--load-extension=${this.extensionDir}`,
      ],
    });
    if (headless) {
      // The explicit env is accepted for compatibility, but Lace smoke keeps the
      // browser headed because extension prompts are part of the surface.
    }
    this.extensionId = await resolveExtensionId(this.context, this.manifestPath);
    return this.context;
  }

  async probeWalletRoles(page) {
    const providerProbe = await page.evaluate((providerId) => {
      const cardano = globalThis.cardano && typeof globalThis.cardano === "object" ? globalThis.cardano : {};
      return {
        present: Boolean(cardano[providerId]),
        canEnable: null,
        networkId: null,
      };
    }, this.providerId);
    return Object.fromEntries(
      [...this.roleStates.keys()].map((role) => [
        role,
        {
          providerId: this.providerId,
          providerName: this.providerName,
          configured: true,
          ...providerProbe,
        },
      ]),
    );
  }

  async connectRole(page, role, purpose) {
    this.requireRoleState(role);
    await this.switchActiveWallet(role);
    if (purpose === "funding") {
      await selectLaceFundingProvider(page, this.providerId, this.providerName);
      await page.getByRole("button", { name: /connect wallet/iu }).click();
      await this.approveDappConnection(role);
      await page.getByText(/CIP-30 wallet address/iu).waitFor();
      await this.assertActiveDappRole(page, role);
      return;
    }
    if (purpose === "claim-wallet-option") {
      await page.getByRole("button", { name: new RegExp(escapeRegex(this.providerName), "iu") }).click();
      return;
    }
    throw new PreprodRealLaceDriverError("lace_connect_purpose_unknown", `Unknown Lace connect purpose: ${purpose}.`);
  }

  async approveDappConnection(role) {
    this.requireRoleState(role);
    await clickFirstVisibleInExtensionPages(
      this.context,
      this.extensionId,
      [
        '[data-testid="connect-modal-accept-once"]',
        '[data-testid="connect-modal-accept-always"]',
        '[data-testid="connect-authorize-button"]',
      ],
      "lace_connection_prompt_missing",
      null,
      this.extensionRoute,
    );
  }

  async approveWalletSigning(role, purpose) {
    this.requireRoleState(role);
    await clickFirstVisibleInExtensionPages(
      this.context,
      this.extensionId,
      [
        '[data-testid="dapp-transaction-confirm"]',
        '[data-testid="sign-transaction-confirm"]',
      ],
      `lace_${purpose}_sign_prompt_missing`,
      async (page) => {
        if (!this.walletPassword) {
          return;
        }
        const passwordInput = page.locator('input[type="password"]').first();
        if (await safeVisible(passwordInput)) {
          await passwordInput.fill(this.walletPassword);
        }
      },
      this.extensionRoute,
    );
  }

  async validateProfile() {
    const results = [];
    for (const role of LACE_BROWSER_ROLES) {
      await this.switchActiveWallet(role);
      results.push({
        role,
        label: this.requireRoleState(role).label,
        paymentCredential: redactCredential(this.requireRoleState(role).paymentCredential),
        address: redactAddress(this.requireRoleState(role).address),
      });
    }
    return {
      schema: "proof-tool-real-lace-profile-validation-v1",
      providerId: this.providerId,
      providerName: this.providerName,
      extensionId: this.extensionId,
      userDataDir: "[redacted-profile-dir]",
      roles: results,
    };
  }

  async switchActiveWallet(role) {
    const state = this.requireRoleState(role);
    const page = await openExtensionRoute(this.context, this.extensionId, this.extensionRoute);
    await unlockIfNeeded(page, this.walletPassword);
    if (await switchOfficialLaceAccount(page, role)) {
      return;
    }
    const currentName = await visibleText(page.locator('[data-testid="header-menu-wallet-name"]').first());
    if (currentName === state.label) {
      return;
    }
    const menuButton = page.locator('[data-testid="header-menu-button"]').first();
    if (!(await safeVisible(menuButton))) {
      throw new PreprodRealLaceDriverError("lace_wallet_menu_missing", "Lace wallet menu button was not visible.");
    }
    await menuButton.click();
    const exactRole = page.getByText(state.label, { exact: true }).first();
    if (!(await safeVisible(exactRole))) {
      throw new PreprodRealLaceDriverError(
        "lace_wallet_role_missing",
        `Lace profile does not expose an imported wallet named ${state.label}.`,
      );
    }
    await exactRole.click();
    await page.waitForTimeout(700);
  }

  async assertActiveDappRole(page, role) {
    const state = this.requireRoleState(role);
    const probe = await page.evaluate(async (providerId) => {
      const provider = globalThis.cardano?.[providerId];
      if (!provider || typeof provider.enable !== "function") {
        return { present: false };
      }
      const api = await provider.enable();
      return {
        present: true,
        networkId: typeof api.getNetworkId === "function" ? await api.getNetworkId() : null,
        usedAddresses: typeof api.getUsedAddresses === "function" ? await api.getUsedAddresses() : [],
        changeAddress: typeof api.getChangeAddress === "function" ? await api.getChangeAddress() : null,
      };
    }, this.providerId);
    if (probe.networkId !== PREPROD_NETWORK_ID) {
      throw new PreprodRealLaceDriverError("lace_network_mismatch", "Lace must expose Preprod network id 0.");
    }
    const addresses = [...(Array.isArray(probe.usedAddresses) ? probe.usedAddresses : []), probe.changeAddress].filter(Boolean);
    if (!addresses.includes(state.addressHex)) {
      throw new PreprodRealLaceDriverError(
        "lace_active_wallet_mismatch",
        `Lace active wallet does not match expected role ${role}.`,
      );
    }
  }

  requireRoleState(role) {
    const state = this.roleStates.get(role);
    if (!state) {
      throw new PreprodRealLaceDriverError("lace_wallet_role_unknown", `Unknown Lace wallet role: ${role}.`);
    }
    return state;
  }
}

function readLaceManifest(manifestPath, readTextFile) {
  try {
    return JSON.parse(readTextFile(manifestPath));
  } catch {
    throw new PreprodRealLaceDriverError("lace_manifest_json_malformed", "Lace manifest.json must be valid JSON.");
  }
}

function resolveLaceExtensionRoute(manifest) {
  const sidePanelPath = normalizeExtensionRoute(manifest?.side_panel?.default_path);
  if (sidePanelPath) {
    return sidePanelPath;
  }
  const actionPopup = normalizeExtensionRoute(manifest?.action?.default_popup);
  if (actionPopup) {
    return actionPopup;
  }
  return "popup.html#/assets";
}

function normalizeExtensionRoute(value) {
  const route = String(value ?? "").trim().replace(/^\/+/u, "");
  return route || null;
}

async function deriveRoleStates(walletFile, { roleLabels, deriveRoleState }) {
  const { rolesRoot } = normalizePreprodWalletRoles(walletFile);
  const entries = [];
  for (const role of REQUIRED_WALLET_ROLES) {
    const roleConfig = rolesRoot[role];
    const mnemonic = normalizeMnemonic(roleConfig.mnemonic ?? roleConfig.seed_phrase ?? roleConfig.recovery_phrase ?? roleConfig.mnemonic_words);
    const label = roleLabels[role] ?? defaultRoleLabel(role);
    const state = deriveRoleState
      ? await deriveRoleState({ role, mnemonic, label, roleConfig })
      : deriveCardanoRoleState({ role, mnemonic, label });
    entries.push([role, state]);
  }
  return new Map(entries);
}

function deriveCardanoRoleState({ role, mnemonic, label }) {
  const derived = walletFromSeed(mnemonic, { network: "Preprod" });
  const details = getAddressDetails(derived.address);
  const rewardDetails = derived.rewardAddress ? getAddressDetails(derived.rewardAddress) : null;
  return {
    role,
    label,
    mnemonic,
    address: derived.address,
    addressHex: details.address.hex,
    rewardAddress: derived.rewardAddress,
    rewardAddressHex: rewardDetails?.address?.hex ?? null,
    paymentCredential: details.paymentCredential?.hash ?? null,
    stakeCredential: details.stakeCredential?.hash ?? null,
    canSign: role === "reclaim_funder" || role === "safe_claim_destination",
    signAttempts: 0,
  };
}

function loadWalletFile(configuredPath, { cwd, repoRoot, fileExists, readTextFile }) {
  const walletPath = requiredString(configuredPath, "PREPROD_TEST_WALLETS_FILE");
  const resolvedPath = resolveExistingLocalPath(walletPath, { cwd, repoRoot }, fileExists);
  if (!fileExists(resolvedPath)) {
    throw new PreprodRealLaceDriverError("lace_wallet_file_missing", "PREPROD_TEST_WALLETS_FILE does not exist.");
  }
  try {
    return JSON.parse(readTextFile(resolvedPath));
  } catch {
    throw new PreprodRealLaceDriverError("lace_wallet_file_json_malformed", "PREPROD_TEST_WALLETS_FILE must be valid JSON.");
  }
}

function resolveExistingLocalPath(configuredPath, options, fileExists) {
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  const candidates = [
    options.cwd ? path.resolve(options.cwd, configuredPath) : null,
    options.repoRoot ? path.resolve(options.repoRoot, configuredPath) : null,
    path.resolve(process.cwd(), configuredPath),
  ].filter(Boolean);
  return candidates.find((candidate) => fileExists(candidate)) ?? candidates[0];
}

function roleLabelsFromEnv(env) {
  const configured = env[LACE_ROLE_LABELS_JSON_ENV]?.trim();
  if (!configured) {
    return Object.fromEntries(REQUIRED_WALLET_ROLES.map((role) => [role, defaultRoleLabel(role)]));
  }
  try {
    const parsed = JSON.parse(configured);
    return Object.fromEntries(
      REQUIRED_WALLET_ROLES.map((role) => [role, typeof parsed?.[role] === "string" && parsed[role].trim() ? parsed[role].trim() : defaultRoleLabel(role)]),
    );
  } catch {
    throw new PreprodRealLaceDriverError("lace_role_labels_json_malformed", `${LACE_ROLE_LABELS_JSON_ENV} must be valid JSON.`);
  }
}

function defaultRoleLabel(role) {
  return `${DEFAULT_ROLE_LABEL_PREFIX} ${role.replaceAll("_", " ")}`;
}

function requiredString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new PreprodRealLaceDriverError(`${field.toLowerCase()}_missing`, `${field} is required for real Lace wallet mode.`);
  }
  return normalized;
}

function requiredExistingDirectory(value, field, fileExists) {
  const resolved = path.resolve(requiredString(value, field));
  if (!fileExists(resolved)) {
    throw new PreprodRealLaceDriverError(`${field.toLowerCase()}_missing`, `${field} does not exist.`);
  }
  return resolved;
}

async function resolveExtensionId(context, manifestPath) {
  const serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: EXTENSION_TIMEOUT_MS }).catch(() => null));
  if (serviceWorker) {
    return new URL(serviceWorker.url()).host;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.key !== "string" || !manifest.key) {
    throw new PreprodRealLaceDriverError("lace_extension_id_unavailable", "Lace extension id could not be discovered and manifest.key is missing.");
  }
  return extensionIdFromManifestKey(manifest.key);
}

function extensionIdFromManifestKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return digest.replace(/[0-9a-f]/gu, (char) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(char, 16)));
}

async function openExtensionRoute(context, extensionId, route) {
  const page = await waitForExtensionPage(context, extensionId, route);
  await page.goto(`chrome-extension://${extensionId}/${route}`, { waitUntil: "domcontentloaded" });
  return page;
}

async function waitForExtensionPage(context, extensionId, route = "popup.html") {
  if (!context || !extensionId) {
    throw new PreprodRealLaceDriverError("lace_context_missing", "Lace browser context is not initialized.");
  }
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = Date.now() + EXTENSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const existing = extensionPages(context, extensionId)[0];
    if (existing) {
      return existing;
    }
    const page = await context.newPage();
    await page.goto(`${prefix}${route}`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    if (!page.isClosed()) {
      return page;
    }
    await sleep(EXTENSION_POLL_MS);
  }
  throw new PreprodRealLaceDriverError("lace_extension_page_missing", "Timed out waiting for a Lace extension page.");
}

async function clickFirstVisibleInExtensionPages(context, extensionId, selectors, code, beforeClick = null, fallbackRoute = "popup.html") {
  if (!context || !extensionId) {
    throw new PreprodRealLaceDriverError("lace_context_missing", "Lace browser context is not initialized.");
  }
  const deadline = Date.now() + EXTENSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let pages = extensionPages(context, extensionId);
    if (pages.length === 0) {
      pages = [await waitForExtensionPage(context, extensionId, fallbackRoute)];
    }
    for (const page of pages) {
      if (beforeClick) {
        await beforeClick(page);
      }
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await safeVisible(locator)) {
          await locator.click();
          return;
        }
      }
    }
    await sleep(EXTENSION_POLL_MS);
  }
  throw new PreprodRealLaceDriverError(code, `Timed out waiting for Lace selector: ${selectors.join(", ")}.`);
}

function extensionPages(context, extensionId) {
  const prefix = `chrome-extension://${extensionId}/`;
  return context.pages().filter((page) => !page.isClosed() && page.url().startsWith(prefix));
}

async function unlockIfNeeded(page, password) {
  const authInput = page.locator('[data-testid="authentication-prompt-input-value"]').first();
  if (await authInput.isVisible({ timeout: 4000 }).catch(() => false)) {
    if (!password) {
      throw new PreprodRealLaceDriverError("lace_wallet_password_missing", `${LACE_WALLET_PASSWORD_ENV} is required to unlock Lace.`);
    }
    await authInput.fill(password);
    await page.locator('[data-testid="authentication-prompt-button-confirm"]').first().click({ force: true });
    await page.locator('[data-testid="authentication-prompt-body"]').first().waitFor({ state: "hidden", timeout: EXTENSION_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForTimeout(1000);
    return;
  }
  const unlockButton = page.locator('[data-testid="unlock-button"]').first();
  if (!(await safeVisible(unlockButton))) {
    return;
  }
  if (!password) {
    throw new PreprodRealLaceDriverError("lace_wallet_password_missing", `${LACE_WALLET_PASSWORD_ENV} is required to unlock Lace.`);
  }
  const passwordInput = page.locator('input[type="password"]').first();
  if (await safeVisible(passwordInput)) {
    await passwordInput.fill(password);
  }
  await unlockButton.click();
  await page.waitForTimeout(1000);
}

async function switchOfficialLaceAccount(page, role) {
  const accountIndex = LACE_BROWSER_ROLES.indexOf(role);
  if (accountIndex < 0) {
    return false;
  }
  await page.getByText(/Portfolio/iu).first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
  const indicator = page.locator('[data-testid="account-indicator"]').nth(accountIndex);
  if (!(await indicator.isVisible({ timeout: 5000 }).catch(() => false))) {
    return false;
  }
  await indicator.click({ force: true });
  await page.waitForTimeout(1200);
  return true;
}

async function selectLaceFundingProvider(page, providerId, providerName) {
  const select = page.getByLabel("Cardano wallet");
  try {
    await select.selectOption(providerId);
    return;
  } catch {
    await select.selectOption({ label: providerName });
  }
}

async function safeVisible(locator) {
  return locator.isVisible({ timeout: 250 }).catch(() => false);
}

async function visibleText(locator) {
  if (!(await safeVisible(locator))) {
    return "";
  }
  return locator.textContent().then((value) => String(value ?? "").trim()).catch(() => "");
}

function publicRoleState(state) {
  if (!state) {
    return null;
  }
  const { mnemonic: _mnemonic, ...publicState } = state;
  return { ...publicState };
}

function redactedRoleSummary(roleStates) {
  return Object.fromEntries(
    [...roleStates.entries()].map(([role, state]) => [
      role,
      {
        role,
        label: state.label,
        address: redactAddress(state.address),
        paymentCredential: redactCredential(state.paymentCredential),
        stakeCredential: redactCredential(state.stakeCredential),
        canSign: state.canSign,
      },
    ]),
  );
}

function redactCredential(value) {
  if (typeof value !== "string" || value.length < 16) {
    return "[redacted-credential]";
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function normalizeMnemonic(value) {
  if (Array.isArray(value)) {
    return value.map((word) => String(word).trim()).filter(Boolean).join(" ");
  }
  return String(value ?? "").trim().replace(/\s+/gu, " ");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRepoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
}
