import ProofToolFormal.ReclaimGlobalV2

/-!
Kernel-inductive facts about the independent GlobalV2 slot specification.
These are deliberately separate from the still-open exact-monolith bridge.
-/

namespace ProofToolFormal.GlobalSemanticLemmas

open CardanoLedgerApi.V3
open PlutusCore.ByteString (ByteString)
open ProofToolFormal.ReclaimGlobalV2

def matchingInputCount (baseHash : ByteString) : List TxInInfo → Nat
  | [] => 0
  | input :: remaining =>
      (if isMatchingBaseInput baseHash input then 1 else 0) +
        matchingInputCount baseHash remaining

theorem slotsHaveExactCoverage_counts
    (baseHash : ByteString)
    (inputs : List TxInInfo)
    (proofs digests : List ByteString)
    (destinations : List CardanoLedgerApi.V2.Tx.TxOut)
    (covered : slotsHaveExactCoverage
      baseHash inputs proofs digests destinations = true) :
    proofs.length = matchingInputCount baseHash inputs ∧
    digests.length = matchingInputCount baseHash inputs ∧
    matchingInputCount baseHash inputs ≤ destinations.length := by
  induction inputs generalizing proofs digests destinations with
  | nil =>
      simp [slotsHaveExactCoverage] at covered
      simp [matchingInputCount, covered]
  | cons input inputs ih =>
      by_cases hmatch : isMatchingBaseInput baseHash input = true
      · cases proofs with
        | nil => simp [slotsHaveExactCoverage, hmatch] at covered
        | cons proof proofs =>
          cases digests with
          | nil => simp [slotsHaveExactCoverage, hmatch] at covered
          | cons digest digests =>
            cases destinations with
            | nil => simp [slotsHaveExactCoverage, hmatch] at covered
            | cons destination destinations =>
              simp [slotsHaveExactCoverage, hmatch] at covered
              have tail := ih proofs digests destinations covered.2
              simp [matchingInputCount, hmatch]
              omega
      · have notMatches : isMatchingBaseInput baseHash input = false := by
          cases value : isMatchingBaseInput baseHash input with
          | false => rfl
          | true => exact (hmatch value).elim
        simp [slotsHaveExactCoverage, notMatches] at covered
        have tail := ih proofs digests destinations covered
        simpa [matchingInputCount, notMatches] using tail

theorem slotsHaveMatchingStatements_implies_exactCoverage
    (baseHash : ByteString)
    (inputs : List TxInInfo)
    (proofs digests : List ByteString)
    (destinations : List CardanoLedgerApi.V2.Tx.TxOut)
    (matching : slotsHaveMatchingStatements
      baseHash inputs proofs digests destinations = true) :
    slotsHaveExactCoverage baseHash inputs proofs digests destinations = true := by
  induction inputs generalizing proofs digests destinations with
  | nil => simpa [slotsHaveMatchingStatements, slotsHaveExactCoverage] using matching
  | cons input inputs ih =>
      by_cases hmatch : isMatchingBaseInput baseHash input = true
      · cases proofs with
        | nil => simp [slotsHaveMatchingStatements, hmatch] at matching
        | cons proof proofs =>
          cases digests with
          | nil => simp [slotsHaveMatchingStatements, hmatch] at matching
          | cons digest digests =>
            cases destinations with
            | nil => simp [slotsHaveMatchingStatements, hmatch] at matching
            | cons destination destinations =>
              cases payment : basePaymentCredential input with
              | none =>
                  simp [slotsHaveMatchingStatements, hmatch, payment] at matching
              | some credential =>
                cases address : destinationAddressV1Bytes destination with
                | none =>
                    simp [slotsHaveMatchingStatements, hmatch, payment, address] at matching
                | some destinationBytes =>
                  simp [slotsHaveMatchingStatements, hmatch, payment, address] at matching
                  have proofWidth := matching.1.1.1
                  have digestWidth := matching.1.1.2
                  have digestMatches := matching.1.2
                  have tailMatching := matching.2
                  simp [slotsHaveExactCoverage, hmatch, proofWidth, digestWidth]
                  exact ih proofs digests destinations tailMatching
      · have notMatches : isMatchingBaseInput baseHash input = false := by
          cases value : isMatchingBaseInput baseHash input with
          | false => rfl
          | true => exact (hmatch value).elim
        simp [slotsHaveMatchingStatements, notMatches] at matching
        simp [slotsHaveExactCoverage, notMatches]
        exact ih proofs digests destinations matching

