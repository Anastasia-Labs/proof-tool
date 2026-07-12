{-# LANGUAGE BangPatterns #-}
{-# LANGUAGE DataKinds #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TemplateHaskell #-}

module Ownership.ReclaimGlobal
  ( ReclaimBaseDatum (..)
  , ReclaimGlobalParams (..)
  , ReclaimGlobalRedeemer (..)
  , findReferenceInputAt
  , foldBatchScalarState
  , retainBatchScalarState
  , hasExactlyOneParamToken
  , reclaimGlobalParamsData
  , reclaimProofBytesConcat
  , reclaimGlobalRedeemerData
  , reclaimGlobalRedeemerDataV2
  , reclaimBatchTranscriptV2
  , reclaimSameAsPreviousProof
  , reclaimGlobalValidator
  , reclaimGlobalValidatorCode
  , reclaimGlobalValidatorUntyped
  , reclaimGlobalValidatorV2
  , reclaimGlobalValidatorV2Code
  , reclaimGlobalValidatorV2Untyped
  , validateReclaimInputs
  , validateReclaimInputsV2
  , valueCoversData
  ) where

import PlutusLedgerApi.V3
  ( CurrencySymbol (CurrencySymbol)
  , ScriptHash (ScriptHash)
  , TokenName (TokenName)
  )
import PlutusTx (CompiledCode)
import PlutusTx.Builtins (ByteOrder (BigEndian))
import PlutusTx.Prelude
import qualified PlutusTx
import qualified PlutusTx.Builtins as B
import qualified PlutusTx.Builtins.Internal as BI

import Ownership.ReclaimBase (ReclaimBaseDatum (..))
import Ownership.Verify
  ( BatchCommittedProofCheck (..)
  , CommittedProofCheck (..)
  , ParsedBatchVerifyingKey
  , Proof (Proof)
  , Scalar (Scalar)
  , blsScalarFieldOrder
  , coefficientFirstVkX
  , committedProofChallengeScalar
  , groth16VerifyCommittedParsedBatchNoPok
  , ownershipDestinationPublicInputDigest
  , ownershipDestinationPublicInputScalar
  , ownershipProofBatchChallenge
  , ownershipProofBatchChallengeV2
  , ownershipProofBatchDomainV2
  , parseVerifyingKeyBatch
  , verifyCommittedProofGrothBatch
  , verifyCommittedProofPokBatchWithBatchVK
  , verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok
  , verifyOwnershipDestinationWithParsedBatchVKLegacyKnown28NoPok
  )

data ReclaimGlobalParams = ReclaimGlobalParams
  { reclaimBaseScriptHash :: ScriptHash
  }

data ReclaimGlobalRedeemer = ReclaimGlobalRedeemer
  { reclaimParamsIdx :: Integer
  , reclaimDestinationOutStartIdx :: Integer
  , reclaimProofs :: [BuiltinByteString]
  }

-- | The exact empty bytestring is the only same-as-previous proof marker.
-- Full committed proofs are exactly 336 bytes, so ON-02 makes this encoding
-- disjoint from every valid proof without changing the existing redeemer
-- shape.
{-# INLINABLE reclaimSameAsPreviousProof #-}
reclaimSameAsPreviousProof :: BuiltinByteString
reclaimSameAsPreviousProof = emptyByteString

{-# INLINABLE reclaimGlobalParamsData #-}
reclaimGlobalParamsData :: ScriptHash -> BuiltinData
reclaimGlobalParamsData (ScriptHash baseScriptHash) =
  BI.mkConstr
    0
    ( BI.mkCons
        (BI.mkB baseScriptHash)
        (BI.mkNilData BI.unitval)
    )

{-# INLINABLE reclaimGlobalRedeemerData #-}
reclaimGlobalRedeemerData :: Integer -> Integer -> [BuiltinByteString] -> BuiltinData
reclaimGlobalRedeemerData paramsIdx destinationOutStartIdx proofs =
  BI.mkConstr
    0
    ( BI.mkCons
        (BI.mkI paramsIdx)
        ( BI.mkCons
            (BI.mkI destinationOutStartIdx)
            ( BI.mkCons
                (BI.mkList (proofListData proofs))
                (BI.mkNilData BI.unitval)
            )
        )
    )
  where
    proofListData [] = BI.mkNilData BI.unitval
    proofListData (proof : moreProofs) =
      BI.mkCons (BI.mkB proof) (proofListData moreProofs)

-- | V2 stores one full proof and one public-input-digest witness for each
-- logical reclaim slot. The claimed digest is authenticated later against the
-- actual input and destination output.
{-# INLINABLE reclaimGlobalRedeemerDataV2 #-}
reclaimGlobalRedeemerDataV2 :: Integer -> Integer -> [BuiltinByteString] -> [BuiltinByteString] -> BuiltinData
reclaimGlobalRedeemerDataV2 paramsIdx destinationOutStartIdx proofs publicInputDigests =
  BI.mkConstr
    0
    ( BI.mkCons
        (BI.mkI paramsIdx)
        ( BI.mkCons
            (BI.mkI destinationOutStartIdx)
            ( BI.mkCons
                (BI.mkList (byteStringListData proofs))
                ( BI.mkCons
                    (BI.mkList (byteStringListData publicInputDigests))
                    (BI.mkNilData BI.unitval)
                )
            )
        )
    )
  where
    byteStringListData [] = BI.mkNilData BI.unitval
    byteStringListData (entry : remainingEntries) =
      BI.mkCons (BI.mkB entry) (byteStringListData remainingEntries)

{-# INLINABLE builtinIf #-}
builtinIf :: BI.BuiltinBool -> a -> a -> a
builtinIf condition trueBranch falseBranch =
  BI.ifThenElse
    condition
    (\_ -> trueBranch)
    (\_ -> falseBranch)
    BI.unitval

{-# INLINABLE boolToBuiltin #-}
boolToBuiltin :: Bool -> BI.BuiltinBool
boolToBuiltin condition =
  if condition then BI.true else BI.false

{-# INLINABLE builtinAnd #-}
builtinAnd :: BI.BuiltinBool -> BI.BuiltinBool -> BI.BuiltinBool
builtinAnd left right =
  builtinIf left right BI.false

{-# INLINABLE builtinToBool #-}
builtinToBool :: BI.BuiltinBool -> Bool
builtinToBool condition =
  builtinIf condition True False

{-# INLINABLE constrFields #-}
constrFields :: BuiltinData -> BI.BuiltinList BuiltinData
constrFields datum =
  BI.snd (BI.unsafeDataAsConstr datum)

{-# INLINABLE field0 #-}
field0 :: BI.BuiltinList BuiltinData -> BuiltinData
field0 =
  BI.head

{-# INLINABLE field1 #-}
field1 :: BI.BuiltinList BuiltinData -> BuiltinData
field1 fields =
  BI.head (BI.tail fields)

{-# INLINABLE field2 #-}
field2 :: BI.BuiltinList BuiltinData -> BuiltinData
field2 fields =
  BI.head (BI.tail (BI.tail fields))

{-# INLINABLE field3 #-}
field3 :: BI.BuiltinList BuiltinData -> BuiltinData
field3 fields =
  BI.head (BI.tail (BI.tail (BI.tail fields)))

{-# INLINABLE hasExactlyFourFields #-}
hasExactlyFourFields :: BI.BuiltinList BuiltinData -> BI.BuiltinBool
hasExactlyFourFields fields =
  B.caseList
    (\() -> BI.false)
    ( \_ afterFirst ->
        B.caseList
          (\() -> BI.false)
          ( \_ afterSecond ->
              B.caseList
                (\() -> BI.false)
                ( \_ afterThird ->
                    B.caseList
                      (\() -> BI.false)
                      (\_ afterFourth -> B.caseList (\() -> BI.true) (\_ _ -> BI.false) afterFourth)
                      afterThird
                )
                afterSecond
          )
          afterFirst
    )
    fields

{-# INLINABLE constrTag #-}
constrTag :: BuiltinData -> Integer
constrTag datum =
  BI.fst (BI.unsafeDataAsConstr datum)

{-# INLINABLE findDataAt #-}
findDataAt :: BuiltinString -> Integer -> BI.BuiltinList BuiltinData -> BuiltinData
findDataAt errorMessage idx values =
  if idx < 0
    then traceError errorMessage
    else go idx values
  where
    go !n !remaining =
      B.caseList
        (\() -> traceError errorMessage)
        ( \value rest ->
            builtinIf
              (BI.equalsInteger n 0)
              value
              (go (n - 1) rest)
        )
        remaining

{-# INLINABLE dropAtData #-}
dropAtData :: BuiltinString -> Integer -> BI.BuiltinList BuiltinData -> BI.BuiltinList BuiltinData
dropAtData errorMessage idx values =
  if idx < 0
    then traceError errorMessage
    else go idx values
  where
    go !n !remaining =
      if n == 0
        then remaining
        else
          B.caseList
            (\() -> traceError errorMessage)
            (\_ rest -> go (n - 1) rest)
            remaining

{-# INLINABLE findReferenceInputAtData #-}
findReferenceInputAtData :: Integer -> BI.BuiltinList BuiltinData -> BuiltinData
findReferenceInputAtData =
  findDataAt "invalid parameter ref index"

{-# INLINABLE findReferenceInputAt #-}
findReferenceInputAt :: Integer -> BI.BuiltinList BuiltinData -> BuiltinData
findReferenceInputAt =
  findReferenceInputAtData

{-# INLINABLE hasExactlyOneParamTokenFromFields #-}
hasExactlyOneParamTokenFromFields :: BuiltinByteString -> BuiltinByteString -> BI.BuiltinList BuiltinData -> BI.BuiltinBool
hasExactlyOneParamTokenFromFields paramsCurrencySymbol paramsTokenName txOutFields =
  let !txOutValueData = field1 txOutFields
      !valueEntries = BI.unsafeDataAsMap txOutValueData
      !nonAdaEntries = BI.tail valueEntries
   in B.caseList
        (\() -> BI.false)
        ( \paramEntry morePolicies ->
            B.caseList
              (\() -> exactParamEntry paramEntry)
              (\_ _ -> BI.false)
              morePolicies
        )
        nonAdaEntries
  where
    exactParamEntry !paramEntry =
      BI.equalsByteString (BI.unsafeDataAsB (BI.fst paramEntry)) paramsCurrencySymbol
        `builtinAnd` hasExactToken (BI.unsafeDataAsMap (BI.snd paramEntry))

    hasExactToken !tokens =
      B.caseList
        (\() -> BI.false)
        ( \token moreTokens ->
            B.caseList
              ( \() ->
                  BI.equalsByteString (BI.unsafeDataAsB (BI.fst token)) paramsTokenName
                    `builtinAnd` BI.equalsInteger (BI.unsafeDataAsI (BI.snd token)) 1
              )
              (\_ _ -> BI.false)
              moreTokens
        )
        tokens

{-# INLINABLE hasExactlyOneParamToken #-}
hasExactlyOneParamToken :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> BI.BuiltinBool
hasExactlyOneParamToken paramsCurrencySymbol paramsTokenName txOut =
  hasExactlyOneParamTokenFromFields paramsCurrencySymbol paramsTokenName (constrFields txOut)

{-# INLINABLE txInResolved #-}
txInResolved :: BuiltinData -> BuiltinData
txInResolved txIn =
  field1 (constrFields txIn)

-- Both values passed by ReclaimGlobal are raw Value fields taken directly from
-- ledger-built TxOuts in the ScriptContext. They are never redeemer, datum, or
-- validator-created values. The ledger guarantees unique, lexicographically
-- ordered policy and token maps, with only positive represented quantities, so
-- compare them directly without decoding BuiltinData to Value or re-validating
-- those ledger invariants here.
{-# INLINABLE valueCoversData #-}
valueCoversData :: BuiltinData -> BuiltinData -> BI.BuiltinBool
valueCoversData requiredValueData paidValueData =
  builtinIf
    (BI.equalsData requiredValueData paidValueData)
    BI.true
    ( let !requiredPolicies = BI.unsafeDataAsMap requiredValueData
          !paidPolicies = BI.unsafeDataAsMap paidValueData
       in ledgerValueCovers requiredPolicies paidPolicies
    )

-- | Linear componentwise coverage for ledger-normalized TxOut Values. A
-- required key that sorts before the current paid key is absent and therefore
-- fails; an earlier paid key is an allowed extra asset and is skipped.
{-# INLINABLE ledgerValueCovers #-}
ledgerValueCovers :: BI.BuiltinList (BI.BuiltinPair BuiltinData BuiltinData) -> BI.BuiltinList (BI.BuiltinPair BuiltinData BuiltinData) -> BI.BuiltinBool
ledgerValueCovers requiredPolicies paidPolicies =
  B.caseList
    (\() -> BI.true)
    ( \requiredPolicy moreRequiredPolicies ->
        B.caseList
          (\() -> BI.false)
          ( \paidPolicy morePaidPolicies ->
              let !requiredPolicyId = BI.unsafeDataAsB (BI.fst requiredPolicy)
                  !paidPolicyId = BI.unsafeDataAsB (BI.fst paidPolicy)
               in builtinIf
                    (BI.equalsByteString requiredPolicyId paidPolicyId)
                    ( ledgerTokenValueCovers
                        (BI.unsafeDataAsMap (BI.snd requiredPolicy))
                        (BI.unsafeDataAsMap (BI.snd paidPolicy))
                        `builtinAnd` ledgerValueCovers moreRequiredPolicies morePaidPolicies
                    )
                    ( builtinIf
                        (BI.lessThanByteString requiredPolicyId paidPolicyId)
                        BI.false
                        (ledgerValueCovers requiredPolicies morePaidPolicies)
                    )
          )
          paidPolicies
    )
    requiredPolicies

{-# INLINABLE ledgerTokenValueCovers #-}
ledgerTokenValueCovers :: BI.BuiltinList (BI.BuiltinPair BuiltinData BuiltinData) -> BI.BuiltinList (BI.BuiltinPair BuiltinData BuiltinData) -> BI.BuiltinBool
ledgerTokenValueCovers requiredTokens paidTokens =
  B.caseList
    (\() -> BI.true)
    ( \requiredToken moreRequiredTokens ->
        B.caseList
          (\() -> BI.false)
          ( \paidToken morePaidTokens ->
              let !requiredTokenName = BI.unsafeDataAsB (BI.fst requiredToken)
                  !paidTokenName = BI.unsafeDataAsB (BI.fst paidToken)
               in builtinIf
                    (BI.equalsByteString requiredTokenName paidTokenName)
                    ( BI.lessThanEqualsInteger (BI.unsafeDataAsI (BI.snd requiredToken)) (BI.unsafeDataAsI (BI.snd paidToken))
                        `builtinAnd` ledgerTokenValueCovers moreRequiredTokens morePaidTokens
                    )
                    ( builtinIf
                        (BI.lessThanByteString requiredTokenName paidTokenName)
                        BI.false
                        (ledgerTokenValueCovers requiredTokens morePaidTokens)
                    )
          )
          paidTokens
    )
    requiredTokens

{-# INLINABLE decodeValidatedParams #-}
decodeValidatedParams :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinByteString
decodeValidatedParams paramsCurrencySymbol paramsTokenName paramsOut =
  let !paramsOutFields = constrFields paramsOut
   in builtinIf
        (hasExactlyOneParamTokenFromFields paramsCurrencySymbol paramsTokenName paramsOutFields)
        ( let !outputDatum = field2 paramsOutFields
              !datumConstr = BI.unsafeDataAsConstr outputDatum
              !paramsDatum = BI.head (BI.snd datumConstr)
              !paramsConstr = BI.unsafeDataAsConstr paramsDatum
           in BI.unsafeDataAsB (BI.head (BI.snd paramsConstr))
        )
        (traceError "parameter NFT invalid")

{-# INLINABLE isReclaimBaseInput #-}
isReclaimBaseInput :: BuiltinByteString -> BI.BuiltinList BuiltinData -> BI.BuiltinBool
isReclaimBaseInput baseScriptHash txOutFields =
  let !address = field0 txOutFields
      !addressFields = constrFields address
      !credential = field0 addressFields
      !credentialConstr = BI.unsafeDataAsConstr credential
   in builtinIf
        (BI.equalsInteger (BI.fst credentialConstr) 1)
        (BI.equalsByteString (BI.unsafeDataAsB (BI.head (BI.snd credentialConstr))) baseScriptHash)
        BI.false

{-# INLINABLE isSameAsPreviousProof #-}
isSameAsPreviousProof :: BuiltinByteString -> BI.BuiltinBool
isSameAsPreviousProof proof =
  BI.equalsByteString proof reclaimSameAsPreviousProof

-- | Concatenate the resolved full proof bytes for the batch transcript.
-- A marker is expanded to the immediately preceding resolved proof before it
-- is absorbed. This intentionally preserves the pre-V5 transcript for the
-- fully expanded redeemer.
{-# INLINABLE reclaimProofBytesConcat #-}
reclaimProofBytesConcat :: BI.BuiltinList BuiltinData -> BuiltinByteString
reclaimProofBytesConcat proofs =
  B.caseList
    (\() -> emptyByteString)
    ( \proofData moreProofs ->
        let !proof = BI.unsafeDataAsB proofData
         in builtinIf
              (isSameAsPreviousProof proof)
              (traceError "proof reuse marker cannot be first")
              (proof <> go proof moreProofs)
    )
    proofs
  where
    go !previousProof !remainingProofs =
      B.caseList
        (\() -> emptyByteString)
        ( \proofData moreProofs ->
            let !proofSlot = BI.unsafeDataAsB proofData
                !resolvedProof =
                  builtinIf
                    (isSameAsPreviousProof proofSlot)
                    previousProof
                    proofSlot
             in resolvedProof <> go resolvedProof moreProofs
        )
        remainingProofs

-- | The exact v2 framing is domain || embedded key hash || u16 count || the
-- ordered concatenation of full proof/digest pairs. This is deliberately the
-- only V2 builder: it validates both parallel lists while consuming them
-- together and never materializes a flat digest blob for later slicing.
{-# INLINABLE reclaimBatchTranscriptV2 #-}
reclaimBatchTranscriptV2 :: BuiltinByteString -> BI.BuiltinList BuiltinData -> BI.BuiltinList BuiltinData -> BuiltinByteString
reclaimBatchTranscriptV2 verifierKeyHash proofs publicInputDigests =
  if lengthOfByteString verifierKeyHash == 32
    then
      let !(!count, !items) = go 0 proofs publicInputDigests
          !header =
            (ownershipProofBatchDomainV2 <> verifierKeyHash)
              <> integerToByteString BigEndian 2 count
       in header <> items
    else traceError "verifier key hash must be 32 bytes"
  where
    go !count !remainingProofs !remainingDigests =
      B.caseList
        ( \() ->
            B.caseList
              (\() -> (count, emptyByteString))
              (\_ _ -> traceError "reclaim proof/digest list lengths differ")
              remainingDigests
        )
        ( \proofData moreProofs ->
            B.caseList
              (\() -> traceError "reclaim proof/digest list lengths differ")
              ( \digestData moreDigests ->
                  let !proof = BI.unsafeDataAsB proofData
                      !digest = BI.unsafeDataAsB digestData
                   in builtinIf
                        ( BI.equalsInteger (lengthOfByteString proof) 336
                            `builtinAnd` BI.equalsInteger (lengthOfByteString digest) 32
                        )
                        ( if count < 65535
                            then
                              let !item = proof <> digest
                                  !(!finalCount, !remainingItems) = go (count + 1) moreProofs moreDigests
                               in (finalCount, item <> remainingItems)
                            else traceError "reclaim batch count exceeds u16"
                        )
                        (traceError "invalid reclaim proof or digest width")
              )
              remainingDigests
        )
        remainingProofs

{-# INLINABLE decodeBasePaymentKeyHashFromFields #-}
decodeBasePaymentKeyHashFromFields :: BI.BuiltinList BuiltinData -> BuiltinByteString
decodeBasePaymentKeyHashFromFields txOutFields =
  let !outputDatum = field2 txOutFields
      !datumConstr = BI.unsafeDataAsConstr outputDatum
      !baseDatum = BI.head (BI.snd datumConstr)
      !baseDatumConstr = BI.unsafeDataAsConstr baseDatum
   in BI.unsafeDataAsB (BI.head (BI.snd baseDatumConstr))

{-# INLINABLE credentialHashBytes #-}
credentialHashBytes :: BuiltinData -> BuiltinByteString
credentialHashBytes credential =
  let !credentialConstr = BI.unsafeDataAsConstr credential
      !credentialHash = BI.unsafeDataAsB (BI.head (BI.snd credentialConstr))
   in if lengthOfByteString credentialHash == 28
        then credentialHash
        else traceError "credential hash must be 28 bytes"

{-# INLINABLE credentialWireTag #-}
credentialWireTag :: BuiltinData -> BuiltinByteString
credentialWireTag credential =
  let !credentialTag = constrTag credential
   in if credentialTag == 0
        then consByteString 1 emptyByteString
        else
          if credentialTag == 1
            then consByteString 2 emptyByteString
            else traceError "unsupported credential constructor"

{-# INLINABLE credentialAddressBytes #-}
credentialAddressBytes :: BuiltinData -> BuiltinByteString
credentialAddressBytes credential =
  credentialWireTag credential <> credentialHashBytes credential

{-# INLINABLE zeroCredentialHash #-}
zeroCredentialHash :: BuiltinByteString
zeroCredentialHash = B.replicateByte 28 0

{-# INLINABLE stakeAddressBytes #-}
stakeAddressBytes :: BuiltinData -> BuiltinByteString
stakeAddressBytes stakingCredentialMaybe =
  let !maybeTag = constrTag stakingCredentialMaybe
   in if maybeTag == 1
        then consByteString 0 zeroCredentialHash
        else
          if maybeTag == 0
            then
              let !stakingCredential = BI.head (constrFields stakingCredentialMaybe)
                  !stakingCredentialTag = constrTag stakingCredential
               in if stakingCredentialTag == 0
                    then credentialAddressBytes (BI.head (constrFields stakingCredential))
                    else
                      if stakingCredentialTag == 1
                        then traceError "staking pointers are unsupported"
                        else traceError "unsupported staking credential constructor"
            else traceError "unsupported maybe staking credential constructor"

{-# INLINABLE destinationAddressV1FromTxOutData #-}
destinationAddressV1FromTxOutData :: BuiltinData -> BuiltinByteString
destinationAddressV1FromTxOutData txOut =
  destinationAddressV1FromTxOutFields (constrFields txOut)

{-# INLINABLE destinationAddressV1FromTxOutFields #-}
destinationAddressV1FromTxOutFields :: BI.BuiltinList BuiltinData -> BuiltinByteString
destinationAddressV1FromTxOutFields txOutFields =
  let !address = field0 txOutFields
      !addressFields = constrFields address
      !encoded =
        credentialAddressBytes (field0 addressFields)
          <> stakeAddressBytes (field1 addressFields)
   in if lengthOfByteString encoded == 58
        then encoded
        else traceError "destination address v1 must be 58 bytes"

{-# INLINABLE validateFreshBatchReclaimProof #-}
validateFreshBatchReclaimProof ::
  ParsedBatchVerifyingKey ->
  BuiltinByteString ->
  BuiltinByteString ->
  BuiltinByteString ->
  BatchCommittedProofCheck
validateFreshBatchReclaimProof parsedVerifierKey paymentKeyHash destinationAddress proof =
  builtinIf
    (BI.equalsInteger (lengthOfByteString paymentKeyHash) 28)
    (verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok parsedVerifierKey proof paymentKeyHash destinationAddress)
    (traceError "reclaim payment key hash must be 28 bytes")

-- | V2 has already authenticated this digest against the current
-- payment-key hash and destination output before parsing the proof. Reusing
-- those exact 32 bytes avoids hashing the same statement a second time while
-- preserving the proof parser and scalar reduction unchanged.
{-# INLINABLE validateFreshBatchReclaimProofWithDigest #-}
validateFreshBatchReclaimProofWithDigest ::
  ParsedBatchVerifyingKey ->
  BuiltinByteString ->
  BuiltinByteString ->
  BuiltinByteString ->
  BatchCommittedProofCheck
validateFreshBatchReclaimProofWithDigest parsedVerifierKey paymentKeyHash publicInputDigest proof =
  builtinIf
    (BI.equalsInteger (lengthOfByteString paymentKeyHash) 28)
    (groth16VerifyCommittedParsedBatchNoPok parsedVerifierKey (Proof proof) (Scalar publicInputDigest))
    (traceError "reclaim payment key hash must be 28 bytes")

{-# INLINABLE validateFreshSingleReclaimProof #-}
validateFreshSingleReclaimProof ::
  ParsedBatchVerifyingKey ->
  BuiltinByteString ->
  BuiltinByteString ->
  BuiltinByteString ->
  CommittedProofCheck
validateFreshSingleReclaimProof parsedVerifierKey paymentKeyHash destinationAddress proof =
  builtinIf
    (BI.equalsInteger (lengthOfByteString paymentKeyHash) 28)
    (verifyOwnershipDestinationWithParsedBatchVKLegacyKnown28NoPok parsedVerifierKey proof paymentKeyHash destinationAddress)
    (traceError "reclaim payment key hash must be 28 bytes")

{-# INLINABLE nextBatchPower #-}
nextBatchPower :: Integer -> Integer -> Integer
nextBatchPower batchChallenge batchPower =
  (batchPower * batchChallenge) `B.modInteger` blsScalarFieldOrder

-- | Advance the coefficient-first integer state for a newly verified distinct
-- proof.
{-# INLINABLE foldBatchScalarState #-}
foldBatchScalarState ::
  Integer ->
  Integer ->
  Integer ->
  Integer ->
  Integer ->
  Integer ->
  Integer ->
  (Integer, Integer, Integer, Integer)
foldBatchScalarState batchChallenge batchPower coefficientSum foldedPub foldedECmt pub eCmt =
  ( nextBatchPower batchChallenge batchPower
  , (coefficientSum + batchPower) `B.modInteger` blsScalarFieldOrder
  , (foldedPub + batchPower * pub) `B.modInteger` blsScalarFieldOrder
  , (foldedECmt + batchPower * eCmt) `B.modInteger` blsScalarFieldOrder
  )

-- | The production cache transition is deliberately the identity on all four
-- coefficient accumulators. Keeping it as a named boundary makes R1 test the
-- exact transition used by both legacy and coefficient-first cache states.
{-# INLINABLE retainBatchScalarState #-}
retainBatchScalarState :: Integer -> Integer -> Integer -> Integer -> (Integer, Integer, Integer, Integer)
retainBatchScalarState batchPower coefficientSum foldedPub foldedECmt =
  (batchPower, coefficientSum, foldedPub, foldedECmt)

{-# INLINABLE foldBatchProof #-}
foldBatchProof ::
  Integer ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_MlResult ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G2_Element ->
  BuiltinBLS12_381_G1_Element ->
  ( BuiltinBLS12_381_G1_Element
  , BuiltinBLS12_381_G1_Element
  , BuiltinBLS12_381_MlResult
  , BuiltinBLS12_381_G1_Element
  )
foldBatchProof batchPower foldedCommitment foldedPok foldedGrothLhs foldedC commitment pok a b c =
  let !scaledCommitment = batchPower `bls12_381_G1_scalarMul` commitment
      !scaledPok = batchPower `bls12_381_G1_scalarMul` pok
      !scaledA = batchPower `bls12_381_G1_scalarMul` a
      !scaledC = batchPower `bls12_381_G1_scalarMul` c
   in ( foldedCommitment `bls12_381_G1_add` scaledCommitment
      , foldedPok `bls12_381_G1_add` scaledPok
      , foldedGrothLhs `bls12_381_mulMlResult` bls12_381_millerLoop scaledA b
      , foldedC `bls12_381_G1_add` scaledC
      )

{-# INLINABLE validateReclaimInputs #-}
validateReclaimInputs ::
  BuiltinByteString ->
  ParsedBatchVerifyingKey ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinBool
validateReclaimInputs baseScriptHash parsedVerifierKey proofs inputs destinationOutputs =
  goFirst inputs proofs destinationOutputs
  where
    !batchChallenge = ownershipProofBatchChallenge (reclaimProofBytesConcat proofs)

    goFirst !remainingInputs !remainingProofs !remainingDestinationOutputs =
      B.caseList
        (\() -> traceError "no reclaim base inputs")
        ( \txIn rest ->
            let !resolved = txInResolved txIn
                !txOutFields = constrFields resolved
             in builtinIf
                  (isReclaimBaseInput baseScriptHash txOutFields)
                  ( B.caseList
                      (\() -> traceError "missing reclaim proof")
                      ( \proofData moreProofs ->
                          B.caseList
                            (\() -> traceError "missing reclaim destination output")
                            ( \destinationOut moreDestinationOutputs ->
                                let !proofSlot = BI.unsafeDataAsB proofData
                                    !proof =
                                      builtinIf
                                        (isSameAsPreviousProof proofSlot)
                                        (traceError "proof reuse marker cannot be first")
                                        proofSlot
                                    !paymentKeyHash = decodeBasePaymentKeyHashFromFields txOutFields
                                    !destinationAddress = destinationAddressV1FromTxOutData destinationOut
                                    !destinationValueData = field1 (constrFields destinationOut)
                                    !inputValueData = field1 txOutFields
                                 in builtinIf
                                      (valueCoversData inputValueData destinationValueData)
                                      ( let !proofCheck = validateFreshSingleReclaimProof parsedVerifierKey paymentKeyHash destinationAddress proof
                                         in case proofCheck of
                                              CommittedProofCheck commitment pok a b c vkX ->
                                                goLegacyCached
                                                  rest
                                                  moreProofs
                                                  moreDestinationOutputs
                                                  paymentKeyHash
                                                  destinationAddress
                                                  proof
                                                  commitment
                                                  pok
                                                  (bls12_381_millerLoop a b)
                                                  vkX
                                                  c
                                                  1
                                                  batchChallenge
                                      )
                                      (traceError "destination output underpays reclaim input")
                            )
                            remainingDestinationOutputs
                      )
                      remainingProofs
                  )
                  (goFirst rest remainingProofs remainingDestinationOutputs)
        )
        remainingInputs

    -- Retain the pre-V8 eager-vkX point state until a second distinct proof is
    -- encountered. N=1 terminates here; repeated-proof cache runs keep the
    -- point state and preserve the next distinct coefficient unchanged.
    goLegacyCached
      !remainingInputs
      !remainingProofs
      !remainingDestinationOutputs
      !previousPaymentKeyHash
      !previousDestinationAddress
      !previousProof
      !foldedCommitment
      !foldedPok
      !foldedGrothLhs
      !foldedVkX
      !foldedC
      !batchCoefficientSum
      !batchPower =
      B.caseList
        ( \() ->
            B.caseList
              ( \() ->
                  builtinIf
                    ( boolToBuiltin
                        ( verifyCommittedProofGrothBatch
                            parsedVerifierKey
                            batchCoefficientSum
                            foldedGrothLhs
                            foldedVkX
                            foldedC
                        )
                    )
                    ( builtinIf
                        (boolToBuiltin (verifyCommittedProofPokBatchWithBatchVK parsedVerifierKey foldedCommitment foldedPok))
                        BI.true
                        (traceError "reclaim proof commitment validation failed")
                    )
                    (traceError "reclaim proof validation failed")
              )
              (\_ _ -> traceError "unused reclaim proofs")
              remainingProofs
        )
        ( \txIn rest ->
            let !resolved = txInResolved txIn
                !txOutFields = constrFields resolved
             in builtinIf
                  (isReclaimBaseInput baseScriptHash txOutFields)
                  ( B.caseList
                      (\() -> traceError "missing reclaim proof")
                      ( \proofData moreProofs ->
                          B.caseList
                            (\() -> traceError "missing reclaim destination output")
                            ( \destinationOut moreDestinationOutputs ->
                                let !proofSlot = BI.unsafeDataAsB proofData
                                    !proof =
                                      builtinIf
                                        (isSameAsPreviousProof proofSlot)
                                        previousProof
                                        proofSlot
                                    !paymentKeyHash = decodeBasePaymentKeyHashFromFields txOutFields
                                    !destinationAddress = destinationAddressV1FromTxOutData destinationOut
                                    !destinationValueData = field1 (constrFields destinationOut)
                                    !inputValueData = field1 txOutFields
                                 in builtinIf
                                      (valueCoversData inputValueData destinationValueData)
                                      ( builtinIf
                                          ( BI.equalsByteString previousPaymentKeyHash paymentKeyHash
                                              `builtinAnd` BI.equalsByteString previousDestinationAddress destinationAddress
                                              `builtinAnd` BI.equalsByteString previousProof proof
                                          )
                                          ( let !(!cachedPower, !cachedCoefficientSum, _, _) =
                                                  retainBatchScalarState batchPower batchCoefficientSum 0 0
                                             in goLegacyCached rest moreProofs moreDestinationOutputs paymentKeyHash destinationAddress proof foldedCommitment foldedPok foldedGrothLhs foldedVkX foldedC cachedCoefficientSum cachedPower
                                          )
                                          ( let !previousPub = ownershipDestinationPublicInputScalar previousPaymentKeyHash previousDestinationAddress
                                                !previousECmt = committedProofChallengeScalar previousProof
                                                !currentCheck = validateFreshBatchReclaimProof parsedVerifierKey paymentKeyHash destinationAddress proof
                                             in case currentCheck of
                                                  BatchCommittedProofCheck commitment pok a b c pub eCmt ->
                                                    let !(!newFoldedCommitment, !newFoldedPok, !newFoldedGrothLhs, !newFoldedC) =
                                                          foldBatchProof batchPower foldedCommitment foldedPok foldedGrothLhs foldedC commitment pok a b c
                                                        !(!newBatchPower, !newBatchCoefficientSum, !newFoldedPub, !newFoldedECmt) =
                                                          foldBatchScalarState batchChallenge batchPower batchCoefficientSum previousPub previousECmt pub eCmt
                                                     in goCoefficientCached
                                                          rest
                                                          moreProofs
                                                          moreDestinationOutputs
                                                          paymentKeyHash
                                                          destinationAddress
                                                          proof
                                                          newFoldedCommitment
                                                          newFoldedPok
                                                          newFoldedGrothLhs
                                                          newFoldedC
                                                          newFoldedPub
                                                          newFoldedECmt
                                                          newBatchCoefficientSum
                                                          newBatchPower
                                          )
                                      )
                                      (traceError "destination output underpays reclaim input")
                            )
                            remainingDestinationOutputs
                      )
                      remainingProofs
                  )
                  (goLegacyCached rest remainingProofs remainingDestinationOutputs previousPaymentKeyHash previousDestinationAddress previousProof foldedCommitment foldedPok foldedGrothLhs foldedVkX foldedC batchCoefficientSum batchPower)
        )
        remainingInputs

    goCoefficientCached
      !remainingInputs
      !remainingProofs
      !remainingDestinationOutputs
      !previousPaymentKeyHash
      !previousDestinationAddress
      !previousProof
      !foldedCommitment
      !foldedPok
      !foldedGrothLhs
      !foldedC
      !foldedPub
      !foldedECmt
      !batchCoefficientSum
      !batchPower =
      B.caseList
        ( \() ->
            B.caseList
              ( \() ->
                  let !foldedVkX =
                        coefficientFirstVkX
                          parsedVerifierKey
                          batchCoefficientSum
                          foldedPub
                          foldedECmt
                          foldedCommitment
                   in builtinIf
                        ( boolToBuiltin
                            ( verifyCommittedProofGrothBatch
                                parsedVerifierKey
                                batchCoefficientSum
                                foldedGrothLhs
                                foldedVkX
                                foldedC
                            )
                        )
                        ( builtinIf
                            (boolToBuiltin (verifyCommittedProofPokBatchWithBatchVK parsedVerifierKey foldedCommitment foldedPok))
                            BI.true
                            (traceError "reclaim proof commitment validation failed")
                        )
                        (traceError "reclaim proof validation failed")
              )
              (\_ _ -> traceError "unused reclaim proofs")
              remainingProofs
        )
        ( \txIn rest ->
            let !resolved = txInResolved txIn
                !txOutFields = constrFields resolved
             in builtinIf
                  (isReclaimBaseInput baseScriptHash txOutFields)
                  ( B.caseList
                      (\() -> traceError "missing reclaim proof")
                      ( \proofData moreProofs ->
                          B.caseList
                            (\() -> traceError "missing reclaim destination output")
                            ( \destinationOut moreDestinationOutputs ->
                                let !proofSlot = BI.unsafeDataAsB proofData
                                    !proof =
                                      builtinIf
                                        (isSameAsPreviousProof proofSlot)
                                        previousProof
                                        proofSlot
                                    !paymentKeyHash = decodeBasePaymentKeyHashFromFields txOutFields
                                    !destinationAddress = destinationAddressV1FromTxOutData destinationOut
                                    !destinationValueData = field1 (constrFields destinationOut)
                                    !inputValueData = field1 txOutFields
                                 in builtinIf
                                      (valueCoversData inputValueData destinationValueData)
                                      ( builtinIf
                                          ( BI.equalsByteString previousPaymentKeyHash paymentKeyHash
                                              `builtinAnd` BI.equalsByteString previousDestinationAddress destinationAddress
                                              `builtinAnd` BI.equalsByteString previousProof proof
                                          )
                                          ( let !(!cachedPower, !cachedCoefficientSum, !cachedPub, !cachedECmt) =
                                                  retainBatchScalarState batchPower batchCoefficientSum foldedPub foldedECmt
                                             in goCoefficientCached rest moreProofs moreDestinationOutputs paymentKeyHash destinationAddress proof foldedCommitment foldedPok foldedGrothLhs foldedC cachedPub cachedECmt cachedCoefficientSum cachedPower
                                          )
                                          ( let !proofCheck = validateFreshBatchReclaimProof parsedVerifierKey paymentKeyHash destinationAddress proof
                                             in case proofCheck of
                                                  BatchCommittedProofCheck commitment pok a b c pub eCmt ->
                                                    let !(!newFoldedCommitment, !newFoldedPok, !newFoldedGrothLhs, !newFoldedC) =
                                                          foldBatchProof batchPower foldedCommitment foldedPok foldedGrothLhs foldedC commitment pok a b c
                                                        !(!newBatchPower, !newBatchCoefficientSum, !newFoldedPub, !newFoldedECmt) =
                                                          foldBatchScalarState batchChallenge batchPower batchCoefficientSum foldedPub foldedECmt pub eCmt
                                                     in goCoefficientCached
                                                          rest
                                                          moreProofs
                                                          moreDestinationOutputs
                                                          paymentKeyHash
                                                          destinationAddress
                                                          proof
                                                          newFoldedCommitment
                                                          newFoldedPok
                                                          newFoldedGrothLhs
                                                          newFoldedC
                                                          newFoldedPub
                                                          newFoldedECmt
                                                          newBatchCoefficientSum
                                                          newBatchPower
                                          )
                                      )
                                      (traceError "destination output underpays reclaim input")
                            )
                            remainingDestinationOutputs
                      )
                      remainingProofs
                  )
                  (goCoefficientCached rest remainingProofs remainingDestinationOutputs previousPaymentKeyHash previousDestinationAddress previousProof foldedCommitment foldedPok foldedGrothLhs foldedC foldedPub foldedECmt batchCoefficientSum batchPower)
        )
        remainingInputs

-- | V2 has no proof marker and no proof/credential cache. Every authenticated
-- reclaim slot consumes exactly one full proof and one digest, and therefore
-- advances the folding coefficient exactly once.
{-# INLINABLE validateReclaimInputsV2 #-}
validateReclaimInputsV2 ::
  BuiltinByteString ->
  ParsedBatchVerifyingKey ->
  BuiltinByteString ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinBool
validateReclaimInputsV2 baseScriptHash parsedVerifierKey verifierKeyHash proofs publicInputDigests inputs destinationOutputs =
  first inputs proofs publicInputDigests destinationOutputs
  where
    !batchTranscript = reclaimBatchTranscriptV2 verifierKeyHash proofs publicInputDigests
    !batchChallenge = ownershipProofBatchChallengeV2 batchTranscript

    first !remainingInputs !remainingProofs !remainingDigests !remainingOutputs =
      B.caseList
        (\() -> traceError "no reclaim base inputs")
        ( \txIn rest ->
            let !txOutFields = constrFields (txInResolved txIn)
             in builtinIf
                  (isReclaimBaseInput baseScriptHash txOutFields)
                  ( B.caseList
                      (\() -> traceError "missing reclaim proof")
                      ( \proofData moreProofs ->
                          B.caseList
                            (\() -> traceError "missing reclaim public input digest")
                            ( \digestData moreDigests ->
                                B.caseList
                                  (\() -> traceError "missing reclaim destination output")
                                  ( \destinationOutput moreOutputs ->
                                      let !proof = BI.unsafeDataAsB proofData
                                          !claimedDigest = BI.unsafeDataAsB digestData
                                          !paymentKeyHash = decodeBasePaymentKeyHashFromFields txOutFields
                                          !destinationOutputFields = constrFields destinationOutput
                                          !destinationAddress = destinationAddressV1FromTxOutFields destinationOutputFields
                                          !actualDigest = ownershipDestinationPublicInputDigest paymentKeyHash destinationAddress
                                          !inputValueData = field1 txOutFields
                                          !outputValueData = field1 destinationOutputFields
                                       in builtinIf
                                            (valueCoversData inputValueData outputValueData)
                                            ( builtinIf
                                                (BI.equalsByteString claimedDigest actualDigest)
                                                ( let !proofCheck = validateFreshBatchReclaimProofWithDigest parsedVerifierKey paymentKeyHash actualDigest proof
                                                   in case proofCheck of
                                                        BatchCommittedProofCheck commitment pok a b c pub eCmt ->
                                                          restOfBatch rest moreProofs moreDigests moreOutputs commitment pok (bls12_381_millerLoop a b) c pub eCmt 1 batchChallenge
                                                )
                                                (traceError "reclaim public input digest does not match statement")
                                            )
                                            (traceError "destination output underpays reclaim input")
                                  )
                                  remainingOutputs
                            )
                            remainingDigests
                      )
                      remainingProofs
                  )
                  (first rest remainingProofs remainingDigests remainingOutputs)
        )
        remainingInputs

    restOfBatch !remainingInputs !remainingProofs !remainingDigests !remainingOutputs !foldedCommitment !foldedPok !foldedGrothLhs !foldedC !foldedPub !foldedECmt !coefficientSum !batchPower =
      B.caseList
        ( \() ->
            B.caseList
              ( \() ->
                  let !foldedVkX = coefficientFirstVkX parsedVerifierKey coefficientSum foldedPub foldedECmt foldedCommitment
                   in builtinIf
                        (boolToBuiltin (verifyCommittedProofGrothBatch parsedVerifierKey coefficientSum foldedGrothLhs foldedVkX foldedC))
                        ( builtinIf
                            (boolToBuiltin (verifyCommittedProofPokBatchWithBatchVK parsedVerifierKey foldedCommitment foldedPok))
                            BI.true
                            (traceError "reclaim proof commitment validation failed")
                        )
                        (traceError "reclaim proof validation failed")
              )
              (\_ _ -> traceError "unused reclaim public input digests")
              remainingDigests
        )
        ( \txIn rest ->
            let !txOutFields = constrFields (txInResolved txIn)
             in builtinIf
                  (isReclaimBaseInput baseScriptHash txOutFields)
                  ( B.caseList
                      (\() -> traceError "missing reclaim proof")
                      ( \proofData moreProofs ->
                          B.caseList
                            (\() -> traceError "missing reclaim public input digest")
                            ( \digestData moreDigests ->
                                B.caseList
                                  (\() -> traceError "missing reclaim destination output")
                                  ( \destinationOutput moreOutputs ->
                                      let !proof = BI.unsafeDataAsB proofData
                                          !claimedDigest = BI.unsafeDataAsB digestData
                                          !paymentKeyHash = decodeBasePaymentKeyHashFromFields txOutFields
                                          !destinationOutputFields = constrFields destinationOutput
                                          !destinationAddress = destinationAddressV1FromTxOutFields destinationOutputFields
                                          !actualDigest = ownershipDestinationPublicInputDigest paymentKeyHash destinationAddress
                                          !inputValueData = field1 txOutFields
                                          !outputValueData = field1 destinationOutputFields
                                       in builtinIf
                                            (valueCoversData inputValueData outputValueData)
                                            ( builtinIf
                                                (BI.equalsByteString claimedDigest actualDigest)
                                                ( let !proofCheck = validateFreshBatchReclaimProofWithDigest parsedVerifierKey paymentKeyHash actualDigest proof
                                                   in case proofCheck of
                                                        BatchCommittedProofCheck commitment pok a b c pub eCmt ->
                                                          let !(!newCommitment, !newPok, !newGrothLhs, !newC) =
                                                                foldBatchProof batchPower foldedCommitment foldedPok foldedGrothLhs foldedC commitment pok a b c
                                                              !(!newPower, !newSum, !newPub, !newECmt) =
                                                                foldBatchScalarState batchChallenge batchPower coefficientSum foldedPub foldedECmt pub eCmt
                                                           in restOfBatch rest moreProofs moreDigests moreOutputs newCommitment newPok newGrothLhs newC newPub newECmt newSum newPower
                                                )
                                                (traceError "reclaim public input digest does not match statement")
                                            )
                                            (traceError "destination output underpays reclaim input")
                                  )
                                  remainingOutputs
                            )
                            remainingDigests
                      )
                      remainingProofs
                  )
                  (restOfBatch rest remainingProofs remainingDigests remainingOutputs foldedCommitment foldedPok foldedGrothLhs foldedC foldedPub foldedECmt coefficientSum batchPower)
        )
        remainingInputs

{-# INLINABLE reclaimGlobalValidatorBuiltin #-}
reclaimGlobalValidatorBuiltin :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinData -> BI.BuiltinBool
reclaimGlobalValidatorBuiltin (CurrencySymbol paramsCurrencySymbol) (TokenName paramsTokenName) verifierKey ctx =
  isRewarding `builtinAnd` validateGlobal
  where
    !ctxFields = constrFields ctx
    !txInfo = field0 ctxFields
    !redeemer = field1 ctxFields
    !scriptInfo = field2 ctxFields
    !txInfoFields = constrFields txInfo
    !txInfoInputs = field0 txInfoFields
    !txInfoReferenceInputs = field1 txInfoFields
    !txInfoOutputs = field2 txInfoFields
    !redeemerConstr = BI.unsafeDataAsConstr redeemer
    !redeemerFields = BI.snd redeemerConstr
    !paramsRefIdx = BI.unsafeDataAsI (field0 redeemerFields)
    !destinationOutStartIdx = BI.unsafeDataAsI (field1 redeemerFields)
    !reclaimProofsData = BI.unsafeDataAsList (field2 redeemerFields)

    isRewarding =
      BI.equalsInteger (constrTag scriptInfo) 2

    validateGlobal =
      let !paramsInput = findReferenceInputAtData paramsRefIdx (BI.unsafeDataAsList txInfoReferenceInputs)
          !paramsOut = txInResolved paramsInput
          !baseScriptHash = decodeValidatedParams paramsCurrencySymbol paramsTokenName paramsOut
          !parsedVerifierKey = parseVerifyingKeyBatch verifierKey
          !destinationOutputs = dropAtData "invalid destination output start index" destinationOutStartIdx (BI.unsafeDataAsList txInfoOutputs)
       in validateReclaimInputs
            baseScriptHash
            parsedVerifierKey
            reclaimProofsData
            (BI.unsafeDataAsList txInfoInputs)
            destinationOutputs

{-# INLINABLE reclaimGlobalValidator #-}
reclaimGlobalValidator :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinData -> Bool
reclaimGlobalValidator paramsCurrencySymbol paramsTokenName verifierKey ctx =
  builtinToBool $
    reclaimGlobalValidatorBuiltin
      paramsCurrencySymbol
      paramsTokenName
      verifierKey
      ctx

{-# INLINABLE reclaimGlobalValidatorUntyped #-}
reclaimGlobalValidatorUntyped :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinData -> BuiltinUnit
reclaimGlobalValidatorUntyped paramsCurrencySymbol paramsTokenName verifierKey ctx =
  builtinIf
    (reclaimGlobalValidatorBuiltin paramsCurrencySymbol paramsTokenName verifierKey ctx)
    BI.unitval
    (traceError "reclaim global validation failed")

reclaimGlobalValidatorCode :: CompiledCode (CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinData -> BuiltinUnit)
reclaimGlobalValidatorCode =
  $$(PlutusTx.compile [||reclaimGlobalValidatorUntyped||])

-- | The V2 script receives the canonical Cardano verification key and its
-- pre-checked BLAKE2b-256 hash as finalized script parameters. It never hashes
-- the 672-byte key at validation time; export/build tooling rejects a key/hash
-- mismatch before this code can be applied.
{-# INLINABLE reclaimGlobalValidatorV2Builtin #-}
reclaimGlobalValidatorV2Builtin :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinByteString -> BuiltinData -> BI.BuiltinBool
reclaimGlobalValidatorV2Builtin (CurrencySymbol paramsCurrencySymbol) (TokenName paramsTokenName) verifierKey verifierKeyHash ctx =
  isRewarding `builtinAnd` validateGlobal
  where
    !ctxFields = constrFields ctx
    !txInfo = field0 ctxFields
    !redeemer = field1 ctxFields
    !scriptInfo = field2 ctxFields
    !txInfoFields = constrFields txInfo
    !txInfoInputs = field0 txInfoFields
    !txInfoReferenceInputs = field1 txInfoFields
    !txInfoOutputs = field2 txInfoFields
    !redeemerConstr = BI.unsafeDataAsConstr redeemer
    !redeemerFields = BI.snd redeemerConstr

    isRewarding = BI.equalsInteger (constrTag scriptInfo) 2
    validRedeemer =
      BI.equalsInteger (BI.fst redeemerConstr) 0
        `builtinAnd` hasExactlyFourFields redeemerFields

    validateGlobal =
      builtinIf
        validRedeemer
        ( let !paramsRefIdx = BI.unsafeDataAsI (field0 redeemerFields)
              !destinationOutStartIdx = BI.unsafeDataAsI (field1 redeemerFields)
              !reclaimProofsData = BI.unsafeDataAsList (field2 redeemerFields)
              !publicInputDigestsData = BI.unsafeDataAsList (field3 redeemerFields)
              !paramsInput = findReferenceInputAtData paramsRefIdx (BI.unsafeDataAsList txInfoReferenceInputs)
              !paramsOut = txInResolved paramsInput
              !baseScriptHash = decodeValidatedParams paramsCurrencySymbol paramsTokenName paramsOut
              !parsedVerifierKey = parseVerifyingKeyBatch verifierKey
              !destinationOutputs = dropAtData "invalid destination output start index" destinationOutStartIdx (BI.unsafeDataAsList txInfoOutputs)
           in validateReclaimInputsV2
                baseScriptHash
                parsedVerifierKey
                verifierKeyHash
                reclaimProofsData
                publicInputDigestsData
                (BI.unsafeDataAsList txInfoInputs)
                destinationOutputs
        )
        (traceError "invalid reclaim global v2 redeemer")

{-# INLINABLE reclaimGlobalValidatorV2 #-}
reclaimGlobalValidatorV2 :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinByteString -> BuiltinData -> Bool
reclaimGlobalValidatorV2 paramsCurrencySymbol paramsTokenName verifierKey verifierKeyHash ctx =
  builtinToBool $
    reclaimGlobalValidatorV2Builtin
      paramsCurrencySymbol
      paramsTokenName
      verifierKey
      verifierKeyHash
      ctx

{-# INLINABLE reclaimGlobalValidatorV2Untyped #-}
reclaimGlobalValidatorV2Untyped :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinUnit
reclaimGlobalValidatorV2Untyped paramsCurrencySymbol paramsTokenName verifierKey verifierKeyHash ctx =
  builtinIf
    (reclaimGlobalValidatorV2Builtin paramsCurrencySymbol paramsTokenName verifierKey verifierKeyHash ctx)
    BI.unitval
    (traceError "reclaim global v2 validation failed")

reclaimGlobalValidatorV2Code :: CompiledCode (CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinUnit)
reclaimGlobalValidatorV2Code =
  $$(PlutusTx.compile [||reclaimGlobalValidatorV2Untyped||])
