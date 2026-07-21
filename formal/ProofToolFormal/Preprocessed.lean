import CardanoLedgerApi.V3
import ProofToolFormal.Artifacts

/-!
Symbolic CEK preprocessing for the exact locked artifacts. These are step
limits for the Blaster partial evaluator, not Cardano execution-unit budgets.
Upstream preprocessing collapses fuel exhaustion to `State.Error`; see
`formal/assurance/model-findings.md`. These definitions may support symbolic
work, but a rejection claim additionally needs an independent within-fuel
witness and `ProofToolFormal.Result` replay.
-/

namespace ProofToolFormal.Preprocessed

open CardanoLedgerApi.IsData.Class (toTerm)
open CardanoLedgerApi.V3 (ScriptContext)
open CardanoLedgerApi.V3.Contexts (mintingInputs rewardingInputs spendingInputs)
open PlutusCore.Data (Data)
open PlutusCore.UPLC.Term (Term)
open ProofToolFormal.Artifacts

def builtinDataInputs (datum : Data) : List Term := [toTerm datum]

#prep_uplc preparedParamsHolder paramsHolder builtinDataInputs 100

/-
The monolithic top-level OneShotNFT, ReclaimBase, and ReclaimGlobalV2
preprocessing probes are intentionally not left in this default module. Even
the OneShotNFT plus ReclaimBase 2,000-step probe exceeded 40 seconds, while the
four-script 20,000-step probe exceeded 50 seconds. These scripts must be split
into exported closed helpers and dedicated top-level corollary modules so
normal builds remain bounded and reviewable.
-/

end ProofToolFormal.Preprocessed
