import { describe, expect, it } from "vitest";
import { blake2b } from "@noble/hashes/blake2b";
import * as LucidExports from "@lucid-evolution/lucid";
import {
  Constr,
  Data,
  credentialToAddress,
  keyHashToCredential,
  scriptHashToCredential,
  type OutRef,
  type Provider,
  type UTxO,
} from "@lucid-evolution/lucid";
import type { ReclaimDeployment } from "../reclaim/types";
import { CLAIM_DEFAULT_BATCH_CAP, CLAIM_HARD_BATCH_CAP, type ClaimDraftResponse } from "../claim/types";
import { ClaimValidationError, outRefToString } from "../claim/validation";
import { destinationAddressV1 } from "../claim/addresses";
import { createClaimDraft } from "./draft";
import { getClaimProgress } from "./progress";
import {
  UnsupportedClaimBuildError,
  buildClaimTx,
  validateClaimBuildRequest,
  validateClaimSubmitRequest,
} from "./build-submit";

const CREDENTIAL_1 = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const CREDENTIAL_2 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CREDENTIAL_3 = "bb".repeat(28);
const CREDENTIAL_4 = "cc".repeat(28);
const CREDENTIAL_5 = "dd".repeat(28);
const CREDENTIAL_6 = "ee".repeat(28);
const SAFE_CREDENTIAL = "00000000000000000000000000000000000000000000000000000001";
const TEST_RECLAIM_BASE_SCRIPT = { type: "PlutusV3" as const, script: "450100002499" };
const TEST_RECLAIM_GLOBAL_SCRIPT = { type: "PlutusV3" as const, script: "450100002498" };
const testValidatorToScriptHash = (LucidExports as unknown as {
  validatorToScriptHash: (script: typeof TEST_RECLAIM_BASE_SCRIPT) => string;
}).validatorToScriptHash;
const RECLAIM_SCRIPT = testValidatorToScriptHash(TEST_RECLAIM_BASE_SCRIPT);
const RECLAIM_GLOBAL_SCRIPT = testValidatorToScriptHash(TEST_RECLAIM_GLOBAL_SCRIPT);
const PARAMS_POLICY = "55".repeat(28);
const PARAMS_TOKEN_NAME = "5245434c41494d";
const PARAMS_HOLDER_ADDRESS = credentialToAddress("Preprod", scriptHashToCredential("66".repeat(28)));
const VK_HASH = "22".repeat(32);
const SAFE_ADDRESS = credentialToAddress("Preprod", keyHashToCredential(SAFE_CREDENTIAL));
const RECLAIM_ADDRESS = credentialToAddress("Preprod", scriptHashToCredential(RECLAIM_SCRIPT));
const DEPLOYMENT: ReclaimDeployment = {
  id: `Preprod:${RECLAIM_SCRIPT}:source`,
  network: "Preprod",
  networkId: 0,
  reclaimBaseAddress: RECLAIM_ADDRESS,
  reclaimBaseScriptHash: RECLAIM_SCRIPT,
  reclaimGlobalCredential: "33".repeat(28),
  reclaimGlobalScriptHash: RECLAIM_GLOBAL_SCRIPT,
  paramsCurrencySymbol: PARAMS_POLICY,
  paramsTokenName: PARAMS_TOKEN_NAME,
  verifierVkHash: VK_HASH,
  contractVersion: "test",
  sourceCommit: "source",
  paramsUtxo: {
    tx_hash: "77".repeat(32),
    output_index: 0,
    policy_id: PARAMS_POLICY,
    token_name: PARAMS_TOKEN_NAME,
    holder_address: PARAMS_HOLDER_ADDRESS,
    datum_reclaim_base_script_hash: RECLAIM_SCRIPT,
  },
};

