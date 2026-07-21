import PlutusCore.UPLC

/-!
Exact public Preprod artifacts plus legacy-named proof aliases and helpers.

Each file is the lowercase `script` field emitted by the production Cabal
exporter in `single_cbor_hex` format. The artifact-lock script verifies files
under `active-preprod` against the public deployment. The files under
`candidate` are byte-identical aliases retained so existing proof names remain
stable; the verification script rejects any divergence from active bytes.
-/

namespace ProofToolFormal.Artifacts

#import_uplc oneShotParamsNFT PlutusV3 single_cbor_hex "artifacts/active-preprod/one-shot-params-nft.cbor.hex"
#import_uplc paramsHolder PlutusV3 single_cbor_hex "artifacts/active-preprod/reclaim-params-holder.cbor.hex"
#import_uplc reclaimBase PlutusV3 single_cbor_hex "artifacts/active-preprod/reclaim-base.cbor.hex"
/-
Legacy-named alias of the active withdrawal-only ReclaimBase artifact.
-/
#import_uplc reclaimBaseCandidate PlutusV3 single_cbor_hex "artifacts/candidate/reclaim-base.cbor.hex"
#import_uplc reclaimGlobalV2 PlutusV3 single_cbor_hex "artifacts/active-preprod/reclaim-global-v2.cbor.hex"
/-
Legacy-named alias of the active canonical ReclaimGlobalV2 artifact.
-/
#import_uplc reclaimGlobalV2Candidate PlutusV3 single_cbor_hex "artifacts/candidate/reclaim-global-v2.cbor.hex"

/- Exact current-source code before the ReclaimBase credential parameter is applied. -/
#import_uplc reclaimBaseParameterized PlutusV3 single_cbor_hex "artifacts/helpers/reclaim-base-parameterized.cbor.hex"
#import_uplc oneShotParameterized PlutusV3 single_cbor_hex "artifacts/helpers/one-shot-parameterized.cbor.hex"
#import_uplc findReferenceInputEquals PlutusV3 single_cbor_hex "artifacts/helpers/find-reference-input-equals.cbor.hex"
#import_uplc hasExactParamToken PlutusV3 single_cbor_hex "artifacts/helpers/has-exact-param-token.cbor.hex"
#import_uplc valueCovers PlutusV3 single_cbor_hex "artifacts/helpers/value-covers.cbor.hex"
#import_uplc statementDigestEquals PlutusV3 single_cbor_hex "artifacts/helpers/statement-digest-equals.cbor.hex"
#import_uplc batchTranscriptV2Equals PlutusV3 single_cbor_hex "artifacts/helpers/batch-transcript-v2-equals.cbor.hex"

end ProofToolFormal.Artifacts
