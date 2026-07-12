#!/usr/bin/env node
/**
 * Generates local-only proof material for the evaluator-only Stage 2g V2
 * benchmark. It never accepts a mnemonic or master XPrv on argv, never emits
 * either value, and does not contact a Cardano provider or submit a transaction.
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getAddressDetails, walletFromSeed } from "@lucid-evolution/lucid";
import { normalizePreprodWalletRoles, validatePreprodWalletFile } from "./preflight.mjs";
import { validateBenchmarkMaterial } from "./stage2g-v2-evaluate.mjs";

const execFileAsync = promisify(execFile);
const NETWORK = "Preprod";
const NETWORK_ID = 0;
const MATERIAL_GATE_ENV = "RECLAIM_E2E_STAGE2G_V2_MATERIAL";
const LIVE_GATE_ENV = "RECLAIM_E2E_LIVE_PREPROD";
const SUBMISSION_GATE_ENV = "RECLAIM_E2E_SUBMIT_TRANSACTIONS";
const WALLET_FILE_ENV = "PREPROD_TEST_WALLETS_FILE";
const KEYS_DIR_ENV = "RECLAIM_E2E_STAGE2G_V2_KEYS_DIR";
const MANIFEST_PUBLIC_KEY_FILE_ENV = "RECLAIM_E2E_STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE";
const SIGNATURE_KEY_ID_ENV = "RECLAIM_E2E_STAGE2G_V2_SIGNATURE_KEY_ID";
const MATERIAL_FILE_ENV = "RECLAIM_E2E_STAGE2G_V2_MATERIAL_FILE";
const MATERIAL_OUTPUT_RELATIVE_ROOT = ["output", "preprod-e2e", "stage2g-v2"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");

export class Stage2gV2MaterialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "Stage2gV2MaterialError";
    this.code = code;
  }
}

export async function generateStage2gV2Material(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const readTextFile = options.readTextFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  const execFileFn = options.execFile ?? execFileAsync;
  const log = options.log ?? console.log;

  assertMaterialGenerationGate(env);
  const walletPath = resolveExistingLocalFile(env[WALLET_FILE_ENV], WALLET_FILE_ENV, repoRoot);
  const keysDir = resolveExistingLocalDirectory(env[KEYS_DIR_ENV], KEYS_DIR_ENV, repoRoot);
  const manifestPublicKeyFile = resolveExistingLocalFile(env[MANIFEST_PUBLIC_KEY_FILE_ENV], MANIFEST_PUBLIC_KEY_FILE_ENV, repoRoot);
  assertExternalManifestPublicKeyFile(manifestPublicKeyFile, keysDir);
  const signatureKeyID = resolveRequiredEnvValue(env[SIGNATURE_KEY_ID_ENV], SIGNATURE_KEY_ID_ENV);
  const materialPath = resolveMaterialOutputPath(env, repoRoot, options.materialPath);
  const materialOutputPath = stage2gRelativeOutputPath(materialPath, repoRoot);
  const safeDestination = loadSafeDestination(walletPath, readTextFile);

  try {
    await execFileFn(
      "go",
      [
        "run",
        "./cmd/proof-tool",
        "generate-stage2g-v2-material",
        "--wallet-file",
        walletPath,
        "--keys-dir",
        keysDir,
        "--manifest-public-key-file",
        manifestPublicKeyFile,
        "--signature-key-id",
        signatureKeyID,
        "--destination-address",
        safeDestination.address,
        "--destination-address-bytes",
        safeDestination.addressV1,
        "--out",
        materialOutputPath,
      ],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Stage2gV2MaterialError(
      "stage2g_material_generation_failed",
      `Stage 2g local material generation failed: ${redactError(error)}.`,
    );
  }

  let material;
  try {
    material = validateBenchmarkMaterial(JSON.parse(readTextFile(materialPath)));
  } catch (error) {
    if (error instanceof Stage2gV2MaterialError) {
      throw error;
    }
    throw new Stage2gV2MaterialError(
      "stage2g_material_output_invalid",
      `Stage 2g material generator did not produce valid evaluator material: ${redactError(error)}.`,
    );
  }
  if (material.entries.some((entry) => entry.destinationAddress !== safeDestination.address)) {
    throw new Stage2gV2MaterialError(
      "stage2g_material_destination_mismatch",
      "Stage 2g material contains a destination other than the local safe wallet.",
    );
  }

  const summary = {
    schema: "proof-tool-stage2g-v2-material-generation-summary-v1",
    outcome: "generated",
    network: NETWORK,
    material_file: path.basename(materialPath),
    entries: material.entries.length,
    distinct_credentials: material.entries.length,
    proof_bytes_per_entry: 336,
    digest_bytes_per_entry: 32,
    vk_bytes: 672,
    local_only: true,
    signing: false,
    submission: false,
    funding: false,
    deployment: false,
  };
  log(JSON.stringify(summary));
  return { ok: true, materialPath, summary };
}

export function assertMaterialGenerationGate(env) {
  if (process.platform !== "linux") {
    throw new Stage2gV2MaterialError(
      "stage2g_secure_output_unsupported",
      "Stage 2g material generation requires Linux for descriptor-anchored secure output.",
    );
  }
  if ((env[LIVE_GATE_ENV] ?? "").trim() !== "1") {
    throw new Stage2gV2MaterialError(
      "live_preprod_gate_missing",
      `${LIVE_GATE_ENV}=1 is required before Stage 2g material generation.`,
    );
  }
  if ((env[MATERIAL_GATE_ENV] ?? "").trim() !== "1") {
    throw new Stage2gV2MaterialError(
      "stage2g_material_gate_missing",
      `${MATERIAL_GATE_ENV}=1 is required before Stage 2g material generation.`,
    );
  }
  if ((env[SUBMISSION_GATE_ENV] ?? "").trim() === "1") {
    throw new Stage2gV2MaterialError(
      "submission_mode_forbidden",
      `${SUBMISSION_GATE_ENV}=1 is incompatible with local-only Stage 2g material generation.`,
    );
  }
  if ((env.NODE_ENV ?? "").trim() === "production") {
    throw new Stage2gV2MaterialError(
      "production_node_env",
      "Stage 2g material generation must not run with NODE_ENV=production.",
    );
  }
}

export function loadSafeDestination(walletPath, readTextFile = (filePath) => readFileSync(filePath, "utf8")) {
  let walletFile;
  try {
    walletFile = JSON.parse(readTextFile(walletPath));
  } catch {
    throw new Stage2gV2MaterialError("wallet_file_unreadable", "The local Stage 2g wallet file could not be read as JSON.");
  }
  const validation = validatePreprodWalletFile(walletFile);
  if (!validation.ok) {
    throw new Stage2gV2MaterialError("wallet_file_invalid", "The local Stage 2g wallet file is not a valid Preprod role file.");
  }
  const { rolesRoot, errors } = normalizePreprodWalletRoles(walletFile);
  const role = rolesRoot.safe_claim_destination;
  const mnemonicSource = role?.mnemonic ?? role?.seed_phrase ?? role?.recovery_phrase ?? role?.mnemonic_words;
  const mnemonic = typeof mnemonicSource === "string" ? mnemonicSource.trim().replace(/\s+/gu, " ") : "";
  if (errors.length > 0 || mnemonic === "") {
    throw new Stage2gV2MaterialError("safe_wallet_missing", "The local safe_claim_destination wallet role is unavailable.");
  }
  let address;
  try {
    address = walletFromSeed(mnemonic, { network: NETWORK }).address;
  } catch {
    throw new Stage2gV2MaterialError("safe_wallet_invalid", "The local safe_claim_destination wallet could not be derived.");
  }
  return { address, addressV1: destinationAddressV1(address) };
}

function destinationAddressV1(address) {
  try {
    const details = getAddressDetails(address);
    if (details.networkId !== NETWORK_ID || !details.paymentCredential || details.type === "Pointer") {
      throw new Error("unsupported address");
    }
    const payment = credentialV1Bytes(details.paymentCredential);
    const stake = details.stakeCredential ? credentialV1Bytes(details.stakeCredential) : `00${"00".repeat(28)}`;
    const encoded = `${payment}${stake}`;
    if (encoded.length !== 58 * 2) {
      throw new Error("wrong destination length");
    }
    return encoded;
  } catch {
    throw new Stage2gV2MaterialError("safe_wallet_address_invalid", "The local safe wallet does not have a supported Preprod destination address.");
  }
}

function credentialV1Bytes(credential) {
  const hash = typeof credential?.hash === "string" ? credential.hash.toLowerCase() : "";
  if (!/^[0-9a-f]{56}$/u.test(hash)) {
    throw new Error("invalid credential");
  }
  if (credential.type === "Key") {
    return `01${hash}`;
  }
  if (credential.type === "Script") {
    return `02${hash}`;
  }
  throw new Error("unsupported credential");
}

function resolveExistingLocalFile(value, envName, repoRoot) {
  const resolved = resolvePath(value, envName, repoRoot);
  if (!existsSync(resolved) || !lstatSync(resolved).isFile() || lstatSync(resolved).isSymbolicLink()) {
    throw new Stage2gV2MaterialError("local_file_missing", `${envName} must name an existing non-symlink local file.`);
  }
  return resolved;
}

function resolveExistingLocalDirectory(value, envName, repoRoot) {
  const resolved = resolvePath(value, envName, repoRoot);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory() || lstatSync(resolved).isSymbolicLink()) {
    throw new Stage2gV2MaterialError("local_directory_missing", `${envName} must name an existing non-symlink local directory.`);
  }
  return resolved;
}

function resolvePath(value, envName, repoRoot) {
  const configured = typeof value === "string" ? value.trim() : "";
  if (!configured) {
    throw new Stage2gV2MaterialError("local_path_missing", `${envName} is required for Stage 2g material generation.`);
  }
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(repoRoot, configured);
}

function resolveRequiredEnvValue(value, envName) {
  const resolved = typeof value === "string" ? value.trim() : "";
  if (!resolved) {
    throw new Stage2gV2MaterialError("trusted_manifest_signer_missing", `${envName} is required for Stage 2g material generation.`);
  }
  return resolved;
}

function assertExternalManifestPublicKeyFile(manifestPublicKeyFile, keysDir) {
  let resolvedManifestPublicKeyFile;
  let resolvedKeysDir;
  try {
    resolvedManifestPublicKeyFile = realpathSync(manifestPublicKeyFile);
    resolvedKeysDir = realpathSync(keysDir);
  } catch {
    throw new Stage2gV2MaterialError(
      "trusted_manifest_public_key_invalid",
      "The trusted Stage 2g manifest public-key file could not be resolved.",
    );
  }
  const relative = path.relative(resolvedKeysDir, resolvedManifestPublicKeyFile);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw new Stage2gV2MaterialError(
      "trusted_manifest_public_key_not_external",
      "The trusted Stage 2g manifest public-key file must be outside the key bundle.",
    );
  }
}

function resolveMaterialOutputPath(env, repoRoot, explicitPath) {
  const configured = explicitPath ?? env[MATERIAL_FILE_ENV]?.trim() ?? path.join(...MATERIAL_OUTPUT_RELATIVE_ROOT, "material.local.json");
  const resolved = path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(repoRoot, configured);
  const root = path.resolve(repoRoot, ...MATERIAL_OUTPUT_RELATIVE_ROOT);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Stage2gV2MaterialError(
      "stage2g_material_path_unsafe",
      "Stage 2g material must be written under output/preprod-e2e/stage2g-v2/.",
    );
  }
  const relative = path.relative(path.resolve(repoRoot), resolved);
  let current = path.resolve(repoRoot);
  for (const part of relative.split(path.sep)) {
    if (!part || part === ".") {
      continue;
    }
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Stage2gV2MaterialError(
          "stage2g_material_path_unsafe",
          "Stage 2g material path traverses a symbolic link.",
        );
      }
    } catch (error) {
      if (error instanceof Stage2gV2MaterialError || error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return resolved;
}

function stage2gRelativeOutputPath(materialPath, repoRoot) {
  const relative = path.relative(path.resolve(repoRoot), materialPath);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Stage2gV2MaterialError(
      "stage2g_material_path_unsafe",
      "Stage 2g material must be written under output/preprod-e2e/stage2g-v2/.",
    );
  }
  return relative;
}

function redactError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "generator error");
  return message
    .replace(/\b(addr(?:_test)?1[0-9a-z]{20,})\b/giu, "[address-redacted]")
    .replace(/\b[0-9a-f]{56,}\b/giu, "[hex-redacted]")
    .replace(/\b[A-Za-z0-9_-]{96,}\b/gu, "[token-redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 360) || "generator error";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateStage2gV2Material().catch((error) => {
    const code = error instanceof Stage2gV2MaterialError ? error.code : "stage2g_material_unexpected_error";
    console.error(JSON.stringify({ schema: "proof-tool-stage2g-v2-material-generation-summary-v1", outcome: "failed", code, message: redactError(error) }));
    process.exitCode = 1;
  });
}
