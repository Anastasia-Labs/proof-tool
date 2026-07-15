import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  BrowserProvingDescriptor,
  BrowserProvingTuning,
  ReclaimDeployment,
  ReclaimDistinctSevenOptIn,
  ReclaimGlobalProofSlotEncoding,
  ReclaimNetwork,
  ReclaimReferenceScriptDeployment,
} from "../reclaim/types";

export const RECLAIM_DEPLOYMENT_SCHEMA = "proof-tool-reclaim-deployment-v1";
export const DESTINATION_CIRCUIT_ID = "root-ownership-destination-v2/bls12-381/groth16";
export const DESTINATION_KEY_VERSION = "ownership-destination-v2";
export const DESTINATION_ADDRESS_ENCODING = "destination-address-v1";
export const SINGLE_DESTINATION_PROOF_PROFILE = "single-destination";
export const SAME_AS_PREVIOUS_PROOF_SLOT_ENCODING =
  "bytes-empty-same-as-previous-v1";
export const FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2 =
  "full-proof-plus-public-input-digest-v2";
const DISTINCT_7_REQUEST_PARAMETER = "maxUtxos";
const DISTINCT_7_REQUEST_VALUE = 7;
const DISTINCT_7_DEFAULT_UTXO_COUNT = 6;
const DISTINCT_7_OPTIMIZATION_UTXO_COUNT = 6;
const DISTINCT_7_MAX_TX_CPU_PERCENT = 90;
const DISTINCT_7_MAX_TX_MEM_PERCENT = 80;

type EnvMap = Record<string, string | undefined>;

type ProviderName = "blockfrost" | "koios";

export type ReclaimDeploymentManifest = {
  schema: typeof RECLAIM_DEPLOYMENT_SCHEMA;
  deployment_id: string;
  network: ReclaimNetwork;
  network_id: 0 | 1;
  source_commit: string;
  contract_version: string;
  reclaim_base: {
    address: string;
    script_hash: string;
    required_global_credential: string;
  };
  reclaim_global: {
    script_hash: string;
    rewarding_credential: string;
    params_currency_symbol: string;
    verifier_vk_hash: string;
    proof_profile: typeof SINGLE_DESTINATION_PROOF_PROFILE;
    proof_slot_encoding?: ReclaimGlobalProofSlotEncoding;
    batch_transcript_vk_hash?: string;
  };
  params_utxo: {
    tx_hash: string;
    output_index: number;
    policy_id: string;
    token_name: string;
    holder_address: string;
    datum_reclaim_base_script_hash: string;
  };
  proof: {
    circuit_id: typeof DESTINATION_CIRCUIT_ID;
    key_version: typeof DESTINATION_KEY_VERSION;
    destination_address_encoding: typeof DESTINATION_ADDRESS_ENCODING;
    vk_hash: string;
    cardano_vk_blake2b256: string;
    browser_proving?: BrowserProvingDescriptor;
  };
  batching: {
    default_utxo_count: number;
    optimization_utxo_count: number;
    hard_max_utxo_count: number;
    max_tx_cpu_percent: number;
    max_tx_mem_percent: number;
    distinct_7_opt_in?: ReclaimDistinctSevenOptIn;
  };
  provider: {
    primary: ProviderName;
    fallback: ProviderName;
  };
  reference_scripts?: {
    reclaim_base: ReclaimReferenceScriptDeployment;
    reclaim_global: ReclaimReferenceScriptDeployment;
  };
  enabled?: boolean;
};

export type ManifestValidationError = {
  code: string;
  field: string;
  message: string;
};

export type DeploymentReadiness = {
  funding: boolean;
  claiming: boolean;
  reasons: string[];
};

export type ProviderReadiness = {
  configured: boolean;
  primary: ProviderName | null;
  fallback: ProviderName | null;
  selected: ProviderName | null;
  missing: string[];
};

export type ClaimDeploymentCapabilities = {
  proofProfile: typeof SINGLE_DESTINATION_PROOF_PROFILE;
  batchCaps: ReclaimDeploymentManifest["batching"];
  helperKeyVersion: typeof DESTINATION_KEY_VERSION;
  destinationAddressEncoding: typeof DESTINATION_ADDRESS_ENCODING;
  indexerStatus: "not_configured";
  singleGlobalCompatible: boolean;
  transactionBuild: {
    referenceScriptsConfigured: boolean;
    missing: string[];
  };
  browserProving: BrowserProvingDescriptor | null;
};

export type DeploymentConfigResult =
  | {
      available: true;
      deployment: ReclaimDeployment;
      manifest: ReclaimDeploymentManifest;
      readiness: DeploymentReadiness;
      provider: ProviderReadiness;
      missing: [];
      errors: [];
    }
  | {
      available: false;
      deployment: null;
      manifest: null;
      readiness: DeploymentReadiness;
      provider: ProviderReadiness;
      missing: string[];
      errors: ManifestValidationError[];
    };

export type ClaimDeploymentConfigResult =
  | (Extract<DeploymentConfigResult, { available: true }> & {
      capabilities: ClaimDeploymentCapabilities;
    })
  | (Extract<DeploymentConfigResult, { available: false }> & {
      capabilities: null;
    });

type ManifestLoadOptions = {
  env?: EnvMap;
  cwd?: string;
  manifest?: unknown;
  enforceEnvCoherence?: boolean;
};

const NETWORK_IDS: Record<ReclaimNetwork, 0 | 1> = {
  Mainnet: 1,
  Preprod: 0,
  Preview: 0,
};

const MANIFEST_PATH_ENVS = ["RECLAIM_DEPLOYMENT_MANIFEST_PATH", "RECLAIM_DEPLOYMENT_MANIFEST", "RECLAIM_MANIFEST_PATH"];
const MANIFEST_JSON_ENV = "RECLAIM_DEPLOYMENT_MANIFEST_JSON";

const FLAT_ENV_FIELDS = {
  deploymentId: "RECLAIM_DEPLOYMENT_ID",
  network: "RECLAIM_NETWORK",
  networkId: "RECLAIM_NETWORK_ID",
  sourceCommit: "RECLAIM_SOURCE_COMMIT",
  contractVersion: "RECLAIM_CONTRACT_VERSION",
  reclaimBaseAddress: "RECLAIM_BASE_ADDRESS",
  reclaimBaseScriptHash: "RECLAIM_BASE_SCRIPT_HASH",
  reclaimBaseRequiredGlobalCredential: "RECLAIM_BASE_REQUIRED_GLOBAL_CREDENTIAL",
  reclaimGlobalCredential: "RECLAIM_GLOBAL_CREDENTIAL",
  reclaimGlobalRewardingCredential: "RECLAIM_GLOBAL_REWARDING_CREDENTIAL",
  reclaimGlobalScriptHash: "RECLAIM_GLOBAL_SCRIPT_HASH",
  reclaimGlobalProofSlotEncoding: "RECLAIM_GLOBAL_PROOF_SLOT_ENCODING",
  reclaimGlobalBatchTranscriptVkHash: "RECLAIM_GLOBAL_BATCH_TRANSCRIPT_VK_HASH",
  paramsCurrencySymbol: "RECLAIM_PARAMS_CURRENCY_SYMBOL",
  paramsTokenName: "RECLAIM_PARAMS_TOKEN_NAME",
  paramsUtxoTxHash: "RECLAIM_PARAMS_UTXO_TX_HASH",
  paramsUtxoOutputIndex: "RECLAIM_PARAMS_UTXO_OUTPUT_INDEX",
  paramsPolicyId: "RECLAIM_PARAMS_POLICY_ID",
  paramsHolderAddress: "RECLAIM_PARAMS_HOLDER_ADDRESS",
  paramsDatumReclaimBaseScriptHash: "RECLAIM_PARAMS_DATUM_RECLAIM_BASE_SCRIPT_HASH",
  verifierVkHash: "RECLAIM_VERIFIER_VK_HASH",
  proofVkHash: "RECLAIM_PROOF_VK_HASH",
  proofCardanoVkHash: "RECLAIM_PROOF_CARDANO_VK_BLAKE2B256",
  proofCircuitId: "RECLAIM_PROOF_CIRCUIT_ID",
  proofKeyVersion: "RECLAIM_PROOF_KEY_VERSION",
  destinationAddressEncoding: "RECLAIM_DESTINATION_ADDRESS_ENCODING",
  defaultUtxoCount: "RECLAIM_DEFAULT_UTXO_COUNT",
  optimizationUtxoCount: "RECLAIM_OPTIMIZATION_UTXO_COUNT",
  hardMaxUtxoCount: "RECLAIM_HARD_MAX_UTXO_COUNT",
  maxTxCpuPercent: "RECLAIM_MAX_TX_CPU_PERCENT",
  maxTxMemPercent: "RECLAIM_MAX_TX_MEM_PERCENT",
  distinctSevenRequestParameter: "RECLAIM_DISTINCT_7_REQUEST_PARAMETER",
  distinctSevenRequestValue: "RECLAIM_DISTINCT_7_REQUEST_VALUE",
  distinctSevenRequireExplicitRequest: "RECLAIM_DISTINCT_7_REQUIRE_EXPLICIT_REQUEST",
  distinctSevenRequireMeasuredExecutionUnits: "RECLAIM_DISTINCT_7_REQUIRE_MEASURED_EXECUTION_UNITS",
  provider: "RECLAIM_PROVIDER",
  providerFallback: "RECLAIM_PROVIDER_FALLBACK",
  reclaimBaseReferenceScriptTxHash: "RECLAIM_BASE_REFERENCE_SCRIPT_TX_HASH",
  reclaimBaseReferenceScriptOutputIndex: "RECLAIM_BASE_REFERENCE_SCRIPT_OUTPUT_INDEX",
  reclaimBaseReferenceScriptHash: "RECLAIM_BASE_REFERENCE_SCRIPT_HASH",
  reclaimBaseReferenceScriptHolderAddress: "RECLAIM_BASE_REFERENCE_SCRIPT_HOLDER_ADDRESS",
  reclaimGlobalReferenceScriptTxHash: "RECLAIM_GLOBAL_REFERENCE_SCRIPT_TX_HASH",
  reclaimGlobalReferenceScriptOutputIndex: "RECLAIM_GLOBAL_REFERENCE_SCRIPT_OUTPUT_INDEX",
  reclaimGlobalReferenceScriptHash: "RECLAIM_GLOBAL_REFERENCE_SCRIPT_HASH",
  reclaimGlobalReferenceScriptHolderAddress: "RECLAIM_GLOBAL_REFERENCE_SCRIPT_HOLDER_ADDRESS",
  enabled: "RECLAIM_DEPLOYMENT_ENABLED",
} as const;

