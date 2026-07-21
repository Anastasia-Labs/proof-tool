import ProofToolFormal.Artifacts
import ProofToolFormal.Result

/-!
The active parameter-holder artifact is intentionally immutable: its compiled
validator ignores its single `Data` argument and enters CEK error. This theorem
is over the exact locked UPLC program, not only the Haskell source function.
-/

namespace ProofToolFormal.ParamsHolder

open PlutusCore.Data (Data)
open PlutusCore.UPLC.CekMachine
open ProofToolFormal.Artifacts
open ProofToolFormal.Result

def paramsHolderSteps : Nat := 20

def paramsHolderResult (argument : Data) : BoundedCekResult :=
  executeProgramClassified
    paramsHolder.script
    [PlutusCore.UPLC.Term.Term.Const (PlutusCore.UPLC.Term.Const.Data argument)]
    paramsHolderSteps

theorem exact_paramsHolder_always_errors (argument : Data) :
    classifyBoundedResult true (paramsHolderResult argument) = .validatorError := by
  simp [paramsHolderResult, paramsHolderSteps, executeProgramClassified,
    runStepsClassified, classifyBoundedResult, applyParams, initialState, step, paramsHolder]

theorem exact_paramsHolder_never_succeeds (argument : Data) :
    classifyBoundedResult true (paramsHolderResult argument) ≠ .successfulHalt := by
  simp [exact_paramsHolder_always_errors]

#print axioms exact_paramsHolder_always_errors
#print axioms exact_paramsHolder_never_succeeds

end ProofToolFormal.ParamsHolder
