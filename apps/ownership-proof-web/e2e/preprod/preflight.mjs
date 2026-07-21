#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_WALLET_ROLES = Object.freeze([
  "deployer",
  "reclaim_funder",
  "compromised_user",
  "safe_claim_destination",
]);

export const MANIFEST_JSON_ENV = "RECLAIM_DEPLOYMENT_MANIFEST_JSON";
export const MANIFEST_PATH_ENVS = Object.freeze([
  "RECLAIM_DEPLOYMENT_MANIFEST_PATH",
  "RECLAIM_DEPLOYMENT_MANIFEST",
  "RECLAIM_MANIFEST_PATH",
]);
export const PROVIDER_HEALTH_JSON_ENV = "RECLAIM_E2E_PROVIDER_HEALTH_JSON";
export const PROVIDER_HEALTH_PATH_ENV = "RECLAIM_E2E_PROVIDER_HEALTH_FILE";

const DEFAULT_REPO_ROOT = defaultRepoRoot();
const MNEMONIC_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);
const SECRET_KEY_PATTERN =
  /(mnemonic|seed|phrase|xprv|private|secret|signing|skey|root_key|witness|proof|cbor|password|token)/iu;

export async function runPreprodPreflight(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const readTextFile = options.readTextFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  const fileExists = options.fileExists ?? existsSync;
  const statFile = options.statFile ?? statSync;
  const execFileFn = options.execFile ?? execFile;

  const gateErrors = validateExecutionGate(env);
  if (gateErrors.length > 0) {
    return preflightFailure(gateErrors, {
      skipped: ["wallet_file", "deployment_manifest", "git_state", "provider_health"],
    });
  }

  const errors = [];
  const context = {
    skipped: [],
    walletRoles: null,
    manifest: null,
    providerHealth: "not_injected",
    git: null,
  };

  errors.push(...validateServerSecretEnv(env));

  const walletResult = loadPreprodWalletsFromEnv(env, {
    cwd,
    repoRoot,
    readTextFile,
    fileExists,
    statFile,
  });
  errors.push(...walletResult.errors);
  if (walletResult.ok) {
    context.walletRoles = walletResult.summary;
  }

  const manifestResult = loadManifestFromEnv(env, {
    cwd,
    repoRoot,
    readTextFile,
    fileExists,
    statFile,
  });
  errors.push(...manifestResult.errors);

  const git = await currentGitState({ cwd: repoRoot, execFile: execFileFn });
  context.git = git.ok ? { commit: git.commit, clean: git.clean } : { clean: false };
  errors.push(...validateGitState(git));

  if (manifestResult.ok && git.ok) {
    const manifestErrors = validatePreprodManifest(manifestResult.manifest);
    errors.push(...validateManifestEnvCoherence(manifestResult.manifest, env));
    errors.push(...manifestErrors);
    if (!manifestErrors.some((error) => error.field === "manifest.source_commit")) {
      const ancestry = await gitCommitIsAncestor({
        ancestor: manifestResult.manifest.source_commit,
        descendant: git.commit,
        cwd: repoRoot,
        execFile: execFileFn,
      });
      errors.push(...validateDeploymentSourceCommit(manifestResult.manifest.source_commit, git.commit, ancestry));
    }
    context.manifest = redactedManifestSummary(manifestResult.manifest);
  }

  const providerHealthResult = loadInjectedProviderHealth(env, {
    cwd,
    repoRoot,
    readTextFile,
    fileExists,
    statFile,
  });
  errors.push(...providerHealthResult.errors);
  if (providerHealthResult.ok) {
    errors.push(...validateProviderHealth(providerHealthResult.health));
    context.providerHealth = redactedProviderHealthSummary(providerHealthResult.health);
  }

  if (errors.length > 0) {
    return preflightFailure(errors, context);
  }

  return {
    ok: true,
    errors: [],
    context,
  };
}

