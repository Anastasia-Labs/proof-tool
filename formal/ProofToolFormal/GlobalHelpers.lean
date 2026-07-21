import Blaster
import CardanoLedgerApi.V3
import PlutusCore.Crypto.Hash
import ProofToolFormal.Artifacts
import ProofToolFormal.Result

/-!
Reusable generalized specifications for closed helpers used by ReclaimGlobalV2.
Each compiled helper calls the production Haskell function and only adds a
unit/error observation wrapper where the source function returns data.
-/

namespace ProofToolFormal.GlobalHelpers

open CardanoLedgerApi.IsData.Class (toTerm)
open PlutusCore.Data (Data)
open PlutusCore.ByteString (ByteString appendByteString)
open PlutusCore.Crypto.Hash (blake2b_256)
open PlutusCore.UPLC.Term (Term)
open PlutusCore.UPLC.Utils (isSuccessful)
open ProofToolFormal.Artifacts
open ProofToolFormal.Result

def byteStringTerm (bytes : ByteString) : Term :=
  Term.Const (.ByteString bytes)

def findReferenceInputs
    (index : Int)
    (referenceInputs : List Data)
    (expected : Data) : List Term :=
  [Term.Const (.Integer index), toTerm (Data.List referenceInputs), toTerm expected]

#prep_uplc preparedFindReferenceInput2000
  findReferenceInputEquals findReferenceInputs 2000

def findReferenceAt (index : Int) : List Data → Option Data
  | [] => none
  | value :: remaining =>
      if index == 0 then some value
      else findReferenceAt (index - 1) remaining

def findReferenceAtNat : Nat → List Data → Option Data
  | _, [] => none
  | 0, value :: _ => some value
  | index + 1, _ :: remaining => findReferenceAtNat index remaining

theorem findReferenceAtNat_eq_get?
    (index : Nat)
    (referenceInputs : List Data) :
    findReferenceAtNat index referenceInputs = referenceInputs[index]? := by
  induction index generalizing referenceInputs with
  | zero => cases referenceInputs <;> rfl
  | succ index ih =>
      cases referenceInputs with
      | nil => rfl
      | cons _ remaining => exact ih remaining

theorem exact_findReference_zero_success_iff_head_equals
    (first : Data)
    (remaining : List Data)
    (expected : Data) :
    isSuccessful
        (preparedFindReferenceInput2000.prop 0 (first :: remaining) expected) ↔
      first == expected := by
  blaster

theorem exact_findReference_empty_is_unsuccessful
    (index : Int)
    (expected : Data) :
    ¬ isSuccessful (preparedFindReferenceInput2000.prop index [] expected) := by
  blaster

def selectedReferenceEquals
    (index : Int)
    (referenceInputs : List Data)
    (expected : Data) : Bool :=
  match findReferenceAt index referenceInputs with
  | some actual => actual == expected
  | none => false

def exactFindReferenceResult2000
    (index : Int)
    (referenceInputs : List Data)
    (expected : Data) : BoundedCekResult :=
  executeProgramClassified
    findReferenceInputEquals.script
    (findReferenceInputs index referenceInputs expected)
    2000

def concreteFindReferenceResult : BoundedCekResult :=
  executeProgramClassified
    findReferenceInputEquals.script
    (findReferenceInputs 0 [.I 7] (.I 7))
    2_000_000

theorem concrete_findReference_helper_succeeds :
    classifyBoundedResult true concreteFindReferenceResult = .successfulHalt := by
  native_decide

def statementDigestInputs
    (credential destination expected : ByteString) : List Term :=
  [byteStringTerm credential, byteStringTerm destination, byteStringTerm expected]

#prep_uplc preparedStatementDigest500
  statementDigestEquals statementDigestInputs 500

def ownershipDestinationDomain : ByteString :=
  "ROOT-OWNERSHIP-DESTINATION-v1"

def statementDigestSpec
    (credential destination : ByteString) : ByteString :=
  blake2b_256
    (appendByteString
      (appendByteString ownershipDestinationDomain credential)
      destination)

theorem exact_statementDigest_success_iff_expected_digest
    (credential destination expected : ByteString) :
    isSuccessful
        (preparedStatementDigest500.prop credential destination expected) ↔
      expected = statementDigestSpec credential destination := by
  blaster