const ENV_MATCH_FIELDS: Array<{ env: string; field: string; getValue: (manifest: ReclaimDeploymentManifest) => string }> = [
  { env: FLAT_ENV_FIELDS.deploymentId, field: "deployment_id", getValue: (manifest) => manifest.deployment_id },
  { env: FLAT_ENV_FIELDS.network, field: "network", getValue: (manifest) => manifest.network },
  { env: FLAT_ENV_FIELDS.networkId, field: "network_id", getValue: (manifest) => String(manifest.network_id) },
  { env: FLAT_ENV_FIELDS.sourceCommit, field: "source_commit", getValue: (manifest) => manifest.source_commit },
  { env: FLAT_ENV_FIELDS.contractVersion, field: "contract_version", getValue: (manifest) => manifest.contract_version },
  { env: FLAT_ENV_FIELDS.reclaimBaseAddress, field: "reclaim_base.address", getValue: (manifest) => manifest.reclaim_base.address },
  { env: FLAT_ENV_FIELDS.reclaimBaseScriptHash, field: "reclaim_base.script_hash", getValue: (manifest) => manifest.reclaim_base.script_hash },
  {
    env: FLAT_ENV_FIELDS.reclaimBaseRequiredGlobalCredential,
    field: "reclaim_base.required_global_credential",
    getValue: (manifest) => manifest.reclaim_base.required_global_credential,
  },
  {
    env: FLAT_ENV_FIELDS.reclaimGlobalCredential,
    field: "reclaim_global.rewarding_credential",
    getValue: (manifest) => manifest.reclaim_global.rewarding_credential,
  },
  {
    env: FLAT_ENV_FIELDS.reclaimGlobalRewardingCredential,
    field: "reclaim_global.rewarding_credential",
    getValue: (manifest) => manifest.reclaim_global.rewarding_credential,
  },
  { env: FLAT_ENV_FIELDS.reclaimGlobalScriptHash, field: "reclaim_global.script_hash", getValue: (manifest) => manifest.reclaim_global.script_hash },
  {
    env: FLAT_ENV_FIELDS.reclaimGlobalProofSlotEncoding,
    field: "reclaim_global.proof_slot_encoding",
    getValue: (manifest) => manifest.reclaim_global.proof_slot_encoding ?? "",
  },
  {
    env: FLAT_ENV_FIELDS.reclaimGlobalBatchTranscriptVkHash,
    field: "reclaim_global.batch_transcript_vk_hash",
    getValue: (manifest) => manifest.reclaim_global.batch_transcript_vk_hash ?? "",
  },
  {
    env: FLAT_ENV_FIELDS.paramsCurrencySymbol,
    field: "reclaim_global.params_currency_symbol",
    getValue: (manifest) => manifest.reclaim_global.params_currency_symbol,
  },
  { env: FLAT_ENV_FIELDS.paramsTokenName, field: "params_utxo.token_name", getValue: (manifest) => manifest.params_utxo.token_name },
  { env: FLAT_ENV_FIELDS.paramsUtxoTxHash, field: "params_utxo.tx_hash", getValue: (manifest) => manifest.params_utxo.tx_hash },
  { env: FLAT_ENV_FIELDS.paramsUtxoOutputIndex, field: "params_utxo.output_index", getValue: (manifest) => String(manifest.params_utxo.output_index) },
  { env: FLAT_ENV_FIELDS.paramsPolicyId, field: "params_utxo.policy_id", getValue: (manifest) => manifest.params_utxo.policy_id },
  { env: FLAT_ENV_FIELDS.paramsHolderAddress, field: "params_utxo.holder_address", getValue: (manifest) => manifest.params_utxo.holder_address },
  {
    env: FLAT_ENV_FIELDS.paramsDatumReclaimBaseScriptHash,
    field: "params_utxo.datum_reclaim_base_script_hash",
    getValue: (manifest) => manifest.params_utxo.datum_reclaim_base_script_hash,
  },
  { env: FLAT_ENV_FIELDS.verifierVkHash, field: "reclaim_global.verifier_vk_hash", getValue: (manifest) => manifest.reclaim_global.verifier_vk_hash },
  { env: FLAT_ENV_FIELDS.proofVkHash, field: "proof.vk_hash", getValue: (manifest) => manifest.proof.vk_hash },
  {
    env: FLAT_ENV_FIELDS.proofCardanoVkHash,
    field: "proof.cardano_vk_blake2b256",
    getValue: (manifest) => manifest.proof.cardano_vk_blake2b256,
  },
  { env: FLAT_ENV_FIELDS.proofCircuitId, field: "proof.circuit_id", getValue: (manifest) => manifest.proof.circuit_id },
  { env: FLAT_ENV_FIELDS.proofKeyVersion, field: "proof.key_version", getValue: (manifest) => manifest.proof.key_version },
  {
    env: FLAT_ENV_FIELDS.destinationAddressEncoding,
    field: "proof.destination_address_encoding",
    getValue: (manifest) => manifest.proof.destination_address_encoding,
  },
  { env: FLAT_ENV_FIELDS.defaultUtxoCount, field: "batching.default_utxo_count", getValue: (manifest) => String(manifest.batching.default_utxo_count) },
  {
    env: FLAT_ENV_FIELDS.optimizationUtxoCount,
    field: "batching.optimization_utxo_count",
    getValue: (manifest) => String(manifest.batching.optimization_utxo_count),
  },
  { env: FLAT_ENV_FIELDS.hardMaxUtxoCount, field: "batching.hard_max_utxo_count", getValue: (manifest) => String(manifest.batching.hard_max_utxo_count) },
  { env: FLAT_ENV_FIELDS.maxTxCpuPercent, field: "batching.max_tx_cpu_percent", getValue: (manifest) => String(manifest.batching.max_tx_cpu_percent) },
  { env: FLAT_ENV_FIELDS.maxTxMemPercent, field: "batching.max_tx_mem_percent", getValue: (manifest) => String(manifest.batching.max_tx_mem_percent) },
  {
    env: FLAT_ENV_FIELDS.distinctSevenRequestParameter,
    field: "batching.distinct_7_opt_in.request_parameter",
    getValue: (manifest) => manifest.batching.distinct_7_opt_in?.request_parameter ?? "",
  },
  {
    env: FLAT_ENV_FIELDS.distinctSevenRequestValue,
    field: "batching.distinct_7_opt_in.request_value",
    getValue: (manifest) => String(manifest.batching.distinct_7_opt_in?.request_value ?? ""),
  },
  {
    env: FLAT_ENV_FIELDS.distinctSevenRequireExplicitRequest,
    field: "batching.distinct_7_opt_in.require_explicit_request",
    getValue: (manifest) => String(manifest.batching.distinct_7_opt_in?.require_explicit_request ?? ""),
  },
  {
    env: FLAT_ENV_FIELDS.distinctSevenRequireMeasuredExecutionUnits,
    field: "batching.distinct_7_opt_in.require_measured_execution_units",
    getValue: (manifest) => String(manifest.batching.distinct_7_opt_in?.require_measured_execution_units ?? ""),
  },
  { env: FLAT_ENV_FIELDS.providerFallback, field: "provider.fallback", getValue: (manifest) => manifest.provider.fallback },
  {
    env: FLAT_ENV_FIELDS.reclaimBaseReferenceScriptTxHash,
    field: "reference_scripts.reclaim_base.tx_hash",
    getValue: (manifest) => manifest.reference_scripts?.reclaim_base.tx_hash ?? "",
  },
  {
    env: FLAT_ENV_FIELDS.reclaimBaseReferenceScriptOutputIndex,
    field: "reference_scripts.reclaim_base.output_index",
    getValue: (manifest) => formatOptionalNumber(manifest.reference_scripts?.reclaim_base.output_index),
  },
  {
    env: FLAT_ENV_FIELDS.reclaimBaseReferenceScriptHash,
    field: "reference_scripts.reclaim_base.script_hash",
    getValue: (manifest) => manifest.reference_scripts?.reclaim_base.script_hash ?? "",
  },
  {
    env: FLAT_ENV_FIELDS.reclaimBaseReferenceScriptHolderAddress,
    field: "reference_scripts.reclaim_base.holder_address",
    getValue: (manifest) => manifest.reference_scripts?.reclaim_base.holder_address ?? "",
  },
  {
    env: FLAT_ENV_FIELDS.reclaimGlobalReferenceScriptTxHash,
    field: "reference_scripts.reclaim_global.tx_hash",
    getValue: (manifest) => manifest.reference_scripts?.reclaim_global.tx_hash ?? "",
  },
  {
    env: FLAT_ENV_FIELDS.reclaimGlobalReferenceScriptOutputIndex,
    field: "reference_scripts.reclaim_global.output_index",
    getValue: (manifest) => formatOptionalNumber(manifest.reference_scripts?.reclaim_global.output_index),
  },
  {
    env: FLAT_ENV_FIELDS.reclaimGlobalReferenceScriptHash,
    field: "reference_scripts.reclaim_global.script_hash",
    getValue: (manifest) => manifest.reference_scripts?.reclaim_global.script_hash ?? "",
  },
  {
    env: FLAT_ENV_FIELDS.reclaimGlobalReferenceScriptHolderAddress,
    field: "reference_scripts.reclaim_global.holder_address",
    getValue: (manifest) => manifest.reference_scripts?.reclaim_global.holder_address ?? "",
  },
];

