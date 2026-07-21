import ProofToolFormal.Artifacts
import ProofToolFormal.ContextGoldens
import ProofToolFormal.ModelBoundary
import ProofToolFormal.Result

/-!
Exact active ReclaimBase artifact under a legacy module name retained for proof
history. Generalized business semantics are stated independently below; the
exact compiled replays are non-vacuity and cross-evaluator anchors, not a
substitute for the still-pending inductive compiled-list bridge.
-/

namespace ProofToolFormal.ReclaimBaseCandidate

open CardanoLedgerApi.V3
open CardanoLedgerApi.V3.Contexts
open ProofToolFormal.Artifacts
open ProofToolFormal.ContextGoldens
open ProofToolFormal.ModelBoundary
open ProofToolFormal.Result

def candidateGlobalCredential : Credential :=
  .ScriptCredential candidateReclaimGlobalV2Hash

def hasConfiguredWithdrawal (ctx : ScriptContext) : Bool :=
  credentialInWithdrawals candidateGlobalCredential ctx.scriptContextTxInfo.txInfoWdrl

theorem configured_withdrawal_ignores_script_info
    (ctx : ScriptContext)
    (scriptInfo : ScriptInfo) :
    hasConfiguredWithdrawal
        { ctx with scriptContextScriptInfo := scriptInfo } =
      hasConfiguredWithdrawal ctx := by
  rfl

def candidateReplaySteps : Nat := 2_000_000

def candidateGoldenResult : BoundedCekResult :=
  executeProgramClassified
    reclaimBaseCandidate.script
    (spendingInputs candidateReclaimBaseContext)
    candidateReplaySteps

def candidateMissingWithdrawalResult : BoundedCekResult :=
  executeProgramClassified
    reclaimBaseCandidate.script
    (spendingInputs candidateReclaimBaseMissingWithdrawalContext)
    candidateReplaySteps

def candidateShortDatumResult : BoundedCekResult :=
  executeProgramClassified
    reclaimBaseCandidate.script
    (spendingInputs candidateReclaimBaseShortDatumContext)
    candidateReplaySteps

def candidateNoncanonicalDatumResult : BoundedCekResult :=
  executeProgramClassified
    reclaimBaseCandidate.script
    (spendingInputs candidateReclaimBaseNoncanonicalDatumContext)
    candidateReplaySteps

theorem exact_candidate_golden_succeeds :
    classifyBoundedResult true candidateGoldenResult = .successfulHalt := by
  native_decide

theorem exact_candidate_missing_withdrawal_rejects_within_fuel :
    classifyBoundedResult true candidateMissingWithdrawalResult = .validatorError := by
  native_decide

theorem exact_candidate_short_datum_succeeds :
    classifyBoundedResult true candidateShortDatumResult = .successfulHalt := by
  native_decide

theorem exact_candidate_noncanonical_datum_succeeds :
    classifyBoundedResult true candidateNoncanonicalDatumResult = .successfulHalt := by
  native_decide

#print axioms configured_withdrawal_ignores_script_info
#print axioms exact_candidate_golden_succeeds
#print axioms exact_candidate_missing_withdrawal_rejects_within_fuel
#print axioms exact_candidate_short_datum_succeeds
#print axioms exact_candidate_noncanonical_datum_succeeds

end ProofToolFormal.ReclaimBaseCandidate
