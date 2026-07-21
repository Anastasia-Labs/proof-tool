import Blaster
import ProofToolFormal.ConcreteReplay
import ProofToolFormal.ContextGoldens
import ProofToolFormal.Feasibility.ReclaimGlobalV2
import ProofToolFormal.GlobalHelpers
import ProofToolFormal.ModelBoundary
import ProofToolFormal.Result

/-!
Exact active ReclaimGlobalV2 evidence and independent semantic predicates.

The exact validator is cryptographically large, so the shallow symbolic
prefix theorems below are deliberately not presented as complete top-level
correctness.  Non-vacuity comes from the exact two-evaluator real-proof replay;
recursive structural properties live in `GlobalHelpers`.  A later composition
theorem must still bridge those helper results to every successful execution of
the monolithic artifact.
-/

namespace ProofToolFormal.ReclaimGlobalV2

open CardanoLedgerApi.V3
open CardanoLedgerApi.V3.Contexts
open PlutusCore.Data (Data)
open PlutusCore.ByteString (ByteString appendByteString)
open PlutusCore.UPLC.Utils (isSuccessful)
open ProofToolFormal.Artifacts
open ProofToolFormal.ConcreteReplay
open ProofToolFormal.ContextGoldens
open ProofToolFormal.Feasibility.ReclaimGlobalV2
open ProofToolFormal.ModelBoundary
open ProofToolFormal.Result

structure ReclaimRequest where
  paramsRefIndex : Int
  destinationStartIndex : Int
  proofs : List ByteString
  digests : List ByteString

def decodeByteStrings : List Data → Option (List ByteString)
  | [] => some []
  | Data.B bytes :: remaining =>
      (decodeByteStrings remaining).map (bytes :: ·)
  | _ => none

def decodeReclaimRequest (redeemer : Data) : Option ReclaimRequest :=
  match redeemer with
  | Data.Constr _
      (Data.I paramsRefIndex :: Data.I destinationStartIndex ::
        Data.List proofData :: Data.List digestData :: _) =>
      match decodeByteStrings proofData, decodeByteStrings digestData with
      | some proofs, some digests =>
          some { paramsRefIndex, destinationStartIndex, proofs, digests }
      | _, _ => none
  | _ => none

def findAtInt (index : Int) : List α → Option α
  | [] => none
  | value :: remaining =>
      if index == 0 then some value else findAtInt (index - 1) remaining

def dropAtInt (index : Int) : List α → Option (List α)
  | [] => if index == 0 then some [] else none
  | values@(_ :: remaining) =>
      if index == 0 then some values else dropAtInt (index - 1) remaining

def selectedBaseScriptHash
    (ctx : ScriptContext)
    (request : ReclaimRequest) : Option ByteString :=
  match findAtInt request.paramsRefIndex ctx.scriptContextTxInfo.txInfoReferenceInputs with
  | some paramsInput =>
      match paramsInput.txInInfoResolved.txOutDatum with
      | .OutputDatum (Data.Constr _ (Data.B baseHash :: _)) =>
          if baseHash.length == 28 then some baseHash else none
      | _ => none
  | none => none

def isMatchingBaseInput (baseHash : ByteString) (input : TxInInfo) : Bool :=
  match input.txInInfoResolved.txOutAddress.addressCredential with
  | .ScriptCredential actualHash => actualHash == baseHash
  | _ => false

def basePaymentCredential (input : TxInInfo) : Option ByteString :=
  match input.txInInfoResolved.txOutDatum with
  | .OutputDatum (Data.Constr _ (Data.B credential :: _)) =>
      if credential.length == 28 then some credential else none
  | _ => none

def zeroCredentialHash : ByteString :=
  "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
  ++ "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"

def credentialAddressBytes (credential : Credential) : Option ByteString :=
  match credential with
  | .PubKeyCredential hash =>
      if hash.length == 28 then
        some (appendByteString "\x01" hash)
      else none
  | .ScriptCredential hash =>
      if hash.length == 28 then
        some (appendByteString "\x02" hash)
      else none

def stakeAddressBytes : Option StakingCredential → Option ByteString
  | none => some (appendByteString "\x00" zeroCredentialHash)
  | some (.StakingHash credential) => credentialAddressBytes credential
  | some (.StakingPtr _ _ _) => none

def destinationAddressV1Bytes
    (output : CardanoLedgerApi.V2.Tx.TxOut) : Option ByteString :=
  match credentialAddressBytes output.txOutAddress.addressCredential,
      stakeAddressBytes output.txOutAddress.addressStakingCredential with
  | some payment, some stake =>
      let encoded := appendByteString payment stake
      if encoded.length == 58 then some encoded else none
  | _, _ => none

