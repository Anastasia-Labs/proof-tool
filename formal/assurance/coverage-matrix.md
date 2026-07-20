# Reclaim Contract Formal-Assurance Coverage Matrix

Status: active assurance run; deployed surface locked and coherent current-source candidate pair classified, 2026-07-20

This matrix fixes what must be proved, falsified, or explicitly retired before
the formal-assurance goal can complete. Current classifications live in
`theorem-catalog.json`; this inventory does not promote supporting evidence to
an exact top-level theorem.

## Authoritative deployment baseline

The enabled public deployment manifest is
`apps/ownership-proof-web/public/proof-assets/reclaim-deployment.json`.
It identifies:

| Field | Locked value |
| --- | --- |
| Network | `Preprod` |
| Deployment source | `c513fd78ecb14a4119769986675d602dffa741b4` |
| Active ReclaimBase hash | `a4cd2a3208a0788aedd1aeea087f8902c58052dc2fcfa2c228ea34dd` |
| Current-source ReclaimBase candidate | `98c37bec5939bf320e387e54973bb2af68b7d839fc8ae96cc8b1ff50` (not deployed; parameterized by the candidate GlobalV2 credential) |
| Active ReclaimGlobal hash | `1556d4b8968fc1bc2beb692634a8e1c7e4d476cce48a5969c007b2c5` |
| Current-source ReclaimGlobalV2 candidate | `b88e02bd9d6a9e711f11941729b437c04a27368bbb10f5f95c1deebb` (not deployed) |
| Parameter policy | `82c806809e8e2a65c153041db187ca96f2feeb87a3fe135bf3803174` |
| Parameter token name | `5245434c41494d504152414d53` (`RECLAIMPARAMS`) |
| Proof-slot encoding | `full-proof-plus-public-input-digest-v2` |
| Batch transcript key hash | `06ce913c931a53561fe5d022ed45a5fbc033b06d80eebdd9f646d23a05b7d5c4` |
| Params/reference holder hash | `ebb18a12777410738fdeaa77ec0fd582685d677b6b34de9a6e3b6d7e` |

The deployed bytes and source-commit evidence remain locked in
`artifact-regeneration.json` and `import-fidelity.json`. Current source now
intentionally diverges for both `ReclaimBase` and `ReclaimGlobalV2`; their
coherent exported pair is kept under `formal/artifacts/candidate/`. OneShotNFT
and ParamsHolder remain byte-identical to active. No active manifest, parameter
datum, or reference-script identity was changed.

## Classification rules

- **Active:** selected by the enabled public manifest and normal claim/deploy
  path. Exact artifact proofs are mandatory.
- **Supporting:** used to create or preserve the active parameter/reference
  state. Its generalized invariant is mandatory even though it does not run in
  every claim transaction.
- **Exported alternative:** the repository can produce the script through a
  supported executable/API, but the active deployer does not select it. It must
  be formally covered or approval-gated for retirement/guarding.
- **Excluded benchmark/test:** no production export or deployment route was
  found. The exclusion is invalidated if a route is later found.

## On-chain entrypoint matrix

| Surface | Export mode | Purpose | Parameters fixed before execution | Runtime input | Reachability | Required disposition |
| --- | --- | --- | --- | --- | --- | --- |
| `Ownership.ReclaimBase.reclaimBaseValidatorCode` | `base` | Spending | Audited withdrawal-map key, applied as encoded `Data` | One V3 `ScriptContext` as `BuiltinData` | Deployed historical artifact plus a simplified current-source candidate; deployment not updated | Preserve exact deployed evidence and prove candidate `RB-*` withdrawal-only semantics before deployment |
| `Ownership.ReclaimGlobalV2.reclaimGlobalValidatorV2Code` | `global-v2` | Rewarding | Parameter policy ID, token name, 672-byte Cardano verifier key, 32-byte verifier-key hash | One V3 `ScriptContext` as `BuiltinData` | Deployed historical V2 artifact plus a distinct current-source canonical V2 candidate; it is the only exported single-proof global mode | Preserve exact deployed evidence; retain coherent candidate replays; complete the applicable generalized `RG-*` bridges before deployment |
| `Ownership.OneShotNFT.oneShotNFTPolicyCode` | `one-shot` | Minting | Deployment seed `TxOutRef` | One V3 `ScriptContext` as `BuiltinData` | Supporting; deployer derives the parameter policy ID from it and consumes the seed while creating the params/reference outputs | Generalized `NFT-*` proof plus exact policy provenance |
| `Ownership.ParamsHolder.paramsHolderValidatorCode` | `params-holder` | Spending | None | One `BuiltinData` argument | Supporting; deployer locks params and reference scripts at its address | Generalized `PH-*` proof plus exact holder-hash provenance |
| `Ownership.ReclaimGlobalMulti.reclaimGlobalMultiValidatorCode` | `global-multi` | Rewarding | Parameter policy ID, token name, 672-byte verifier key | One V3 `ScriptContext` as `BuiltinData` | Exported alternative; CLI and `reclaimGlobalExportArgs` accept it, while the normal deployer does not select it | Prove a multi catalog or approval-gate retirement/production guard |

The active manifest and deployer route select only `global-v2`. The former
single-proof V1 implementation and its `global` export mode have been removed,
so there is no V1 production or comparison surface to select accidentally.
`global-multi` remains a separate, explicitly named aggregate-proof design.

## Non-entrypoint and excluded surfaces