export function loadReclaimDeployment(options: ManifestLoadOptions = {}): DeploymentConfigResult {
  const env = options.env ?? process.env;
  const providerFallback = providerReadiness(null, env);
  const source = options.manifest === undefined
    ? readManifestSource(env, options.cwd ?? process.cwd())
    : { raw: options.manifest, errors: [] };

  if (!source.raw) {
    return disabledResult(source.errors, providerFallback);
  }

  const validation = validateReclaimDeploymentManifest(source.raw);
  if (!validation.available) {
    return disabledResult([...source.errors, ...validation.errors], providerFallback);
  }

  const envErrors = options.enforceEnvCoherence === false
    ? []
    : validateManifestEnvCoherence(validation.manifest, env);
  if (envErrors.length > 0) {
    return disabledResult(envErrors, providerReadiness(validation.manifest, env));
  }

  const provider = providerReadiness(validation.manifest, env);
  return {
    available: true,
    deployment: deploymentFromManifest(validation.manifest),
    manifest: validation.manifest,
    readiness: {
      funding: true,
      claiming: true,
      reasons: [],
    },
    provider,
    missing: [],
    errors: [],
  };
}

export function loadClaimDeployment(options: ManifestLoadOptions = {}): ClaimDeploymentConfigResult {
  const result = loadReclaimDeployment(options);
  if (!result.available) {
    return {
      ...result,
      capabilities: null,
    };
  }

  return {
    ...result,
    capabilities: claimCapabilities(result.manifest),
  };
}

