#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  Blockfrost,
  Constr,
  Data,
  Koios,
  Lucid,
  calculateMinLovelaceFromUTxO,
  credentialToRewardAddress,
  getAddressDetails,
  mintingPolicyToId,
  scriptHashToCredential,
  validatorToAddress,
  validatorToScriptHash,
  walletFromSeed,
} from "@lucid-evolution/lucid";
import { normalizePreprodWalletRoles } from "./preflight.mjs";

const execFileAsync = promisify(execFile);

const NETWORK = "Preprod";
const NETWORK_ID = 0;
const FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2 = "full-proof-plus-public-input-digest-v2";
const REQUIRED_LIVE_GATE = "RECLAIM_E2E_LIVE_PREPROD";
const REQUIRED_GATE = "RECLAIM_E2E_SUBMIT_TRANSACTIONS";
const STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE_ENV = "RECLAIM_E2E_STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE";
const STAGE2G_V2_SIGNATURE_KEY_ID_ENV = "RECLAIM_E2E_STAGE2G_V2_SIGNATURE_KEY_ID";
const DEFAULT_MANIFEST_PATH = "deployments/reclaim/preprod/live.local.json";
const DEFAULT_CARDANO_VK_DIR = "output/preprod-e2e/destination-cardano-vk.local";
const PARAMS_TOKEN_NAME = "5245434c41494d504152414d53"; // RECLAIMPARAMS
const FEE_BUFFER_LOVELACE = 2_000_000n;
const REFERENCE_DATUM = Data.void();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CONTRACT_DIR = path.join(REPO_ROOT, "contracts", "ownership-verifier");

class DeployPreprodError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeployPreprodError";
    this.code = code;
  }
}