export function validateExecutionGate(env) {
  const errors = [];
  if ((env.RECLAIM_E2E_LIVE_PREPROD ?? "").trim() !== "1") {
    errors.push({
      code: "live_preprod_gate_missing",
      field: "RECLAIM_E2E_LIVE_PREPROD",
      message: "Set RECLAIM_E2E_LIVE_PREPROD=1 to enable the live preprod preflight.",
    });
  }
  if ((env.NODE_ENV ?? "").trim() === "production") {
    errors.push({
      code: "production_node_env",
      field: "NODE_ENV",
      message: "Live preprod E2E harnesses must not run with NODE_ENV=production.",
    });
  }
  return errors;
}

export function validatePreprodWalletFile(raw) {
  const { rolesRoot, errors } = normalizePreprodWalletRoles(raw);

  const normalized = {};
  const secretFingerprints = new Map();
  for (const role of REQUIRED_WALLET_ROLES) {
    const roleValue = rolesRoot[role];
    if (!roleValue || typeof roleValue !== "object" || Array.isArray(roleValue)) {
      errors.push({
        code: "wallet_role_missing",
        field: `wallets.${role}`,
        message: `Missing ${role} preprod test wallet role.`,
      });
      continue;
    }

    const mnemonic = normalizeMnemonic(
      roleValue.mnemonic ?? roleValue.seed_phrase ?? roleValue.recovery_phrase ?? roleValue.mnemonic_words,
    );
    if (!mnemonic.ok) {
      errors.push({
        code: "wallet_mnemonic_malformed",
        field: `wallets.${role}.mnemonic`,
        message: `${role} must provide a 12, 15, 18, 21, or 24 word mnemonic.`,
      });
    } else {
      const existingRole = secretFingerprints.get(mnemonic.fingerprint);
      if (existingRole) {
        errors.push({
          code: "wallet_secret_reused",
          field: `wallets.${role}.mnemonic`,
          message: `${role} must not reuse the same mnemonic as ${existingRole}.`,
        });
      } else {
        secretFingerprints.set(mnemonic.fingerprint, role);
      }
    }

    if (roleValue.address !== undefined) {
      if (typeof roleValue.address !== "string" || !roleValue.address.startsWith("addr_test")) {
        errors.push({
          code: "wallet_address_not_preprod",
          field: `wallets.${role}.address`,
          message: `${role} address must be a testnet address when present.`,
        });
      }
    }

    normalized[role] = {
      configured: true,
      mnemonicWordCount: mnemonic.ok ? mnemonic.wordCount : null,
      address: typeof roleValue.address === "string" ? redactAddress(roleValue.address) : null,
    };
  }

  if (errors.length > 0) {
    return { ok: false, errors, summary: redactWalletRoleSummary(rolesRoot) };
  }

  return { ok: true, errors: [], summary: normalized };
}

export function normalizePreprodWalletRoles(raw) {
  const errors = [];
  const root = objectValue(raw, "wallet_file", errors);
  if (errors.length > 0) {
    return { rolesRoot: {}, errors };
  }

  const candidate = root.roles ?? root.wallets ?? root;
  if (Array.isArray(candidate)) {
    return { rolesRoot: walletArrayToRoleMap(candidate, errors), errors };
  }

  return {
    rolesRoot: objectValue(candidate, "wallet_file.roles", errors),
    errors,
  };
}

export function validatePreprodManifest(manifest) {
  const errors = [];
  const root = objectValue(manifest, "manifest", errors);
  if (errors.length > 0) {
    return errors;
  }

  if (root.network !== "Preprod") {
    errors.push({
      code: "manifest_network_not_preprod",
      field: "manifest.network",
      message: "Deployment manifest network must be Preprod.",
    });
  }
  if (root.network_id !== 0) {
    errors.push({
      code: "manifest_network_id_not_preprod",
      field: "manifest.network_id",
      message: "Deployment manifest network_id must be 0 for Preprod.",
    });
  }
  if (root.enabled === false) {
    errors.push({
      code: "manifest_disabled",
      field: "manifest.enabled",
      message: "Deployment manifest must not be explicitly disabled.",
    });
  }
  if (typeof root.deployment_id === "string" && !root.deployment_id.startsWith("preprod:")) {
    errors.push({
      code: "manifest_deployment_id_not_preprod",
      field: "manifest.deployment_id",
      message: "Deployment id must be bound to preprod.",
    });
  }
  if (typeof root.source_commit !== "string" || root.source_commit.trim() === "") {
    errors.push({
      code: "manifest_source_commit_missing",
      field: "manifest.source_commit",
      message: "Deployment manifest source_commit is required.",
    });
  } else if (/dirty|uncommitted/iu.test(root.source_commit)) {
    errors.push({
      code: "manifest_source_commit_dirty",
      field: "manifest.source_commit",
      message: "Deployment manifest source_commit must be a clean commit.",
    });
  } else if (!/^[0-9a-f]{40}$/iu.test(root.source_commit)) {
    errors.push({
      code: "manifest_source_commit_invalid",
      field: "manifest.source_commit",
      message: "Deployment manifest source_commit must be a full 40-character Git commit SHA.",
    });
  }

  errors.push(...validateReferenceScriptManifest(root));

  return errors;
}