export function validateReclaimDeploymentManifest(raw: unknown):
  | { available: true; manifest: ReclaimDeploymentManifest; errors: [] }
  | { available: false; manifest: null; errors: ManifestValidationError[] } {
  const errors: ManifestValidationError[] = [];
  const root = objectField(raw, "manifest", errors);
  const reclaimBase = objectField(root.reclaim_base, "reclaim_base", errors);
  const reclaimGlobal = objectField(root.reclaim_global, "reclaim_global", errors);
  const paramsUtxo = objectField(root.params_utxo, "params_utxo", errors);
  const proof = objectField(root.proof, "proof", errors);
  const batching = objectField(root.batching, "batching", errors);
  const provider = objectField(root.provider, "provider", errors);
  const referenceScripts = optionalReferenceScriptsField(root.reference_scripts, errors);
  const distinctSevenOptIn = optionalDistinctSevenOptInField(
    batching.distinct_7_opt_in,
    "batching.distinct_7_opt_in",
    errors,
  );

  const schema = stringField(root.schema, "schema", errors);
  const deploymentId = stringField(root.deployment_id, "deployment_id", errors);
  const network = reclaimNetworkField(root.network, "network", errors);
  const networkId = networkIdField(root.network_id, "network_id", errors);
  const sourceCommit = stringField(root.source_commit, "source_commit", errors);
  const contractVersion = stringField(root.contract_version, "contract_version", errors);

  const manifest: ReclaimDeploymentManifest = {
    schema: RECLAIM_DEPLOYMENT_SCHEMA,
    deployment_id: deploymentId,
    network,
    network_id: networkId,
    source_commit: sourceCommit,
    contract_version: contractVersion,
    reclaim_base: {
      address: stringField(reclaimBase.address, "reclaim_base.address", errors),
      script_hash: hexField(reclaimBase.script_hash, "reclaim_base.script_hash", 56, errors),
      required_global_credential: hexField(reclaimBase.required_global_credential, "reclaim_base.required_global_credential", 56, errors),
    },
    reclaim_global: {
      script_hash: hexField(reclaimGlobal.script_hash, "reclaim_global.script_hash", 56, errors),
      rewarding_credential: hexField(reclaimGlobal.rewarding_credential, "reclaim_global.rewarding_credential", 56, errors),
      params_currency_symbol: hexField(reclaimGlobal.params_currency_symbol, "reclaim_global.params_currency_symbol", 56, errors),
      verifier_vk_hash: hashField(reclaimGlobal.verifier_vk_hash, "reclaim_global.verifier_vk_hash", errors),
      proof_profile: literalField(
        reclaimGlobal.proof_profile,
        "reclaim_global.proof_profile",
        SINGLE_DESTINATION_PROOF_PROFILE,
        errors,
      ),
      ...(reclaimGlobal.proof_slot_encoding === undefined
        ? {}
        : {
            proof_slot_encoding: proofSlotEncodingField(
              reclaimGlobal.proof_slot_encoding,
              "reclaim_global.proof_slot_encoding",
              errors,
            ),
          }),
      ...(reclaimGlobal.batch_transcript_vk_hash === undefined
        ? {}
        : {
            batch_transcript_vk_hash: hashField(
              reclaimGlobal.batch_transcript_vk_hash,
              "reclaim_global.batch_transcript_vk_hash",
              errors,
            ),
          }),
    },
    params_utxo: {
      tx_hash: hexField(paramsUtxo.tx_hash, "params_utxo.tx_hash", 64, errors),
      output_index: nonNegativeIntegerField(paramsUtxo.output_index, "params_utxo.output_index", errors),
      policy_id: hexField(paramsUtxo.policy_id, "params_utxo.policy_id", 56, errors),
      token_name: tokenNameField(paramsUtxo.token_name, "params_utxo.token_name", errors),
      holder_address: stringField(paramsUtxo.holder_address, "params_utxo.holder_address", errors),
      datum_reclaim_base_script_hash: hexField(paramsUtxo.datum_reclaim_base_script_hash, "params_utxo.datum_reclaim_base_script_hash", 56, errors),
    },
    proof: {
      circuit_id: literalField(proof.circuit_id, "proof.circuit_id", DESTINATION_CIRCUIT_ID, errors),
      key_version: literalField(proof.key_version, "proof.key_version", DESTINATION_KEY_VERSION, errors),
      destination_address_encoding: literalField(
        proof.destination_address_encoding,
        "proof.destination_address_encoding",
        DESTINATION_ADDRESS_ENCODING,
        errors,
      ),
      vk_hash: hashField(proof.vk_hash, "proof.vk_hash", errors),
      cardano_vk_blake2b256: hashField(proof.cardano_vk_blake2b256, "proof.cardano_vk_blake2b256", errors),
      ...browserProvingFromField(proof.browser_proving, errors),
    },
    batching: {
      default_utxo_count: positiveIntegerField(batching.default_utxo_count, "batching.default_utxo_count", errors),
      optimization_utxo_count: positiveIntegerField(batching.optimization_utxo_count, "batching.optimization_utxo_count", errors),
      hard_max_utxo_count: positiveIntegerField(batching.hard_max_utxo_count, "batching.hard_max_utxo_count", errors),
      max_tx_cpu_percent: percentField(batching.max_tx_cpu_percent, "batching.max_tx_cpu_percent", errors),
      max_tx_mem_percent: percentField(batching.max_tx_mem_percent, "batching.max_tx_mem_percent", errors),
      ...(distinctSevenOptIn ? { distinct_7_opt_in: distinctSevenOptIn } : {}),
    },
    provider: {
      primary: providerField(provider.primary, "provider.primary", errors),
      fallback: providerField(provider.fallback, "provider.fallback", errors),
    },
  };
  if (referenceScripts) {
    manifest.reference_scripts = referenceScripts;
  }

  if (root.enabled !== undefined) {
    if (typeof root.enabled !== "boolean") {
      errors.push({ code: "invalid_type", field: "enabled", message: "enabled must be a boolean when present." });
    } else {
      manifest.enabled = root.enabled;
    }
  }

  if (schema && schema !== RECLAIM_DEPLOYMENT_SCHEMA) {
    errors.push({ code: "unsupported_schema", field: "schema", message: `schema must be ${RECLAIM_DEPLOYMENT_SCHEMA}.` });
  }
  if (network && networkId !== NETWORK_IDS[network]) {
    errors.push({ code: "network_id_mismatch", field: "network_id", message: "network_id does not match network." });
  }
  if (deploymentId && network && manifest.reclaim_base.script_hash && sourceCommit) {
    const expected = `${network.toLowerCase()}:${manifest.reclaim_base.script_hash}:${sourceCommit}`;
    if (deploymentId !== expected) {
      errors.push({ code: "deployment_id_mismatch", field: "deployment_id", message: "deployment_id must bind network, ReclaimBase script hash, and source_commit." });
    }
  }
  const proofSlotEncoding = manifest.reclaim_global.proof_slot_encoding;
  const batchTranscriptVkHash = manifest.reclaim_global.batch_transcript_vk_hash;
  if (proofSlotEncoding === undefined && batchTranscriptVkHash !== undefined) {
    errors.push({
      code: "missing",
      field: "reclaim_global.proof_slot_encoding",
      message: "batch transcript key hash requires a proof-slot encoding.",
    });
  } else if (proofSlotEncoding === FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2) {
    if (!batchTranscriptVkHash) {
      errors.push({
        code: "missing",
        field: "reclaim_global.batch_transcript_vk_hash",
        message: "statement-bound V2 requires the canonical Cardano verifier-key hash.",
      });
    } else if (
      manifest.proof.cardano_vk_blake2b256 &&
      normalizedHash(batchTranscriptVkHash) !==
        normalizedHash(manifest.proof.cardano_vk_blake2b256)
    ) {
      errors.push({
        code: "batch_transcript_vk_hash_mismatch",
        field: "reclaim_global.batch_transcript_vk_hash",
        message: "V2 batch transcript key hash must equal proof.cardano_vk_blake2b256.",
      });
    }
  } else if (batchTranscriptVkHash !== undefined) {
    errors.push({
      code: "unsupported_value",
      field: "reclaim_global.batch_transcript_vk_hash",
      message: "batch transcript key hash is only valid for statement-bound V2.",
    });
  }
  if (sourceCommit && /dirty|uncommitted/iu.test(sourceCommit)) {
    errors.push({ code: "dirty_source_commit", field: "source_commit", message: "source_commit must be a clean tag or commit." });
  }
  if (manifest.reclaim_base.required_global_credential && manifest.reclaim_global.rewarding_credential) {
    if (manifest.reclaim_base.required_global_credential !== manifest.reclaim_global.rewarding_credential) {
      errors.push({
        code: "global_credential_mismatch",
        field: "reclaim_base.required_global_credential",
        message: "ReclaimBase required global credential must equal ReclaimGlobal rewarding credential.",
      });
    }
  }
  if (manifest.reclaim_global.verifier_vk_hash && manifest.proof.vk_hash && manifest.reclaim_global.verifier_vk_hash !== manifest.proof.vk_hash) {
    errors.push({
      code: "verifier_hash_mismatch",
      field: "proof.vk_hash",
      message: "proof.vk_hash must equal reclaim_global.verifier_vk_hash.",
    });
  }
  if (
    manifest.params_utxo.datum_reclaim_base_script_hash &&
    manifest.reclaim_base.script_hash &&
    manifest.params_utxo.datum_reclaim_base_script_hash !== manifest.reclaim_base.script_hash
  ) {
    errors.push({
      code: "params_datum_base_hash_mismatch",
      field: "params_utxo.datum_reclaim_base_script_hash",
      message: "parameter datum ReclaimBase script hash must equal reclaim_base.script_hash.",
    });
  }
  if (manifest.params_utxo.policy_id && manifest.reclaim_global.params_currency_symbol && manifest.params_utxo.policy_id !== manifest.reclaim_global.params_currency_symbol) {
    errors.push({
      code: "params_policy_mismatch",
      field: "params_utxo.policy_id",
      message: "parameter UTxO policy id must equal reclaim_global.params_currency_symbol.",
    });
  }
  if (manifest.reference_scripts?.reclaim_base.script_hash && manifest.reclaim_base.script_hash) {
    if (manifest.reference_scripts.reclaim_base.script_hash !== manifest.reclaim_base.script_hash) {
      errors.push({
        code: "reference_script_hash_mismatch",
        field: "reference_scripts.reclaim_base.script_hash",
        message: "ReclaimBase reference script hash must equal reclaim_base.script_hash.",
      });
    }
  }
  if (manifest.reference_scripts?.reclaim_global.script_hash && manifest.reclaim_global.script_hash) {
    if (manifest.reference_scripts.reclaim_global.script_hash !== manifest.reclaim_global.script_hash) {
      errors.push({
        code: "reference_script_hash_mismatch",
        field: "reference_scripts.reclaim_global.script_hash",
        message: "ReclaimGlobal reference script hash must equal reclaim_global.script_hash.",
      });
    }
  }
  if (manifest.reference_scripts) {
    const paramsOutRef = `${manifest.params_utxo.tx_hash}#${manifest.params_utxo.output_index}`;
    for (const [role, referenceScript] of Object.entries(manifest.reference_scripts)) {
      if (`${referenceScript.tx_hash}#${referenceScript.output_index}` === paramsOutRef) {
        errors.push({
          code: "reference_script_outref_conflict",
          field: `reference_scripts.${role}`,
          message: "reference script UTxOs must be distinct from the parameter reference UTxO.",
        });
      }
    }
  }
  if (
    manifest.batching.default_utxo_count > manifest.batching.optimization_utxo_count ||
    manifest.batching.optimization_utxo_count > manifest.batching.hard_max_utxo_count
  ) {
    errors.push({
      code: "batch_caps_mismatch",
      field: "batching",
      message: "batching counts must satisfy default <= optimization <= hard max.",
    });
  }
  if (proofSlotEncoding === FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2) {
    if (manifest.batching.hard_max_utxo_count > DISTINCT_7_REQUEST_VALUE) {
      errors.push({
        code: "batch_hard_max_exceeds_policy",
        field: "batching.hard_max_utxo_count",
        message: "statement-bound V2 hard_max_utxo_count must not exceed the explicit seven-slot capacity policy.",
      });
    }
    if (!manifest.batching.distinct_7_opt_in) {
      errors.push({
        code: "distinct_7_opt_in_required",
        field: "batching.distinct_7_opt_in",
        message: "statement-bound V2 requires explicit seven-slot opt-in metadata.",
      });
    }
    requireDistinctSevenCapacityValue(
      manifest.batching.default_utxo_count,
      DISTINCT_7_DEFAULT_UTXO_COUNT,
      "batching.default_utxo_count",
      errors,
    );
    requireDistinctSevenCapacityValue(
      manifest.batching.optimization_utxo_count,
      DISTINCT_7_OPTIMIZATION_UTXO_COUNT,
      "batching.optimization_utxo_count",
      errors,
    );
    requireDistinctSevenCapacityValue(
      manifest.batching.hard_max_utxo_count,
      DISTINCT_7_REQUEST_VALUE,
      "batching.hard_max_utxo_count",
      errors,
    );
    requireDistinctSevenCapacityValue(
      manifest.batching.max_tx_cpu_percent,
      DISTINCT_7_MAX_TX_CPU_PERCENT,
      "batching.max_tx_cpu_percent",
      errors,
    );
    requireDistinctSevenCapacityValue(
      manifest.batching.max_tx_mem_percent,
      DISTINCT_7_MAX_TX_MEM_PERCENT,
      "batching.max_tx_mem_percent",
      errors,
    );
  } else if (manifest.batching.distinct_7_opt_in) {
    errors.push({
      code: "distinct_7_opt_in_requires_v2",
      field: "batching.distinct_7_opt_in",
      message: "explicit seven-slot opt-in metadata is only valid for statement-bound V2.",
    });
  }
  if (manifest.enabled === false) {
    errors.push({ code: "deployment_disabled", field: "enabled", message: "deployment manifest is explicitly disabled." });
  }

  if (errors.length > 0) {
    return {
      available: false,
      manifest: null,
      errors,
    };
  }

  return {
    available: true,
    manifest,
    errors: [],
  };
}