export async function deployReclaimPreprod(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const env = { ...process.env, ...(options.env ?? {}) };
  const assertCleanPushedSourceFn = options.assertCleanPushedSourceFn ?? assertCleanPushedSource;
  const prepareDestinationKeysFn = options.prepareDestinationKeysFn ?? prepareDestinationKeys;
  const loadWalletFileFn = options.loadWalletFileFn ?? loadWalletFile;
  loadLocalEnv(env, repoRoot);
  assertPreprodOnly(env);

  const git = await assertCleanPushedSourceFn(repoRoot);
  const destination = await prepareDestinationKeysFn({ env, repoRoot, git });
  const walletFile = loadWalletFileFn(env, repoRoot);
  const deployer = walletRole(walletFile, "deployer");
  const provider = createProvider(env);
  const protocol = await provider.getProtocolParameters();
  const lucid = await Lucid(provider, NETWORK);
  lucid.selectWallet.fromSeed(deployer.mnemonic, { accountIndex: 0 });
  const deployerAddress = walletFromSeed(deployer.mnemonic, { network: NETWORK }).address;
  const deployerDetails = getAddressDetails(deployerAddress);
  if (deployerDetails.networkId !== NETWORK_ID) {
    throw new DeployPreprodError("deployer_network_invalid", "Deployer wallet must derive a Preprod address.");
  }

  const deployerUtxos = await provider.getUtxos(deployerAddress);
  const seedUtxo = selectSeedUtxo(deployerUtxos);
  const oneShotScript = await exportScript("one-shot", seedUtxo.txHash, String(seedUtxo.outputIndex));
  const paramsPolicyId = mintingPolicyToId(oneShotScript);
  const globalScript = await exportScript(
    ...reclaimGlobalExportArgs(
      "global-v2",
      paramsPolicyId,
      destination.cardanoVkHex,
      normalizeBlake2b256(destination.cardanoVkBlake2b256),
    ),
  );
  assertReclaimGlobalProofSlotEncoding(
    globalScript.proofSlotEncoding,
    globalScript.batchTranscript,
    globalScript.verifierVkHash,
    destination.cardanoVkBlake2b256,
  );
  const globalScriptHash = validatorToScriptHash(globalScript).toLowerCase();
  const baseScript = await exportScript("base", globalScriptHash);
  const baseScriptHash = validatorToScriptHash(baseScript).toLowerCase();
  const holderScript = await exportScript("params-holder");
  const holderScriptHash = validatorToScriptHash(holderScript).toLowerCase();
  const holderAddress = validatorToAddress(NETWORK, holderScript);
  const baseAddress = validatorToAddress(NETWORK, baseScript);
  const globalRewardAddress = credentialToRewardAddress(NETWORK, scriptHashToCredential(globalScriptHash));
  const globalRewardAccountRegistered = await isRewardAccountRegistered(env, globalRewardAddress);
  const registerGlobalRewardAccount = !globalRewardAccountRegistered;
  const paramsUnit = `${paramsPolicyId}${PARAMS_TOKEN_NAME}`;
  const paramsDatum = Data.to(new Constr(0, [baseScriptHash]));
  const paramsLovelace = minOutputLovelace(protocol, {
    address: holderAddress,
    assets: { lovelace: 1n, [paramsUnit]: 1n },
    datum: paramsDatum,
  });
  const baseReferenceLovelace = minOutputLovelace(protocol, {
    address: holderAddress,
    assets: { lovelace: 1n },
    datum: REFERENCE_DATUM,
    scriptRef: baseScript,
  });
  const globalReferenceLovelace = minOutputLovelace(protocol, {
    address: holderAddress,
    assets: { lovelace: 1n },
    datum: REFERENCE_DATUM,
    scriptRef: globalScript,
  });
  const rewardAccountRegistrationDeposit = registerGlobalRewardAccount ? protocolKeyDeposit(protocol) : 0n;
  const minimumOutputLovelace = paramsLovelace + baseReferenceLovelace + globalReferenceLovelace + rewardAccountRegistrationDeposit;
  const availableLovelace = sumLovelace(deployerUtxos);
  if (availableLovelace <= minimumOutputLovelace + FEE_BUFFER_LOVELACE) {
    throw new DeployPreprodError(
      "deployer_balance_too_low",
      `Deployer wallet has ${lovelaceToAda(availableLovelace)} ADA; deployment outputs and reward-account registration require ${lovelaceToAda(minimumOutputLovelace)} ADA before fees.`,
    );
  }

  let tx = lucid
    .newTx()
    .collectFrom([seedUtxo])
    .mintAssets({ [paramsUnit]: 1n }, Data.void())
    .attach.MintingPolicy(oneShotScript);
  if (registerGlobalRewardAccount) {
    tx = tx.register.Stake(globalRewardAddress);
  }
  const signBuilder = await tx
    .pay.ToAddressWithData(
      holderAddress,
      { kind: "inline", value: paramsDatum },
      { lovelace: paramsLovelace, [paramsUnit]: 1n },
    )
    .pay.ToAddressWithData(
      holderAddress,
      { kind: "inline", value: REFERENCE_DATUM },
      { lovelace: baseReferenceLovelace },
      baseScript,
    )
    .pay.ToAddressWithData(
      holderAddress,
      { kind: "inline", value: REFERENCE_DATUM },
      { lovelace: globalReferenceLovelace },
      globalScript,
    )
    .complete({
      canonical: true,
      changeAddress: deployerAddress,
      presetWalletInputs: deployerUtxos,
    });

  const txHash = signBuilder.toHash();
  const summary = {
    ok: false,
    submitted: false,
    network: NETWORK,
    sourceCommit: git.commit,
    txHash,
    deployer: redactAddress(deployerAddress),
    seedOutRef: `${seedUtxo.txHash}#${seedUtxo.outputIndex}`,
    paramsPolicyId,
    paramsTokenName: PARAMS_TOKEN_NAME,
    paramsUnit,
    reclaimBaseScriptHash: baseScriptHash,
    reclaimGlobalScriptHash: globalScriptHash,
    paramsHolderScriptHash: holderScriptHash,
    paramsHolderAddress: redactAddress(holderAddress),
    reclaimGlobalRewardAddress: globalRewardAddress,
    globalRewardAccountRegisteredBefore: globalRewardAccountRegistered,
    globalRewardAccountRegistrationSubmitted: registerGlobalRewardAccount,
    destinationVkHash: destination.vkHash,
    destinationCardanoVkBlake2b256: destination.cardanoVkBlake2b256,
    destinationKeysDir: path.relative(repoRoot, destination.keysDir),
    manifestPath: resolveManifestPath(env, repoRoot).relative,
    outputLovelace: {
      params: paramsLovelace.toString(),
      reclaimBaseReference: baseReferenceLovelace.toString(),
      reclaimGlobalReference: globalReferenceLovelace.toString(),
    },
  };

  console.error(
    JSON.stringify({
      schema: "proof-tool-preprod-deploy-status-v1",
      stage: "pre-submit",
      txHash,
      sourceCommit: git.commit,
      paramsPolicyId,
      reclaimBaseScriptHash: baseScriptHash,
      reclaimGlobalScriptHash: globalScriptHash,
      paramsHolderScriptHash: holderScriptHash,
      globalRewardAccountRegistration: registerGlobalRewardAccount,
    }),
  );
  const signed = await signBuilder.sign.withWallet().complete();
  const submittedHash = await submitDeploymentTxOrRecover({
    signed,
    lucid,
    txHash,
  });
  console.error(
    JSON.stringify({
      schema: "proof-tool-preprod-deploy-status-v1",
      stage: "submitted",
      txHash: submittedHash,
    }),
  );
  if (submittedHash !== txHash) {
    throw new DeployPreprodError("submitted_tx_hash_mismatch", "Submitted tx hash did not match the reviewed deployment tx hash.");
  }
  await waitForTx(lucid, submittedHash);
  const deployed = await loadDeploymentOutputs(provider, holderAddress, submittedHash, {
    paramsUnit,
    baseScriptHash,
    globalScriptHash,
  });
  const manifest = buildManifest({
    sourceCommit: git.commit,
    baseAddress,
    baseScriptHash,
    globalScriptHash,
    globalRewardAddress,
    holderScriptHash,
    paramsPolicyId,
    paramsUnit,
    paramsOutRef: deployed.params,
    referenceBase: deployed.baseReference,
    referenceGlobal: deployed.globalReference,
    destination,
    providerName: providerName(env),
    globalRewardAccountRegistered: true,
  });
  const manifestPath = writeManifest(env, repoRoot, manifest);
  await runNode(repoRoot, [path.join("apps", "ownership-proof-web", "scripts", "verify-reclaim-manifest.mjs"), manifestPath]);
  updateLocalEnv(repoRoot, {
    RECLAIM_DEPLOYMENT_MANIFEST_PATH: path.relative(repoRoot, manifestPath),
    RECLAIM_DESTINATION_KEYS_DIR: path.relative(repoRoot, destination.keysDir),
  });

  return {
    ...summary,
    ok: true,
    submitted: true,
    submittedHash,
    manifestPath: path.relative(repoRoot, manifestPath),
    paramsOutRef: `${deployed.params.tx_hash}#${deployed.params.output_index}`,
    reclaimBaseReferenceOutRef: `${deployed.baseReference.tx_hash}#${deployed.baseReference.output_index}`,
    reclaimGlobalReferenceOutRef: `${deployed.globalReference.tx_hash}#${deployed.globalReference.output_index}`,
  };
}

