{-# LANGUAGE BangPatterns #-}
{-# LANGUAGE DataKinds #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TemplateHaskell #-}

-- | Canonical statement-bound global reclaim validator.
--
-- Every reclaim slot carries one full proof and its authenticated public-input
-- digest. There is no legacy marker encoding, proof cache, or alternate
-- single-destination validator in this package.
module Ownership.ReclaimGlobalV2
  ( ReclaimBaseDatum (..)
  , ReclaimGlobalParams (..)
  , findReferenceInputAt
  , foldBatchScalarState
  , hasExactlyOneParamToken
  , hasExactlyOneParamTokenCheckCode
  , reclaimGlobalParamsData
  , reclaimGlobalRedeemerDataV2
  , reclaimBatchTranscriptV2
  , reclaimGlobalValidatorV2
  , reclaimGlobalValidatorV2Code
  , reclaimGlobalValidatorV2Untyped
  , validateReclaimInputsV2
  , v2VerifierKeyParametersMatch
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
  , ParsedBatchVerifyingKey
  , Proof (Proof)
  , Scalar (Scalar)
  , blsScalarFieldOrder
  , coefficientFirstVkX
  , groth16VerifyCommittedParsedBatchNoPok
  , ownershipDestinationPublicInputDigest
  , ownershipProofBatchChallengeV2
  , ownershipProofBatchDomainV2
  , parseVerifyingKeyBatch
  , verifyCommittedProofGrothBatchBuiltin
  , verifyCommittedProofPokBatchWithBatchVKBuiltin
  )

data ReclaimGlobalParams = ReclaimGlobalParams
  { reclaimBaseScriptHash :: ScriptHash
  }

-- | Host-side export/build guard for the two V2 script parameters. The
-- validator deliberately does not hash the 672-byte verification key at
-- execution time; this check must succeed before a script is finalized.
{-# INLINABLE v2VerifierKeyParametersMatch #-}
v2VerifierKeyParametersMatch :: BuiltinByteString -> BuiltinByteString -> Bool
v2VerifierKeyParametersMatch verifierKey verifierKeyHash =
  lengthOfByteString verifierKey == 672
    && lengthOfByteString verifierKeyHash == 32
    && builtinToBool (BI.equalsByteString (B.blake2b_256 verifierKey) verifierKeyHash)

{-# INLINABLE reclaimGlobalParamsData #-}
reclaimGlobalParamsData :: ScriptHash -> BuiltinData
reclaimGlobalParamsData (ScriptHash baseScriptHash) =
  BI.mkConstr
    0
    ( BI.mkCons
        (BI.mkB baseScriptHash)
        (BI.mkNilData BI.unitval)
    )

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

{-# INLINABLE constrTag #-}
constrTag :: BuiltinData -> Integer
constrTag datum =
  BI.fst (BI.unsafeDataAsConstr datum)

{-# INLINABLE findDataAt #-}
findDataAt :: BuiltinString -> Integer -> BI.BuiltinList BuiltinData -> BuiltinData
findDataAt errorMessage idx values =
  go idx values
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
  go idx values
  where
    go !n !remaining =
      builtinIf
        (BI.equalsInteger n 0)
        remaining
        (
          B.caseList
            (\() -> traceError errorMessage)
            (\_ rest -> go (n - 1) rest)
            remaining
        )

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
   in findPolicy valueEntries
  where
    findPolicy !remainingPolicies =
      B.caseList
        (\() -> BI.false)
        ( \policyEntry morePolicies ->
            let !policyId = BI.unsafeDataAsB (BI.fst policyEntry)
             in builtinIf
                  (BI.equalsByteString policyId paramsCurrencySymbol)
                  (findToken (BI.unsafeDataAsMap (BI.snd policyEntry)))
                  (findPolicy morePolicies)
        )
        remainingPolicies

    findToken !remainingTokens =
      B.caseList
        (\() -> BI.false)
        ( \tokenEntry moreTokens ->
            let !tokenName = BI.unsafeDataAsB (BI.fst tokenEntry)
             in builtinIf
                  (BI.equalsByteString tokenName paramsTokenName)
                  (BI.equalsInteger (BI.unsafeDataAsI (BI.snd tokenEntry)) 1)
                  (findToken moreTokens)
        )
        remainingTokens

{-# INLINABLE hasExactlyOneParamToken #-}
hasExactlyOneParamToken :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> BI.BuiltinBool
hasExactlyOneParamToken paramsCurrencySymbol paramsTokenName txOut =
  hasExactlyOneParamTokenFromFields paramsCurrencySymbol paramsTokenName (constrFields txOut)

-- | Formal-assurance observation wrapper compiled beside the production
-- predicate so the imported UPLC is tied to this module's exact unfolding.
{-# INLINABLE hasExactlyOneParamTokenCheck #-}
hasExactlyOneParamTokenCheck :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinUnit
hasExactlyOneParamTokenCheck paramsCurrencySymbol paramsTokenName txOut =
  builtinIf
    (hasExactlyOneParamToken paramsCurrencySymbol paramsTokenName txOut)
    BI.unitval
    (traceError "formal helper predicate failed")

hasExactlyOneParamTokenCheckCode ::
  CompiledCode (BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinUnit)
hasExactlyOneParamTokenCheckCode =
  $$(PlutusTx.compile [||hasExactlyOneParamTokenCheck||])

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

-- | The exact v2 framing is domain || embedded key hash || u16 count || the
-- ordered concatenation of full proof/digest pairs. This is deliberately the
-- only V2 builder: it validates both parallel lists while consuming them
-- together and never materializes a flat digest blob for later slicing.
{-# INLINABLE reclaimBatchTranscriptV2 #-}
reclaimBatchTranscriptV2 :: BuiltinByteString -> BI.BuiltinList BuiltinData -> BI.BuiltinList BuiltinData -> BuiltinByteString
reclaimBatchTranscriptV2 verifierKeyHash proofs publicInputDigests =
  let !(!count, !items) = go 0 proofs publicInputDigests
      !header =
        (ownershipProofBatchDomainV2 <> verifierKeyHash)
          <> integerToByteString BigEndian 2 count
   in header <> items
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

-- The enclosing validator proves these widths on every accepted path: the
-- proof parser requires 336 bytes and the claimed digest must equal the
-- computed 32-byte statement digest. Keep only list alignment and count
-- framing on the production transcript path.
{-# INLINABLE reclaimBatchTranscriptKnownWidthsV2 #-}
reclaimBatchTranscriptKnownWidthsV2 :: BuiltinByteString -> BI.BuiltinList BuiltinData -> BI.BuiltinList BuiltinData -> BuiltinByteString
reclaimBatchTranscriptKnownWidthsV2 verifierKeyHash proofs publicInputDigests =
  let !(!count, !items) = go 0 proofs publicInputDigests
      !header =
        (ownershipProofBatchDomainV2 <> verifierKeyHash)
          <> integerToByteString BigEndian 2 count
   in header <> items
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
                        (BI.lessThanInteger count 65535)
                        ( let !item = proof <> digest
                              !(!finalCount, !remainingItems) = go (count + 1) moreProofs moreDigests
                           in (finalCount, item <> remainingItems)
                        )
                        (traceError "reclaim batch count exceeds u16")
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

-- These helpers receive only Address components projected from ledger-built
-- TxOuts. The ledger fixes Credential/Maybe constructor ranges and credential
-- hash widths, so only the variants that change destination semantics remain
-- branched here. Pointer staking credentials are valid ledger values but are
-- deliberately unsupported by destinationAddressV1.
{-# INLINABLE credentialAddressBytes #-}
credentialAddressBytes :: BuiltinData -> BuiltinByteString
credentialAddressBytes credential =
  let !credentialConstr = BI.unsafeDataAsConstr credential
      !credentialTag = BI.fst credentialConstr
      !wireTag =
        builtinIf
          (BI.equalsInteger credentialTag 0)
          (consByteString 1 emptyByteString)
          (consByteString 2 emptyByteString)
      !credentialHash = BI.unsafeDataAsB (BI.head (BI.snd credentialConstr))
   in wireTag <> credentialHash

{-# INLINABLE zeroCredentialHash #-}
zeroCredentialHash :: BuiltinByteString
zeroCredentialHash = B.replicateByte 28 0

{-# INLINABLE stakeAddressBytes #-}
stakeAddressBytes :: BuiltinData -> BuiltinByteString
stakeAddressBytes stakingCredentialMaybe =
  let !maybeConstr = BI.unsafeDataAsConstr stakingCredentialMaybe
      !maybeTag = BI.fst maybeConstr
   in builtinIf
        (BI.equalsInteger maybeTag 1)
        (consByteString 0 zeroCredentialHash)
        (
          let !stakingCredential = BI.head (BI.snd maybeConstr)
              !stakingCredentialConstr = BI.unsafeDataAsConstr stakingCredential
           in builtinIf
                (BI.equalsInteger (BI.fst stakingCredentialConstr) 0)
                (credentialAddressBytes (BI.head (BI.snd stakingCredentialConstr)))
                (traceError "staking pointers are unsupported")
        )

{-# INLINABLE destinationAddressV1FromTxOutFields #-}
destinationAddressV1FromTxOutFields :: BI.BuiltinList BuiltinData -> BuiltinByteString
destinationAddressV1FromTxOutFields txOutFields =
  let !address = field0 txOutFields
      !addressFields = constrFields address
   in credentialAddressBytes (field0 addressFields)
        <> stakeAddressBytes (field1 addressFields)

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
    !batchTranscript = reclaimBatchTranscriptKnownWidthsV2 verifierKeyHash proofs publicInputDigests
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
                        (verifyCommittedProofGrothBatchBuiltin parsedVerifierKey coefficientSum foldedGrothLhs foldedVkX foldedC)
                        ( builtinIf
                            (verifyCommittedProofPokBatchWithBatchVKBuiltin parsedVerifierKey foldedCommitment foldedPok)
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
    !redeemerFields = constrFields redeemer

    isRewarding = BI.equalsInteger (constrTag scriptInfo) 2

    validateGlobal =
      let !paramsRefIdx = BI.unsafeDataAsI (field0 redeemerFields)
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