export function validateDeploymentSourceCommit(sourceCommit, currentCommit, ancestry) {
  if (sourceCommit === currentCommit) {
    return [];
  }
  if (!ancestry?.ok) {
    return [
      {
        code: "manifest_source_commit_ancestry_unavailable",
        field: "manifest.source_commit",
        message:
          "Could not verify that the deployment source commit is in the current Git history; fetch the commit history and retry.",
      },
    ];
  }
  if (!ancestry.isAncestor) {
    return [
      {
        code: "manifest_source_commit_not_ancestor",
        field: "manifest.source_commit",
        message: "Deployment manifest source_commit must be the current Git commit or an ancestor of it.",
      },
    ];
  }
  return [];
}

export function validateServerSecretEnv(env) {
  const errors = [];
  if (!envValue(env, "RECLAIM_REVIEW_TOKEN_SECRET")) {
    errors.push({
      code: "review_token_secret_missing",
      field: "RECLAIM_REVIEW_TOKEN_SECRET",
      message: "RECLAIM_REVIEW_TOKEN_SECRET is required before live preprod build/submit tests.",
    });
  }
  return errors;
}

function validateReferenceScriptManifest(manifest) {
  const errors = [];
  const referenceScripts = manifest?.reference_scripts;
  if (!referenceScripts || typeof referenceScripts !== "object" || Array.isArray(referenceScripts)) {
    return [
      {
        code: "manifest_reference_scripts_missing",
        field: "manifest.reference_scripts",
        message: "Deployment manifest must include ReclaimBase and ReclaimGlobal reference-script UTxOs.",
      },
    ];
  }
  for (const role of ["reclaim_base", "reclaim_global"]) {
    const value = referenceScripts[role];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push({
        code: "manifest_reference_script_missing",
        field: `manifest.reference_scripts.${role}`,
        message: `${role} reference-script deployment metadata is required.`,
      });
      continue;
    }
    if (typeof value.tx_hash !== "string" || !/^[0-9a-f]{64}$/u.test(value.tx_hash)) {
      errors.push({
        code: "manifest_reference_script_outref_malformed",
        field: `manifest.reference_scripts.${role}.tx_hash`,
        message: `${role} reference script tx_hash must be 32-byte lowercase hex.`,
      });
    }
    if (!Number.isInteger(value.output_index) || value.output_index < 0) {
      errors.push({
        code: "manifest_reference_script_outref_malformed",
        field: `manifest.reference_scripts.${role}.output_index`,
        message: `${role} reference script output_index must be a non-negative integer.`,
      });
    }
    if (typeof value.script_hash !== "string" || !/^[0-9a-f]{56}$/u.test(value.script_hash)) {
      errors.push({
        code: "manifest_reference_script_hash_malformed",
        field: `manifest.reference_scripts.${role}.script_hash`,
        message: `${role} reference script hash must be 28-byte lowercase hex.`,
      });
    }
  }
  return errors;
}

