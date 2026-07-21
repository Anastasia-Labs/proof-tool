import CardanoLedgerApi.V3
import PlutusCore.Cbor.Basic
import PlutusCore.UPLC.ScriptEncoding
import ProofToolFormal.ContextGoldensGenerated
import ProofToolFormal.ModelBoundary

/-!
Cross-language golden contexts generated from the production Haskell Plutus V3
types and the repository's `ScriptContextBuilder`. The theorems below ensure
that Lean decodes exactly the same CBOR `Data`, re-encodes it byte-for-byte,
accepts the typed context as ledger-valid, and binds it to the intended active
artifact identity.
-/

namespace ProofToolFormal.ContextGoldens

open CardanoLedgerApi.IsData.Class
open CardanoLedgerApi.V3
open CardanoLedgerApi.V3.Contexts
open ProofToolFormal.ModelBoundary

private def binaryFromHex! (hex : String) : String :=
  match PlutusCore.UPLC.ScriptEncoding.Internal.hexStringToString hex.data [] with
  | some bytes => String.mk bytes
  | none => panic! "invalid generated context CBOR hex"

private def decodeScriptContext (hex : String) : Option ScriptContext := do
  let (remaining, data) ← PlutusCore.Cbor.decodeData (binaryFromHex! hex)
  if remaining.isEmpty then IsData.fromData data else none

private theorem oneShot_decodes :
    (decodeScriptContext Generated.oneShotDataCborHex).isSome := by
  native_decide

private theorem reclaimBase_decodes :
    (decodeScriptContext Generated.reclaimBaseDataCborHex).isSome := by
  native_decide

private theorem reclaimBaseMissingWithdrawal_decodes :
    (decodeScriptContext Generated.reclaimBaseMissingWithdrawalDataCborHex).isSome := by
  native_decide

private theorem reclaimBaseShortDatum_decodes :
    (decodeScriptContext Generated.reclaimBaseShortDatumDataCborHex).isSome := by
  native_decide

private theorem reclaimBaseNoncanonicalDatum_decodes :
    (decodeScriptContext Generated.reclaimBaseNoncanonicalDatumDataCborHex).isSome := by
  native_decide

private theorem reclaimGlobalV2Success_decodes :
    (decodeScriptContext Generated.reclaimGlobalV2SuccessDataCborHex).isSome := by
  native_decide

private theorem reclaimGlobalV2SubstitutedDigest_decodes :
    (decodeScriptContext Generated.reclaimGlobalV2SubstitutedDigestDataCborHex).isSome := by
  native_decide

private theorem reclaimGlobalV2NoncanonicalParamDatum_decodes :
    (decodeScriptContext Generated.reclaimGlobalV2NoncanonicalParamDatumDataCborHex).isSome := by
  native_decide

private theorem reclaimGlobalV2NoncanonicalBaseDatum_decodes :
    (decodeScriptContext Generated.reclaimGlobalV2NoncanonicalBaseDatumDataCborHex).isSome := by
  native_decide

private theorem reclaimGlobalV2MalformedRedeemer_decodes :
    (decodeScriptContext Generated.reclaimGlobalV2MalformedRedeemerDataCborHex).isSome := by
  native_decide

private theorem candidateReclaimBase_decodes :
    (decodeScriptContext Generated.candidateReclaimBaseDataCborHex).isSome := by
  native_decide

private theorem candidateReclaimBaseMissingWithdrawal_decodes :
    (decodeScriptContext Generated.candidateReclaimBaseMissingWithdrawalDataCborHex).isSome := by
  native_decide

private theorem candidateReclaimBaseShortDatum_decodes :
    (decodeScriptContext Generated.candidateReclaimBaseShortDatumDataCborHex).isSome := by
  native_decide

private theorem candidateReclaimBaseNoncanonicalDatum_decodes :
    (decodeScriptContext Generated.candidateReclaimBaseNoncanonicalDatumDataCborHex).isSome := by
  native_decide

