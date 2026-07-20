import CardanoLedgerApi.V3
import PlutusCore.UPLC.ScriptEncoding

/-!
Ledger validity does not identify the UPLC artifact currently executing. These
predicates add that external invocation boundary explicitly, so a proof about
one script cannot be satisfied by a valid context for another script.
-/

namespace ProofToolFormal.ModelBoundary

open CardanoLedgerApi.V3
open CardanoLedgerApi.V3.Contexts
def activeReclaimBaseHash : ScriptHash :=
  ⟨"\xa4\xcd\x2a\x32\x08\xa0\x78\x8a\xed\xd1\xae\xea\x08\x7f\x89\x02\xc5\x80\x52\xdc\x2f\xcf\xa2\xc2\x28\xea\x34\xdd"⟩

def activeReclaimGlobalV2Hash : ScriptHash :=
  ⟨"\x15\x56\xd4\xb8\x96\x8f\xc1\xbc\x2b\xeb\x69\x26\x34\xa8\xe1\xc7\xe4\xd4\x76\xcc\xe4\x8a\x59\x69\xc0\x07\xb2\xc5"⟩

def candidateReclaimBaseHash : ScriptHash :=
  ⟨"\xc2\x34\xce\xda\x7e\xe9\x8f\xbc\x61\xab\x7c\x3d\x5c\x17\x48\x41\x17\x18\x35\x3b\x63\x60\x10\xa4\xdf\x60\xda\x45"⟩

def candidateReclaimGlobalV2Hash : ScriptHash :=
  ⟨"\xf9\x3e\xd0\xe3\x5e\x7f\x49\x7f\x7c\xcd\x43\x2e\xfe\x8f\x7d\xca\x6f\x86\xa2\x07\x29\x64\xf8\xf2\x7b\xd7\x05\x82"⟩

def activeParamsPolicyId : CurrencySymbol :=
  ⟨"\x82\xc8\x06\x80\x9e\x8e\x2a\x65\xc1\x53\x04\x1d\xb1\x87\xca\x96\xf2\xfe\xeb\x87\xa3\xfe\x13\x5b\xf3\x80\x31\x74"⟩

inductive ArtifactIdentity where
  | spending : ScriptHash → ArtifactIdentity
  | rewarding : ScriptHash → ArtifactIdentity
  | minting : CurrencySymbol → ArtifactIdentity
deriving Repr

/-- Bind a typed, generic V3 context to the exact artifact identity under proof. -/
def validContextForArtifact (identity : ArtifactIdentity) (ctx : ScriptContext) : Bool :=
  match identity, ctx.scriptContextScriptInfo with
  | .spending expectedHash, .SpendingScript ownRef _ =>
      match resolveInput ownRef ctx.scriptContextTxInfo.txInfoInputs with
      | some ownInput => hasScriptHash expectedHash ownInput.txInInfoResolved.txOutAddress
      | none => false
  | .rewarding expectedHash, .RewardingScript (.ScriptCredential actualHash) =>
      actualHash == expectedHash
  | .minting expectedPolicy, .MintingScript actualPolicy =>
      actualPolicy == expectedPolicy
  | _, _ => false

def validActiveReclaimBaseContext (ctx : ScriptContext) : Bool :=
  validScriptContext ctx && validContextForArtifact (.spending activeReclaimBaseHash) ctx

def validActiveReclaimGlobalV2Context (ctx : ScriptContext) : Bool :=
  validScriptContext ctx && validContextForArtifact (.rewarding activeReclaimGlobalV2Hash) ctx

def validCandidateReclaimBaseContext (ctx : ScriptContext) : Bool :=
  validScriptContext ctx && validContextForArtifact (.spending candidateReclaimBaseHash) ctx

def validCandidateReclaimGlobalV2Context (ctx : ScriptContext) : Bool :=
  validScriptContext ctx &&
    validContextForArtifact (.rewarding candidateReclaimGlobalV2Hash) ctx

def validActiveOneShotContext (ctx : ScriptContext) : Bool :=
  validScriptContext ctx && validContextForArtifact (.minting activeParamsPolicyId) ctx

@[simp] theorem resolveInput_self_head (input : TxInInfo) (inputs : List TxInInfo) :
    resolveInput input.txInInfoOutRef (input :: inputs) = some input := by
  unfold resolveInput
  change (if input.txInInfoOutRef == input.txInInfoOutRef then some input else _) = some input
  simp

