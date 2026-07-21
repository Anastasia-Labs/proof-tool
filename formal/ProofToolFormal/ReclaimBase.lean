import Blaster
import ProofToolFormal.Feasibility.ReclaimBase
import ProofToolFormal.ModelBoundary
import ProofToolFormal.Result

/-!
Independent typed authorization predicates for ReclaimBase. They deliberately
describe business/ledger meaning rather than duplicating the production raw
`Data` field walk. The first exact-artifact theorem is the safety direction;
the converse and recursive withdrawal-list completeness remain separate
catalog obligations because finite preprocessing cannot silently stand in for
an unbounded traversal proof.
-/

namespace ProofToolFormal.ReclaimBase

open CardanoLedgerApi.V3
open CardanoLedgerApi.V3.Contexts
open PlutusCore.Data (Data)
open PlutusCore.UPLC.Utils (isSuccessful)
open ProofToolFormal.Artifacts
open ProofToolFormal.Feasibility.ReclaimBase
open ProofToolFormal.ModelBoundary
open ProofToolFormal.Result

def activeGlobalCredential : Credential :=
  .ScriptCredential activeReclaimGlobalV2Hash

def hasAuthorizedBaseDatum (ctx : ScriptContext) : Bool :=
  match ctx.scriptContextScriptInfo with
  | .SpendingScript _ (some (Data.Constr 0 (Data.B paymentCredential :: _))) =>
      paymentCredential.length == 28
  | _ => false

def hasActiveGlobalWithdrawal (ctx : ScriptContext) : Bool :=
  credentialInWithdrawals activeGlobalCredential ctx.scriptContextTxInfo.txInfoWdrl

def authorized (ctx : ScriptContext) : Bool :=
  hasAuthorizedBaseDatum ctx && hasActiveGlobalWithdrawal ctx

def withBaseDatum
    (ctx : ScriptContext)
    (ownRef : TxOutRef)
    (paymentCredential : PlutusCore.ByteString.ByteString)
    (trailing : List Data) : ScriptContext :=
  { ctx with scriptContextScriptInfo :=
      (.SpendingScript ownRef
        (some (.Constr 0 (.B paymentCredential :: trailing)))) }

theorem datum_trailing_fields_do_not_change_authorization
    (ctx : ScriptContext)
    (ownRef : TxOutRef)
    (paymentCredential : PlutusCore.ByteString.ByteString)
    (leftTrailing rightTrailing : List Data) :
    hasAuthorizedBaseDatum
        { ctx with scriptContextScriptInfo :=
            (.SpendingScript ownRef
              (some (.Constr 0 (.B paymentCredential :: leftTrailing)))) } =
      hasAuthorizedBaseDatum
        { ctx with scriptContextScriptInfo :=
            (.SpendingScript ownRef
              (some (.Constr 0 (.B paymentCredential :: rightTrailing)))) } := by
  rfl

theorem datum_first_field_width_is_authoritative
    (ctx : ScriptContext)
    (ownRef : TxOutRef)
    (paymentCredential : PlutusCore.ByteString.ByteString)
    (trailing : List Data) :
    hasAuthorizedBaseDatum
        { ctx with scriptContextScriptInfo :=
            (.SpendingScript ownRef
              (some (.Constr 0 (.B paymentCredential :: trailing)))) } =
      (paymentCredential.length == 28) := by
  rfl

def exactResult500 (ctx : ScriptContext) : BoundedCekResult :=
  executeProgramClassified reclaimBase.script (spendingInputs ctx) 500

theorem exactResult500_erases_to_preparedExec (ctx : ScriptContext) :
    (exactResult500 ctx).eraseExhaustion = preparedReclaimBase500.exec ctx := by
  symm
  exact executeProgram_erases_exhaustion reclaimBase.script (spendingInputs ctx) 500 default

theorem exactResult500_success_iff_preparedExec (ctx : ScriptContext) :
    (exactResult500 ctx).isSuccessful ↔
      isSuccessful (preparedReclaimBase500.exec ctx) := by
  rw [successful_iff_erased_successful, exactResult500_erases_to_preparedExec]

/--
At the exact locked artifact boundary, a successful finite symbolic execution
cannot occur without a spending datum whose authoritative first field is a
28-byte credential and the active GlobalV2 script credential in withdrawals.
This implication is not weakened by finite-step exhaustion because exhaustion
can only make `isSuccessful` false.
-/
theorem exact_success_implies_authorized (ctx : ScriptContext) :
    isSuccessful (preparedReclaimBase500.prop ctx) →
    authorized ctx = true := by
  blaster