| Surface | Classification | Evidence and treatment |
| --- | --- | --- |
| `Ownership.Verify` | Shared production logic | Not independently exported, but its BLS/Groth16 parser and verifier are reachable from the exact active ReclaimGlobalV2 artifact. Covered by `RG-5`, `RG-6`, cross-language vectors, and the trust report. Cryptographic knowledge soundness remains an explicit assumption. |
| `Ownership.ReclaimGlobalMultiV2Bench` | Excluded benchmark | Exposed by the Cabal library but never imported by the exporter; used only by benchmarks/tests. |
| `bench/Bench.hs` and `bench/ProfileV4.hs` | Supporting evidence | Benchmark executables, not validators deployed by the application. Their capacity and differential results may support fuel/exunit boundaries but cannot replace formal theorems. |
| `export/VerifyDestinationProof.hs` | Supporting evidence | Off-chain executable that evaluates repository-backed proof material. It is not an on-chain entrypoint. |
| `test-support/ReclaimBaseOracle.hs` | Supporting oracle | Test-only typed oracle used to check the raw ReclaimBase rewrite. It is not deployed and cannot be the subject substituted for the compiled script. |
| `test-support/ScriptContextBuilder.hs` | Supporting fixtures | Test/benchmark context builder. Its comments explicitly say it does not enforce every ledger invariant, so `validScriptContext` remains mandatory for on-chain claims. |

## Independent specification boundaries

These observations constrain the theorem statements; they are not themselves
proof results.

### ReclaimBase

- The current-source Base condition is exactly membership of the applied Data
  key in the transaction withdrawal map; withdrawal amount is irrelevant. The
  locked candidate applies the current-source GlobalV2 candidate credential,
  matching deployer construction order.
- Purpose, datum availability/shape, credential width, and parameter
  constructor do not affect this local decision.
- Ledger invocation and GlobalV2 own the spending-purpose, datum-credential,
  proof, destination, and complete-value obligations.
- Auditing that the applied key selects the intended GlobalV2 script is a
  one-time deployment obligation, not a repeated execution-time branch.

### ReclaimGlobalV2

- The first four V2 redeemer fields are authoritative: parameter reference
  index, destination output start index, proof list, and digest list. The
  constructor tag and harmless trailing fields are ignored.
- The selected params output must contain the configured policy and token name
  with quantity one. ADA and unrelated policies or token names are allowed.
- The params datum, base datum, addresses, Values, proofs, and digests are
  decoded through raw `BuiltinData`. The independent typed specification must
  describe the intended meanings; copying the unsafe field walks is not
  sufficient.
- Matching inputs are those whose resolved output payment credential is the
  base script hash from the selected parameter datum. Non-matching inputs are
  skipped without consuming proof/digest/destination slots.
- Every matching input consumes one 336-byte proof, one 32-byte claimed digest,
  and one destination output in ledger order. The digest is recomputed from
  the base credential and on-chain destination address before the proof is
  folded.
- Full multi-asset input Value must be componentwise covered by the paired
  destination output. Ledger normalization is a precondition of the optimized
  raw Value walk and must come from `validScriptContext`.
- The script rejects zero matching base inputs, list asymmetry, unused digests,
  missing/unused proofs, invalid widths, count overflow, bad statements,
  underpayment, and failed batch verification.

## Red-team decisions for theorem design

1. A theorem over one manifest instance may quantify over all contexts and be
   generalized over behavior, but helper properties that should be
   parameter-independent also need reusable closed-term proofs.
2. `isSuccessful -> P` is a safety theorem only. Functional correctness also
   needs an `authorized -> isSuccessful` theorem under explicit verifier and
   fuel assumptions.
3. CEK exhaustion is not contract rejection. Negative theorems must use a
   classifier that distinguishes the two.
4. `validScriptContext` is required for ledger-valid guarantees. Raw malformed
   `Data` checks are separate robustness results. A second predicate must bind
   that generic context to the exact artifact hash/currency symbol under proof;
   the ledger model cannot infer the currently executing script from UPLC bytes.
5. Finite list unrolling and repository fixtures are supporting evidence, not
   universal proofs. Recursive list theorems require induction or an explicit
   protocol bound.
6. The active V2 proof does not cover the manually exportable V1 or multi
   validators. No shared helper name may be used to imply otherwise.
7. An unexpected ledger-valid counterexample is preserved and replayed as a
   finding. The property may not be weakened to recover a green build.
8. The normative `ReclaimGlobalParams` and `ReclaimBaseDatum` constructor/field
   shapes are independent intended properties. The optimized global raw decoder
   does not get to define those predicates; broader acceptance must be
   falsified, replayed, and assessed at the composed-system boundary.

## Phase 0 evidence commands

```text
git rev-parse HEAD
git rev-parse <deployment-source>:contracts/ownership-verifier/{src,export,ownership-verifier.cabal}
rg "reclaimGlobalValidator.*Code|oneShotNFTPolicyCode|paramsHolderValidatorCode|reclaimBaseValidatorCode" contracts/ownership-verifier
jq '{deployment_id,source_commit,reclaim_base,reclaim_global,params_utxo,reference_scripts}' apps/ownership-proof-web/public/proof-assets/reclaim-deployment.json
```

Phase 1 must replace source-level confidence with regenerated bytes, script
hashes, Lean imports, and cross-evaluator decisions.

## Current disposition summary

- Active/supporting exact artifacts are regenerated and imported.
- ParamsHolder, OneShotNFT, and ReclaimBase generalized properties are
  classified.
- Two intended GlobalV2 typed datum-shape properties are falsified with
  ledger-valid, two-evaluator replays.
- Current-source GlobalV2 helper semantics and exact active/candidate concrete
  mutations are classified, but the generalized exact-monolith bridges are
  still open.
- The former `global` V1 export has been removed. `global-multi` is covered by
  the Haskell suite but not by a formal theorem catalog or production guard, so
  its separate coverage gate remains pending.