export function deploymentFromManifest(manifest: ReclaimDeploymentManifest): ReclaimDeployment {
  return {
    id: manifest.deployment_id,
    network: manifest.network,
    networkId: manifest.network_id,
    reclaimBaseAddress: manifest.reclaim_base.address,
    reclaimBaseScriptHash: manifest.reclaim_base.script_hash,
    reclaimGlobalCredential: manifest.reclaim_base.required_global_credential,
    reclaimGlobalScriptHash: manifest.reclaim_global.script_hash,
    reclaimGlobalProofSlotEncoding: manifest.reclaim_global.proof_slot_encoding,
    reclaimGlobalBatchTranscriptVkHash: manifest.reclaim_global.batch_transcript_vk_hash,
    paramsCurrencySymbol: manifest.reclaim_global.params_currency_symbol,
    paramsTokenName: manifest.params_utxo.token_name,
    verifierVkHash: manifest.reclaim_global.verifier_vk_hash,
    contractVersion: manifest.contract_version,
    sourceCommit: manifest.source_commit,
    reclaimGlobalRewardingCredential: manifest.reclaim_global.rewarding_credential,
    paramsUtxo: manifest.params_utxo,
    proof: manifest.proof,
    batching: manifest.batching,
    provider: manifest.provider,
    referenceScripts: manifest.reference_scripts
      ? {
          reclaimBase: manifest.reference_scripts.reclaim_base,
          reclaimGlobal: manifest.reference_scripts.reclaim_global,
        }
      : undefined,
  };
}

function readManifestSource(env: EnvMap, cwd: string): { raw: unknown | null; errors: ManifestValidationError[] } {
  const json = envValue(env, MANIFEST_JSON_ENV);
  if (json) {
    try {
      return { raw: JSON.parse(json) as unknown, errors: [] };
    } catch {
      return {
        raw: null,
        errors: [{ code: "manifest_json_malformed", field: MANIFEST_JSON_ENV, message: "deployment manifest JSON is malformed." }],
      };
    }
  }

  const manifestPath = firstEnvValue(env, MANIFEST_PATH_ENVS);
  if (manifestPath) {
    const resolved = resolveManifestPath(manifestPath, cwd);
    if (!resolved) {
      return {
        raw: null,
        errors: [{ code: "manifest_missing", field: "manifest_path", message: "deployment manifest file was not found." }],
      };
    }
    try {
      return { raw: JSON.parse(readFileSync(resolved, "utf8")) as unknown, errors: [] };
    } catch {
      return {
        raw: null,
        errors: [{ code: "manifest_file_malformed", field: "manifest_path", message: "deployment manifest file is malformed JSON." }],
      };
    }
  }

  if (hasFlatDeploymentEnv(env)) {
    return { raw: manifestFromEnv(env), errors: [] };
  }

  return {
    raw: null,
    errors: [
      {
        code: "manifest_missing",
        field: "manifest",
        message: "deployment manifest path, manifest JSON, or complete RECLAIM_* deployment env values are required.",
      },
    ],
  };
}

function manifestFromEnv(env: EnvMap): Record<string, unknown> {
  const network = envValue(env, FLAT_ENV_FIELDS.network);
  const baseScriptHash = envValue(env, FLAT_ENV_FIELDS.reclaimBaseScriptHash);
  const sourceCommit = envValue(env, FLAT_ENV_FIELDS.sourceCommit);
  const globalCredential =
    envValue(env, FLAT_ENV_FIELDS.reclaimGlobalCredential) ||
    envValue(env, FLAT_ENV_FIELDS.reclaimGlobalRewardingCredential) ||
    envValue(env, FLAT_ENV_FIELDS.reclaimBaseRequiredGlobalCredential);
  const paramsCurrencySymbol = envValue(env, FLAT_ENV_FIELDS.paramsCurrencySymbol);
  const verifierVkHash = envValue(env, FLAT_ENV_FIELDS.verifierVkHash) || envValue(env, FLAT_ENV_FIELDS.proofVkHash);
  const proofSlotEncoding = envValue(env, FLAT_ENV_FIELDS.reclaimGlobalProofSlotEncoding);
  const batchTranscriptVkHash = envValue(env, FLAT_ENV_FIELDS.reclaimGlobalBatchTranscriptVkHash);
  const distinctSevenOptIn = distinctSevenOptInFromEnv(env);
  const deploymentId = envValue(env, FLAT_ENV_FIELDS.deploymentId) || [network.toLowerCase(), baseScriptHash, sourceCommit].filter(Boolean).join(":");

  return {
    schema: RECLAIM_DEPLOYMENT_SCHEMA,
    deployment_id: deploymentId,
    network,
    network_id: parseEnvInteger(env, FLAT_ENV_FIELDS.networkId) ?? (isReclaimNetwork(network) ? NETWORK_IDS[network] : undefined),
    source_commit: sourceCommit,
    contract_version: envValue(env, FLAT_ENV_FIELDS.contractVersion),
    reclaim_base: {
      address: envValue(env, FLAT_ENV_FIELDS.reclaimBaseAddress),
      script_hash: baseScriptHash,
      required_global_credential: envValue(env, FLAT_ENV_FIELDS.reclaimBaseRequiredGlobalCredential) || globalCredential,
    },
    reclaim_global: {
      script_hash: envValue(env, FLAT_ENV_FIELDS.reclaimGlobalScriptHash),
      rewarding_credential: envValue(env, FLAT_ENV_FIELDS.reclaimGlobalRewardingCredential) || globalCredential,
      params_currency_symbol: paramsCurrencySymbol,
      verifier_vk_hash: verifierVkHash,
      proof_profile: SINGLE_DESTINATION_PROOF_PROFILE,
      ...(proofSlotEncoding ? { proof_slot_encoding: proofSlotEncoding } : {}),
      ...(batchTranscriptVkHash ? { batch_transcript_vk_hash: batchTranscriptVkHash } : {}),
    },
    params_utxo: {
      tx_hash: envValue(env, FLAT_ENV_FIELDS.paramsUtxoTxHash),
      output_index: parseEnvInteger(env, FLAT_ENV_FIELDS.paramsUtxoOutputIndex),
      policy_id: envValue(env, FLAT_ENV_FIELDS.paramsPolicyId) || paramsCurrencySymbol,
      token_name: envValue(env, FLAT_ENV_FIELDS.paramsTokenName),
      holder_address: envValue(env, FLAT_ENV_FIELDS.paramsHolderAddress),
      datum_reclaim_base_script_hash: envValue(env, FLAT_ENV_FIELDS.paramsDatumReclaimBaseScriptHash) || baseScriptHash,
    },
    proof: {
      circuit_id: envValue(env, FLAT_ENV_FIELDS.proofCircuitId) || DESTINATION_CIRCUIT_ID,
      key_version: envValue(env, FLAT_ENV_FIELDS.proofKeyVersion) || DESTINATION_KEY_VERSION,
      destination_address_encoding: envValue(env, FLAT_ENV_FIELDS.destinationAddressEncoding) || DESTINATION_ADDRESS_ENCODING,
      vk_hash: envValue(env, FLAT_ENV_FIELDS.proofVkHash) || verifierVkHash,
      cardano_vk_blake2b256: envValue(env, FLAT_ENV_FIELDS.proofCardanoVkHash),
    },
    batching: {
      default_utxo_count: parseEnvInteger(env, FLAT_ENV_FIELDS.defaultUtxoCount) ?? 4,
      optimization_utxo_count: parseEnvInteger(env, FLAT_ENV_FIELDS.optimizationUtxoCount) ?? 5,
      hard_max_utxo_count: parseEnvInteger(env, FLAT_ENV_FIELDS.hardMaxUtxoCount) ?? 5,
      max_tx_cpu_percent: parseEnvInteger(env, FLAT_ENV_FIELDS.maxTxCpuPercent) ?? 80,
      max_tx_mem_percent: parseEnvInteger(env, FLAT_ENV_FIELDS.maxTxMemPercent) ?? 80,
      ...(distinctSevenOptIn ? { distinct_7_opt_in: distinctSevenOptIn } : {}),
    },
    provider: {
      primary: normalizedProvider(envValue(env, FLAT_ENV_FIELDS.provider)) || "koios",
      fallback: normalizedProvider(envValue(env, FLAT_ENV_FIELDS.providerFallback)) || "blockfrost",
    },
    reference_scripts: manifestReferenceScriptsFromEnv(env),
    enabled: parseEnabled(envValue(env, FLAT_ENV_FIELDS.enabled)),
  };
}