private theorem candidateReclaimGlobalV2Success_decodes :
    (decodeScriptContext Generated.candidateReclaimGlobalV2SuccessDataCborHex).isSome := by
  native_decide

private theorem candidateReclaimGlobalV2SubstitutedDigest_decodes :
    (decodeScriptContext Generated.candidateReclaimGlobalV2SubstitutedDigestDataCborHex).isSome := by
  native_decide

private theorem candidateReclaimGlobalV2NoncanonicalParamDatum_decodes :
    (decodeScriptContext
      Generated.candidateReclaimGlobalV2NoncanonicalParamDatumDataCborHex).isSome := by
  native_decide

private theorem candidateReclaimGlobalV2NoncanonicalBaseDatum_decodes :
    (decodeScriptContext
      Generated.candidateReclaimGlobalV2NoncanonicalBaseDatumDataCborHex).isSome := by
  native_decide

private theorem candidateReclaimGlobalV2MalformedRedeemer_decodes :
    (decodeScriptContext
      Generated.candidateReclaimGlobalV2MalformedRedeemerDataCborHex).isSome := by
  native_decide

def oneShotContext : ScriptContext :=
  (decodeScriptContext Generated.oneShotDataCborHex).get oneShot_decodes

def reclaimBaseContext : ScriptContext :=
  (decodeScriptContext Generated.reclaimBaseDataCborHex).get reclaimBase_decodes

def reclaimBaseMissingWithdrawalContext : ScriptContext :=
  (decodeScriptContext Generated.reclaimBaseMissingWithdrawalDataCborHex).get
    reclaimBaseMissingWithdrawal_decodes

def reclaimBaseShortDatumContext : ScriptContext :=
  (decodeScriptContext Generated.reclaimBaseShortDatumDataCborHex).get
    reclaimBaseShortDatum_decodes

def reclaimBaseNoncanonicalDatumContext : ScriptContext :=
  (decodeScriptContext Generated.reclaimBaseNoncanonicalDatumDataCborHex).get
    reclaimBaseNoncanonicalDatum_decodes

def reclaimGlobalV2SuccessContext : ScriptContext :=
  (decodeScriptContext Generated.reclaimGlobalV2SuccessDataCborHex).get
    reclaimGlobalV2Success_decodes

def reclaimGlobalV2SubstitutedDigestContext : ScriptContext :=
  (decodeScriptContext Generated.reclaimGlobalV2SubstitutedDigestDataCborHex).get
    reclaimGlobalV2SubstitutedDigest_decodes

def reclaimGlobalV2NoncanonicalParamDatumContext : ScriptContext :=
  (decodeScriptContext Generated.reclaimGlobalV2NoncanonicalParamDatumDataCborHex).get
    reclaimGlobalV2NoncanonicalParamDatum_decodes

def reclaimGlobalV2NoncanonicalBaseDatumContext : ScriptContext :=
  (decodeScriptContext Generated.reclaimGlobalV2NoncanonicalBaseDatumDataCborHex).get
    reclaimGlobalV2NoncanonicalBaseDatum_decodes

def reclaimGlobalV2Context : ScriptContext :=
  (decodeScriptContext Generated.reclaimGlobalV2MalformedRedeemerDataCborHex).get
    reclaimGlobalV2MalformedRedeemer_decodes

def candidateReclaimBaseContext : ScriptContext :=
  (decodeScriptContext Generated.candidateReclaimBaseDataCborHex).get
    candidateReclaimBase_decodes

def candidateReclaimBaseMissingWithdrawalContext : ScriptContext :=
  (decodeScriptContext Generated.candidateReclaimBaseMissingWithdrawalDataCborHex).get
    candidateReclaimBaseMissingWithdrawal_decodes

def candidateReclaimBaseShortDatumContext : ScriptContext :=
  (decodeScriptContext Generated.candidateReclaimBaseShortDatumDataCborHex).get
    candidateReclaimBaseShortDatum_decodes

