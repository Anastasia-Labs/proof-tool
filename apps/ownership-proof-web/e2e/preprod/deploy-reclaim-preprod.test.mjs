import { describe, expect, it } from "vitest";
import {
  assertReclaimGlobalProofSlotEncoding,
  buildManifest,
  reclaimGlobalExportArgs,
} from "./deploy-reclaim-preprod.mjs";

const POLICY_ID = "ab".repeat(28);
const VERIFIER_KEY = "cd".repeat(672);
const RECLAIM_PARAMS_TOKEN_NAME = "5245434c41494d504152414d53";

describe("reclaim script exporter invocation", () => {
  it("passes canonical key bytes and their hash to the statement-bound V2 exporter", () => {
    const cardanoVkHash = "ef".repeat(32);
    expect(reclaimGlobalExportArgs("global-v2", POLICY_ID, VERIFIER_KEY, cardanoVkHash)).toEqual([
      "global-v2",
      POLICY_ID,
      RECLAIM_PARAMS_TOKEN_NAME,
      VERIFIER_KEY,
      cardanoVkHash,
    ]);
  });

  it("uses the same policy/name/VK ordering for the multi global exporter", () => {
    expect(reclaimGlobalExportArgs("global-multi", POLICY_ID, VERIFIER_KEY)).toEqual([
      "global-multi",
      POLICY_ID,
      RECLAIM_PARAMS_TOKEN_NAME,
      VERIFIER_KEY,
    ]);
  });

  it("rejects unrelated exporter modes", () => {
    expect(() => reclaimGlobalExportArgs("base", POLICY_ID, VERIFIER_KEY)).toThrow(/unsupported reclaim global export mode/u);
  });

  it.each([
    [undefined, "statement-bound-v2", `blake2b256:${"11".repeat(32)}`],
    ["ambiguous-marker-v0", "statement-bound-v2", `blake2b256:${"11".repeat(32)}`],
    ["full-proof-plus-public-input-digest-v2", "v1", `blake2b256:${"11".repeat(32)}`],
    ["full-proof-plus-public-input-digest-v2", "statement-bound-v2", `blake2b256:${"ff".repeat(32)}`],
  ])(
    "rejects missing or mismatched V2 export metadata",
    (proofSlotEncoding, batchTranscript, exportedVerifierVkHash) => {
      expect(() =>
        assertReclaimGlobalProofSlotEncoding(
          proofSlotEncoding,
          batchTranscript,
          exportedVerifierVkHash,
          `blake2b256:${"11".repeat(32)}`,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "reclaim_global_proof_slot_encoding",
        }),
      );
    },
  );

  it("propagates statement-bound V2 key coherence while retaining the Stage 2g cap-5 policy", () => {
    const manifest = buildManifest({
      sourceCommit: "12".repeat(20),
      baseAddress: "addr_test1_base",
      baseScriptHash: "34".repeat(28),
      globalScriptHash: "56".repeat(28),
      globalRewardAddress: "stake_test1_global",
      holderScriptHash: "78".repeat(28),
      paramsPolicyId: "9a".repeat(28),
      paramsUnit: `${"9a".repeat(28)}${RECLAIM_PARAMS_TOKEN_NAME}`,
      paramsOutRef: {
        tx_hash: "bc".repeat(32),
        output_index: 0,
        holder_address: "addr_test1_holder",
      },
      referenceBase: { tx_hash: "de".repeat(32), output_index: 1 },
      referenceGlobal: { tx_hash: "f0".repeat(32), output_index: 2 },
      destination: {
        vkHash: `blake2b256:${"11".repeat(32)}`,
        cardanoVkBlake2b256: `blake2b256:${"22".repeat(32)}`,
      },
      providerName: "blockfrost",
      globalRewardAccountRegistered: false,
    });

    expect(manifest.reclaim_global.proof_slot_encoding).toBe(
      "full-proof-plus-public-input-digest-v2",
    );
    expect(manifest.reclaim_global.batch_transcript_vk_hash).toBe(
      `blake2b256:${"22".repeat(32)}`,
    );
    expect(manifest.batching.hard_max_utxo_count).toBe(5);
  });
});