function loadLocalEnv(env, repoRoot) {
  const envPath = path.join(repoRoot, ".env.local");
  if (!existsSync(envPath)) {
    return;
  }
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (env[key] === undefined) {
      env[key] = unquoteEnvValue(rawValue.trim());
    }
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function assertPreprodOnly(env) {
  if ((env[REQUIRED_LIVE_GATE] ?? "").trim() !== "1") {
    throw new DeployPreprodError("live_preprod_gate_missing", `${REQUIRED_LIVE_GATE}=1 is required before live Preprod deployment.`);
  }
  if ((env[REQUIRED_GATE] ?? "").trim() !== "1") {
    throw new DeployPreprodError("submit_gate_missing", `${REQUIRED_GATE}=1 is required before submitting the Preprod deployment transaction.`);
  }
  if ((env.RECLAIM_NETWORK ?? "").trim() !== NETWORK) {
    throw new DeployPreprodError("network_not_preprod", "RECLAIM_NETWORK must be Preprod.");
  }
  if ((env.RECLAIM_NETWORK_ID ?? "0").trim() !== "0") {
    throw new DeployPreprodError("network_id_not_preprod", "RECLAIM_NETWORK_ID must be 0 when set.");
  }
}

async function assertCleanPushedSource(repoRoot) {
  const status = (await execGit(repoRoot, ["status", "--porcelain", "--untracked-files=all"])).trim();
  if (status) {
    throw new DeployPreprodError("git_worktree_dirty", "Git worktree must be clean before a Preprod deployment transaction.");
  }
  const commit = (await execGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  const origin = await execGitMaybe(repoRoot, ["rev-parse", "--verify", "origin/main"]);
  if (origin.ok && origin.stdout.trim() !== commit) {
    throw new DeployPreprodError("git_not_pushed", "HEAD must match origin/main before a Preprod deployment transaction.");
  }
  return { commit };
}

async function execGit(repoRoot, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function execGitMaybe(repoRoot, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, error };
  }
}

function loadWalletFile(env, repoRoot) {
  const configured = env.PREPROD_TEST_WALLETS_FILE?.trim();
  if (!configured) {
    throw new DeployPreprodError("wallet_file_missing", "PREPROD_TEST_WALLETS_FILE is required.");
  }
  const resolved = path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
  if (!existsSync(resolved)) {
    throw new DeployPreprodError("wallet_file_missing", "PREPROD_TEST_WALLETS_FILE does not exist.");
  }
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function walletRole(walletFile, role) {
  const { rolesRoot, errors } = normalizePreprodWalletRoles(walletFile);
  if (errors.length > 0) {
    throw new DeployPreprodError("wallet_file_invalid", "Preprod wallet file is malformed.");
  }
  const value = rolesRoot[role];
  const mnemonic = normalizeMnemonic(value?.mnemonic ?? value?.seed_phrase ?? value?.recovery_phrase ?? value?.mnemonic_words);
  if (!mnemonic) {
    throw new DeployPreprodError("wallet_role_missing", `${role} mnemonic is required.`);
  }
  return { mnemonic };
}

function normalizeMnemonic(value) {
  if (Array.isArray(value)) {
    return value.map((word) => String(word).trim()).filter(Boolean).join(" ");
  }
  if (typeof value === "string") {
    return value.trim().split(/\s+/u).filter(Boolean).join(" ");
  }
  return "";
}

function createProvider(env) {
  const name = providerName(env);
  if (name === "blockfrost") {
    const projectId = env.RECLAIM_BLOCKFROST_PROJECT_ID?.trim() || env.BLOCKFROST_PROJECT_ID?.trim();
    if (!projectId) {
      throw new DeployPreprodError("blockfrost_project_id_missing", "RECLAIM_BLOCKFROST_PROJECT_ID is required.");
    }
    return new Blockfrost(env.RECLAIM_BLOCKFROST_URL?.trim() || "https://cardano-preprod.blockfrost.io/api/v0", projectId);
  }
  if (name === "koios") {
    const koiosUrl = env.RECLAIM_KOIOS_URL?.trim() || "https://preprod.koios.rest/api/v1";
    const koiosToken = env.RECLAIM_KOIOS_TOKEN?.trim();
    return koiosToken ? new Koios(koiosUrl, koiosToken) : new Koios(koiosUrl);
  }
  throw new DeployPreprodError("provider_unsupported", "RECLAIM_PROVIDER must be blockfrost or koios.");
}

function providerName(env) {
  return (env.RECLAIM_PROVIDER?.trim() || "blockfrost").toLowerCase();
}

async function isRewardAccountRegistered(env, rewardAddress) {
  const name = providerName(env);
  if (name === "blockfrost") {
    const projectId = env.RECLAIM_BLOCKFROST_PROJECT_ID?.trim() || env.BLOCKFROST_PROJECT_ID?.trim();
    if (!projectId) {
      throw new DeployPreprodError("blockfrost_project_id_missing", "RECLAIM_BLOCKFROST_PROJECT_ID is required.");
    }
    const baseUrl = (env.RECLAIM_BLOCKFROST_URL?.trim() || "https://cardano-preprod.blockfrost.io/api/v0").replace(/\/+$/u, "");
    const response = await fetch(`${baseUrl}/accounts/${rewardAddress}`, {
      headers: { project_id: projectId },
    });
    if (response.status === 200) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }
    throw new DeployPreprodError(
      "reward_account_status_unavailable",
      `Blockfrost account status check returned HTTP ${response.status} for ReclaimGlobal reward account.`,
    );
  }
  if (name === "koios") {
    const baseUrl = (env.RECLAIM_KOIOS_URL?.trim() || "https://preprod.koios.rest/api/v1").replace(/\/+$/u, "");
    const headers = { "content-type": "application/json" };
    const token = env.RECLAIM_KOIOS_TOKEN?.trim();
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    const response = await fetch(`${baseUrl}/account_info`, {
      method: "POST",
      headers,
      body: JSON.stringify({ _stake_addresses: [rewardAddress] }),
    });
    if (!response.ok) {
      throw new DeployPreprodError(
        "reward_account_status_unavailable",
        `Koios account status check returned HTTP ${response.status} for ReclaimGlobal reward account.`,
      );
    }
    const body = await response.json();
    return Array.isArray(body) && body.length > 0;
  }
  throw new DeployPreprodError("provider_unsupported", "RECLAIM_PROVIDER must be blockfrost or koios.");
}

export async function prepareDestinationKeys({ env, repoRoot, git, runGoFn = runGo }) {
  void git;
  const configured = env.RECLAIM_DESTINATION_KEYS_DIR?.trim() || env.RECLAIM_E2E_DESTINATION_KEYS_DIR?.trim();
  if (!configured) {
    throw new DeployPreprodError("destination_keys_dir_missing", "RECLAIM_DESTINATION_KEYS_DIR or RECLAIM_E2E_DESTINATION_KEYS_DIR is required.");
  }
  const keysDir = path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
  const manifestPublicKeyFile = requireDestinationTrustEnv(
    env[STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE_ENV],
    STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE_ENV,
    "stage2g_manifest_public_key_missing",
  );
  const signatureKeyID = requireDestinationTrustEnv(
    env[STAGE2G_V2_SIGNATURE_KEY_ID_ENV],
    STAGE2G_V2_SIGNATURE_KEY_ID_ENV,
    "stage2g_signature_key_id_missing",
  );
  if (!hasKeyBundle(keysDir)) {
    throw new DeployPreprodError("destination_key_bundle_missing", "Destination key bundle must already exist; deployment will not create proof keys.");
  }
  const trustedManifestPublicKeyFile = resolveExternalManifestPublicKeyFile(manifestPublicKeyFile, repoRoot, keysDir);
  await verifyDestinationKeyBundle(runGoFn, repoRoot, [
    "run",
    "./cmd/proof-tool",
    "verify-stage2g-v2-key-bundle",
    "--keys-dir",
    keysDir,
    "--manifest-public-key-file",
    trustedManifestPublicKeyFile,
    "--signature-key-id",
    signatureKeyID,
  ]);
  const cardanoDir = path.resolve(repoRoot, env.RECLAIM_DESTINATION_CARDANO_VK_DIR?.trim() || DEFAULT_CARDANO_VK_DIR);
  mkdirSync(cardanoDir, { recursive: true });
  const cardanoVkPath = path.join(cardanoDir, "vk.hex");
  const formatPath = path.join(cardanoDir, "format.txt");
  const exportOutput = await runGoFn(repoRoot, [
    "run",
    "./cmd/proof-tool",
    "export-cardano-vk",
    "--key-version",
    "ownership-destination-v2",
    "--keys-dir",
    keysDir,
    "--out",
    cardanoVkPath,
    "--format-out",
    formatPath,
  ]);
  const manifest = JSON.parse(readFileSync(path.join(keysDir, "manifest.json"), "utf8"));
  const cardanoVkHex = readFileSync(cardanoVkPath, "utf8").trim().toLowerCase();
  if (!/^[0-9a-f]{1344}$/u.test(cardanoVkHex)) {
    throw new DeployPreprodError("cardano_vk_malformed", "Destination Cardano verifier key must be 672 bytes.");
  }
  return {
    keysDir,
    cardanoVkHex,
    vkHash: manifest.vk_hash,
    cardanoVkBlake2b256: parseLine(exportOutput.stdout, "cardano_vk_blake2b256"),
  };
}

function requireDestinationTrustEnv(value, envName, errorCode) {
  const resolved = typeof value === "string" ? value.trim() : "";
  if (!resolved) {
    throw new DeployPreprodError(errorCode, `${envName} is required before destination key export.`);
  }
  return resolved;
}

function resolveExternalManifestPublicKeyFile(configured, repoRoot, keysDir) {
  const requestedPath = path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(repoRoot, configured);
  let resolvedManifestPublicKeyFile;
  let resolvedKeysDir;
  try {
    resolvedManifestPublicKeyFile = realpathSync(requestedPath);
    resolvedKeysDir = realpathSync(keysDir);
  } catch {
    throw new DeployPreprodError(
      "stage2g_manifest_public_key_invalid",
      "The trusted destination manifest public-key file could not be resolved.",
    );
  }
  if (pathIsWithin(resolvedKeysDir, resolvedManifestPublicKeyFile)) {
    throw new DeployPreprodError(
      "stage2g_manifest_public_key_not_external",
      "The trusted destination manifest public-key file must be outside the destination key bundle.",
    );
  }
  try {
    if (!statSync(resolvedManifestPublicKeyFile).isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new DeployPreprodError(
      "stage2g_manifest_public_key_invalid",
      "The trusted destination manifest public-key file must resolve to a regular file.",
    );
  }
  // Pass the normalized requested path rather than the canonical target. The
  // specialized verifier must still see a direct symlink so it can reject it;
  // the canonical path above is used only for containment validation.
  return requestedPath;
}

function pathIsWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function verifyDestinationKeyBundle(runGoFn, repoRoot, args) {
  try {
    await runGoFn(repoRoot, args);
  } catch {
    throw new DeployPreprodError(
      "destination_key_bundle_trust_verification_failed",
      "Destination key bundle trust verification failed.",
    );
  }
}

function hasKeyBundle(keysDir) {
  return ["manifest.json", "ownership.pk", "ownership.vk", "manifest.sig", "manifest-public-key.hex"].every((name) =>
    existsSync(path.join(keysDir, name)),
  );
}

async function runGo(repoRoot, args) {
  try {
    return await execFileAsync("go", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    throw new DeployPreprodError("go_command_failed", redactCommandError(error));
  }
}

async function runNode(repoRoot, args) {
  try {
    return await execFileAsync(process.execPath, args, { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new DeployPreprodError("node_command_failed", redactCommandError(error));
  }
}

async function exportScript(mode, ...args) {
  try {
    const { stdout } = await execFileAsync(
      "cabal",
      ["v2-run", "reclaim-scripts-export", "--", mode, ...args],
      { cwd: CONTRACT_DIR, maxBuffer: 256 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    return {
      type: parsed.type,
      script: parsed.script,
      proofSlotEncoding: parsed.proof_slot_encoding,
      batchTranscript: parsed.batch_transcript,
      verifierVkHash: parsed.verifier_vk_hash,
    };
  } catch (error) {
    throw new DeployPreprodError("script_export_failed", redactCommandError(error));
  }
}

export function reclaimGlobalExportArgs(mode, paramsPolicyId, cardanoVkHex, cardanoVkHash) {
  if (mode !== "global-multi" && mode !== "global-v2") {
    throw new Error(`unsupported reclaim global export mode ${mode}`);
  }
  if (mode === "global-v2") {
    if (!/^[0-9a-f]{64}$/u.test(cardanoVkHash ?? "")) {
      throw new Error("global-v2 requires a 32-byte canonical Cardano verifier-key hash");
    }
    return [mode, paramsPolicyId, PARAMS_TOKEN_NAME, cardanoVkHex, cardanoVkHash];
  }
  return [mode, paramsPolicyId, PARAMS_TOKEN_NAME, cardanoVkHex];
}

function selectSeedUtxo(utxos) {
  const candidates = utxos
    .filter((utxo) => (utxo.assets?.lovelace ?? 0n) > 0n)
    .sort((left, right) => Number((right.assets?.lovelace ?? 0n) - (left.assets?.lovelace ?? 0n)));
  if (candidates.length === 0) {
    throw new DeployPreprodError("seed_utxo_missing", "Deployer wallet needs a spendable Preprod UTxO.");
  }
  return candidates[0];
}

async function waitForTx(lucid, txHash) {
  try {
    await lucid.awaitTx(txHash, 5000);
  } catch {
    await sleep(10000);
  }
}

async function submitDeploymentTxOrRecover({ signed, lucid, txHash }) {
  try {
    return await signed.submit({ canonical: true });
  } catch (error) {
    if (!isAlreadyIncludedSubmitError(error)) {
      throw error;
    }
    console.error(
      JSON.stringify({
        schema: "proof-tool-preprod-deploy-status-v1",
        stage: "submit-recovered",
        txHash,
        reason: "provider_reported_inputs_already_spent",
      }),
    );
    await waitForTx(lucid, txHash);
    return txHash;
  }
}

function isAlreadyIncludedSubmitError(error) {
  const message = typeof error?.message === "string" ? error.message : String(error ?? "");
  return /All inputs are spent|already been included/iu.test(message);
}

async function loadDeploymentOutputs(provider, holderAddress, txHash, expected) {
  let txUtxos = [];
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const utxos = await provider.getUtxos(holderAddress);
    txUtxos = utxos.filter((utxo) => utxo.txHash === txHash);
    if (txUtxos.length >= 3) {
      break;
    }
    await sleep(5000);
  }
  const params = txUtxos.find((utxo) => utxo.assets?.[expected.paramsUnit] === 1n);
  const baseReference = txUtxos.find((utxo) => scriptRefHash(utxo) === expected.baseScriptHash);
  const globalReference = txUtxos.find((utxo) => scriptRefHash(utxo) === expected.globalScriptHash);
  if (!params || !baseReference || !globalReference) {
    throw new DeployPreprodError("deployment_outputs_missing", "Submitted tx did not produce the expected params and reference-script UTxOs.");
  }
  return {
    params: outRef(params, holderAddress),
    baseReference: referenceOutRef(baseReference, expected.baseScriptHash),
    globalReference: referenceOutRef(globalReference, expected.globalScriptHash),
  };
}

function scriptRefHash(utxo) {
  if (!utxo.scriptRef) {
    return "";
  }
  return validatorToScriptHash(utxo.scriptRef).toLowerCase();
}

function outRef(utxo, holderAddress) {
  return {
    tx_hash: utxo.txHash,
    output_index: utxo.outputIndex,
    holder_address: holderAddress,
  };
}

function referenceOutRef(utxo, scriptHash) {
  return {
    tx_hash: utxo.txHash,
    output_index: utxo.outputIndex,
    script_hash: scriptHash,
    holder_address: utxo.address,
  };
}

function minOutputLovelace(protocol, utxo) {
  return calculateMinLovelaceFromUTxO(protocol.coinsPerUtxoByte, {
    txHash: "0".repeat(64),
    outputIndex: 0,
    ...utxo,
  });
}

function protocolKeyDeposit(protocol) {
  return BigInt(protocol.keyDeposit ?? 0n);
}

function sumLovelace(utxos) {
  return utxos.reduce((total, utxo) => total + BigInt(utxo.assets?.lovelace ?? 0n), 0n);
}

function lovelaceToAda(lovelace) {
  return (Number(lovelace) / 1_000_000).toFixed(6);
}

export function assertReclaimGlobalProofSlotEncoding(
  proofSlotEncoding,
  batchTranscript,
  exportedVerifierVkHash,
  expectedVerifierVkHash,
) {
  if (
    proofSlotEncoding !== FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2 ||
    batchTranscript !== "statement-bound-v2" ||
    normalizeBlake2b256(exportedVerifierVkHash) !==
      normalizeBlake2b256(expectedVerifierVkHash)
  ) {
    throw new DeployPreprodError(
      "reclaim_global_proof_slot_encoding",
      "Reclaim global export is missing the statement-bound V2 transcript coherence metadata.",
    );
  }
}

export function buildManifest({
  sourceCommit,
  baseAddress,
  baseScriptHash,
  globalScriptHash,
  globalRewardAddress,
  holderScriptHash,
  paramsPolicyId,
  paramsUnit,
  paramsOutRef,
  referenceBase,
  referenceGlobal,
  destination,
  providerName,
  globalRewardAccountRegistered,
}) {
  return {
    schema: "proof-tool-reclaim-deployment-v1",
    deployment_id: `${NETWORK.toLowerCase()}:${baseScriptHash}:${sourceCommit}`,
    network: NETWORK,
    network_id: NETWORK_ID,
    source_commit: sourceCommit,
    contract_version: "ownership-verifier-0.1.0.0",
    reclaim_base: {
      address: baseAddress,
      script_hash: baseScriptHash,
      required_global_credential: globalScriptHash,
    },
    reclaim_global: {
      script_hash: globalScriptHash,
      rewarding_credential: globalScriptHash,
      params_currency_symbol: paramsPolicyId,
      verifier_vk_hash: destination.vkHash,
      proof_profile: "single-destination",
      proof_slot_encoding: FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2,
      batch_transcript_vk_hash: destination.cardanoVkBlake2b256,
    },
    params_utxo: {
      tx_hash: paramsOutRef.tx_hash,
      output_index: paramsOutRef.output_index,
      policy_id: paramsPolicyId,
      token_name: paramsUnit.slice(56),
      holder_address: paramsOutRef.holder_address,
      datum_reclaim_base_script_hash: baseScriptHash,
    },
    proof: {
      circuit_id: "root-ownership-destination-v2/bls12-381/groth16",
      key_version: "ownership-destination-v2",
      destination_address_encoding: "destination-address-v1",
      vk_hash: destination.vkHash,
      cardano_vk_blake2b256: destination.cardanoVkBlake2b256,
    },
    batching: {
      default_utxo_count: 6,
      optimization_utxo_count: 6,
      hard_max_utxo_count: 7,
      max_tx_cpu_percent: 90,
      max_tx_mem_percent: 80,
      distinct_7_opt_in: {
        request_parameter: "maxUtxos",
        request_value: 7,
        require_explicit_request: true,
        require_measured_execution_units: true,
      },
    },
    provider: {
      primary: providerName === "koios" ? "koios" : "blockfrost",
      fallback: providerName === "koios" ? "blockfrost" : "koios",
    },
    reference_scripts: {
      reclaim_base: referenceBase,
      reclaim_global: referenceGlobal,
    },
    enabled: true,
    preprod_notes: {
      holder_model: "local-preprod-unspendable-params-holder",
      holder_script_hash: holderScriptHash,
      destination_key_provenance: "single-actor local Preprod setup; not an MPC ceremony",
      global_reward_address: globalRewardAddress,
      global_reward_account_registered: globalRewardAccountRegistered,
    },
  };
}

function writeManifest(env, repoRoot, manifest) {
  const manifestPath = resolveManifestPath(env, repoRoot).absolute;
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifestPath;
}

function resolveManifestPath(env, repoRoot) {
  const configured = env.RECLAIM_PREPROD_DEPLOYMENT_MANIFEST_PATH?.trim() || DEFAULT_MANIFEST_PATH;
  const absolute = path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
  return { absolute, relative: path.relative(repoRoot, absolute) };
}

function updateLocalEnv(repoRoot, updates) {
  const envPath = path.join(repoRoot, ".env.local");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/u) : [];
  const pending = new Map(Object.entries(updates));
  const next = [];
  for (const line of existing) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line);
    if (!match || !pending.has(match[1])) {
      next.push(line);
      continue;
    }
    next.push(`${match[1]}=${pending.get(match[1])}`);
    pending.delete(match[1]);
  }
  for (const [key, value] of pending) {
    next.push(`${key}=${value}`);
  }
  while (next.length > 0 && next[next.length - 1] === "") {
    next.pop();
  }
  writeFileSync(envPath, `${next.join("\n")}\n`, { mode: statMode(envPath) ?? 0o600 });
}

function statMode(filePath) {
  try {
    return statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
}

function parseLine(output, key) {
  const line = output
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(`${key}:`));
  if (!line) {
    throw new DeployPreprodError("go_output_malformed", `${key} was not reported by proof-tool.`);
  }
  return line.slice(key.length + 1).trim();
}

function normalizeBlake2b256(value) {
  return value?.startsWith("blake2b256:")
    ? value.slice("blake2b256:".length)
    : value;
}

function redactCommandError(error) {
  const message = error?.message ?? "command failed";
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  return [message, stderr, stdout]
    .join("\n")
    .replace(/(mnemonic|seed|phrase|xprv|private|secret|token)=\S+/giu, "$1=[redacted]")
    .slice(0, 4000);
}

function redactAddress(address) {
  return `${address.slice(0, 10)}...${address.slice(-8)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  try {
    const result = await deployReclaimPreprod();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const code = error?.code ?? "deploy_failed";
    const message = error?.message ?? String(error);
    console.error(`Preprod reclaim deployment failed closed: ${code}: ${message}`);
    if (process.env.RECLAIM_E2E_DEBUG_STACK === "1" && error?.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