export function validateManifestEnvCoherence(manifest, env) {
  const errors = [];
  const envNetwork = envValue(env, "RECLAIM_NETWORK");
  const envNetworkId = envValue(env, "RECLAIM_NETWORK_ID");
  const envSourceCommit = envValue(env, "RECLAIM_SOURCE_COMMIT");

  if (envNetwork && envNetwork !== "Preprod") {
    errors.push({
      code: "env_network_not_preprod",
      field: "RECLAIM_NETWORK",
      message: "RECLAIM_NETWORK must be Preprod for the live preprod E2E harness.",
    });
  }
  if (envNetwork && manifest?.network && envNetwork !== manifest.network) {
    errors.push({
      code: "env_manifest_network_mismatch",
      field: "RECLAIM_NETWORK",
      message: "RECLAIM_NETWORK must match the deployment manifest network.",
    });
  }
  if (envNetworkId && envNetworkId !== "0") {
    errors.push({
      code: "env_network_id_not_preprod",
      field: "RECLAIM_NETWORK_ID",
      message: "RECLAIM_NETWORK_ID must be 0 for Preprod.",
    });
  }
  if (envNetworkId && manifest?.network_id !== undefined && Number(envNetworkId) !== manifest.network_id) {
    errors.push({
      code: "env_manifest_network_id_mismatch",
      field: "RECLAIM_NETWORK_ID",
      message: "RECLAIM_NETWORK_ID must match the deployment manifest network_id.",
    });
  }
  if (envSourceCommit && manifest?.source_commit && envSourceCommit !== manifest.source_commit) {
    errors.push({
      code: "env_manifest_source_commit_mismatch",
      field: "RECLAIM_SOURCE_COMMIT",
      message: "RECLAIM_SOURCE_COMMIT must match the deployment manifest source_commit.",
    });
  }

  return errors;
}

export function validateProviderHealth(health) {
  if (health === null || health === undefined) {
    return [];
  }

  const errors = [];
  const root = objectValue(health, "provider_health", errors);
  if (errors.length > 0) {
    return errors;
  }

  const network = firstString(
    root.network,
    root.network_name,
    root.networkName,
    root.cardano_network,
    root.cardanoNetwork,
  );
  if (!network || !/\bpreprod\b/iu.test(network)) {
    errors.push({
      code: "provider_health_not_preprod",
      field: "provider_health.network",
      message: "Injected provider health must report preprod.",
    });
  }

  if (root.network_id !== undefined && root.network_id !== 0) {
    errors.push({
      code: "provider_health_network_id_not_preprod",
      field: "provider_health.network_id",
      message: "Injected provider health network_id must be 0 for Preprod.",
    });
  }

  return errors;
}

export function validateGitState(git) {
  if (!git.ok) {
    return [
      {
        code: "git_state_unavailable",
        field: "git",
        message: "Could not read current git commit and clean status.",
      },
    ];
  }
  if (!git.clean) {
    return [
      {
        code: "git_worktree_dirty",
        field: "git.status",
        message: "Git worktree must be clean before live preprod E2E work.",
      },
    ];
  }
  return [];
}

export function redactSensitiveValue(value) {
  if (typeof value === "string") {
    return `[redacted:${value.length}]`;
  }
  if (Array.isArray(value)) {
    return `[redacted-array:${value.length}]`;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      redacted[key] = redactSensitiveValue(child);
    } else if (Array.isArray(child)) {
      redacted[key] = child.map((entry) =>
        typeof entry === "object" && entry !== null ? redactSensitiveValue(entry) : entry,
      );
    } else if (typeof child === "object" && child !== null) {
      redacted[key] = redactSensitiveValue(child);
    } else {
      redacted[key] = child;
    }
  }
  return redacted;
}

export function redactAddress(address) {
  if (typeof address !== "string" || address.length <= 18) {
    return "[redacted-address]";
  }
  return `${address.slice(0, 10)}...${address.slice(-8)}`;
}

export function redactWalletRoleSummary(rolesRoot) {
  const summary = {};
  const source = rolesRoot && typeof rolesRoot === "object" && !Array.isArray(rolesRoot) ? rolesRoot : {};
  for (const role of REQUIRED_WALLET_ROLES) {
    const roleValue = source[role];
    if (!roleValue || typeof roleValue !== "object" || Array.isArray(roleValue)) {
      summary[role] = { configured: false };
      continue;
    }
    const mnemonic = normalizeMnemonic(
      roleValue.mnemonic ?? roleValue.seed_phrase ?? roleValue.recovery_phrase ?? roleValue.mnemonic_words,
    );
    summary[role] = {
      configured: true,
      mnemonicWordCount: mnemonic.ok ? mnemonic.wordCount : null,
      address: typeof roleValue.address === "string" ? redactAddress(roleValue.address) : null,
    };
  }
  return summary;
}