describe("claim draft server helpers", () => {
  it("orders selected reclaim inputs by oldest confirmation and then outref", async () => {
    const newer = reclaimUtxo("02", 0, CREDENTIAL_1, 20);
    const older = reclaimUtxo("01", 0, CREDENTIAL_2, 10);
    const provider = providerWith({
      reclaimUtxos: [newer, older],
      selectedUtxos: [newer, older],
      safeUtxos: [safeUtxo()],
    });

    const draft = await createClaimDraft(provider, DEPLOYMENT, {
      deploymentId: DEPLOYMENT.id,
      networkId: 0,
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
      selectedOutrefs: [newer, older].map(outRefToString),
    });

    expect(draft.orderedInputs.map((input) => input.outRefId)).toEqual([outRefToString(older), outRefToString(newer)]);
    expect(draft.orderedPaymentCredentials).toEqual([CREDENTIAL_2, CREDENTIAL_1]);
    expect(draft.destinationOutputs.map((output) => output.destinationAddress)).toEqual([
      destinationAddressV1(SAFE_ADDRESS, 0),
      destinationAddressV1(SAFE_ADDRESS, 0),
    ]);
    expect(draft.buildSupported).toBe(false);
  });

  it("reports build support when reference script prerequisites are configured", async () => {
    const deployment = deploymentWithReferenceScripts();
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
    });

    const draft = await createClaimDraft(provider, deployment, {
      deploymentId: deployment.id,
      networkId: 0,
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
      selectedOutrefs: [outRefToString(selected)],
    });

    expect(draft.buildSupported).toBe(true);
  });

  it("requires explicit nextBatch for automatic public selection", async () => {
    const provider = providerWith({
      reclaimUtxos: [reclaimUtxo("01", 0, CREDENTIAL_1, 1)],
      selectedUtxos: [],
      safeUtxos: [safeUtxo()],
    });

    await expect(
      createClaimDraft(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
      }),
    ).rejects.toMatchObject({ code: "claim_batch_selection_required" });
  });

  it("ignores provider-returned outrefs outside an explicit selected set", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const extra = reclaimUtxo("02", 0, CREDENTIAL_2, 2);
    const provider = providerWith({
      reclaimUtxos: [selected, extra],
      selectedUtxos: [selected, extra],
      safeUtxos: [safeUtxo()],
    });

    const draft = await createClaimDraft(provider, DEPLOYMENT, {
      deploymentId: DEPLOYMENT.id,
      networkId: 0,
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
      selectedOutrefs: [outRefToString(selected)],
    });

    expect(draft.orderedInputs.map((input) => input.outRefId)).toEqual([outRefToString(selected)]);
  });

  it("excludes pending outrefs from automatic next-batch selection", async () => {
    const pending = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const available = reclaimUtxo("02", 0, CREDENTIAL_2, 2);
    const provider = providerWith({
      reclaimUtxos: [pending, available],
      selectedUtxos: [pending, available],
      safeUtxos: [safeUtxo()],
    });

    const draft = await createClaimDraft(provider, DEPLOYMENT, {
      deploymentId: DEPLOYMENT.id,
      networkId: 0,
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
      nextBatch: true,
      pendingOutrefs: [outRefToString(pending)],
    });

    expect(draft.orderedInputs.map((input) => input.outRefId)).toEqual([outRefToString(available)]);
  });

  it("rejects explicit selected outrefs that are pending", async () => {
    const pending = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [pending],
      selectedUtxos: [pending],
      safeUtxos: [safeUtxo()],
    });

    await expect(
      createClaimDraft(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        selectedOutrefs: [outRefToString(pending)],
        pendingOutrefs: [outRefToString(pending)],
      }),
    ).rejects.toMatchObject({ code: "selected_outref_pending" });
  });

  it("applies default cap 4 and hard cap 5", async () => {
    const reclaimUtxos = [
      reclaimUtxo("01", 0, CREDENTIAL_1, 1),
      reclaimUtxo("02", 0, CREDENTIAL_2, 2),
      reclaimUtxo("03", 0, CREDENTIAL_3, 3),
      reclaimUtxo("04", 0, CREDENTIAL_4, 4),
      reclaimUtxo("05", 0, CREDENTIAL_5, 5),
      reclaimUtxo("06", 0, CREDENTIAL_6, 6),
    ];
    const provider = providerWith({
      reclaimUtxos,
      selectedUtxos: reclaimUtxos,
      safeUtxos: [safeUtxo()],
    });

    const draft = await createClaimDraft(provider, DEPLOYMENT, {
      deploymentId: DEPLOYMENT.id,
      networkId: 0,
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
      nextBatch: true,
    });

    expect(draft.batchCap).toEqual({
      requested: CLAIM_DEFAULT_BATCH_CAP,
      default: CLAIM_DEFAULT_BATCH_CAP,
      hardMax: CLAIM_HARD_BATCH_CAP,
    });
    expect(draft.orderedInputs).toHaveLength(4);
    expect(draft.reductions).toContain("reduced_to_batch_cap_4");

    await expect(
      createClaimDraft(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        nextBatch: true,
        maxUtxos: 6,
      }),
    ).rejects.toMatchObject({ code: "batch_cap_exceeded" });
  });

  it("rejects selected malformed reclaim datums", async () => {
    const malformed = reclaimUtxo("01", 0, CREDENTIAL_1, 1, { datum: Data.to(new Constr(0, ["ab"])) });
    const provider = providerWith({
      reclaimUtxos: [malformed],
      selectedUtxos: [malformed],
      safeUtxos: [safeUtxo()],
    });

    await expect(
      createClaimDraft(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        selectedOutrefs: [outRefToString(malformed)],
      }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it("requires a conservative safe-wallet ADA buffer", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo({ lovelace: 4_999_999n })],
    });

    await expect(
      createClaimDraft(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        selectedOutrefs: [outRefToString(selected)],
      }),
    ).rejects.toMatchObject({ code: "safe_wallet_lovelace_unavailable" });
  });
});