def typedValueComponentwiseCovers
    (required paid : CardanoLedgerApi.V1.Value.Value) : Bool :=
  required.all fun policyEntry =>
    match policyEntry with
    | (Data.B policyId, Data.Map tokens) =>
        tokens.all fun tokenEntry =>
          match tokenEntry with
          | (Data.B tokenName, Data.I requiredQuantity) =>
              requiredQuantity ≤
                CardanoLedgerApi.V1.Value.valueOf policyId tokenName paid
          | _ => false
    | _ => false

structure GlobalSemanticView where
  baseHash : ByteString
  inputs : List TxInInfo
  proofs : List ByteString
  digests : List ByteString
  destinations : List CardanoLedgerApi.V2.Tx.TxOut

def semanticView (ctx : ScriptContext) : Option GlobalSemanticView :=
  match decodeReclaimRequest ctx.scriptContextRedeemer with
  | some request =>
      match selectedBaseScriptHash ctx request,
          dropAtInt request.destinationStartIndex
            ctx.scriptContextTxInfo.txInfoOutputs with
      | some baseHash, some destinations =>
          some
            { baseHash
              inputs := ctx.scriptContextTxInfo.txInfoInputs
              proofs := request.proofs
              digests := request.digests
              destinations }
      | _, _ => none
  | none => none

def hasMatchingBaseInput (view : GlobalSemanticView) : Bool :=
  view.inputs.any (isMatchingBaseInput view.baseHash)

def slotsHaveExactCoverage
    (baseHash : ByteString) :
    List TxInInfo →
    List ByteString →
    List ByteString →
    List CardanoLedgerApi.V2.Tx.TxOut → Bool
  | [], proofs, digests, _ => proofs.isEmpty && digests.isEmpty
  | input :: inputs, proofs, digests, destinations =>
      if isMatchingBaseInput baseHash input then
        match proofs, digests, destinations with
        | proof :: moreProofs, digest :: moreDigests,
            _ :: moreDestinations =>
            proof.length == 336 && digest.length == 32 &&
              slotsHaveExactCoverage
                baseHash inputs moreProofs moreDigests moreDestinations
        | _, _, _ => false
      else
        slotsHaveExactCoverage baseHash inputs proofs digests destinations

def slotsHaveMatchingStatements
    (baseHash : ByteString) :
    List TxInInfo →
    List ByteString →
    List ByteString →
    List CardanoLedgerApi.V2.Tx.TxOut → Bool
  | [], proofs, digests, _ => proofs.isEmpty && digests.isEmpty
  | input :: inputs, proofs, digests, destinations =>
      if isMatchingBaseInput baseHash input then
        match proofs, digests, destinations with
        | proof :: moreProofs, digest :: moreDigests,
            destination :: moreDestinations =>
            match basePaymentCredential input,
                destinationAddressV1Bytes destination with
            | some credential, some destinationBytes =>
                proof.length == 336 && digest.length == 32 &&
                  digest ==
                    GlobalHelpers.statementDigestSpec
                      credential destinationBytes &&
                  slotsHaveMatchingStatements
                    baseHash inputs moreProofs moreDigests moreDestinations
            | _, _ => false
        | _, _, _ => false
      else
        slotsHaveMatchingStatements baseHash inputs proofs digests destinations

def slotsHaveValueCoverage
    (baseHash : ByteString) :
    List TxInInfo →
    List ByteString →
    List ByteString →
    List CardanoLedgerApi.V2.Tx.TxOut → Bool
  | [], proofs, digests, _ => proofs.isEmpty && digests.isEmpty
  | input :: inputs, proofs, digests, destinations =>
      if isMatchingBaseInput baseHash input then
        match proofs, digests, destinations with
        | _ :: moreProofs, _ :: moreDigests,
            destination :: moreDestinations =>
            typedValueComponentwiseCovers
                input.txInInfoResolved.txOutValue destination.txOutValue &&
              slotsHaveValueCoverage
                baseHash inputs moreProofs moreDigests moreDestinations
        | _, _, _ => false
      else
        slotsHaveValueCoverage baseHash inputs proofs digests destinations

def exactOrderedSlotCoverage (ctx : ScriptContext) : Bool :=
  match semanticView ctx with
  | some view =>
      hasMatchingBaseInput view &&
        slotsHaveExactCoverage
          view.baseHash view.inputs view.proofs view.digests view.destinations
  | none => false

def everyConsumedStatementMatches (ctx : ScriptContext) : Bool :=
  match semanticView ctx with
  | some view =>
      hasMatchingBaseInput view &&
        slotsHaveMatchingStatements
          view.baseHash view.inputs view.proofs view.digests view.destinations
  | none => false