def candidateReclaimBaseNoncanonicalDatumContext : ScriptContext :=
  (decodeScriptContext Generated.candidateReclaimBaseNoncanonicalDatumDataCborHex).get
    candidateReclaimBaseNoncanonicalDatum_decodes

def candidateReclaimGlobalV2SuccessContext : ScriptContext :=
  (decodeScriptContext Generated.candidateReclaimGlobalV2SuccessDataCborHex).get
    candidateReclaimGlobalV2Success_decodes

def candidateReclaimGlobalV2SubstitutedDigestContext : ScriptContext :=
  (decodeScriptContext Generated.candidateReclaimGlobalV2SubstitutedDigestDataCborHex).get
    candidateReclaimGlobalV2SubstitutedDigest_decodes

def candidateReclaimGlobalV2NoncanonicalParamDatumContext : ScriptContext :=
  (decodeScriptContext
      Generated.candidateReclaimGlobalV2NoncanonicalParamDatumDataCborHex).get
    candidateReclaimGlobalV2NoncanonicalParamDatum_decodes

def candidateReclaimGlobalV2NoncanonicalBaseDatumContext : ScriptContext :=
  (decodeScriptContext
      Generated.candidateReclaimGlobalV2NoncanonicalBaseDatumDataCborHex).get
    candidateReclaimGlobalV2NoncanonicalBaseDatum_decodes

def candidateReclaimGlobalV2Context : ScriptContext :=
  (decodeScriptContext
      Generated.candidateReclaimGlobalV2MalformedRedeemerDataCborHex).get
    candidateReclaimGlobalV2MalformedRedeemer_decodes

theorem oneShot_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData (binaryFromHex! Generated.oneShotDataCborHex) =
      some ("", IsData.toData oneShotContext) := by
  native_decide

theorem reclaimBase_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData (binaryFromHex! Generated.reclaimBaseDataCborHex) =
      some ("", IsData.toData reclaimBaseContext) := by
  native_decide

theorem reclaimBaseMissingWithdrawal_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData
        (binaryFromHex! Generated.reclaimBaseMissingWithdrawalDataCborHex) =
      some ("", IsData.toData reclaimBaseMissingWithdrawalContext) := by
  native_decide

theorem reclaimBaseShortDatum_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData
        (binaryFromHex! Generated.reclaimBaseShortDatumDataCborHex) =
      some ("", IsData.toData reclaimBaseShortDatumContext) := by
  native_decide

theorem reclaimBaseNoncanonicalDatum_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData
        (binaryFromHex! Generated.reclaimBaseNoncanonicalDatumDataCborHex) =
      some ("", IsData.toData reclaimBaseNoncanonicalDatumContext) := by
  native_decide

theorem reclaimGlobalV2_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData
        (binaryFromHex! Generated.reclaimGlobalV2MalformedRedeemerDataCborHex) =
      some ("", IsData.toData reclaimGlobalV2Context) := by
  native_decide

theorem reclaimGlobalV2Success_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData
        (binaryFromHex! Generated.reclaimGlobalV2SuccessDataCborHex) =
      some ("", IsData.toData reclaimGlobalV2SuccessContext) := by
  native_decide

theorem reclaimGlobalV2SubstitutedDigest_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData
        (binaryFromHex! Generated.reclaimGlobalV2SubstitutedDigestDataCborHex) =
      some ("", IsData.toData reclaimGlobalV2SubstitutedDigestContext) := by
  native_decide

theorem reclaimGlobalV2NoncanonicalParamDatum_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData
        (binaryFromHex! Generated.reclaimGlobalV2NoncanonicalParamDatumDataCborHex) =
      some ("", IsData.toData reclaimGlobalV2NoncanonicalParamDatumContext) := by
  native_decide

theorem reclaimGlobalV2NoncanonicalBaseDatum_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData
        (binaryFromHex! Generated.reclaimGlobalV2NoncanonicalBaseDatumDataCborHex) =
      some ("", IsData.toData reclaimGlobalV2NoncanonicalBaseDatumContext) := by
  native_decide