describe("claim build and submit fail closed", () => {
  it("route-facing build refuses deployments that are missing reference scripts", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
    });
    const draft = await selectedDraft(provider, selected);

    await expect(
      buildClaimTx(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: draft.draftId,
        selectedOutrefs: [outRefToString(selected)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({
      code: "claim_build_unsupported",
      reason: "build_prerequisites_missing",
      missingBuildArtifacts: ["reference_scripts.reclaim_base", "reference_scripts.reclaim_global"],
    });
  });

  it("requeries draft material, validates proofs, and refuses unsupported live build", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
    });
    const draft = await selectedDraft(provider, selected);

    await expect(
      validateClaimBuildRequest(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: draft.draftId,
        selectedOutrefs: [outRefToString(selected)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({
      code: "claim_build_unsupported",
      preflight: {
        deploymentId: DEPLOYMENT.id,
        selectedOutrefs: [outRefToString(selected)],
        paramsReferenceInput: {
          outRefId: `${DEPLOYMENT.paramsUtxo?.tx_hash}#${DEPLOYMENT.paramsUtxo?.output_index}`,
          holderAddress: PARAMS_HOLDER_ADDRESS,
        },
        buildReady: false,
        missingBuildArtifacts: ["reference_scripts.reclaim_base", "reference_scripts.reclaim_global"],
        referenceScripts: {
          ready: false,
          missing: ["reference_scripts.reclaim_base", "reference_scripts.reclaim_global"],
          inputs: [],
        },
        orderedPaymentCredentials: [CREDENTIAL_1],
      },
      reason: "build_prerequisites_missing",
      missingBuildArtifacts: ["reference_scripts.reclaim_base", "reference_scripts.reclaim_global"],
    });
  });

  it("verifies configured reference script UTxOs before the unsupported build boundary", async () => {
    const deployment = deploymentWithReferenceScripts();
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
      referenceScriptUtxos: referenceScriptUtxos(deployment),
    });
    const draft = await selectedDraft(provider, selected, deployment);

    await expect(
      validateClaimBuildRequest(provider, deployment, {
        deploymentId: deployment.id,
        networkId: 0,
        draftId: draft.draftId,
        selectedOutrefs: [outRefToString(selected)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({
      code: "claim_build_unsupported",
      reason: "transaction_builder_not_implemented",
      missingBuildArtifacts: [],
      preflight: {
        buildReady: true,
        missingBuildArtifacts: [],
        referenceScripts: {
          ready: true,
          missing: [],
          inputs: [
            {
              role: "reclaim_base",
              outRefId: `${deployment.referenceScripts?.reclaimBase.tx_hash}#${deployment.referenceScripts?.reclaimBase.output_index}`,
              scriptHash: RECLAIM_SCRIPT,
              scriptType: "PlutusV3",
            },
            {
              role: "reclaim_global",
              outRefId: `${deployment.referenceScripts?.reclaimGlobal.tx_hash}#${deployment.referenceScripts?.reclaimGlobal.output_index}`,
              scriptHash: RECLAIM_GLOBAL_SCRIPT,
              scriptType: "PlutusV3",
            },
          ],
        },
      },
    });
  });

  it("rejects configured reference script UTxOs that are unavailable or mismatched", async () => {
    const deployment = deploymentWithReferenceScripts();
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const baseInput = {
      deploymentId: deployment.id,
      networkId: 0,
      selectedOutrefs: [outRefToString(selected)],
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
    };
    const proofProvider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
      referenceScriptUtxos: referenceScriptUtxos(deployment),
    });
    const draft = await selectedDraft(proofProvider, selected, deployment);

    const missingReferenceProvider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
      referenceScriptUtxos: [],
    });
    await expect(
      validateClaimBuildRequest(missingReferenceProvider, deployment, {
        ...baseInput,
        draftId: draft.draftId,
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({ code: "claim_reference_script_not_found" });

    const wrongScriptRefProvider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
      referenceScriptUtxos: referenceScriptUtxos(deployment, {
        reclaimGlobal: { scriptRef: TEST_RECLAIM_BASE_SCRIPT },
      }),
    });
    await expect(
      validateClaimBuildRequest(wrongScriptRefProvider, deployment, {
        ...baseInput,
        draftId: draft.draftId,
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({ code: "claim_reference_script_hash_mismatch" });

    const invalidScriptRefProvider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
      referenceScriptUtxos: referenceScriptUtxos(deployment, {
        reclaimGlobal: { scriptRef: { type: "PlutusV3", script: "4948010000222601" } as UTxO["scriptRef"] },
      }),
    });
    await expect(
      validateClaimBuildRequest(invalidScriptRefProvider, deployment, {
        ...baseInput,
        draftId: draft.draftId,
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({ code: "claim_reference_script_invalid" });
  });

  it("rejects stale drafts before the unsupported build boundary", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
    });
    const draft = await selectedDraft(provider, selected);

    await expect(
      validateClaimBuildRequest(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: "aa".repeat(32),
        selectedOutrefs: [outRefToString(selected)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({ code: "claim_draft_stale" });
  });

  it("rejects wrong verifier hash before the unsupported build boundary", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
    });
    const draft = await selectedDraft(provider, selected);
    const artifact = proofArtifactForDraft(draft, 0);
    artifact.artifact.vk_hash = "ff".repeat(32);

    await expect(
      validateClaimBuildRequest(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: draft.draftId,
        selectedOutrefs: [outRefToString(selected)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [artifact],
      }),
    ).rejects.toMatchObject({ code: "proof_artifact_vk_hash" });
  });

  it("rejects reordered proof artifacts and changed destinations", async () => {
    const first = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const second = reclaimUtxo("02", 0, CREDENTIAL_2, 2);
    const provider = providerWith({
      reclaimUtxos: [first, second],
      selectedUtxos: [first, second],
      safeUtxos: [safeUtxo()],
    });
    const draft = await selectedDraft(provider, first, second);

    await expect(
      validateClaimBuildRequest(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: draft.draftId,
        selectedOutrefs: [outRefToString(first), outRefToString(second)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [proofArtifactForDraft(draft, 1), proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({ code: "proof_artifact_outref_order" });

    const wrongDestination = proofArtifactForDraft(draft, 0);
    wrongDestination.artifact.destination_address = "00".repeat(58);
    await expect(
      validateClaimBuildRequest(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: draft.draftId,
        selectedOutrefs: [outRefToString(first), outRefToString(second)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [wrongDestination, proofArtifactForDraft(draft, 1)],
      }),
    ).rejects.toMatchObject({ code: "proof_artifact_destination" });
  });

  it("rejects proof artifacts with path metadata or wrong public input digest", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
    });
    const draft = await selectedDraft(provider, selected);
    const withPath = proofArtifactForDraft(draft, 0);
    withPath.artifact.path = { account: 0, role: 0, index: 0 };

    await expect(
      validateClaimBuildRequest(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: draft.draftId,
        selectedOutrefs: [outRefToString(selected)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [withPath],
      }),
    ).rejects.toMatchObject({ code: "proof_artifact_path_metadata" });

    const wrongDigest = proofArtifactForDraft(draft, 0);
    wrongDigest.artifact.cardano.public_input_digest_hex = "00".repeat(32);
    await expect(
      validateClaimBuildRequest(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: draft.draftId,
        selectedOutrefs: [outRefToString(selected)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [wrongDigest],
      }),
    ).rejects.toMatchObject({ code: "proof_artifact_public_input_digest" });
  });

  it("rejects missing or mismatched parameter reference UTxOs", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const baseInput = {
      deploymentId: DEPLOYMENT.id,
      networkId: 0,
      selectedOutrefs: [outRefToString(selected)],
      safeWalletChangeAddress: SAFE_ADDRESS,
      safeWalletAddresses: [SAFE_ADDRESS],
    };
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
      paramsUtxo: null,
    });
    const draft = await selectedDraft(providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
    }), selected);

    await expect(
      validateClaimBuildRequest(provider, DEPLOYMENT, {
        ...baseInput,
        draftId: draft.draftId,
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({ code: "claim_params_not_found" });

    const wrongDatumProvider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
      paramsUtxo: paramsUtxo({ datum: Data.to(new Constr(0, ["aa".repeat(28)])) }),
    });
    await expect(
      validateClaimBuildRequest(wrongDatumProvider, DEPLOYMENT, {
        ...baseInput,
        draftId: draft.draftId,
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({ code: "claim_params_datum_mismatch" });
  });

  it("accepts canonical parameter datum CBOR from provider responses", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
      paramsUtxo: paramsUtxo({ datum: `d87981581c${RECLAIM_SCRIPT}` }),
    });
    const draft = await selectedDraft(provider, selected);

    await expect(
      validateClaimBuildRequest(provider, DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: draft.draftId,
        selectedOutrefs: [outRefToString(selected)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({ code: "claim_build_unsupported" });
  });

  it("rejects unsupported deployments with no parameter reference in the manifest", async () => {
    const selected = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const provider = providerWith({
      reclaimUtxos: [selected],
      selectedUtxos: [selected],
      safeUtxos: [safeUtxo()],
    });
    const draft = await selectedDraft(provider, selected);
    const { paramsUtxo: _paramsUtxo, ...deploymentWithoutParams } = DEPLOYMENT;

    await expect(
      validateClaimBuildRequest(provider, deploymentWithoutParams, {
        deploymentId: DEPLOYMENT.id,
        networkId: 0,
        draftId: draft.draftId,
        selectedOutrefs: [outRefToString(selected)],
        safeWalletChangeAddress: SAFE_ADDRESS,
        safeWalletAddresses: [SAFE_ADDRESS],
        proofArtifacts: [proofArtifactForDraft(draft, 0)],
      }),
    ).rejects.toMatchObject({ code: "claim_params_missing" });
  });

  it("does not act as a generic signed transaction relay", () => {
    expect(() =>
      validateClaimSubmitRequest(DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        selectedOutrefs: [`${"01".repeat(32)}#0`],
        signedTxCbor: "84a1",
      }),
    ).toThrow("reviewed claim build token");
  });

  it("requires reviewed claim build material before submit", () => {
    expect(() =>
      validateClaimSubmitRequest(DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        selectedOutrefs: [`${"01".repeat(32)}#0`],
        signedTxCbor: "84a1",
        claimBuildReviewToken: "reviewed",
      }),
    ).toThrow("reviewed claim build summary");
  });

  it("accepts reviewed signed transaction shape for submit inspection", () => {
    expect(() =>
      validateClaimSubmitRequest(DEPLOYMENT, {
        deploymentId: DEPLOYMENT.id,
        selectedOutrefs: [`${"01".repeat(32)}#0`],
        signedTxCbor: "84a1",
        claimBuildReviewToken: "reviewed",
        review: claimBuildReview([`${"01".repeat(32)}#0`]),
      }),
    ).not.toThrow();
  });
});