def everyDestinationCoversInputValue (ctx : ScriptContext) : Bool :=
  match semanticView ctx with
  | some view =>
      hasMatchingBaseInput view &&
        slotsHaveValueCoverage
          view.baseHash view.inputs view.proofs view.digests view.destinations
  | none => false

theorem shallow_exact_success_requires_rewarding_purpose
    (ctx : ScriptContext) :
    isSuccessful (preparedReclaimGlobalV2_100.prop ctx) →
      isRewardingScriptInfo ctx = true := by
  blaster

def exactActiveReplayResult (ctx : ScriptContext) : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2.script
    (rewardingInputs ctx)
    replaySteps

def exactActivePrefix500 (ctx : ScriptContext) : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2.script
    (rewardingInputs ctx)
    500

set_option maxRecDepth 100000 in
set_option maxHeartbeats 1000000 in
theorem exact_success_implies_prefix500_canStillSucceed
    (ctx : ScriptContext)
    (successful : (exactActiveReplayResult ctx).isSuccessful) :
    (exactActivePrefix500 ctx).canStillSucceed := by
  change
    (executeProgramClassified reclaimGlobalV2.script (rewardingInputs ctx)
      replaySteps).isSuccessful at successful
  change
    (executeProgramClassified reclaimGlobalV2.script (rewardingInputs ctx)
      500).canStillSucceed
  have fuelSplit : replaySteps = 500 + 1_999_500 := by rfl
  rw [fuelSplit] at successful
  exact successful_program_implies_prefix_canStillSucceed
    reclaimGlobalV2.script (rewardingInputs ctx) 500 1_999_500
      (semanticsVariant := default) successful

set_option maxHeartbeats 2000000 in
theorem exact_prefix500_canStillSucceed_requires_rewarding_purpose
    (ctx : ScriptContext) :
    (exactActivePrefix500 ctx).canStillSucceed →
      isRewardingScriptInfo ctx = true := by
  blaster

def exactActivePrefix900 (ctx : ScriptContext) : BoundedCekResult :=
  executeProgramClassified
    reclaimGlobalV2.script
    (rewardingInputs ctx)
    900

set_option maxRecDepth 100000 in
set_option maxHeartbeats 1000000 in
theorem exact_success_implies_prefix900_canStillSucceed
    (ctx : ScriptContext)
    (successful : (exactActiveReplayResult ctx).isSuccessful) :
    (exactActivePrefix900 ctx).canStillSucceed := by
  change
    (executeProgramClassified reclaimGlobalV2.script (rewardingInputs ctx)
      replaySteps).isSuccessful at successful
  change
    (executeProgramClassified reclaimGlobalV2.script (rewardingInputs ctx)
      900).canStillSucceed
  have fuelSplit : replaySteps = 900 + 1_999_100 := by rfl
  rw [fuelSplit] at successful
  exact successful_program_implies_prefix_canStillSucceed
    reclaimGlobalV2.script (rewardingInputs ctx) 900 1_999_100
      (semanticsVariant := default) successful

set_option maxRecDepth 100000 in
set_option maxHeartbeats 1000000 in
/-
Rewarding-only execution is a lifecycle property, not merely an invocation-shape
property. In particular, it rules out successful certifying execution that could
deregister the script stake credential, return its deposit, and make subsequent
reclaim withdrawals ledger-invalid until registration is restored.
-/
theorem exact_success_requires_rewarding_purpose
    (ctx : ScriptContext)
    (successful : (exactActiveReplayResult ctx).isSuccessful) :
    isRewardingScriptInfo ctx = true :=
  exact_prefix500_canStillSucceed_requires_rewarding_purpose ctx
    (exact_success_implies_prefix500_canStillSucceed ctx successful)

def unsafeNoLedgerValidActiveContextSucceeds : Prop :=
  ∀ ctx : ScriptContext,
    validActiveReclaimGlobalV2Context ctx = true →
    ¬ (exactActiveReplayResult ctx).isSuccessful

def unsafeSuccessWithoutExactCoverage : Prop :=
  ∀ ctx : ScriptContext,
    validActiveReclaimGlobalV2Context ctx = true →
    (exactActiveReplayResult ctx).isSuccessful →
    exactOrderedSlotCoverage ctx = false

def unsafeSuccessWithStatementMismatch : Prop :=
  ∀ ctx : ScriptContext,
    validActiveReclaimGlobalV2Context ctx = true →
    (exactActiveReplayResult ctx).isSuccessful →
    everyConsumedStatementMatches ctx = false

