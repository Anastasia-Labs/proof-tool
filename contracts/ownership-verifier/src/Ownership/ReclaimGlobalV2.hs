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
  , affineBatchCoefficient
  , findReferenceInputAt
  , finishBatchG1Column
  , finishMergedPokColumn
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
  , coefficientFirstVkXSumOne
  , groth16VerifyCommittedParsedBatchNoPok
  , ownershipDestinationPublicInputDigest
  , ownershipProofBatchChallengeFromDigestV2
  , ownershipProofBatchDomainV2
  , ownershipProofBatchMergeChallengeFromDigestV2
  , parseVerifyingKeyBatch
  , verifyCommittedProofMergedBatchSumOneWithScaledPokBatchVK
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
    && BI.equalsByteString (B.blake2b_256 verifierKey) verifierKeyHash

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

{-# INLINABLE firstThree #-}
firstThree :: BI.BuiltinList BuiltinData -> (BuiltinData, BuiltinData, BuiltinData)
firstThree fields =
  B.caseList
    (\() -> traceError "missing data field")
    ( \a afterA ->
        B.caseList
          (\() -> traceError "missing data field")
          ( \b afterB ->
              B.caseList
                (\() -> traceError "missing data field")
                (\c _ -> (a, b, c))
                afterB
          )
          afterA
    )
    fields

{-# INLINABLE firstFour #-}
firstFour :: BI.BuiltinList BuiltinData -> (BuiltinData, BuiltinData, BuiltinData, BuiltinData)
firstFour fields =
  B.caseList
    (\() -> traceError "missing data field")
    ( \a afterA ->
        B.caseList
          (\() -> traceError "missing data field")
          ( \b afterB ->
              B.caseList
                (\() -> traceError "missing data field")
                ( \c afterC ->
                    B.caseList
                      (\() -> traceError "missing data field")
                      (\d _ -> (a, b, c, d))
                      afterC
                )
                afterB
          )
          afterA
    )
    fields

{-# INLINABLE constrTag #-}
constrTag :: BuiltinData -> Integer
constrTag datum =
  BI.fst (BI.unsafeDataAsConstr datum)

{-# INLINABLE findReferenceInputAt #-}
findReferenceInputAt :: Integer -> BI.BuiltinList BuiltinData -> BuiltinData
findReferenceInputAt idx values =
  BI.head (BI.drop idx values)

{-# INLINABLE hasExactlyOneParamTokenFromFields #-}
hasExactlyOneParamTokenFromFields :: BuiltinByteString -> BuiltinByteString -> BI.BuiltinList BuiltinData -> Bool
hasExactlyOneParamTokenFromFields paramsCurrencySymbol paramsTokenName txOutFields =
  let !txOutValueData = field1 txOutFields
   in BI.equalsInteger
        (BI.lookupCoin paramsCurrencySymbol paramsTokenName (BI.unsafeDataAsValue txOutValueData))
        1

{-# INLINABLE hasExactlyOneParamToken #-}
hasExactlyOneParamToken :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> Bool
hasExactlyOneParamToken paramsCurrencySymbol paramsTokenName txOut =
  hasExactlyOneParamTokenFromFields paramsCurrencySymbol paramsTokenName (constrFields txOut)

-- | Formal-assurance observation wrapper compiled beside the production
-- predicate so the imported UPLC is tied to this module's exact unfolding.
{-# INLINABLE hasExactlyOneParamTokenCheck #-}
hasExactlyOneParamTokenCheck :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinUnit
hasExactlyOneParamTokenCheck paramsCurrencySymbol paramsTokenName txOut =
  if hasExactlyOneParamToken paramsCurrencySymbol paramsTokenName txOut
    then BI.unitval
    else traceError "formal helper predicate failed"

hasExactlyOneParamTokenCheckCode ::
  CompiledCode (BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinUnit)
hasExactlyOneParamTokenCheckCode =
  $$(PlutusTx.compile [||hasExactlyOneParamTokenCheck||])

{-# INLINABLE txInResolved #-}
txInResolved :: BuiltinData -> BuiltinData
txInResolved txIn =
  field1 (constrFields txIn)

-- Both values are canonical positive Value fields from ledger-built TxOuts.
-- Convert them with the PV11 Value builtin and ask whether the paid value (the
-- first argument) contains the required value.
{-# INLINABLE valueCoversData #-}
valueCoversData :: BuiltinData -> BuiltinData -> Bool
valueCoversData requiredValueData paidValueData =
  BI.valueContains
    (BI.unsafeDataAsValue paidValueData)
    (BI.unsafeDataAsValue requiredValueData)

{-# INLINABLE decodeValidatedParams #-}
decodeValidatedParams :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinByteString
decodeValidatedParams paramsCurrencySymbol paramsTokenName paramsOut =
  let !paramsOutFields = constrFields paramsOut
   in if hasExactlyOneParamTokenFromFields paramsCurrencySymbol paramsTokenName paramsOutFields
        then
          let !outputDatum = field2 paramsOutFields
              !datumConstr = BI.unsafeDataAsConstr outputDatum
              !paramsDatum = BI.head (BI.snd datumConstr)
              !paramsConstr = BI.unsafeDataAsConstr paramsDatum
           in BI.unsafeDataAsB (BI.head (BI.snd paramsConstr))
        else traceError "parameter NFT invalid"

{-# INLINABLE isReclaimBaseInput #-}
isReclaimBaseInput :: BuiltinByteString -> BI.BuiltinList BuiltinData -> Bool
isReclaimBaseInput baseScriptHash txOutFields =
  let !address = field0 txOutFields
      !addressFields = constrFields address
      !credential = field0 addressFields
      !credentialConstr = BI.unsafeDataAsConstr credential
   in B.caseInteger
        (BI.fst credentialConstr)
        [ False
        , BI.equalsByteString (BI.unsafeDataAsB (BI.head (BI.snd credentialConstr))) baseScriptHash
        ]

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
                   in if lengthOfByteString proof == 336
                          && lengthOfByteString digest == 32
                        then
                          if count < 65535
                            then
                              let !item = proof <> digest
                                  !(!finalCount, !remainingItems) = go (count + 1) moreProofs moreDigests
                               in (finalCount, item <> remainingItems)
                            else traceError "reclaim batch count exceeds u16"
                        else traceError "invalid reclaim proof or digest width"
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
                      !item = proof <> digest
                      !(!finalCount, !remainingItems) = go (count + 1) moreProofs moreDigests
                   in (finalCount, item <> remainingItems)
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
        B.caseInteger
          credentialTag
          [ consByteString 1 emptyByteString
          , consByteString 2 emptyByteString
          ]
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
   in B.caseInteger
        maybeTag
        [ let !stakingCredential = BI.head (BI.snd maybeConstr)
              !stakingCredentialConstr = BI.unsafeDataAsConstr stakingCredential
           in B.caseInteger
                (BI.fst stakingCredentialConstr)
                [ credentialAddressBytes (BI.head (BI.snd stakingCredentialConstr))
                , traceError "staking pointers are unsupported"
                ]
        , consByteString 0 zeroCredentialHash
        ]

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
-- preserving the proof parser. Scalar representatives stay unreduced until
-- native group multiplication, which already interprets them modulo q.
{-# INLINABLE validateFreshBatchReclaimProofWithDigest #-}
validateFreshBatchReclaimProofWithDigest ::
  ParsedBatchVerifyingKey ->
  BuiltinByteString ->
  BuiltinByteString ->
  BuiltinByteString ->
  BatchCommittedProofCheck
validateFreshBatchReclaimProofWithDigest parsedVerifierKey paymentKeyHash publicInputDigest proof =
  if BI.equalsInteger (lengthOfByteString paymentKeyHash) 28
    then groth16VerifyCommittedParsedBatchNoPok parsedVerifierKey (Proof proof) (Scalar publicInputDigest)
    else traceError "reclaim payment key hash must be 28 bytes"

{-# INLINABLE nextBatchPower #-}
nextBatchPower :: Integer -> Integer -> Integer
nextBatchPower batchChallenge batchPower =
  (batchPower * batchChallenge) `B.modInteger` blsScalarFieldOrder

-- | Choose the coefficient for one proof. Every non-final proof receives a
-- positive power of the complete-transcript challenge. The final coefficient
-- closes the affine sum to one:
--
--   r, r^2, ..., r^(n-1), 1 - sum [r .. r^(n-1)]
--
-- For n=1 this returns one. For n>1 no coefficient is fixed independently of
-- the transcript. If proof errors are e_i, the folded error is
--
--   e_n + sum_i r^i (e_i - e_n),
--
-- which is identically zero only when every e_i is zero. For n=9 the random-
-- oracle failure probability is therefore at most 8/q. Group multiplication
-- interprets the final (usually negative) integer modulo q, while retaining an
-- exact integer coefficient sum of one for the specialized terminal equation.
{-# INLINABLE affineBatchCoefficient #-}
affineBatchCoefficient :: Bool -> Integer -> Integer -> Integer
affineBatchCoefficient isFinalProof priorCoefficientSum batchPower =
  if isFinalProof
    then 1 - priorCoefficientSum
    else batchPower

{-# INLINABLE nextAffineBatchCoefficient #-}
nextAffineBatchCoefficient :: Integer -> Integer -> BI.BuiltinList BuiltinData -> Integer
nextAffineBatchCoefficient priorCoefficientSum batchPower remainingProofs =
  B.caseList
    (\() -> 1 - priorCoefficientSum)
    (\_ _ -> batchPower)
    remainingProofs

{-# INLINABLE scaleBatchPoint #-}
scaleBatchPoint :: Integer -> BuiltinBLS12_381_G1_Element -> BuiltinBLS12_381_G1_Element
scaleBatchPoint coefficient point =
  if BI.equalsInteger coefficient 1
    then point
    else coefficient `bls12_381_G1_scalarMul` point

-- | Finish one weighted G1 column. All coefficients are explicit because every
-- proof in a multi-proof batch is transcript-dependent. The PV11 MSM cost
-- model has a large fixed intercept, so short batches retain individual folds.
{-# INLINABLE finishBatchG1Column #-}
finishBatchG1Column ::
  [Integer] ->
  [BuiltinBLS12_381_G1_Element] ->
  BuiltinBLS12_381_G1_Element
finishBatchG1Column coefficients points =
  case coefficients of
    _ : _ : _ : _ : _ : _ : _ : _ ->
      B.bls12_381_G1_multiScalarMul coefficients points
    _ -> finishSmallBatchG1Column coefficients points

{-# INLINABLE finishSmallBatchG1Column #-}
finishSmallBatchG1Column ::
  [Integer] ->
  [BuiltinBLS12_381_G1_Element] ->
  BuiltinBLS12_381_G1_Element
finishSmallBatchG1Column coefficients points =
  case coefficients of
    [] -> traceError "internal reclaim batch has no coefficients"
    coefficient : moreCoefficients ->
      case points of
        [] -> traceError "internal reclaim batch column mismatch"
        point : morePoints -> go (scaleBatchPoint coefficient point) moreCoefficients morePoints
  where
    go !foldedPoint !remainingCoefficients !remainingPoints =
      case remainingCoefficients of
        [] ->
          case remainingPoints of
            [] -> foldedPoint
            _ -> traceError "internal reclaim batch column mismatch"
        coefficient : moreCoefficients ->
          case remainingPoints of
            [] -> traceError "internal reclaim batch column mismatch"
            point : morePoints ->
              go
                (foldedPoint `bls12_381_G1_add` scaleBatchPoint coefficient point)
                moreCoefficients
                morePoints

-- | Finish the PoK column already multiplied by the statement-bound merge
-- challenge. For N>=8, fusing the challenge into every MSM scalar avoids a
-- separate full-width G1 scalar multiplication. Smaller batches retain the
-- cheaper scalar-fold implementation because PV11 MSM has a large intercept.
{-# INLINABLE finishMergedPokColumn #-}
finishMergedPokColumn ::
  Integer ->
  [Integer] ->
  [BuiltinBLS12_381_G1_Element] ->
  BuiltinBLS12_381_G1_Element
finishMergedPokColumn mergeChallenge coefficients points =
  case coefficients of
    _ : _ : _ : _ : _ : _ : _ : _ ->
      B.bls12_381_G1_multiScalarMul
        (scaleBatchPowers mergeChallenge coefficients)
        points
    _ ->
      mergeChallenge
        `bls12_381_G1_scalarMul` finishSmallBatchG1Column coefficients points

{-# INLINABLE finishBatchColumns #-}
finishBatchColumns ::
  Integer ->
  [Integer] ->
  [BuiltinBLS12_381_G1_Element] ->
  [BuiltinBLS12_381_G1_Element] ->
  [BuiltinBLS12_381_G1_Element] ->
  ( BuiltinBLS12_381_G1_Element ->
    BuiltinBLS12_381_G1_Element ->
    BuiltinBLS12_381_G1_Element ->
    Bool
  ) ->
  Bool
finishBatchColumns mergeChallenge coefficients commitments poks cs continue =
  case coefficients of
    _ : _ : _ : _ : _ : _ : _ : _ ->
      continue
        (B.bls12_381_G1_multiScalarMul coefficients commitments)
        (B.bls12_381_G1_multiScalarMul (scaleBatchPowers mergeChallenge coefficients) poks)
        (B.bls12_381_G1_multiScalarMul coefficients cs)
    _ ->
      continue
        (finishSmallBatchG1Column coefficients commitments)
        (mergeChallenge `bls12_381_G1_scalarMul` finishSmallBatchG1Column coefficients poks)
        (finishSmallBatchG1Column coefficients cs)

{-# INLINABLE scaleBatchPowers #-}
scaleBatchPowers :: Integer -> [Integer] -> [Integer]
scaleBatchPowers mergeChallenge batchPowers =
  case batchPowers of
    [] -> []
    batchPower : morePowers ->
      (mergeChallenge * batchPower)
        : scaleBatchPowers mergeChallenge morePowers

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
  Bool
validateReclaimInputsV2 baseScriptHash parsedVerifierKey verifierKeyHash proofs publicInputDigests inputs destinationOutputs =
  first inputs proofs publicInputDigests destinationOutputs
  where
    !batchTranscript = reclaimBatchTranscriptKnownWidthsV2 verifierKeyHash proofs publicInputDigests
    !batchTranscriptDigest = B.blake2b_256 batchTranscript
    !batchChallenge = ownershipProofBatchChallengeFromDigestV2 batchTranscriptDigest
    !mergeChallenge = ownershipProofBatchMergeChallengeFromDigestV2 batchTranscriptDigest

    first !remainingInputs !remainingProofs !remainingDigests !remainingOutputs =
      B.caseList
        (\() -> traceError "no reclaim base inputs")
        ( \txIn rest ->
            let !txOutFields = constrFields (txInResolved txIn)
             in if isReclaimBaseInput baseScriptHash txOutFields
                  then
                    B.caseList
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
                                       in if valueCoversData inputValueData outputValueData
                                            then
                                              if BI.equalsByteString claimedDigest actualDigest
                                                then
                                                  let !proofCheck = validateFreshBatchReclaimProofWithDigest parsedVerifierKey paymentKeyHash actualDigest proof
                                                   in case proofCheck of
                                                        BatchCommittedProofCheck commitment pok a b c pub eCmt ->
                                                          let !coefficient = nextAffineBatchCoefficient 0 batchChallenge moreProofs
                                                              !scaledA = scaleBatchPoint coefficient a
                                                              !foldedPub = coefficient * pub
                                                              !foldedECmt = coefficient * eCmt
                                                           in restOfBatch
                                                                rest
                                                                moreProofs
                                                                moreDigests
                                                                moreOutputs
                                                                [coefficient]
                                                                [commitment]
                                                                [pok]
                                                                (bls12_381_millerLoop scaledA b)
                                                                [c]
                                                                foldedPub
                                                                foldedECmt
                                                                coefficient
                                                                (nextBatchPower batchChallenge batchChallenge)
                                                else traceError "reclaim public input digest does not match statement"
                                            else traceError "destination output underpays reclaim input"
                                  )
                                  remainingOutputs
                            )
                            remainingDigests
                      )
                      remainingProofs
                  else first rest remainingProofs remainingDigests remainingOutputs
        )
        remainingInputs

    restOfBatch !remainingInputs !remainingProofs !remainingDigests !remainingOutputs !batchCoefficients !commitments !poks !foldedGrothLhs !cs !foldedPub !foldedECmt coefficientSum batchPower =
      B.caseList
        ( \() ->
            B.caseList
              ( \() ->
                  finishBatchColumns
                    mergeChallenge
                    batchCoefficients
                    commitments
                    poks
                    cs
                    ( \foldedCommitment scaledFoldedPok foldedC ->
                        -- The affine coefficient construction guarantees this
                        -- sum exactly. Supplying the literal lets Plinth erase
                        -- both fixed-base coefficient-one tests and their dead
                        -- scalar-multiplication branches after inlining.
                        let !foldedVkX = coefficientFirstVkXSumOne parsedVerifierKey foldedPub foldedECmt foldedCommitment
                         in verifyCommittedProofMergedBatchSumOneWithScaledPokBatchVK
                              parsedVerifierKey
                              foldedGrothLhs
                              foldedVkX
                              foldedC
                              foldedCommitment
                              scaledFoldedPok
                              mergeChallenge
                    )
              )
              (\_ _ -> traceError "unused reclaim public input digests")
              remainingDigests
        )
        ( \txIn rest ->
            let !txOutFields = constrFields (txInResolved txIn)
             in if isReclaimBaseInput baseScriptHash txOutFields
                  then
                    B.caseList
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
                                       in if valueCoversData inputValueData outputValueData
                                            then
                                              if BI.equalsByteString claimedDigest actualDigest
                                                then
                                                  let !proofCheck = validateFreshBatchReclaimProofWithDigest parsedVerifierKey paymentKeyHash actualDigest proof
                                                   in case proofCheck of
                                                        BatchCommittedProofCheck commitment pok a b c pub eCmt ->
                                                          let !coefficient = nextAffineBatchCoefficient coefficientSum batchPower moreProofs
                                                              -- In a multi-proof batch this coefficient
                                                              -- is transcript-dependent. Scalar-multiply
                                                              -- unconditionally; the coefficient-one fast
                                                              -- path is only material for N=1 above.
                                                              !scaledA = coefficient `bls12_381_G1_scalarMul` a
                                                              !newGrothLhs = foldedGrothLhs `bls12_381_mulMlResult` bls12_381_millerLoop scaledA b
                                                              newPower = nextBatchPower batchChallenge batchPower
                                                              newSum = coefficientSum + coefficient
                                                              !newPub = foldedPub + coefficient * pub
                                                              !newECmt = foldedECmt + coefficient * eCmt
                                                           in restOfBatch
                                                                rest
                                                                moreProofs
                                                                moreDigests
                                                                moreOutputs
                                                                (coefficient : batchCoefficients)
                                                                (commitment : commitments)
                                                                (pok : poks)
                                                                newGrothLhs
                                                                (c : cs)
                                                                newPub
                                                                newECmt
                                                                newSum
                                                                newPower
                                                else traceError "reclaim public input digest does not match statement"
                                            else traceError "destination output underpays reclaim input"
                                  )
                                  remainingOutputs
                            )
                            remainingDigests
                      )
                      remainingProofs
                  else restOfBatch rest remainingProofs remainingDigests remainingOutputs batchCoefficients commitments poks foldedGrothLhs cs foldedPub foldedECmt coefficientSum batchPower
        )
        remainingInputs



-- | The V2 script receives the canonical Cardano verification key and its
-- pre-checked BLAKE2b-256 hash as finalized script parameters. It never hashes
-- the 672-byte key at validation time; export/build tooling rejects a key/hash
-- mismatch before this code can be applied.
{-# INLINABLE reclaimGlobalValidatorV2Builtin #-}
reclaimGlobalValidatorV2Builtin :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinByteString -> BuiltinData -> Bool
reclaimGlobalValidatorV2Builtin (CurrencySymbol paramsCurrencySymbol) (TokenName paramsTokenName) verifierKey verifierKeyHash ctx =
  isRewarding && validateGlobal
  where
    !ctxFields = constrFields ctx
    !(!txInfo, !redeemer, !scriptInfo) = firstThree ctxFields
    !txInfoFields = constrFields txInfo
    !(!txInfoInputs, !txInfoReferenceInputs, !txInfoOutputs) = firstThree txInfoFields
    !redeemerFields = constrFields redeemer
    !(!paramsRefIdxData, !destinationOutStartIdxData, !reclaimProofs, !publicInputDigests) = firstFour redeemerFields

    isRewarding =
      B.caseInteger
        (constrTag scriptInfo)
        [False, False, True, False, False, False]

    validateGlobal =
      let !paramsRefIdx = BI.unsafeDataAsI paramsRefIdxData
          !destinationOutStartIdx = BI.unsafeDataAsI destinationOutStartIdxData
          !reclaimProofsData = BI.unsafeDataAsList reclaimProofs
          !publicInputDigestsData = BI.unsafeDataAsList publicInputDigests
          !paramsInput = findReferenceInputAt paramsRefIdx (BI.unsafeDataAsList txInfoReferenceInputs)
          !paramsOut = txInResolved paramsInput
          !baseScriptHash = decodeValidatedParams paramsCurrencySymbol paramsTokenName paramsOut
          !parsedVerifierKey = parseVerifyingKeyBatch verifierKey
          !destinationOutputs = BI.drop destinationOutStartIdx (BI.unsafeDataAsList txInfoOutputs)
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
  reclaimGlobalValidatorV2Builtin
    paramsCurrencySymbol
    paramsTokenName
    verifierKey
    verifierKeyHash
    ctx

{-# INLINABLE reclaimGlobalValidatorV2Untyped #-}
reclaimGlobalValidatorV2Untyped :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinUnit
reclaimGlobalValidatorV2Untyped paramsCurrencySymbol paramsTokenName verifierKey verifierKeyHash ctx =
  if reclaimGlobalValidatorV2Builtin paramsCurrencySymbol paramsTokenName verifierKey verifierKeyHash ctx
    then BI.unitval
    else traceError "reclaim global v2 validation failed"

reclaimGlobalValidatorV2Code :: CompiledCode (CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinUnit)
reclaimGlobalValidatorV2Code =
  $$(PlutusTx.compile [||reclaimGlobalValidatorV2Untyped||])