@[simp] theorem resolveInput_explicit_head
    (ownRef : TxOutRef) (resolved : TxOut) (inputs : List TxInInfo) :
    resolveInput ownRef
      ({ txInInfoOutRef := ownRef, txInInfoResolved := resolved } :: inputs) =
      some { txInInfoOutRef := ownRef, txInInfoResolved := resolved } := by
  simpa using
    (resolveInput_self_head
      ({ txInInfoOutRef := ownRef, txInInfoResolved := resolved } : TxInInfo)
      inputs)

/-- Change only the invocation identity; useful for auditing the model boundary. -/
def bindRewardingContext (ctx : ScriptContext) (scriptHash : ScriptHash) : ScriptContext :=
  { ctx with scriptContextScriptInfo := .RewardingScript (.ScriptCredential scriptHash) }

/-- Change only the invocation identity; useful for auditing the model boundary. -/
def bindMintingContext (ctx : ScriptContext) (policyId : CurrencySymbol) : ScriptContext :=
  { ctx with scriptContextScriptInfo := .MintingScript policyId }

def bindSpendingContext
    (ctx : ScriptContext)
    (scriptHash : ScriptHash)
    (ownRef : TxOutRef)
    (datum : Option Datum)
    (resolved : TxOut) : ScriptContext :=
  let ownOutput :=
    { resolved with
      txOutAddress :=
        { addressCredential := .ScriptCredential scriptHash
          addressStakingCredential := none } }
  let ownInput : TxInInfo :=
    { txInInfoOutRef := ownRef
      txInInfoResolved := ownOutput }
  { ctx with
    scriptContextTxInfo :=
      { ctx.scriptContextTxInfo with txInfoInputs := ownInput :: ctx.scriptContextTxInfo.txInfoInputs }
    scriptContextScriptInfo := .SpendingScript ownRef datum }

@[simp] theorem rewarding_binding_witness (ctx : ScriptContext) (scriptHash : ScriptHash) :
    validContextForArtifact (.rewarding scriptHash) (bindRewardingContext ctx scriptHash) = true := by
  simp [validContextForArtifact, bindRewardingContext]

theorem rewarding_wrong_artifact_rejected
    (ctx : ScriptContext) (actual expected : ScriptHash) (different : actual ≠ expected) :
    validContextForArtifact (.rewarding expected) (bindRewardingContext ctx actual) = false := by
  simp [validContextForArtifact, bindRewardingContext, different]

@[simp] theorem minting_binding_witness (ctx : ScriptContext) (policyId : CurrencySymbol) :
    validContextForArtifact (.minting policyId) (bindMintingContext ctx policyId) = true := by
  simp [validContextForArtifact, bindMintingContext]

theorem minting_wrong_artifact_rejected
    (ctx : ScriptContext) (actual expected : CurrencySymbol) (different : actual ≠ expected) :
    validContextForArtifact (.minting expected) (bindMintingContext ctx actual) = false := by
  simp [validContextForArtifact, bindMintingContext, different]

@[simp] theorem spending_binding_witness
    (ctx : ScriptContext)
    (scriptHash : ScriptHash)
    (ownRef : TxOutRef)
    (datum : Option Datum)
    (resolved : TxOut) :
    validContextForArtifact
      (.spending scriptHash)
      (bindSpendingContext ctx scriptHash ownRef datum resolved) = true := by
  simp [validContextForArtifact, bindSpendingContext, hasScriptHash, hasScriptCredential]

theorem spending_wrong_artifact_rejected
    (ctx : ScriptContext)
    (actual expected : ScriptHash)
    (ownRef : TxOutRef)
    (datum : Option Datum)
    (resolved : TxOut)
    (different : actual ≠ expected) :
    validContextForArtifact
      (.spending expected)
      (bindSpendingContext ctx actual ownRef datum resolved) = false := by
  simp [validContextForArtifact, bindSpendingContext, hasScriptHash, hasScriptCredential, different]

example : activeReclaimBaseHash.length = 28 := by native_decide
example : activeReclaimGlobalV2Hash.length = 28 := by native_decide
example : candidateReclaimBaseHash.length = 28 := by native_decide
example : candidateReclaimGlobalV2Hash.length = 28 := by native_decide
example : activeParamsPolicyId.length = 28 := by native_decide

end ProofToolFormal.ModelBoundary
