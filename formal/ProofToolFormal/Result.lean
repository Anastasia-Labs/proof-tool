import PlutusCore.UPLC

/-!
Upstream `CekMachine.runSteps` returns `State.Error` both for a real CEK error
and when its step counter reaches zero. Therefore `cekExecuteProgram` and
`#prep_uplc` cannot, by themselves, justify a logical-rejection claim at a
finite bound. This wrapper preserves the terminal distinction explicitly.

Input well-formedness remains separate because malformed raw `Data` and a
well-formed logical rejection can both reach a genuine CEK error.
-/

namespace ProofToolFormal.Result

open PlutusCore.UPLC
open PlutusCore.UPLC.CekMachine

inductive BoundedCekResult where
  | halted : PlutusCore.UPLC.CekValue.CekValue → BoundedCekResult
  | machineError
  | stepLimitExhausted : State → BoundedCekResult

def BoundedCekResult.isSuccessful : BoundedCekResult → Prop
  | .halted _ => True
  | _ => False

def BoundedCekResult.isMachineError : BoundedCekResult → Prop
  | .machineError => True
  | _ => False

def BoundedCekResult.withinFuel : BoundedCekResult → Prop
  | .stepLimitExhausted _ => False
  | _ => True

/-- A prefix can still lead to success unless it has already reached a CEK
machine error. A halted prefix is included because it is already successful;
an exhausted prefix retains its resumable state. -/
def BoundedCekResult.canStillSucceed : BoundedCekResult → Prop
  | .machineError => False
  | _ => True

instance (result : BoundedCekResult) : Decidable result.isSuccessful := by
  cases result <;> simp [BoundedCekResult.isSuccessful] <;> infer_instance

instance (result : BoundedCekResult) : Decidable result.isMachineError := by
  cases result <;> simp [BoundedCekResult.isMachineError] <;> infer_instance

instance (result : BoundedCekResult) : Decidable result.withinFuel := by
  cases result <;> simp [BoundedCekResult.withinFuel] <;> infer_instance

instance (result : BoundedCekResult) : Decidable result.canStillSucceed := by
  cases result <;> simp [BoundedCekResult.canStillSucceed] <;> infer_instance

/-- The information-losing result used by upstream finite `runSteps`. -/
def BoundedCekResult.eraseExhaustion : BoundedCekResult → State
  | .halted value => .Halt value
  | .machineError => .Error
  | .stepLimitExhausted _ => .Error

def runStepsClassified
    (semanticsVariant : PlutusCore.Default.BuiltinSemanticsVariant)
    (state : State)
    (steps : Nat) : BoundedCekResult :=
  match state with
  | .Halt value => .halted value
  | .Error => .machineError
  | _ =>
      match steps with
      | 0 => .stepLimitExhausted state
      | n + 1 => runStepsClassified semanticsVariant (step semanticsVariant state) n

def executeProgramClassified
    (program : PlutusCore.UPLC.Term.Program)
    (params : List PlutusCore.UPLC.Term.Term)
    (steps : Nat)
    (semanticsVariant : PlutusCore.Default.BuiltinSemanticsVariant := default) : BoundedCekResult :=
  match program with
  | PlutusCore.UPLC.Term.Program.Program _ body =>
      runStepsClassified semanticsVariant (initialState (applyParams body params)) steps

def resumeBoundedResult
    (semanticsVariant : PlutusCore.Default.BuiltinSemanticsVariant)
    (result : BoundedCekResult)
    (steps : Nat) : BoundedCekResult :=
  match result with
  | .halted value => .halted value
  | .machineError => .machineError
  | .stepLimitExhausted state =>
      runStepsClassified semanticsVariant state steps

theorem runStepsClassified_add
    (semanticsVariant : PlutusCore.Default.BuiltinSemanticsVariant)
    (state : State)
    (first more : Nat) :
    runStepsClassified semanticsVariant state (first + more) =
      resumeBoundedResult semanticsVariant
        (runStepsClassified semanticsVariant state first) more := by
  induction first generalizing state with
  | zero =>
      cases state <;>
        simp [runStepsClassified, resumeBoundedResult]
  | succ first ih =>
      simp only [Nat.succ_add]
      cases state with
      | Halt value => simp [runStepsClassified, resumeBoundedResult]
      | Error => simp [runStepsClassified, resumeBoundedResult]
      | Eval stack environment term =>
          change
            runStepsClassified semanticsVariant
                (step semanticsVariant (.Eval stack environment term))
                (first + more) =
              resumeBoundedResult semanticsVariant
                (runStepsClassified semanticsVariant
                  (step semanticsVariant (.Eval stack environment term)) first)
                more
          exact ih _
      | Return stack value =>
          change
            runStepsClassified semanticsVariant
                (step semanticsVariant (.Return stack value))
                (first + more) =
              resumeBoundedResult semanticsVariant
                (runStepsClassified semanticsVariant
                  (step semanticsVariant (.Return stack value)) first)
                more
          exact ih _