function distinctSevenOptInFromEnv(env: EnvMap): Record<string, unknown> | undefined {
  const values = [
    envValue(env, FLAT_ENV_FIELDS.distinctSevenRequestParameter),
    envValue(env, FLAT_ENV_FIELDS.distinctSevenRequestValue),
    envValue(env, FLAT_ENV_FIELDS.distinctSevenRequireExplicitRequest),
    envValue(env, FLAT_ENV_FIELDS.distinctSevenRequireMeasuredExecutionUnits),
  ];
  if (!values.some(Boolean)) {
    return undefined;
  }
  return {
    request_parameter: values[0],
    request_value: parseEnvInteger(env, FLAT_ENV_FIELDS.distinctSevenRequestValue),
    require_explicit_request: parseEnabled(values[2]),
    require_measured_execution_units: parseEnabled(values[3]),
  };
}

function manifestReferenceScriptsFromEnv(env: EnvMap): Record<string, unknown> | undefined {
  const baseTxHash = envValue(env, FLAT_ENV_FIELDS.reclaimBaseReferenceScriptTxHash);
  const baseOutputIndex = parseEnvInteger(env, FLAT_ENV_FIELDS.reclaimBaseReferenceScriptOutputIndex);
  const baseScriptHash = envValue(env, FLAT_ENV_FIELDS.reclaimBaseReferenceScriptHash);
  const globalTxHash = envValue(env, FLAT_ENV_FIELDS.reclaimGlobalReferenceScriptTxHash);
  const globalOutputIndex = parseEnvInteger(env, FLAT_ENV_FIELDS.reclaimGlobalReferenceScriptOutputIndex);
  const globalScriptHash = envValue(env, FLAT_ENV_FIELDS.reclaimGlobalReferenceScriptHash);
  const hasAnyReferenceScriptEnv = [
    baseTxHash,
    baseScriptHash,
    envValue(env, FLAT_ENV_FIELDS.reclaimBaseReferenceScriptOutputIndex),
    envValue(env, FLAT_ENV_FIELDS.reclaimBaseReferenceScriptHolderAddress),
    globalTxHash,
    globalScriptHash,
    envValue(env, FLAT_ENV_FIELDS.reclaimGlobalReferenceScriptOutputIndex),
    envValue(env, FLAT_ENV_FIELDS.reclaimGlobalReferenceScriptHolderAddress),
  ].some(Boolean);
  if (!hasAnyReferenceScriptEnv) {
    return undefined;
  }

  return {
    reclaim_base: {
      tx_hash: baseTxHash,
      output_index: baseOutputIndex,
      script_hash: baseScriptHash,
      holder_address: envValue(env, FLAT_ENV_FIELDS.reclaimBaseReferenceScriptHolderAddress),
    },
    reclaim_global: {
      tx_hash: globalTxHash,
      output_index: globalOutputIndex,
      script_hash: globalScriptHash,
      holder_address: envValue(env, FLAT_ENV_FIELDS.reclaimGlobalReferenceScriptHolderAddress),
    },
  };
}

function validateManifestEnvCoherence(manifest: ReclaimDeploymentManifest, env: EnvMap): ManifestValidationError[] {
  const errors: ManifestValidationError[] = [];
  for (const check of ENV_MATCH_FIELDS) {
    const value = envValue(env, check.env);
    if (!value) {
      continue;
    }
    if (value !== check.getValue(manifest)) {
      errors.push({
        code: "env_manifest_mismatch",
        field: check.env,
        message: `${check.env} does not match manifest field ${check.field}.`,
      });
    }
  }

  const provider = normalizedProvider(envValue(env, FLAT_ENV_FIELDS.provider));
  if (provider && provider !== manifest.provider.primary && provider !== manifest.provider.fallback) {
    errors.push({
      code: "env_manifest_mismatch",
      field: FLAT_ENV_FIELDS.provider,
      message: "RECLAIM_PROVIDER must match the manifest primary or fallback provider.",
    });
  }

  return errors;
}

function disabledResult(errors: ManifestValidationError[], provider: ProviderReadiness): DeploymentConfigResult {
  return {
    available: false,
    deployment: null,
    manifest: null,
    readiness: {
      funding: false,
      claiming: false,
      reasons: unique(errors.map((error) => error.code)),
    },
    provider,
    missing: unique(errors.filter((error) => error.code === "missing" || error.code === "manifest_missing").map((error) => error.field)),
    errors,
  };
}

function providerReadiness(manifest: ReclaimDeploymentManifest | null, env: EnvMap): ProviderReadiness {
  const configuredPrimary = manifest?.provider.primary ?? null;
  const configuredFallback = manifest?.provider.fallback ?? null;
  const selected = normalizedProvider(envValue(env, FLAT_ENV_FIELDS.provider)) ?? configuredPrimary ?? "koios";
  const missing: string[] = [];

  if (selected === "blockfrost" && !envValue(env, "RECLAIM_BLOCKFROST_PROJECT_ID") && !envValue(env, "BLOCKFROST_PROJECT_ID")) {
    missing.push("RECLAIM_BLOCKFROST_PROJECT_ID");
  }

  return {
    configured: missing.length === 0,
    primary: configuredPrimary,
    fallback: configuredFallback,
    selected,
    missing,
  };
}

function claimCapabilities(manifest: ReclaimDeploymentManifest): ClaimDeploymentCapabilities {
  return {
    proofProfile: manifest.reclaim_global.proof_profile,
    batchCaps: manifest.batching,
    helperKeyVersion: manifest.proof.key_version,
    destinationAddressEncoding: manifest.proof.destination_address_encoding,
    indexerStatus: "not_configured",
    singleGlobalCompatible: manifest.reclaim_base.required_global_credential === manifest.reclaim_global.rewarding_credential,
    transactionBuild: {
      referenceScriptsConfigured: Boolean(manifest.reference_scripts),
      missing: manifest.reference_scripts ? [] : ["reference_scripts.reclaim_base", "reference_scripts.reclaim_global"],
    },
    browserProving: manifest.proof.browser_proving ?? null,
  };
}