def hasParamTokenInputs
    (policyId tokenName : ByteString)
    (output : CardanoLedgerApi.V2.Tx.TxOut) : List Term :=
  [byteStringTerm policyId, byteStringTerm tokenName, toTerm output]

#prep_uplc preparedHasExactParamToken4000
  hasExactParamToken hasParamTokenInputs 4000

def configuredParamNFTQuantityIsOne
    (policyId tokenName : ByteString)
    (output : CardanoLedgerApi.V2.Tx.TxOut) : Bool :=
  CardanoLedgerApi.V1.Value.valueOf policyId tokenName output.txOutValue == 1

theorem exact_hasParamToken_success_requires_configured_quantity_one
    (policyId tokenName : ByteString)
    (output : CardanoLedgerApi.V2.Tx.TxOut) :
    policyId.length = 28 →
    CardanoLedgerApi.V1.Contexts.validTxOutValue output.txOutValue = true →
    isSuccessful
        (preparedHasExactParamToken4000.prop policyId tokenName output) →
      configuredParamNFTQuantityIsOne policyId tokenName output = true := by
  blaster

def outputWithTrailingUnrelatedAssets
    (policyId tokenName extraTokenName extraPolicyId : ByteString)
    (quantity : Int)
    (output : CardanoLedgerApi.V2.Tx.TxOut) :
    CardanoLedgerApi.V2.Tx.TxOut :=
  { output with
    txOutValue :=
      [ (Data.B "", Data.Map [(Data.B "", Data.I 2_000_000)])
      , (Data.B policyId,
          Data.Map
            [ (Data.B tokenName, Data.I quantity)
            , (Data.B extraTokenName, Data.I 7) ])
      , (Data.B extraPolicyId,
          Data.Map [(Data.B "unrelated", Data.I 11)]) ] }

theorem typed_parameter_quantity_ignores_trailing_unrelated_assets
    (policyId tokenName extraTokenName extraPolicyId : ByteString)
    (quantity : Int)
    (output : CardanoLedgerApi.V2.Tx.TxOut) :
    policyId.length = 28 →
    configuredParamNFTQuantityIsOne
        policyId tokenName
        (outputWithTrailingUnrelatedAssets
          policyId tokenName extraTokenName extraPolicyId quantity output) =
      (quantity == 1) := by
  blaster

def singleAssetValue
    (policyId tokenName : ByteString)
    (quantity : Int) : CardanoLedgerApi.V1.Value.Value :=
  [(Data.B policyId, Data.Map [(Data.B tokenName, Data.I quantity)])]

def valuePolicyA : ByteString := "1111111111111111111111111111"
def valuePolicyB : ByteString := "2222222222222222222222222222"
def valuePolicyC : ByteString := "3333333333333333333333333333"

def canonicalAdaAndAssetValue
    (adaQuantity : Int)
    (policyId tokenName : ByteString)
    (quantity : Int) : CardanoLedgerApi.V1.Value.Value :=
  [ (Data.B "", Data.Map [(Data.B "", Data.I adaQuantity)])
  , (Data.B policyId, Data.Map [(Data.B tokenName, Data.I quantity)])
  ]

def appendExtraAsset
    (value : CardanoLedgerApi.V1.Value.Value) :
    CardanoLedgerApi.V1.Value.Value :=
  value ++
    [(Data.B valuePolicyC, Data.Map [(Data.B "", Data.I 1)])]

/-!
The paid value carries a fixed later extra policy so the two Data maps are
structurally unequal.  This bypasses a Lean-Blaster optimizer bug in the
production helper's `equalsData` fast path while exercising the exact compiled
merge comparator on canonical ledger-shaped Values.
-/
def canonicalValueCoverageInputs
    (requiredAda requiredAsset paidAda paidAsset : Int) : List Term :=
  [ toTerm (Data.Map
      (canonicalAdaAndAssetValue
        requiredAda valuePolicyA "asset" requiredAsset))
  , toTerm (Data.Map
      (appendExtraAsset
        (canonicalAdaAndAssetValue
          paidAda valuePolicyA "asset" paidAsset)))
  ]

#prep_uplc preparedCanonicalValueCoverage2500
  valueCovers canonicalValueCoverageInputs 2500