export function formatPreflightReport(result) {
  const lines = [];
  if (!result.ok) {
    lines.push("Phase 9A live-preprod preflight failed closed.");
    for (const error of result.errors) {
      lines.push(`- ${error.field}: ${error.message}`);
    }
    if (result.context?.skipped?.length) {
      lines.push(`Skipped before live work: ${result.context.skipped.join(", ")}.`);
    }
    lines.push("No browser automation, provider submission, wallet signing, or transaction work was started.");
    return lines.join("\n");
  }

  lines.push("Phase 9A live-preprod preflight passed.");
  lines.push(`- web commit: ${result.context.git.commit}`);
  if (result.context.manifest) {
    lines.push(`- manifest: ${result.context.manifest.network} ${result.context.manifest.deployment_id}`);
    lines.push(`- deployment source_commit: ${result.context.manifest.source_commit}`);
  }
  lines.push(`- wallet roles: ${REQUIRED_WALLET_ROLES.join(", ")}`);
  if (result.context.providerHealth === "not_injected") {
    lines.push("- provider health: not injected");
  } else {
    lines.push(`- provider health: ${result.context.providerHealth.network}`);
  }
  lines.push("This slice is a preflight gate only; it does not run browser automation or submit transactions.");
  return lines.join("\n");
}

export function parseJsonConfig(text, field) {
  try {
    return { ok: true, value: JSON.parse(text), errors: [] };
  } catch {
    return {
      ok: false,
      value: null,
      errors: [
        {
          code: "json_malformed",
          field,
          message: `${field} must be valid JSON.`,
        },
      ],
    };
  }
}

export function manifestFromFlatEnv(env) {
  if (
    !envValue(env, "RECLAIM_NETWORK") &&
    !envValue(env, "RECLAIM_SOURCE_COMMIT") &&
    !envValue(env, "RECLAIM_DEPLOYMENT_ID")
  ) {
    return null;
  }
  return {
    deployment_id: envValue(env, "RECLAIM_DEPLOYMENT_ID"),
    network: envValue(env, "RECLAIM_NETWORK"),
    network_id: parseIntegerEnv(env, "RECLAIM_NETWORK_ID"),
    source_commit: envValue(env, "RECLAIM_SOURCE_COMMIT"),
    enabled: parseEnabled(envValue(env, "RECLAIM_DEPLOYMENT_ENABLED")),
  };
}

export function redactedManifestSummary(manifest) {
  return {
    deployment_id: typeof manifest.deployment_id === "string" ? manifest.deployment_id : "[missing]",
    network: manifest.network,
    network_id: manifest.network_id,
    source_commit: manifest.source_commit,
    enabled: manifest.enabled !== false,
  };
}

export function redactedProviderHealthSummary(health) {
  return {
    network:
      firstString(
        health?.network,
        health?.network_name,
        health?.networkName,
        health?.cardano_network,
        health?.cardanoNetwork,
      ) ?? "[unknown]",
    network_id: health?.network_id,
  };
}

export async function currentGitState({ cwd, execFile: execFileFn = execFile } = {}) {
  const commit = await execFileText(execFileFn, "git", ["rev-parse", "HEAD"], cwd);
  if (!commit.ok) {
    return { ok: false, clean: false, commit: null };
  }

  const status = await execFileText(execFileFn, "git", ["status", "--porcelain", "--untracked-files=all"], cwd);
  if (!status.ok) {
    return { ok: false, clean: false, commit: commit.stdout.trim() || null };
  }

  return {
    ok: true,
    clean: status.stdout.trim() === "",
    commit: commit.stdout.trim(),
  };
}

