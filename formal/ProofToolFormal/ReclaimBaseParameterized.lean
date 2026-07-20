import ProofToolFormal.ReclaimBaseCandidate

/-!
Generalized business semantics for the current-source ReclaimBase candidate before the
deployment credential is applied. The source-exported helper artifact is locked
as `reclaimBaseParameterized`; the universal compiled-list bridge remains an
explicit obligation because finite CEK preprocessing expands the recursive
withdrawal scan rather than proving it by induction.
-/

namespace ProofToolFormal.ReclaimBaseParameterized

open CardanoLedgerApi.V3
open CardanoLedgerApi.V3.Contexts

def authorizedFor (globalCredential : Credential) (ctx : ScriptContext) : Bool :=
  credentialInWithdrawals globalCredential ctx.scriptContextTxInfo.txInfoWdrl

theorem authorization_is_exact_withdrawal_membership
    (globalCredential : Credential)
    (ctx : ScriptContext) :
    authorizedFor globalCredential ctx =
      credentialInWithdrawals globalCredential ctx.scriptContextTxInfo.txInfoWdrl := by
  rfl

theorem authorization_ignores_script_info
    (globalCredential : Credential)
    (ctx : ScriptContext)
    (scriptInfo : ScriptInfo) :
    authorizedFor globalCredential
        { ctx with scriptContextScriptInfo := scriptInfo } =
      authorizedFor globalCredential ctx := by
  rfl

#print axioms authorization_is_exact_withdrawal_membership
#print axioms authorization_ignores_script_info

end ProofToolFormal.ReclaimBaseParameterized