theorem exact_canonicalValueCoverage_success_iff_componentwise_quantities
    (requiredAda requiredAsset paidAda paidAsset : Int) :
    isSuccessful
        (preparedCanonicalValueCoverage2500.prop
          requiredAda requiredAsset paidAda paidAsset) ↔
      requiredAda ≤ paidAda ∧ requiredAsset ≤ paidAsset := by
  blaster

def wrongPolicyValueCoverageInputs
    (requiredAsset paidAsset : Int) : List Term :=
  [ toTerm (Data.Map
      (canonicalAdaAndAssetValue 10 valuePolicyA "asset" requiredAsset))
  , toTerm (Data.Map
      (appendExtraAsset
        (canonicalAdaAndAssetValue 10 valuePolicyB "asset" paidAsset)))
  ]

#prep_uplc preparedWrongPolicyValueCoverage2500
  valueCovers wrongPolicyValueCoverageInputs 2500

theorem exact_canonicalValueCoverage_rejects_wrong_policy
    (requiredAsset paidAsset : Int) :
    ¬ isSuccessful
      (preparedWrongPolicyValueCoverage2500.prop requiredAsset paidAsset) := by
  blaster

def wrongTokenValueCoverageInputs
    (requiredAsset paidAsset : Int) : List Term :=
  [ toTerm (Data.Map
      (canonicalAdaAndAssetValue 10 valuePolicyA "asset-a" requiredAsset))
  , toTerm (Data.Map
      (appendExtraAsset
        (canonicalAdaAndAssetValue 10 valuePolicyA "asset-b" paidAsset)))
  ]

#prep_uplc preparedWrongTokenValueCoverage2500
  valueCovers wrongTokenValueCoverageInputs 2500

theorem exact_canonicalValueCoverage_rejects_wrong_token
    (requiredAsset paidAsset : Int) :
    ¬ isSuccessful
      (preparedWrongTokenValueCoverage2500.prop requiredAsset paidAsset) := by
  blaster

/-!
Independent typed model of the production merge comparator.  The algorithm is
linear on two ordered maps, while the specification below searches the paid
map independently for every required key.  Soundness does not need the ledger
ordering premise: a successful merge walk necessarily found every required
policy/token with a sufficient quantity.  Ledger normalization is needed for
the converse/completeness direction and is supplied by `validScriptContext` at
the production call sites.
-/

abbrev AssetAmounts := List (ByteString × Int)
abbrev PolicyAmounts := List (ByteString × AssetAmounts)

def mergeAssetAmountsCover : AssetAmounts → AssetAmounts → Bool
  | [], _ => true
  | _, [] => false
  | required@((requiredName, requiredQuantity) :: moreRequired),
      (paidName, paidQuantity) :: morePaid =>
      if requiredName == paidName then
        requiredQuantity ≤ paidQuantity &&
          mergeAssetAmountsCover moreRequired morePaid
      else if requiredName < paidName then
        false
      else
        mergeAssetAmountsCover required morePaid
termination_by required paid => required.length + paid.length

def assetEntryIsCovered
    (required : ByteString × Int)
    (paid : AssetAmounts) : Bool :=
  paid.any (fun candidate =>
    candidate.1 == required.1 && required.2 ≤ candidate.2)

def everyAssetEntryIsCovered
    (required paid : AssetAmounts) : Bool :=
  required.all (fun entry => assetEntryIsCovered entry paid)

theorem mergeAssetAmountsCover_sound
    (required paid : AssetAmounts) :
    mergeAssetAmountsCover required paid = true →
      everyAssetEntryIsCovered required paid = true := by
  induction required, paid using mergeAssetAmountsCover.induct <;>
    simp_all [mergeAssetAmountsCover, everyAssetEntryIsCovered,
      assetEntryIsCovered]

def mergePolicyAmountsCover : PolicyAmounts → PolicyAmounts → Bool
  | [], _ => true
  | _, [] => false
  | required@((requiredPolicy, requiredAssets) :: moreRequired),
      (paidPolicy, paidAssets) :: morePaid =>
      if requiredPolicy == paidPolicy then
        mergeAssetAmountsCover requiredAssets paidAssets &&
          mergePolicyAmountsCover moreRequired morePaid
      else if requiredPolicy < paidPolicy then
        false
      else
        mergePolicyAmountsCover required morePaid
termination_by required paid => required.length + paid.length