export async function gitCommitIsAncestor({ ancestor, descendant, cwd, execFile: execFileFn = execFile } = {}) {
  if (ancestor === descendant) {
    return { ok: true, isAncestor: true };
  }
  if (!/^[0-9a-f]{40}$/iu.test(String(ancestor ?? "")) || !/^[0-9a-f]{40}$/iu.test(String(descendant ?? ""))) {
    return { ok: false, isAncestor: false };
  }

  const result = await execFileResult(execFileFn, "git", ["merge-base", "--is-ancestor", ancestor, descendant], cwd);
  if (result.ok) {
    return { ok: true, isAncestor: true };
  }
  if (result.code === 1) {
    return { ok: true, isAncestor: false };
  }
  return { ok: false, isAncestor: false };
}

function loadPreprodWalletsFromEnv(env, options) {
  const walletPath = envValue(env, "PREPROD_TEST_WALLETS_FILE");
  if (!walletPath) {
    return {
      ok: false,
      errors: [
        {
          code: "wallet_file_env_missing",
          field: "PREPROD_TEST_WALLETS_FILE",
          message: "PREPROD_TEST_WALLETS_FILE must point to the local preprod wallet JSON file.",
        },
      ],
      summary: null,
    };
  }

  const file = readJsonFile(walletPath, "PREPROD_TEST_WALLETS_FILE", options);
  if (!file.ok) {
    return { ok: false, errors: file.errors, summary: null };
  }
  return validatePreprodWalletFile(file.value);
}

function loadManifestFromEnv(env, options) {
  const manifestJson = envValue(env, MANIFEST_JSON_ENV);
  if (manifestJson) {
    const parsed = parseJsonConfig(manifestJson, MANIFEST_JSON_ENV);
    if (!parsed.ok) {
      return { ok: false, errors: parsed.errors, manifest: null };
    }
    return { ok: true, errors: [], manifest: parsed.value };
  }

  const manifestPathEnv = firstString(...MANIFEST_PATH_ENVS.map((name) => envValue(env, name)));
  if (manifestPathEnv) {
    const file = readJsonFile(manifestPathEnv, "deployment_manifest", options);
    if (!file.ok) {
      return { ok: false, errors: file.errors, manifest: null };
    }
    return { ok: true, errors: [], manifest: file.value };
  }

  const flatManifest = manifestFromFlatEnv(env);
  if (flatManifest) {
    return { ok: true, errors: [], manifest: flatManifest };
  }

  return {
    ok: false,
    errors: [
      {
        code: "manifest_missing",
        field: "deployment_manifest",
        message:
          "Configure RECLAIM_DEPLOYMENT_MANIFEST_PATH, RECLAIM_DEPLOYMENT_MANIFEST_JSON, or RECLAIM_* deployment env values.",
      },
    ],
    manifest: null,
  };
}

function loadInjectedProviderHealth(env, options) {
  const providerHealthJson = envValue(env, PROVIDER_HEALTH_JSON_ENV);
  if (providerHealthJson) {
    const parsed = parseJsonConfig(providerHealthJson, PROVIDER_HEALTH_JSON_ENV);
    if (!parsed.ok) {
      return { ok: false, errors: parsed.errors, health: null };
    }
    return { ok: true, errors: [], health: parsed.value };
  }

  const providerHealthPath = envValue(env, PROVIDER_HEALTH_PATH_ENV);
  if (providerHealthPath) {
    const file = readJsonFile(providerHealthPath, PROVIDER_HEALTH_PATH_ENV, options);
    if (!file.ok) {
      return { ok: false, errors: file.errors, health: null };
    }
    return { ok: true, errors: [], health: file.value };
  }

  return { ok: false, errors: [], health: null };
}

function readJsonFile(inputPath, field, options) {
  const resolved = resolveExistingPath(inputPath, options);
  if (!resolved) {
    return {
      ok: false,
      value: null,
      errors: [
        {
          code: "file_missing",
          field,
          message: `${field} file was not found.`,
        },
      ],
    };
  }

  try {
    const stat = options.statFile(resolved);
    if (!stat.isFile()) {
      return {
        ok: false,
        value: null,
        errors: [
          {
            code: "file_not_regular",
            field,
            message: `${field} must be a regular JSON file.`,
          },
        ],
      };
    }
  } catch {
    return {
      ok: false,
      value: null,
      errors: [
        {
          code: "file_unreadable",
          field,
          message: `${field} file could not be inspected.`,
        },
      ],
    };
  }

  let text;
  try {
    text = options.readTextFile(resolved);
  } catch {
    return {
      ok: false,
      value: null,
      errors: [
        {
          code: "file_unreadable",
          field,
          message: `${field} file could not be read.`,
        },
      ],
    };
  }

  const parsed = parseJsonConfig(text, field);
  if (!parsed.ok) {
    return { ok: false, value: null, errors: parsed.errors };
  }
  return { ok: true, value: parsed.value, errors: [] };
}