const BROWSER_PROVING_SAME_ORIGIN_URLS = [
  "runtime_base_url",
  "runtime_manifest_url",
  "prover_worker_js_url",
  "wasm_exec_js_url",
  "proof_wasm_url",
  "worker_js_url",
  "msm_worker_wasm_url",
] as const;

const BROWSER_PROVING_ASSET_URLS = [
  "manifest_url",
  "manifest_sig_url",
  "chunk_manifest_url",
  "chunk_manifest_sig_url",
  "deployment_manifest_url",
  "vk_url",
  "pk_url",
  "pk_index_url",
  "ccs_url",
] as const;

function browserProvingFromField(
  value: unknown,
  errors: ManifestValidationError[],
): { browser_proving: BrowserProvingDescriptor } | Record<never, never> {
  if (value === undefined) {
    return {};
  }
  const field = "proof.browser_proving";
  const root = objectField(value, field, errors);

  if (typeof root.enabled !== "boolean") {
    errors.push({ code: "invalid_type", field: `${field}.enabled`, message: `${field}.enabled must be a boolean.` });
  }

  const descriptor: BrowserProvingDescriptor = {
    enabled: root.enabled === true,
    runtime_base_url: "",
    runtime_manifest_url: "",
    prover_worker_js_url: "",
    wasm_exec_js_url: "",
    manifest_url: "",
    manifest_sig_url: "",
    manifest_public_key_hex: hexField(root.manifest_public_key_hex, `${field}.manifest_public_key_hex`, 64, errors),
    chunk_manifest_url: "",
    chunk_manifest_sig_url: "",
    chunk_manifest_public_key_hex: hexField(root.chunk_manifest_public_key_hex, `${field}.chunk_manifest_public_key_hex`, 64, errors),
    deployment_manifest_url: "",
    vk_url: "",
    pk_url: "",
    pk_index_url: "",
    ccs_url: "",
    ccs_blake2b256: hashField(root.ccs_blake2b256, `${field}.ccs_blake2b256`, errors),
    proof_wasm_url: "",
    worker_js_url: "",
    msm_worker_wasm_url: "",
  };

  for (const key of BROWSER_PROVING_SAME_ORIGIN_URLS) {
    const url = stringField(root[key], `${field}.${key}`, errors);
    if (url && !url.startsWith("/")) {
      errors.push({
        code: "browser_proving_url_not_same_origin",
        field: `${field}.${key}`,
        message: `${field}.${key} must be a same-origin path starting with /.`,
      });
    }
    descriptor[key] = url;
  }
  for (const key of BROWSER_PROVING_ASSET_URLS) {
    const url = stringField(root[key], `${field}.${key}`, errors);
    if (url && !url.startsWith("/") && !/^https?:\/\//u.test(url)) {
      errors.push({
        code: "browser_proving_url_malformed",
        field: `${field}.${key}`,
        message: `${field}.${key} must be a same-origin path or an absolute http(s) URL.`,
      });
    }
    descriptor[key] = url;
  }

  const tuning = browserProvingTuningField(root.tuning, `${field}.tuning`, errors);
  if (tuning) {
    descriptor.tuning = tuning;
  }
  return { browser_proving: descriptor };
}

function browserProvingTuningField(
  value: unknown,
  field: string,
  errors: ManifestValidationError[],
): BrowserProvingTuning | undefined {
  if (value === undefined) {
    return undefined;
  }
  const root = objectField(value, field, errors);
  const tuning: BrowserProvingTuning = {};
  for (const key of ["worker_count", "shard_count", "shard_multiplier", "range_fetch_concurrency", "chunk_prefetch_window", "gogc"] as const) {
    if (root[key] === undefined) {
      continue;
    }
    tuning[key] = positiveIntegerField(root[key], `${field}.${key}`, errors);
  }
  // chunk_readahead admits 0: it is the documented off switch for the
  // default-on readahead, and the manifest is the only remote tuning channel.
  if (root.chunk_readahead !== undefined) {
    const value = root.chunk_readahead;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      errors.push({
        code: "invalid_type",
        field: field + ".chunk_readahead",
        message: field + ".chunk_readahead must be a non-negative integer.",
      });
    } else {
      tuning.chunk_readahead = value;
    }
  }
  if (
    tuning.chunk_prefetch_window !== undefined &&
    tuning.chunk_prefetch_window > 4
  ) {
    errors.push({
      code: "invalid_value",
      field: field + ".chunk_prefetch_window",
      message: field + ".chunk_prefetch_window must be at most 4.",
    });
  }
  if (tuning.chunk_readahead !== undefined && tuning.chunk_readahead > 4) {
    errors.push({
      code: "invalid_value",
      field: field + ".chunk_readahead",
      message: field + ".chunk_readahead must be at most 4.",
    });
  }
  if (root.pinned_decode !== undefined) {
    if (typeof root.pinned_decode !== "boolean") {
      errors.push({ code: "invalid_type", field: `${field}.pinned_decode`, message: `${field}.pinned_decode must be a boolean.` });
    } else {
      tuning.pinned_decode = root.pinned_decode;
    }
  }
  // The opt_w* switches are part of BrowserProvingTuning and the deployment
  // manifest is the only remote tuning channel; without parsing them here a
  // default-on optimization (e.g. opt_w8) could not be disabled without a
  // webapp redeploy.
  for (const key of ["opt_w1", "opt_w2", "opt_w3", "opt_w5", "opt_w6", "opt_w7", "opt_w8"] as const) {
    if (root[key] === undefined) {
      continue;
    }
    if (typeof root[key] !== "boolean") {
      errors.push({ code: "invalid_type", field: `${field}.${key}`, message: `${field}.${key} must be a boolean.` });
    } else {
      tuning[key] = root[key];
    }
  }
  if (root.gomemlimit !== undefined) {
    const gomemlimit = stringField(root.gomemlimit, `${field}.gomemlimit`, errors);
    if (gomemlimit && !/^\d+(?:[KMGT]i?B)?$/u.test(gomemlimit)) {
      errors.push({ code: "invalid_type", field: `${field}.gomemlimit`, message: `${field}.gomemlimit must be a Go memory limit like 3000MiB.` });
    } else if (gomemlimit) {
      tuning.gomemlimit = gomemlimit;
    }
  }
  return tuning;
}

function optionalReferenceScriptsField(
  value: unknown,
  errors: ManifestValidationError[],
): ReclaimDeploymentManifest["reference_scripts"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const root = objectField(value, "reference_scripts", errors);
  const reclaimBase = objectField(root.reclaim_base, "reference_scripts.reclaim_base", errors);
  const reclaimGlobal = objectField(root.reclaim_global, "reference_scripts.reclaim_global", errors);
  return {
    reclaim_base: referenceScriptField(reclaimBase, "reference_scripts.reclaim_base", errors),
    reclaim_global: referenceScriptField(reclaimGlobal, "reference_scripts.reclaim_global", errors),
  };
}

function referenceScriptField(
  value: Record<string, unknown>,
  field: string,
  errors: ManifestValidationError[],
): ReclaimReferenceScriptDeployment {
  const holderAddress = optionalStringField(value.holder_address, `${field}.holder_address`, errors);
  return {
    tx_hash: hexField(value.tx_hash, `${field}.tx_hash`, 64, errors),
    output_index: nonNegativeIntegerField(value.output_index, `${field}.output_index`, errors),
    script_hash: hexField(value.script_hash, `${field}.script_hash`, 56, errors),
    ...(holderAddress ? { holder_address: holderAddress } : {}),
  };
}