def policyEntryIsCovered
    (required : ByteString × AssetAmounts)
    (paid : PolicyAmounts) : Bool :=
  paid.any (fun candidate =>
    candidate.1 == required.1 &&
      everyAssetEntryIsCovered required.2 candidate.2)

def everyPolicyAndAssetIsCovered
    (required paid : PolicyAmounts) : Bool :=
  required.all (fun entry => policyEntryIsCovered entry paid)

theorem mergePolicyAmountsCover_sound
    (required paid : PolicyAmounts) :
    mergePolicyAmountsCover required paid = true →
      everyPolicyAndAssetIsCovered required paid = true := by
  induction required, paid using mergePolicyAmountsCover.induct <;>
    simp_all [mergePolicyAmountsCover, everyPolicyAndAssetIsCovered,
      policyEntryIsCovered, mergeAssetAmountsCover_sound]

def batchTranscriptInputs
    (verifierKeyHash : ByteString)
    (proofs digests : List Data)
    (expected : ByteString) : List Term :=
  [ byteStringTerm verifierKeyHash
  , toTerm (Data.List proofs)
  , toTerm (Data.List digests)
  , byteStringTerm expected
  ]

#prep_uplc preparedBatchTranscriptV2_1000
  batchTranscriptV2Equals batchTranscriptInputs 1000

def ownershipProofBatchDomainV2 : ByteString :=
  "ROOT-OWNERSHIP-POK-BATCH-v2"

def oneSlotTranscriptSpec
    (verifierKeyHash proof digest : ByteString) : ByteString :=
  appendByteString
    (appendByteString
      (appendByteString
        (appendByteString ownershipProofBatchDomainV2 verifierKeyHash)
        "\x00\x01")
      proof)
    digest

def emptyTranscriptSpec (verifierKeyHash : ByteString) : ByteString :=
  appendByteString
    (appendByteString ownershipProofBatchDomainV2 verifierKeyHash)
    "\x00\x00"

def twoSlotTranscriptSpec
    (verifierKeyHash proof₁ digest₁ proof₂ digest₂ : ByteString) : ByteString :=
  appendByteString
    (appendByteString
      (appendByteString
        (appendByteString
          (appendByteString
            (appendByteString ownershipProofBatchDomainV2 verifierKeyHash)
            "\x00\x02")
          proof₁)
        digest₁)
      proof₂)
    digest₂

/-!
`batchSlotsWellFormed` and `batchTranscriptItemsRecursive` are independent
typed specifications of the recursive production loop.  The former captures
parallel-list consumption and the fixed proof/digest widths; the latter makes
the ledger-order concatenation explicit.  The induction theorems below range
over lists of arbitrary length.  They complement, rather than replace, the
exact compiled empty/one/two-step branch theorems.
-/

def batchSlotsWellFormed : List ByteString → List ByteString → Bool
  | [], [] => true
  | proof :: proofs, digest :: digests =>
      proof.length == 336 &&
        digest.length == 32 &&
        batchSlotsWellFormed proofs digests
  | _, _ => false

def batchTranscriptItemsRecursive :
    List ByteString → List ByteString → ByteString
  | proof :: proofs, digest :: digests =>
      appendByteString
        (appendByteString proof digest)
        (batchTranscriptItemsRecursive proofs digests)
  | _, _ => ""

def batchTranscriptItemsFold
    (proofs digests : List ByteString) : ByteString :=
  (List.zip proofs digests).foldr
    (fun slot remaining =>
      appendByteString
        (appendByteString slot.1 slot.2)
        remaining)
    ""

theorem batchSlotsWellFormed_iff_parallel_fixed_width
    (proofs digests : List ByteString) :
    batchSlotsWellFormed proofs digests = true ↔
      proofs.length = digests.length ∧
      proofs.all (fun proof => proof.length == 336) = true ∧
      digests.all (fun digest => digest.length == 32) = true := by
  induction proofs generalizing digests with
  | nil => cases digests <;> simp [batchSlotsWellFormed]
  | cons proof proofs ih =>
      cases digests <;>
        simp [batchSlotsWellFormed, ih, and_assoc, and_left_comm,
          and_comm]