/-- Same safety implication over the unoptimized exact CEK expression. -/
theorem exact_exec_success_implies_authorized (ctx : ScriptContext) :
    isSuccessful (preparedReclaimBase500.exec ctx) →
    authorized ctx = true := by
  blaster

theorem exact_authorized_within_fuel_implies_success (ctx : ScriptContext) :
    authorized ctx = true →
    (exactResult500 ctx).withinFuel →
    (exactResult500 ctx).isSuccessful := by
  blaster

theorem exact_classified_success_implies_authorized (ctx : ScriptContext) :
    (exactResult500 ctx).isSuccessful → authorized ctx = true := by
  blaster

theorem exact_success_iff_authorized_within_fuel (ctx : ScriptContext) :
    (exactResult500 ctx).withinFuel →
    ((exactResult500 ctx).isSuccessful ↔ authorized ctx = true) := by
  blaster

theorem exact_trailing_fields_do_not_change_success
    (ctx : ScriptContext)
    (ownRef : TxOutRef)
    (paymentCredential : PlutusCore.ByteString.ByteString)
    (leftTrailing rightTrailing : List Data) :
    (exactResult500 (withBaseDatum ctx ownRef paymentCredential leftTrailing)).withinFuel →
    (exactResult500 (withBaseDatum ctx ownRef paymentCredential rightTrailing)).withinFuel →
    ((exactResult500 (withBaseDatum ctx ownRef paymentCredential leftTrailing)).isSuccessful ↔
      (exactResult500 (withBaseDatum ctx ownRef paymentCredential rightTrailing)).isSuccessful) := by
  blaster

theorem unauthorized_within_fuel_is_machine_error
    (ctx : ScriptContext)
    (result : BoundedCekResult)
    (erasedState : PlutusCore.UPLC.CekMachine.State) :
    result.eraseExhaustion = erasedState →
    (isSuccessful erasedState → authorized ctx = true) →
    authorized ctx = false →
    result.withinFuel →
    result.isMachineError := by
  intro erasesToState successImpliesAuthorized notAuthorized withinFuel
  apply withinFuel_and_not_success_is_machineError result withinFuel
  intro boundedSuccess
  have erasedSuccess : isSuccessful result.eraseExhaustion :=
    (successful_iff_erased_successful result).mp boundedSuccess
  have stateSuccess : isSuccessful erasedState :=
    Eq.mp (congrArg isSuccessful erasesToState) erasedSuccess
  have nowAuthorized := successImpliesAuthorized stateSuccess
  simp_all

theorem exact_not_authorized_is_unsuccessful (ctx : ScriptContext) :
    authorized ctx = false →
    ¬ isSuccessful (preparedReclaimBase500.prop ctx) := by
  intro notAuthorized success
  have authorizedNow := exact_success_implies_authorized ctx success
  simp_all

theorem exact_invalid_or_missing_datum_is_unsuccessful (ctx : ScriptContext) :
    hasAuthorizedBaseDatum ctx = false →
    ¬ isSuccessful (preparedReclaimBase500.prop ctx) := by
  intro invalidDatum
  apply exact_not_authorized_is_unsuccessful
  simp [authorized, invalidDatum]

theorem exact_missing_active_withdrawal_is_unsuccessful (ctx : ScriptContext) :
    hasActiveGlobalWithdrawal ctx = false →
    ¬ isSuccessful (preparedReclaimBase500.prop ctx) := by
  intro missingWithdrawal
  apply exact_not_authorized_is_unsuccessful
  simp [authorized, missingWithdrawal]

theorem exact_wrong_purpose_is_unsuccessful (ctx : ScriptContext) :
    isSpendingScriptInfo ctx = false →
    ¬ isSuccessful (preparedReclaimBase500.prop ctx) := by
  intro wrongPurpose
  have datumInvalid : hasAuthorizedBaseDatum ctx = false := by
    unfold isSpendingScriptInfo at wrongPurpose
    unfold hasAuthorizedBaseDatum
    split <;> simp_all
  apply exact_not_authorized_is_unsuccessful
  simp [authorized, datumInvalid]

#print axioms exact_success_implies_authorized
#print axioms exact_trailing_fields_do_not_change_success
#print axioms exact_exec_success_implies_authorized
#print axioms exact_authorized_within_fuel_implies_success
#print axioms exact_success_iff_authorized_within_fuel
#print axioms unauthorized_within_fuel_is_machine_error
#print axioms exact_not_authorized_is_unsuccessful
#print axioms exact_invalid_or_missing_datum_is_unsuccessful
#print axioms exact_missing_active_withdrawal_is_unsuccessful
#print axioms exact_wrong_purpose_is_unsuccessful

end ProofToolFormal.ReclaimBase