theorem successful_run_implies_prefix_canStillSucceed
    (semanticsVariant : PlutusCore.Default.BuiltinSemanticsVariant)
    (state : State)
    (first more : Nat)
    (successful :
      (runStepsClassified semanticsVariant state (first + more)).isSuccessful) :
    (runStepsClassified semanticsVariant state first).canStillSucceed := by
  rw [runStepsClassified_add] at successful
  cases hprefix : runStepsClassified semanticsVariant state first <;>
    simp [hprefix, resumeBoundedResult, BoundedCekResult.isSuccessful,
      BoundedCekResult.canStillSucceed] at successful ⊢

theorem successful_program_implies_prefix_canStillSucceed
    (program : PlutusCore.UPLC.Term.Program)
    (params : List PlutusCore.UPLC.Term.Term)
    (first more : Nat)
    (semanticsVariant : PlutusCore.Default.BuiltinSemanticsVariant := default)
    (successful :
      (executeProgramClassified program params (first + more)
        semanticsVariant).isSuccessful) :
    (executeProgramClassified program params first
      semanticsVariant).canStillSucceed := by
  cases program with
  | Program version body =>
      exact successful_run_implies_prefix_canStillSucceed
        semanticsVariant (initialState (applyParams body params)) first more successful

theorem runSteps_erases_exhaustion
    (semanticsVariant : PlutusCore.Default.BuiltinSemanticsVariant)
    (state : State)
    (steps : Nat) :
    runSteps semanticsVariant state steps =
      (runStepsClassified semanticsVariant state steps).eraseExhaustion := by
  induction steps generalizing state with
  | zero => cases state <;> rfl
  | succ n ih =>
      cases state <;>
        simp [runSteps, runStepsClassified, BoundedCekResult.eraseExhaustion, ih]

theorem executeProgram_erases_exhaustion
    (program : PlutusCore.UPLC.Term.Program)
    (params : List PlutusCore.UPLC.Term.Term)
    (steps : Nat)
    (semanticsVariant : PlutusCore.Default.BuiltinSemanticsVariant) :
    cekExecuteProgramWithSemanticVariant semanticsVariant program params steps =
      (executeProgramClassified program params steps semanticsVariant).eraseExhaustion := by
  cases program
  exact runSteps_erases_exhaustion semanticsVariant _ steps

theorem withinFuel_and_not_success_is_machineError
    (result : BoundedCekResult)
    (within : result.withinFuel)
    (notSuccessful : ¬ result.isSuccessful) :
    result.isMachineError := by
  cases result <;> simp_all [BoundedCekResult.withinFuel,
    BoundedCekResult.isSuccessful, BoundedCekResult.isMachineError]

theorem successful_iff_erased_successful (result : BoundedCekResult) :
    result.isSuccessful ↔
      PlutusCore.UPLC.Utils.isSuccessful result.eraseExhaustion := by
  cases result <;> simp [BoundedCekResult.isSuccessful,
    BoundedCekResult.eraseExhaustion, PlutusCore.UPLC.Utils.isSuccessful,
    PlutusCore.UPLC.Utils.isHaltState]

inductive ClassifiedResult where
  | successfulHalt
  | validatorError
  | malformedInput
  | stepLimitExhausted
deriving Repr, BEq, DecidableEq

def classifyBoundedResult
    (inputWellFormed : Bool)
    (result : BoundedCekResult) : ClassifiedResult :=
  if !inputWellFormed then
    .malformedInput
  else
    match result with
    | .halted _ => .successfulHalt
    | .machineError => .validatorError
    | .stepLimitExhausted _ => .stepLimitExhausted

@[simp] theorem wellFormed_successful_iff (result : BoundedCekResult) :
    classifyBoundedResult true result = .successfulHalt ↔ result.isSuccessful := by
  cases result <;>
    simp [classifyBoundedResult, BoundedCekResult.isSuccessful]

@[simp] theorem malformed_is_not_validator_failure (result : BoundedCekResult) :
    classifyBoundedResult false result = .malformedInput := by
  simp [classifyBoundedResult]

theorem zero_steps_on_nonterminal_is_exhaustion
    (stack : Stack)
    (env : PlutusCore.UPLC.CekValue.Environment)
    (term : PlutusCore.UPLC.Term.Term) :
    runStepsClassified
      default
      (.Eval stack env term)
      0 =
      .stepLimitExhausted (.Eval stack env term) := by
  rfl

#print axioms runStepsClassified_add
#print axioms successful_program_implies_prefix_canStillSucceed

end ProofToolFormal.Result