describe("claim progress", () => {
  it("returns provider-aware pending and confirmed-spent states", async () => {
    const stillUnspent = reclaimUtxo("01", 0, CREDENTIAL_1, 1);
    const spent = reclaimUtxo("02", 0, CREDENTIAL_2, 2);
    const provider = providerWith({
      reclaimUtxos: [stillUnspent],
      selectedUtxos: [stillUnspent],
      safeUtxos: [safeUtxo()],
    });

    const progress = await getClaimProgress(provider, DEPLOYMENT, {
      outrefs: [outRefToString(stillUnspent), outRefToString(spent)],
      pendingOutrefs: [outRefToString(stillUnspent), outRefToString(spent)],
    });

    expect(progress.outrefs.map((entry) => entry.state)).toEqual(["pending", "spent_or_unknown"]);
    expect(progress.nextBatch.available).toBe(false);
  });

  it("returns typed provider-unavailable states", async () => {
    const progress = await getClaimProgress(null, DEPLOYMENT, {
      outrefs: [`${"01".repeat(32)}#0`],
    });

    expect(progress.providerAvailable).toBe(false);
    expect(progress.outrefs[0]?.state).toBe("provider_unavailable");
  });
});

function reclaimUtxo(
  txByte: string,
  outputIndex: number,
  credential: string,
  slot: number,
  overrides: Partial<UTxO> = {},
): UTxO {
  return {
    txHash: txByte.repeat(32),
    outputIndex,
    address: RECLAIM_ADDRESS,
    assets: { lovelace: 2_000_000n },
    datum: Data.to(new Constr(0, [credential])),
    slot,
    ...overrides,
  } as UTxO;
}

