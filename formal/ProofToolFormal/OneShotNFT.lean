import Blaster
import ProofToolFormal.ConcreteReplay
import ProofToolFormal.ContextGoldens
import ProofToolFormal.Feasibility.OneShot
import ProofToolFormal.Result

/-!
Generalized OneShotNFT semantics for both the exact active parameterized policy
and the exact production code before its seed parameter is applied.
-/

namespace ProofToolFormal.OneShotNFT

open CardanoLedgerApi.IsData.Class (toTerm)
open CardanoLedgerApi.V3
open CardanoLedgerApi.V3.Contexts
open PlutusCore.Data (Data)
open ProofToolFormal.Artifacts
open ProofToolFormal.ConcreteReplay
open ProofToolFormal.ContextGoldens
open ProofToolFormal.Feasibility.OneShot
open ProofToolFormal.ModelBoundary
open ProofToolFormal.Result

def activeSeedRef : TxOutRef :=
  { txOutRefId :=
      ⟨"\xa1\xd0\x67\x7b\x0b\x29\x28\x1b\x42\x2c\x0c\xd2\xfb\x66\x14\xd6\x15\xd7\x73\xe9\x08\xd0\x2e\xed\x20\xb6\xf9\x8c\x77\x2a\x0b\x8b"⟩
    txOutRefIdx := 3 }

def parameterizedInputs (seed : TxOutRef) (ctx : ScriptContext) :=
  [toTerm seed, toTerm ctx]

#prep_uplc preparedOneShotParameterized500
  oneShotParameterized parameterizedInputs 500

def policyMintsExactlyOneToken
    (ownPolicy : CurrencySymbol) : MintValue → Bool
  | [] => false
  | (Data.B policy, Data.Map tokens) :: rest =>
      if policy == ownPolicy then
        match tokens with
        | [(_, Data.I quantity)] => quantity == 1
        | _ => false
      else policyMintsExactlyOneToken ownPolicy rest
  | _ :: rest => policyMintsExactlyOneToken ownPolicy rest

def authorizedFor (seed : TxOutRef) (ctx : ScriptContext) : Bool :=
  match ctx.scriptContextScriptInfo with
  | .MintingScript ownPolicy =>
      utxoConsumed seed ctx.scriptContextTxInfo.txInfoInputs &&
        policyMintsExactlyOneToken ownPolicy ctx.scriptContextTxInfo.txInfoMint
  | _ => false

def exactActiveResult500 (ctx : ScriptContext) : BoundedCekResult :=
  executeProgramClassified oneShotParamsNFT.script (mintingInputs ctx) 500

def exactActiveReplayResult (ctx : ScriptContext) : BoundedCekResult :=
  executeProgramClassified oneShotParamsNFT.script (mintingInputs ctx) replaySteps

def exactParameterizedResult500
    (seed : TxOutRef)
    (ctx : ScriptContext) : BoundedCekResult :=
  executeProgramClassified
    oneShotParameterized.script
    (parameterizedInputs seed ctx)
    500

theorem exact_active_success_iff_authorized_within_fuel (ctx : ScriptContext) :
    (exactActiveResult500 ctx).withinFuel →
    ((exactActiveResult500 ctx).isSuccessful ↔ authorizedFor activeSeedRef ctx = true) := by
  blaster

theorem exact_parameterized_success_iff_authorized_within_fuel
    (seed : TxOutRef)
    (ctx : ScriptContext) :
    (exactParameterizedResult500 seed ctx).withinFuel →
    ((exactParameterizedResult500 seed ctx).isSuccessful ↔ authorizedFor seed ctx = true) := by
  blaster

theorem exact_success_requires_minting_purpose
    (seed : TxOutRef)
    (ctx : ScriptContext) :
    (exactParameterizedResult500 seed ctx).isSuccessful →
    isMintingScriptInfo ctx = true := by
  blaster

def unsafeSuccessWithoutAuthorization : Prop :=
  ∀ ctx : ScriptContext,
    validActiveOneShotContext ctx = true →
    (exactActiveReplayResult ctx).isSuccessful →
    authorizedFor activeSeedRef ctx = false

set_option maxRecDepth 100000 in
theorem golden_falsifies_unsafe_success_without_authorization :
    ¬ unsafeSuccessWithoutAuthorization := by
  intro hUnsafe
  have isAuthorized : authorizedFor activeSeedRef oneShotContext = true := by native_decide
  have replayEq : exactActiveReplayResult oneShotContext = oneShotResult := rfl
  have succeeds : (exactActiveReplayResult oneShotContext).isSuccessful := by
    rw [replayEq]
    exact exact_oneShot_golden_isSuccessful
  have impossible := hUnsafe oneShotContext oneShot_bound_to_active_artifact succeeds
  rw [isAuthorized] at impossible
  contradiction

#print axioms exact_active_success_iff_authorized_within_fuel
#print axioms exact_parameterized_success_iff_authorized_within_fuel
#print axioms exact_success_requires_minting_purpose
#print axioms golden_falsifies_unsafe_success_without_authorization

end ProofToolFormal.OneShotNFT
