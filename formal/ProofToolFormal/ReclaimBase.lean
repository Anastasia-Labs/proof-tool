import ProofToolFormal.Artifacts
import ProofToolFormal.ModelBoundary
import ProofToolFormal.Result

/-!
Independent authorization predicate for the active withdrawal-only ReclaimBase
artifact. The deployed script intentionally ignores spending purpose and datum
shape locally; the ledger invocation and paired ReclaimGlobalV2 validator own
those composed-system obligations.

The exact compiled recursive-list bridge remains a cataloged pending
obligation. Concrete active-artifact replays live in `ConcreteReplay`, while
the closed parameterized business predicate is proved in
`ReclaimBaseParameterized`.
-/

namespace ProofToolFormal.ReclaimBase

open CardanoLedgerApi.V3
open CardanoLedgerApi.V3.Contexts
open ProofToolFormal.ModelBoundary

def activeGlobalCredential : Credential :=
  .ScriptCredential activeReclaimGlobalV2Hash

def authorized (ctx : ScriptContext) : Bool :=
  credentialInWithdrawals activeGlobalCredential ctx.scriptContextTxInfo.txInfoWdrl

theorem authorization_ignores_script_info
    (ctx : ScriptContext)
    (scriptInfo : ScriptInfo) :
    authorized { ctx with scriptContextScriptInfo := scriptInfo } =
      authorized ctx := by
  rfl

#print axioms authorization_ignores_script_info

end ProofToolFormal.ReclaimBase