function safeUtxo(assets = { lovelace: 10_000_000n }): UTxO {
  return {
    txHash: "99".repeat(32),
    outputIndex: 0,
    address: SAFE_ADDRESS,
    assets,
  };
}

function paramsUtxo(overrides: Partial<UTxO> = {}): UTxO {
  return {
    txHash: DEPLOYMENT.paramsUtxo?.tx_hash ?? "77".repeat(32),
    outputIndex: DEPLOYMENT.paramsUtxo?.output_index ?? 0,
    address: PARAMS_HOLDER_ADDRESS,
    assets: { lovelace: 2_000_000n, [`${PARAMS_POLICY}${PARAMS_TOKEN_NAME}`]: 1n },
    datum: Data.to(new Constr(0, [RECLAIM_SCRIPT])),
    ...overrides,
  } as UTxO;
}

function providerWith(input: {
  reclaimUtxos: UTxO[];
  selectedUtxos: UTxO[];
  safeUtxos: UTxO[];
  paramsUtxo?: UTxO | null;
  referenceScriptUtxos?: UTxO[];
}): Provider {
  return {
    getUtxos: async (addressOrCredential: string) => {
      if (addressOrCredential === RECLAIM_ADDRESS) {
        return input.reclaimUtxos;
      }
      if (addressOrCredential === SAFE_ADDRESS) {
        return input.safeUtxos;
      }
      return [];
    },
    getUtxosByOutRef: async (outrefs: OutRef[]) => {
      const requested = new Set(outrefs.map(outRefToString));
      return [
        ...input.selectedUtxos,
        ...(input.paramsUtxo === null ? [] : [input.paramsUtxo ?? paramsUtxo()]),
        ...(input.referenceScriptUtxos ?? []),
      ].filter((utxo) => requested.has(outRefToString(utxo)));
    },
  } as unknown as Provider;
}

