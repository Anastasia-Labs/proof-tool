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
  ⟨"\x74\x4c\xc4\x71\x8e\x81\x49\x20\x1c\x7e\x9c\xb3\xd3\xa5\x50\xf3\x4c\xb1\x8d\xfc\x80\x76\xa3\x31\x72\xd9\x35\x4d"⟩

def activeReclaimGlobalV2Hash : ScriptHash :=
  ⟨"\xa4\xda\x74\xe7\xcb\x6e\xa4\xf4\xe6\x04\x56\xa0\xa6\xea\xbf\x0c\xcf\x83\x46\x4e\xbe\x55\x66\x43\x90\xef\x39\xf8"⟩

def candidateReclaimBaseHash : ScriptHash :=
  activeReclaimBaseHash

def candidateReclaimGlobalV2Hash : ScriptHash :=
  activeReclaimGlobalV2Hash

def activeParamsPolicyId : CurrencySymbol :=
  ⟨"\xd6\x77\x7b\x8c\x3b\xe1\xc6\xc0\xc9\xba\xba\x52\xa8\x80\xc1\x98\x0a\x66\x2c\x16\xff\xc0\x88\x5e\xca\xa0\x31\x19"⟩

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
