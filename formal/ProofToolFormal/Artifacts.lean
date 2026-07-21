import PlutusCore.UPLC

/-!
Exact public Preprod artifacts plus explicitly separated current-source
candidates and helpers.

Each file is the lowercase `script` field emitted by the production Cabal
exporter in `single_cbor_hex` format. The artifact-lock script verifies files
under `active-preprod` against the public deployment. Candidate files are
round-tripped and hashed separately and are never attributed to that lock.
-/

namespace ProofToolFormal.Artifacts

#import_uplc oneShotParamsNFT PlutusV3 single_cbor_hex "artifacts/active-preprod/one-shot-params-nft.cbor.hex"
#import_uplc paramsHolder PlutusV3 single_cbor_hex "artifacts/active-preprod/reclaim-params-holder.cbor.hex"
#import_uplc reclaimBase PlutusV3 single_cbor_hex "artifacts/active-preprod/reclaim-base.cbor.hex"
/-
Current source-exported ReclaimBase candidate after the withdrawal-only
simplification. It is intentionally separate from the deployed Preprod artifact
until a later deployment updates the public identity.
-/
#import_uplc reclaimBaseCandidate PlutusV3 single_cbor_hex "artifacts/candidate/reclaim-base.cbor.hex"
#import_uplc reclaimGlobalV2 PlutusV3 single_cbor_hex "artifacts/active-preprod/reclaim-global-v2.cbor.hex"
/-
Current source-exported canonical ReclaimGlobalV2 candidate after the V1
retirement. It is not byte-identical to the deployed Preprod artifact and is
therefore imported under a distinct name and identity.
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