function proofArtifact(overrides: Record<string, unknown> = {}) {
  return {
    artifact: {
      schema: "root-ownership-proof-artifact-v1",
      circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
      vk_hash: VK_HASH,
      cardano: {
        proof_hex: "aa",
        public_input_digest_hex: "bb",
      },
      ...overrides,
    },
  };
}

async function selectedDraft(provider: Provider, ...args: Array<UTxO | ReclaimDeployment>): Promise<ClaimDraftResponse> {
  const maybeDeployment = args.at(-1);
  const deployment = isDeployment(maybeDeployment) ? maybeDeployment : DEPLOYMENT;
  const selected = (isDeployment(maybeDeployment) ? args.slice(0, -1) : args) as UTxO[];
  return createClaimDraft(provider, deployment, {
    deploymentId: deployment.id,
    networkId: 0,
    safeWalletChangeAddress: SAFE_ADDRESS,
    safeWalletAddresses: [SAFE_ADDRESS],
    selectedOutrefs: selected.map(outRefToString),
  });
}

function deploymentWithReferenceScripts(): ReclaimDeployment {
  return {
    ...DEPLOYMENT,
    referenceScripts: {
      reclaimBase: {
        tx_hash: "12".repeat(32),
        output_index: 0,
        script_hash: RECLAIM_SCRIPT,
        holder_address: PARAMS_HOLDER_ADDRESS,
      },
      reclaimGlobal: {
        tx_hash: "13".repeat(32),
        output_index: 0,
        script_hash: RECLAIM_GLOBAL_SCRIPT,
        holder_address: PARAMS_HOLDER_ADDRESS,
      },
    },
  };
}