theorem candidateReclaimBase_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData
        (binaryFromHex! Generated.candidateReclaimBaseDataCborHex) =
      some ("", IsData.toData candidateReclaimBaseContext) := by
  native_decide

theorem candidateReclaimGlobalV2Success_haskell_cbor_decodes_exactly :
    PlutusCore.Cbor.decodeData
        (binaryFromHex! Generated.candidateReclaimGlobalV2SuccessDataCborHex) =
      some ("", IsData.toData candidateReclaimGlobalV2SuccessContext) := by
  native_decide

theorem oneShot_ledger_valid : validScriptContext oneShotContext = true := by
  native_decide

theorem reclaimBase_ledger_valid : validScriptContext reclaimBaseContext = true := by
  native_decide

theorem reclaimBaseMissingWithdrawal_ledger_valid :
    validScriptContext reclaimBaseMissingWithdrawalContext = true := by
  native_decide

theorem reclaimBaseShortDatum_ledger_valid :
    validScriptContext reclaimBaseShortDatumContext = true := by
  native_decide

theorem reclaimBaseNoncanonicalDatum_ledger_valid :
    validScriptContext reclaimBaseNoncanonicalDatumContext = true := by
  native_decide

theorem reclaimGlobalV2_ledger_valid : validScriptContext reclaimGlobalV2Context = true := by
  native_decide

theorem reclaimGlobalV2Success_ledger_valid :
    validScriptContext reclaimGlobalV2SuccessContext = true := by
  native_decide

theorem reclaimGlobalV2SubstitutedDigest_ledger_valid :
    validScriptContext reclaimGlobalV2SubstitutedDigestContext = true := by
  native_decide

theorem reclaimGlobalV2NoncanonicalParamDatum_ledger_valid :
    validScriptContext reclaimGlobalV2NoncanonicalParamDatumContext = true := by
  native_decide

theorem reclaimGlobalV2NoncanonicalBaseDatum_ledger_valid :
    validScriptContext reclaimGlobalV2NoncanonicalBaseDatumContext = true := by
  native_decide

theorem candidateReclaimBase_ledger_valid :
    validScriptContext candidateReclaimBaseContext = true := by
  native_decide

theorem candidateReclaimBaseMissingWithdrawal_ledger_valid :
    validScriptContext candidateReclaimBaseMissingWithdrawalContext = true := by
  native_decide

theorem candidateReclaimBaseShortDatum_ledger_valid :
    validScriptContext candidateReclaimBaseShortDatumContext = true := by
  native_decide

theorem candidateReclaimBaseNoncanonicalDatum_ledger_valid :
    validScriptContext candidateReclaimBaseNoncanonicalDatumContext = true := by
  native_decide

theorem candidateReclaimGlobalV2Success_ledger_valid :
    validScriptContext candidateReclaimGlobalV2SuccessContext = true := by
  native_decide

theorem candidateReclaimGlobalV2SubstitutedDigest_ledger_valid :
    validScriptContext candidateReclaimGlobalV2SubstitutedDigestContext = true := by
  native_decide

theorem candidateReclaimGlobalV2NoncanonicalParamDatum_ledger_valid :
    validScriptContext candidateReclaimGlobalV2NoncanonicalParamDatumContext = true := by
  native_decide

theorem candidateReclaimGlobalV2NoncanonicalBaseDatum_ledger_valid :
    validScriptContext candidateReclaimGlobalV2NoncanonicalBaseDatumContext = true := by
  native_decide

theorem candidateReclaimGlobalV2MalformedRedeemer_ledger_valid :
    validScriptContext candidateReclaimGlobalV2Context = true := by
  native_decide

theorem oneShot_bound_to_active_artifact : validActiveOneShotContext oneShotContext = true := by
  native_decide

theorem reclaimBase_bound_to_active_artifact :
    validActiveReclaimBaseContext reclaimBaseContext = true := by
  native_decide

theorem reclaimBaseMissingWithdrawal_bound_to_active_artifact :
    validActiveReclaimBaseContext reclaimBaseMissingWithdrawalContext = true := by
  native_decide

