import ProofToolFormal.Artifacts
import ProofToolFormal.ContextGoldens
import ProofToolFormal.Result

/-!
Concrete cross-evaluator anchors for the exact locked artifacts. These are
finite fixture replays, not generalized contract proofs. Their role is to
validate the artifact/application/CEK boundary before symbolic proofs compose
over it.
-/

namespace ProofToolFormal.ConcreteReplay

open CardanoLedgerApi.V3.Contexts
open ProofToolFormal.Artifacts
open ProofToolFormal.ContextGoldens
open ProofToolFormal.Result

def replaySteps : Nat := 2_000_000

def oneShotResult : BoundedCekResult :=
  executeProgramClassified oneShotParamsNFT.script (mintingInputs oneShotContext) replaySteps

def reclaimBaseResult : BoundedCekResult :=
  executeProgramClassified reclaimBase.script (spendingInputs reclaimBaseContext) replaySteps

def reclaimBaseMissingWithdrawalResult : BoundedCekResult :=
  executeProgramClassified
    reclaimBase.script
    (spendingInputs reclaimBaseMissingWithdrawalContext)
    replaySteps

def reclaimBaseShortDatumResult : BoundedCekResult :=
  executeProgramClassified
    reclaimBase.script
    (spendingInputs reclaimBaseShortDatumContext)
    replaySteps

def reclaimBaseNoncanonicalDatumResult : BoundedCekResult :=
  executeProgramClassified
    reclaimBase.script
    (spendingInputs reclaimBaseNoncanonicalDatumContext)
    replaySteps

def reclaimGlobalV2MalformedRedeemerResult : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2.script
    (rewardingInputs reclaimGlobalV2Context)
    replaySteps

def reclaimGlobalV2SuccessResult : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2.script
    (rewardingInputs reclaimGlobalV2SuccessContext)
    replaySteps

def reclaimGlobalV2SubstitutedDigestResult : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2.script
    (rewardingInputs reclaimGlobalV2SubstitutedDigestContext)
    replaySteps

def reclaimGlobalV2NoncanonicalParamDatumResult : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2.script
    (rewardingInputs reclaimGlobalV2NoncanonicalParamDatumContext)
    replaySteps

def reclaimGlobalV2NoncanonicalBaseDatumResult : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2.script
    (rewardingInputs reclaimGlobalV2NoncanonicalBaseDatumContext)
    replaySteps

theorem exact_oneShot_golden_succeeds :
    classifyBoundedResult true oneShotResult = .successfulHalt := by
  native_decide

set_option maxRecDepth 100000 in
theorem exact_oneShot_golden_isSuccessful : oneShotResult.isSuccessful :=
  (wellFormed_successful_iff oneShotResult).mp exact_oneShot_golden_succeeds

theorem exact_reclaimBase_golden_succeeds :
    classifyBoundedResult true reclaimBaseResult = .successfulHalt := by
  native_decide

set_option maxRecDepth 100000 in
theorem exact_reclaimBase_golden_isSuccessful : reclaimBaseResult.isSuccessful :=
  (wellFormed_successful_iff reclaimBaseResult).mp exact_reclaimBase_golden_succeeds

theorem exact_reclaimBase_missing_withdrawal_rejects_within_fuel :
    classifyBoundedResult true reclaimBaseMissingWithdrawalResult = .validatorError := by
  native_decide

theorem exact_reclaimBase_short_datum_rejects_within_fuel :
    classifyBoundedResult true reclaimBaseShortDatumResult = .validatorError := by
  native_decide

theorem exact_reclaimBase_noncanonical_datum_tag_rejects_within_fuel :
    classifyBoundedResult true reclaimBaseNoncanonicalDatumResult = .validatorError := by
  native_decide

theorem exact_reclaimGlobalV2_unit_redeemer_rejects_within_fuel :
    classifyBoundedResult true reclaimGlobalV2MalformedRedeemerResult = .validatorError := by
  native_decide

theorem exact_reclaimGlobalV2_real_proof_succeeds :
    classifyBoundedResult true reclaimGlobalV2SuccessResult = .successfulHalt := by
  native_decide

theorem exact_reclaimGlobalV2_substituted_digest_rejects_within_fuel :
    classifyBoundedResult true reclaimGlobalV2SubstitutedDigestResult = .validatorError := by
  native_decide

theorem exact_reclaimGlobalV2_noncanonical_param_datum_tag_succeeds :
    classifyBoundedResult true reclaimGlobalV2NoncanonicalParamDatumResult =
      .successfulHalt := by
  native_decide

theorem exact_reclaimGlobalV2_noncanonical_base_datum_tag_succeeds :
    classifyBoundedResult true reclaimGlobalV2NoncanonicalBaseDatumResult =
      .successfulHalt := by
  native_decide

end ProofToolFormal.ConcreteReplay