function optionalDistinctSevenOptInField(
  value: unknown,
  field: string,
  errors: ManifestValidationError[],
): ReclaimDistinctSevenOptIn | undefined {
  if (value === undefined) {
    return undefined;
  }
  const root = objectField(value, field, errors);
  const allowedFields = new Set([
    "request_parameter",
    "request_value",
    "require_explicit_request",
    "require_measured_execution_units",
  ]);
  for (const key of Object.keys(root)) {
    if (!allowedFields.has(key)) {
      errors.push({
        code: "unsupported_field",
        field: `${field}.${key}`,
        message: `${field}.${key} is not part of the explicit seven-slot opt-in policy.`,
      });
    }
  }
  return {
    request_parameter: literalField(
      root.request_parameter,
      `${field}.request_parameter`,
      DISTINCT_7_REQUEST_PARAMETER,
      errors,
    ),
    request_value: literalIntegerField(
      root.request_value,
      `${field}.request_value`,
      DISTINCT_7_REQUEST_VALUE,
      errors,
    ),
    require_explicit_request: literalBooleanField(
      root.require_explicit_request,
      `${field}.require_explicit_request`,
      true,
      errors,
    ),
    require_measured_execution_units: literalBooleanField(
      root.require_measured_execution_units,
      `${field}.require_measured_execution_units`,
      true,
      errors,
    ),
  };
}

function requireDistinctSevenCapacityValue(
  actual: number,
  expected: number,
  field: string,
  errors: ManifestValidationError[],
): void {
  if (actual !== expected) {
    errors.push({
      code: "distinct_7_capacity_policy_mismatch",
      field,
      message: `${field} must be ${expected} for the explicit seven-slot capacity policy.`,
    });
  }
}

function objectField(value: unknown, field: string, errors: ManifestValidationError[]): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  errors.push({ code: value === undefined ? "missing" : "invalid_type", field, message: `${field} must be an object.` });
  return {};
}

function stringField(value: unknown, field: string, errors: ManifestValidationError[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ code: value === undefined ? "missing" : "invalid_type", field, message: `${field} must be a non-empty string.` });
    return "";
  }
  return value.trim();
}

function optionalStringField(value: unknown, field: string, errors: ManifestValidationError[]): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return stringField(value, field, errors);
}

function reclaimNetworkField(value: unknown, field: string, errors: ManifestValidationError[]): ReclaimNetwork {
  const network = stringField(value, field, errors);
  if (!isReclaimNetwork(network)) {
    errors.push({ code: "unsupported_network", field, message: "network must be Mainnet, Preprod, or Preview." });
    return "Preprod";
  }
  return network;
}

function networkIdField(value: unknown, field: string, errors: ManifestValidationError[]): 0 | 1 {
  if (value !== 0 && value !== 1) {
    errors.push({ code: value === undefined ? "missing" : "invalid_type", field, message: "network_id must be 0 or 1." });
    return 0;
  }
  return value;
}

function providerField(value: unknown, field: string, errors: ManifestValidationError[]): ProviderName {
  const provider = stringField(value, field, errors).toLowerCase();
  if (provider !== "blockfrost" && provider !== "koios") {
    errors.push({ code: "unsupported_provider", field, message: `${field} must be blockfrost or koios.` });
    return "koios";
  }
  return provider;
}

function literalField<const T extends string>(value: unknown, field: string, expected: T, errors: ManifestValidationError[]): T {
  const actual = stringField(value, field, errors);
  if (actual && actual !== expected) {
    errors.push({ code: "unsupported_value", field, message: `${field} must be ${expected}.` });
  }
  return expected;
}

function literalIntegerField<const T extends number>(value: unknown, field: string, expected: T, errors: ManifestValidationError[]): T {
  if (!Number.isInteger(value)) {
    errors.push({
      code: value === undefined ? "missing" : "invalid_type",
      field,
      message: `${field} must be the integer ${expected}.`,
    });
  } else if (value !== expected) {
    errors.push({ code: "unsupported_value", field, message: `${field} must be ${expected}.` });
  }
  return expected;
}

function literalBooleanField<const T extends boolean>(value: unknown, field: string, expected: T, errors: ManifestValidationError[]): T {
  if (typeof value !== "boolean") {
    errors.push({
      code: value === undefined ? "missing" : "invalid_type",
      field,
      message: `${field} must be ${expected}.`,
    });
  } else if (value !== expected) {
    errors.push({ code: "unsupported_value", field, message: `${field} must be ${expected}.` });
  }
  return expected;
}

function proofSlotEncodingField(
  value: unknown,
  field: string,
  errors: ManifestValidationError[],
): ReclaimGlobalProofSlotEncoding {
  const encoding = stringField(value, field, errors);
  if (
    encoding !== SAME_AS_PREVIOUS_PROOF_SLOT_ENCODING &&
    encoding !== FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2
  ) {
    errors.push({
      code: "unsupported_value",
      field,
      message:
        field +
        " must be " +
        SAME_AS_PREVIOUS_PROOF_SLOT_ENCODING +
        " or " +
        FULL_PROOF_PLUS_PUBLIC_INPUT_DIGEST_V2 +
        ".",
    });
  }
  return encoding as ReclaimGlobalProofSlotEncoding;
}

function hexField(value: unknown, field: string, length: number, errors: ManifestValidationError[]): string {
  const hex = stringField(value, field, errors).toLowerCase();
  if (hex && (!/^[0-9a-f]+$/u.test(hex) || hex.length !== length)) {
    errors.push({ code: "malformed_hex", field, message: `${field} must be ${length} lowercase hex characters.` });
  }
  return hex;
}

function hashField(value: unknown, field: string, errors: ManifestValidationError[]): string {
  const hash = stringField(value, field, errors);
  const digest = hash.startsWith("blake2b256:") ? hash.slice("blake2b256:".length) : hash;
  if (digest && (!/^[0-9a-f]+$/u.test(digest) || digest.length !== 64)) {
    errors.push({ code: "malformed_hash", field, message: `${field} must be a 32-byte hex digest, optionally prefixed with blake2b256:.` });
  }
  return hash;
}

function normalizedHash(value: string): string {
  return value.startsWith("blake2b256:") ? value.slice("blake2b256:".length) : value;
}

function tokenNameField(value: unknown, field: string, errors: ManifestValidationError[]): string {
  if (typeof value !== "string") {
    errors.push({ code: value === undefined ? "missing" : "invalid_type", field, message: `${field} must be token-name hex.` });
    return "";
  }
  const tokenName = value.trim().toLowerCase();
  if (!/^[0-9a-f]*$/u.test(tokenName) || tokenName.length % 2 !== 0 || tokenName.length > 64) {
    errors.push({ code: "malformed_hex", field, message: `${field} must be even-length hex up to 32 bytes.` });
  }
  return tokenName;
}

function nonNegativeIntegerField(value: unknown, field: string, errors: ManifestValidationError[]): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    errors.push({ code: value === undefined ? "missing" : "invalid_type", field, message: `${field} must be a non-negative integer.` });
    return 0;
  }
  return Number(value);
}

function positiveIntegerField(value: unknown, field: string, errors: ManifestValidationError[]): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    errors.push({ code: value === undefined ? "missing" : "invalid_type", field, message: `${field} must be a positive integer.` });
    return 1;
  }
  return Number(value);
}

function percentField(value: unknown, field: string, errors: ManifestValidationError[]): number {
  const percent = positiveIntegerField(value, field, errors);
  if (percent > 100) {
    errors.push({ code: "invalid_percent", field, message: `${field} must be between 1 and 100.` });
  }
  return percent;
}

function resolveManifestPath(manifestPath: string, cwd: string): string | null {
  if (path.isAbsolute(manifestPath)) {
    return existsSync(manifestPath) ? manifestPath : null;
  }

  let current = cwd;
  while (true) {
    const candidate = path.join(current, manifestPath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function hasFlatDeploymentEnv(env: EnvMap): boolean {
  return Object.values(FLAT_ENV_FIELDS).some((name) => Boolean(envValue(env, name)));
}

function parseEnvInteger(env: EnvMap, name: string): number | undefined {
  const value = envValue(env, name);
  if (!value || !/^\d+$/u.test(value)) {
    return undefined;
  }
  return Number(value);
}

function parseEnabled(value: string): boolean | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  return undefined;
}

function normalizedProvider(value: string): ProviderName | null {
  const provider = value.toLowerCase();
  if (provider === "blockfrost" || provider === "koios") {
    return provider;
  }
  return null;
}

function firstEnvValue(env: EnvMap, names: string[]): string {
  for (const name of names) {
    const value = envValue(env, name);
    if (value) {
      return value;
    }
  }
  return "";
}

function envValue(env: EnvMap, name: string): string {
  return env[name]?.trim() ?? "";
}

function isReclaimNetwork(value: string): value is ReclaimNetwork {
  return value === "Mainnet" || value === "Preprod" || value === "Preview";
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
