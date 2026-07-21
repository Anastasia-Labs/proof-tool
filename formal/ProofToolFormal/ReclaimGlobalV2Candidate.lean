import ProofToolFormal.Artifacts
import ProofToolFormal.ContextGoldens
import ProofToolFormal.Result

/-!
Concrete replays for the exact current-source ReclaimGlobalV2 candidate. These
fixtures establish that the separately locked candidate is executable and
retains the expected positive and adversarial decisions. They are finite
regression anchors, not a universal correctness proof and not evidence about
the distinct deployed Preprod bytes.
-/

namespace ProofToolFormal.ReclaimGlobalV2Candidate

open CardanoLedgerApi.V3.Contexts
open ProofToolFormal.Artifacts
open ProofToolFormal.ContextGoldens
open ProofToolFormal.Result

def candidateReplaySteps : Nat := 2_000_000

def candidateMalformedRedeemerResult : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2Candidate.script
    (rewardingInputs candidateReclaimGlobalV2Context)
    candidateReplaySteps

def candidateSuccessResult : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2Candidate.script
    (rewardingInputs candidateReclaimGlobalV2SuccessContext)
    candidateReplaySteps

def candidateSubstitutedDigestResult : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2Candidate.script
    (rewardingInputs candidateReclaimGlobalV2SubstitutedDigestContext)
    candidateReplaySteps

def candidateNoncanonicalParamDatumResult : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2Candidate.script
    (rewardingInputs candidateReclaimGlobalV2NoncanonicalParamDatumContext)
    candidateReplaySteps

def candidateNoncanonicalBaseDatumResult : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2Candidate.script
    (rewardingInputs candidateReclaimGlobalV2NoncanonicalBaseDatumContext)
    candidateReplaySteps

theorem exact_candidate_unit_redeemer_rejects_within_fuel :
    classifyBoundedResult true candidateMalformedRedeemerResult =
      .validatorError := by
  native_decide

theorem exact_candidate_real_proof_succeeds :
    classifyBoundedResult true candidateSuccessResult = .successfulHalt := by
  native_decide

theorem exact_candidate_substituted_digest_rejects_within_fuel :
    classifyBoundedResult true candidateSubstitutedDigestResult =
      .validatorError := by
  native_decide

theorem exact_candidate_noncanonical_param_datum_tag_succeeds :
    classifyBoundedResult true candidateNoncanonicalParamDatumResult =
      .successfulHalt := by
  native_decide

theorem exact_candidate_noncanonical_base_datum_tag_succeeds :
    classifyBoundedResult true candidateNoncanonicalBaseDatumResult =
      .successfulHalt := by
  native_decide

#print axioms exact_candidate_unit_redeemer_rejects_within_fuel
#print axioms exact_candidate_real_proof_succeeds
#print axioms exact_candidate_substituted_digest_rejects_within_fuel
#print axioms exact_candidate_noncanonical_param_datum_tag_succeeds
#print axioms exact_candidate_noncanonical_base_datum_tag_succeeds

end ProofToolFormal.ReclaimGlobalV2Candidate