function referenceScriptUtxos(
  deployment: ReclaimDeployment,
  overrides: {
    reclaimBase?: Partial<UTxO>;
    reclaimGlobal?: Partial<UTxO>;
  } = {},
): UTxO[] {
  if (!deployment.referenceScripts) {
    return [];
  }
  return [
    {
      txHash: deployment.referenceScripts.reclaimBase.tx_hash,
      outputIndex: deployment.referenceScripts.reclaimBase.output_index,
      address: deployment.referenceScripts.reclaimBase.holder_address ?? PARAMS_HOLDER_ADDRESS,
      assets: { lovelace: 5_000_000n },
      scriptRef: TEST_RECLAIM_BASE_SCRIPT,
      ...overrides.reclaimBase,
    } as UTxO,
    {
      txHash: deployment.referenceScripts.reclaimGlobal.tx_hash,
      outputIndex: deployment.referenceScripts.reclaimGlobal.output_index,
      address: deployment.referenceScripts.reclaimGlobal.holder_address ?? PARAMS_HOLDER_ADDRESS,
      assets: { lovelace: 5_000_000n },
      scriptRef: TEST_RECLAIM_GLOBAL_SCRIPT,
      ...overrides.reclaimGlobal,
    } as UTxO,
  ];
}

function isDeployment(value: unknown): value is ReclaimDeployment {
  return Boolean(value && typeof value === "object" && "reclaimBaseAddress" in value && "verifierVkHash" in value);
}

function claimBuildReview(selectedOutrefs: string[]) {
  return {
    deploymentId: DEPLOYMENT.id,
    draftId: "ab".repeat(32),
    selectedOutrefs,
    transactionInputOrder: selectedOutrefs,
    destinationOutputStartIndex: 0,
    destinationOutputs: selectedOutrefs.map((outRefIdValue) => ({
      outRefId: outRefIdValue,
      address: SAFE_ADDRESS,
      destinationAddressEncoding: "destination-address-v1" as const,
      destinationAddress: destinationAddressV1(SAFE_ADDRESS, 0),
      value: { lovelace: "2000000" },
    })),
    paramsReferenceInput: {
      outRefId: `${DEPLOYMENT.paramsUtxo?.tx_hash}#${DEPLOYMENT.paramsUtxo?.output_index}`,
      holderAddress: PARAMS_HOLDER_ADDRESS,
      datumCbor: Data.to(new Constr(0, [RECLAIM_SCRIPT])),
    },
    referenceScriptInputs: [
      {
        role: "reclaim_base" as const,
        outRefId: `${"12".repeat(32)}#0`,
        holderAddress: PARAMS_HOLDER_ADDRESS,
        scriptHash: RECLAIM_SCRIPT,
        scriptType: "PlutusV3",
      },
      {
        role: "reclaim_global" as const,
        outRefId: `${"13".repeat(32)}#0`,
        holderAddress: PARAMS_HOLDER_ADDRESS,
        scriptHash: RECLAIM_GLOBAL_SCRIPT,
        scriptType: "PlutusV3",
      },
    ],
    proofDigests: selectedOutrefs.map((outRefIdValue) => ({
      outRefId: outRefIdValue,
      targetCredential: CREDENTIAL_1,
      destinationAddress: destinationAddressV1(SAFE_ADDRESS, 0),
      publicInputDigestHex: "00".repeat(32),
    })),
  };
}

function proofArtifactForDraft(draft: ClaimDraftResponse, index: number): any {
  const input = draft.orderedInputs[index];
  const output = draft.destinationOutputs[index];
  if (!input || !output) {
    throw new Error(`missing draft item ${index}`);
  }
  return {
    out_ref: input.outRefId,
    artifact: {
      schema: "root-ownership-proof-artifact-v1",
      circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
      vk_hash: VK_HASH,
      target_credential: input.paymentCredential,
      destination_address_encoding: "destination-address-v1",
      destination_address: output.destinationAddress,
      public_input_encoding: "single-credential-destination-v1",
      public_input: "01",
      proof: "encoded-proof",
      cardano: {
        format: "groth16-bls12-381-bsb22",
        proof_hex: "aa",
        public_input_digest_hex: destinationPublicInputDigest(input.paymentCredential, output.destinationAddress),
      },
    },
  };
}

function destinationPublicInputDigest(credentialHex: string, destinationAddressHex: string): string {
  const preimage = Buffer.concat([
    Buffer.from("ROOT-OWNERSHIP-DESTINATION-v1", "utf8"),
    Buffer.from(credentialHex, "hex"),
    Buffer.from(destinationAddressHex, "hex"),
  ]);
  return Buffer.from(blake2b(new Uint8Array(preimage), { dkLen: 32 })).toString("hex");
}