theorem everyConsumedStatementMatches_implies_exactOrderedSlotCoverage
    (ctx : ScriptContext)
    (matching : everyConsumedStatementMatches ctx = true) :
    exactOrderedSlotCoverage ctx = true := by
  unfold everyConsumedStatementMatches at matching
  unfold exactOrderedSlotCoverage
  cases view : semanticView ctx with
  | none => simp [view] at matching
  | some semantic =>
      simp [view] at matching ⊢
      exact ⟨matching.1,
        slotsHaveMatchingStatements_implies_exactCoverage
          semantic.baseHash semantic.inputs semantic.proofs semantic.digests
          semantic.destinations matching.2⟩

theorem slotsHaveValueCoverage_counts
    (baseHash : ByteString)
    (inputs : List TxInInfo)
    (proofs digests : List ByteString)
    (destinations : List CardanoLedgerApi.V2.Tx.TxOut)
    (covered : slotsHaveValueCoverage
      baseHash inputs proofs digests destinations = true) :
    proofs.length = matchingInputCount baseHash inputs ∧
    digests.length = matchingInputCount baseHash inputs ∧
    matchingInputCount baseHash inputs ≤ destinations.length := by
  induction inputs generalizing proofs digests destinations with
  | nil =>
      simp [slotsHaveValueCoverage] at covered
      simp [matchingInputCount, covered]
  | cons input inputs ih =>
      by_cases hmatch : isMatchingBaseInput baseHash input = true
      · cases proofs with
        | nil => simp [slotsHaveValueCoverage, hmatch] at covered
        | cons proof proofs =>
          cases digests with
          | nil => simp [slotsHaveValueCoverage, hmatch] at covered
          | cons digest digests =>
            cases destinations with
            | nil => simp [slotsHaveValueCoverage, hmatch] at covered
            | cons destination destinations =>
              simp [slotsHaveValueCoverage, hmatch] at covered
              have tail := ih proofs digests destinations covered.2
              simp [matchingInputCount, hmatch]
              omega
      · have notMatches : isMatchingBaseInput baseHash input = false := by
          cases value : isMatchingBaseInput baseHash input with
          | false => rfl
          | true => exact (hmatch value).elim
        simp [slotsHaveValueCoverage, notMatches] at covered
        have tail := ih proofs digests destinations covered
        simpa [matchingInputCount, notMatches] using tail

theorem destinationAddressV1Bytes_has_fixed_width
    (output : CardanoLedgerApi.V2.Tx.TxOut)
    (bytes : ByteString)
    (encoded : destinationAddressV1Bytes output = some bytes) :
    bytes.length = 58 := by
  unfold destinationAddressV1Bytes at encoded
  cases payment : credentialAddressBytes output.txOutAddress.addressCredential with
  | none => simp [payment] at encoded
  | some paymentBytes =>
    cases stake : stakeAddressBytes output.txOutAddress.addressStakingCredential with
    | none => simp [payment, stake] at encoded
    | some stakeBytes =>
      simp [payment, stake] at encoded
      rw [← encoded.2]
      exact encoded.1

#print axioms slotsHaveExactCoverage_counts
#print axioms slotsHaveMatchingStatements_implies_exactCoverage
#print axioms everyConsumedStatementMatches_implies_exactOrderedSlotCoverage
#print axioms slotsHaveValueCoverage_counts
#print axioms destinationAddressV1Bytes_has_fixed_width

end ProofToolFormal.GlobalSemanticLemmas