def unsafeSuccessWithDestinationUnderpayment : Prop :=
  ∀ ctx : ScriptContext,
    validActiveReclaimGlobalV2Context ctx = true →
    (exactActiveReplayResult ctx).isSuccessful →
    everyDestinationCoversInputValue ctx = false

theorem real_proof_context_has_exact_ordered_slot_coverage :
    exactOrderedSlotCoverage reclaimGlobalV2SuccessContext = true := by
  native_decide

theorem real_proof_context_has_matching_statements :
    everyConsumedStatementMatches reclaimGlobalV2SuccessContext = true := by
  native_decide

theorem real_proof_context_has_componentwise_value_coverage :
    everyDestinationCoversInputValue reclaimGlobalV2SuccessContext = true := by
  native_decide

set_option maxRecDepth 100000 in
theorem real_proof_falsifies_unsafe_coverage_claim :
    ¬ unsafeSuccessWithoutExactCoverage := by
  intro hUnsafe
  have succeeds :
      (exactActiveReplayResult reclaimGlobalV2SuccessContext).isSuccessful := by
    change reclaimGlobalV2SuccessResult.isSuccessful
    exact
      (wellFormed_successful_iff reclaimGlobalV2SuccessResult).mp
        exact_reclaimGlobalV2_real_proof_succeeds
  have impossible :=
    hUnsafe
      reclaimGlobalV2SuccessContext
      reclaimGlobalV2Success_bound_to_active_artifact
      succeeds
  rw [real_proof_context_has_exact_ordered_slot_coverage] at impossible
  contradiction

set_option maxRecDepth 100000 in
theorem real_proof_falsifies_unsafe_statement_claim :
    ¬ unsafeSuccessWithStatementMismatch := by
  intro hUnsafe
  have succeeds :
      (exactActiveReplayResult reclaimGlobalV2SuccessContext).isSuccessful := by
    change reclaimGlobalV2SuccessResult.isSuccessful
    exact
      (wellFormed_successful_iff reclaimGlobalV2SuccessResult).mp
        exact_reclaimGlobalV2_real_proof_succeeds
  have impossible :=
    hUnsafe
      reclaimGlobalV2SuccessContext
      reclaimGlobalV2Success_bound_to_active_artifact
      succeeds
  rw [real_proof_context_has_matching_statements] at impossible
  contradiction

set_option maxRecDepth 100000 in
theorem real_proof_falsifies_unsafe_value_claim :
    ¬ unsafeSuccessWithDestinationUnderpayment := by
  intro hUnsafe
  have succeeds :
      (exactActiveReplayResult reclaimGlobalV2SuccessContext).isSuccessful := by
    change reclaimGlobalV2SuccessResult.isSuccessful
    exact
      (wellFormed_successful_iff reclaimGlobalV2SuccessResult).mp
        exact_reclaimGlobalV2_real_proof_succeeds
  have impossible :=
    hUnsafe
      reclaimGlobalV2SuccessContext
      reclaimGlobalV2Success_bound_to_active_artifact
      succeeds
  rw [real_proof_context_has_componentwise_value_coverage] at impossible
  contradiction

set_option maxRecDepth 100000 in
theorem real_proof_falsifies_unsafe_no_success_claim :
    ¬ unsafeNoLedgerValidActiveContextSucceeds := by
  intro hUnsafe
  have succeeds :
      (exactActiveReplayResult reclaimGlobalV2SuccessContext).isSuccessful := by
    change reclaimGlobalV2SuccessResult.isSuccessful
    exact
      (wellFormed_successful_iff reclaimGlobalV2SuccessResult).mp
        exact_reclaimGlobalV2_real_proof_succeeds
  exact
    (hUnsafe
      reclaimGlobalV2SuccessContext
      reclaimGlobalV2Success_bound_to_active_artifact)
      succeeds

theorem real_proof_context_has_rewarding_purpose :
    isRewardingScriptInfo reclaimGlobalV2SuccessContext = true := by
  native_decide

#print axioms shallow_exact_success_requires_rewarding_purpose
#print axioms exact_success_requires_rewarding_purpose
#print axioms real_proof_falsifies_unsafe_no_success_claim
#print axioms real_proof_falsifies_unsafe_coverage_claim
#print axioms real_proof_falsifies_unsafe_statement_claim
#print axioms real_proof_falsifies_unsafe_value_claim
#print axioms real_proof_context_has_exact_ordered_slot_coverage
#print axioms real_proof_context_has_matching_statements
#print axioms real_proof_context_has_componentwise_value_coverage
#print axioms real_proof_context_has_rewarding_purpose

end ProofToolFormal.ReclaimGlobalV2