theorem reclaimBaseShortDatum_bound_to_active_artifact :
    validActiveReclaimBaseContext reclaimBaseShortDatumContext = true := by
  native_decide

theorem reclaimBaseNoncanonicalDatum_bound_to_active_artifact :
    validActiveReclaimBaseContext reclaimBaseNoncanonicalDatumContext = true := by
  native_decide

theorem reclaimGlobalV2_bound_to_active_artifact :
    validActiveReclaimGlobalV2Context reclaimGlobalV2Context = true := by
  native_decide

theorem reclaimGlobalV2Success_bound_to_active_artifact :
    validActiveReclaimGlobalV2Context reclaimGlobalV2SuccessContext = true := by
  native_decide

theorem reclaimGlobalV2SubstitutedDigest_bound_to_active_artifact :
    validActiveReclaimGlobalV2Context reclaimGlobalV2SubstitutedDigestContext = true := by
  native_decide

theorem reclaimGlobalV2NoncanonicalParamDatum_bound_to_active_artifact :
    validActiveReclaimGlobalV2Context
      reclaimGlobalV2NoncanonicalParamDatumContext = true := by
  native_decide

theorem reclaimGlobalV2NoncanonicalBaseDatum_bound_to_active_artifact :
    validActiveReclaimGlobalV2Context
      reclaimGlobalV2NoncanonicalBaseDatumContext = true := by
  native_decide

theorem candidateReclaimBase_bound_to_candidate_artifact :
    validCandidateReclaimBaseContext candidateReclaimBaseContext = true := by
  native_decide

theorem candidateReclaimBaseMissingWithdrawal_bound_to_candidate_artifact :
    validCandidateReclaimBaseContext
      candidateReclaimBaseMissingWithdrawalContext = true := by
  native_decide

theorem candidateReclaimBaseShortDatum_bound_to_candidate_artifact :
    validCandidateReclaimBaseContext candidateReclaimBaseShortDatumContext = true := by
  native_decide

theorem candidateReclaimBaseNoncanonicalDatum_bound_to_candidate_artifact :
    validCandidateReclaimBaseContext
      candidateReclaimBaseNoncanonicalDatumContext = true := by
  native_decide

theorem candidateReclaimGlobalV2Success_bound_to_candidate_artifact :
    validCandidateReclaimGlobalV2Context
      candidateReclaimGlobalV2SuccessContext = true := by
  native_decide

theorem candidateReclaimGlobalV2SubstitutedDigest_bound_to_candidate_artifact :
    validCandidateReclaimGlobalV2Context
      candidateReclaimGlobalV2SubstitutedDigestContext = true := by
  native_decide

theorem candidateReclaimGlobalV2NoncanonicalParamDatum_bound_to_candidate_artifact :
    validCandidateReclaimGlobalV2Context
      candidateReclaimGlobalV2NoncanonicalParamDatumContext = true := by
  native_decide

theorem candidateReclaimGlobalV2NoncanonicalBaseDatum_bound_to_candidate_artifact :
    validCandidateReclaimGlobalV2Context
      candidateReclaimGlobalV2NoncanonicalBaseDatumContext = true := by
  native_decide

theorem candidateReclaimGlobalV2MalformedRedeemer_bound_to_candidate_artifact :
    validCandidateReclaimGlobalV2Context candidateReclaimGlobalV2Context = true := by
  native_decide

theorem reclaimBase_not_bound_to_global_artifact :
    validContextForArtifact
      (.spending activeReclaimGlobalV2Hash)
      reclaimBaseContext = false := by
  native_decide

theorem reclaimGlobalV2_not_bound_to_base_artifact :
    validContextForArtifact
      (.rewarding activeReclaimBaseHash)
      reclaimGlobalV2Context = false := by
  native_decide

theorem oneShot_not_bound_to_base_identity :
    validContextForArtifact
      (.minting activeReclaimBaseHash)
      oneShotContext = false := by
  native_decide

end ProofToolFormal.ContextGoldens