function resolveExistingPath(inputPath, { cwd, repoRoot, fileExists }) {
  if (path.isAbsolute(inputPath)) {
    return fileExists(inputPath) ? inputPath : null;
  }

  const candidates = [path.resolve(cwd, inputPath), path.resolve(repoRoot, inputPath)];
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizeMnemonic(value) {
  let words;
  if (typeof value === "string") {
    words = value.trim().split(/\s+/u).filter(Boolean);
  } else if (Array.isArray(value) && value.every((word) => typeof word === "string")) {
    words = value.map((word) => word.trim()).filter(Boolean);
  } else {
    return { ok: false, wordCount: 0, fingerprint: null };
  }

  if (!MNEMONIC_WORD_COUNTS.has(words.length)) {
    return { ok: false, wordCount: words.length, fingerprint: null };
  }
  if (!words.every((word) => /^[a-z]+$/u.test(word))) {
    return { ok: false, wordCount: words.length, fingerprint: null };
  }

  return {
    ok: true,
    wordCount: words.length,
    fingerprint: words.join(" "),
  };
}

function objectValue(value, field, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push({
      code: "invalid_object",
      field,
      message: `${field} must be a JSON object.`,
    });
    return {};
  }
  return value;
}

function walletArrayToRoleMap(entries, errors) {
  const roles = {};
  const allowed = new Set(REQUIRED_WALLET_ROLES);
  for (const [index, entry] of entries.entries()) {
    const field = `wallet_file.wallets[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push({
        code: "wallet_role_entry_invalid",
        field,
        message: "Wallet role entries must be JSON objects.",
      });
      continue;
    }

    const role = typeof entry.role === "string" ? entry.role.trim() : "";
    if (!allowed.has(role)) {
      errors.push({
        code: "wallet_role_unknown",
        field: `${field}.role`,
        message: "Wallet role entries must declare one of the required preprod roles.",
      });
      continue;
    }
    if (roles[role]) {
      errors.push({
        code: "wallet_role_duplicate",
        field: `${field}.role`,
        message: `Duplicate ${role} preprod test wallet role.`,
      });
      continue;
    }
    roles[role] = entry;
  }
  return roles;
}

function preflightFailure(errors, context = {}) {
  return {
    ok: false,
    errors,
    context,
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

function envValue(env, name) {
  return typeof env[name] === "string" ? env[name].trim() : "";
}

function parseIntegerEnv(env, name) {
  const value = envValue(env, name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function parseEnabled(value) {
  if (!value) {
    return undefined;
  }
  if (/^(1|true|yes)$/iu.test(value)) {
    return true;
  }
  if (/^(0|false|no)$/iu.test(value)) {
    return false;
  }
  return value;
}

function execFileText(execFileFn, command, args, cwd) {
  return new Promise((resolve) => {
    execFileFn(command, args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

function execFileResult(execFileFn, command, args, cwd) {
  return new Promise((resolve) => {
    execFileFn(command, args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: typeof error?.code === "number" ? error.code : null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

function defaultRepoRoot() {
  if (import.meta.url.startsWith("file:")) {
    try {
      return path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
    } catch {
      // Vitest may transform import.meta.url while preserving a file-like prefix.
      return path.resolve(process.cwd(), "../..");
    }
  }
  return path.resolve(process.cwd(), "../..");
}

async function main() {
  const result = await runPreprodPreflight();
  const report = formatPreflightReport(result);
  if (result.ok) {
    console.log(report);
    return;
  }
  console.error(report);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Phase 9A live-preprod preflight failed closed.");
    console.error(error instanceof Error ? error.message : String(error));
    console.error("No browser automation, provider submission, wallet signing, or transaction work was started.");
    process.exitCode = 1;
  });
}
