import ProofToolFormal.ConcreteReplay
import ProofToolFormal.ReclaimBase

/-!
Replayable refutation of the deliberately inverted ReclaimBase authorization
claim in theorem-catalog entry RB-CEX-1.
-/

namespace ProofToolFormal.ReclaimBaseCounterexample

open CardanoLedgerApi.V3
open CardanoLedgerApi.V3.Contexts
open ProofToolFormal.Artifacts
open ProofToolFormal.ConcreteReplay
open ProofToolFormal.ContextGoldens
open ProofToolFormal.ModelBoundary
open ProofToolFormal.Result

def exactReplayResult (ctx : ScriptContext) : BoundedCekResult :=
  executeProgramClassified reclaimBase.script (spendingInputs ctx) replaySteps

def unsafeSuccessWithoutAuthorization : Prop :=
  ∀ ctx : ScriptContext,
    validActiveReclaimBaseContext ctx = true →
    (exactReplayResult ctx).isSuccessful →
    ReclaimBase.authorized ctx = false

set_option maxRecDepth 100000 in
theorem golden_falsifies_unsafe_success_without_authorization :
    ¬ unsafeSuccessWithoutAuthorization := by
  intro hUnsafe
  have replayEq : exactReplayResult reclaimBaseContext = reclaimBaseResult := rfl
  have succeeds : (exactReplayResult reclaimBaseContext).isSuccessful := by
    rw [replayEq]
    exact exact_reclaimBase_golden_isSuccessful
  have impossible := hUnsafe reclaimBaseContext
    reclaimBase_bound_to_active_artifact succeeds
  have isAuthorized : ReclaimBase.authorized reclaimBaseContext = true := by
    native_decide
  rw [isAuthorized] at impossible
  contradiction

#print axioms golden_falsifies_unsafe_success_without_authorization

end ProofToolFormal.ReclaimBaseCounterexample