theorem batchTranscriptItemsRecursive_eq_fold
    (proofs digests : List ByteString) :
    batchTranscriptItemsRecursive proofs digests =
      batchTranscriptItemsFold proofs digests := by
  induction proofs generalizing digests with
  | nil => cases digests <;> rfl
  | cons proof proofs ih =>
      cases digests with
      | nil => rfl
      | cons digest digests =>
          simp [batchTranscriptItemsRecursive, batchTranscriptItemsFold, ih]

theorem batchSlotsWellFormed_preserves_count
    (proofs digests : List ByteString) :
    batchSlotsWellFormed proofs digests = true →
      proofs.length = digests.length := by
  intro wellFormed
  exact
    (batchSlotsWellFormed_iff_parallel_fixed_width proofs digests).mp
      wellFormed |>.1

theorem batchSlotsWellFormed_preserves_head_and_tail_order
    (proof : ByteString)
    (proofs : List ByteString)
    (digest : ByteString)
    (digests : List ByteString) :
    batchSlotsWellFormed (proof :: proofs) (digest :: digests) = true →
      batchTranscriptItemsRecursive (proof :: proofs) (digest :: digests) =
        appendByteString
          (appendByteString proof digest)
          (batchTranscriptItemsRecursive proofs digests) := by
  intro _
  rfl

theorem exact_emptyTranscript_success_iff_framed_bytes
    (verifierKeyHash expected : ByteString) :
    verifierKeyHash.length = 32 →
    ( isSuccessful
        (preparedBatchTranscriptV2_1000.prop
          verifierKeyHash [] [] expected) ↔
      expected = emptyTranscriptSpec verifierKeyHash ) := by
  blaster

theorem exact_oneSlotTranscript_success_iff_framed_bytes
    (verifierKeyHash proof digest expected : ByteString) :
    verifierKeyHash.length = 32 →
    proof.length = 336 →
    digest.length = 32 →
    ( isSuccessful
        (preparedBatchTranscriptV2_1000.prop
          verifierKeyHash [Data.B proof] [Data.B digest] expected) ↔
      expected = oneSlotTranscriptSpec verifierKeyHash proof digest ) := by
  blaster

theorem exact_transcript_rejects_missing_digest
    (verifierKeyHash proof expected : ByteString) :
    ¬ isSuccessful
      (preparedBatchTranscriptV2_1000.prop
        verifierKeyHash [Data.B proof] [] expected) := by
  blaster

theorem exact_transcript_rejects_missing_proof
    (verifierKeyHash digest expected : ByteString) :
    ¬ isSuccessful
      (preparedBatchTranscriptV2_1000.prop
        verifierKeyHash [] [Data.B digest] expected) := by
  blaster

theorem exact_transcript_success_requires_slot_widths
    (verifierKeyHash proof digest expected : ByteString) :
    isSuccessful
        (preparedBatchTranscriptV2_1000.prop
          verifierKeyHash [Data.B proof] [Data.B digest] expected) →
    proof.length = 336 ∧ digest.length = 32 := by
  blaster

#print axioms findReferenceAtNat_eq_get?
#print axioms exact_findReference_zero_success_iff_head_equals
#print axioms exact_findReference_empty_is_unsuccessful
#print axioms concrete_findReference_helper_succeeds
#print axioms exact_statementDigest_success_iff_expected_digest
#print axioms exact_hasParamToken_success_requires_configured_quantity_one
#print axioms typed_parameter_quantity_ignores_trailing_unrelated_assets
#print axioms exact_canonicalValueCoverage_success_iff_componentwise_quantities
#print axioms exact_canonicalValueCoverage_rejects_wrong_policy
#print axioms exact_canonicalValueCoverage_rejects_wrong_token
#print axioms mergeAssetAmountsCover_sound
#print axioms mergePolicyAmountsCover_sound
#print axioms batchSlotsWellFormed_iff_parallel_fixed_width
#print axioms batchTranscriptItemsRecursive_eq_fold
#print axioms batchSlotsWellFormed_preserves_count
#print axioms batchSlotsWellFormed_preserves_head_and_tail_order
#print axioms exact_emptyTranscript_success_iff_framed_bytes
#print axioms exact_oneSlotTranscript_success_iff_framed_bytes
#print axioms exact_transcript_rejects_missing_digest
#print axioms exact_transcript_rejects_missing_proof
#print axioms exact_transcript_success_requires_slot_widths

end ProofToolFormal.GlobalHelpers
