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
  , hasExactlyOneParamToken
  , reclaimGlobalParamsData
  , reclaimGlobalRedeemerData
  , reclaimGlobalValidator
  , reclaimGlobalValidatorCode
  , reclaimGlobalValidatorUntyped
  , validateReclaimInputs
  ) where

import PlutusLedgerApi.V3
  ( CurrencySymbol (CurrencySymbol)
  , ScriptHash (ScriptHash)
  , Value
  )
import PlutusTx (CompiledCode)
import PlutusTx.Prelude
import qualified PlutusLedgerApi.V1.Value as Value
import qualified PlutusTx
import qualified PlutusTx.Builtins as B
import qualified PlutusTx.Builtins.Internal as BI

import Ownership.ReclaimBase (ReclaimBaseDatum (..))
import Ownership.Verify
  ( CommittedProofCheck (..)
  , ParsedVerifyingKey
  , blsScalarFieldOrder
  , ownershipProofBatchChallenge
  , parseVerifyingKey
  , verifyCommittedProofGrothBatch
  , verifyCommittedProofPokBatch
  , verifyOwnershipDestinationWithParsedVKKnown28NoPok
  )

data ReclaimGlobalParams = ReclaimGlobalParams
  { reclaimBaseScriptHash :: ScriptHash
  }

data ReclaimGlobalRedeemer = ReclaimGlobalRedeemer
  { reclaimParamsIdx :: Integer
  , reclaimDestinationOutStartIdx :: Integer
  , reclaimProofs :: [BuiltinByteString]
  }

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
hasExactlyOneParamTokenFromFields :: BuiltinByteString -> BI.BuiltinList BuiltinData -> BI.BuiltinBool
hasExactlyOneParamTokenFromFields paramsCurrencySymbol txOutFields =
  let !txOutValueData = field1 txOutFields
      !valueEntries = BI.unsafeDataAsMap txOutValueData
      !nonAdaEntries = BI.tail valueEntries
      !paramEntry = BI.head nonAdaEntries
      !policyId = BI.unsafeDataAsB (BI.fst paramEntry)
   in BI.equalsByteString policyId paramsCurrencySymbol

{-# INLINABLE hasExactlyOneParamToken #-}
hasExactlyOneParamToken :: BuiltinByteString -> BuiltinData -> BI.BuiltinBool
hasExactlyOneParamToken paramsCurrencySymbol txOut =
  hasExactlyOneParamTokenFromFields paramsCurrencySymbol (constrFields txOut)

{-# INLINABLE txInResolved #-}
txInResolved :: BuiltinData -> BuiltinData
txInResolved txIn =
  field1 (constrFields txIn)

{-# INLINABLE txOutValueFromFields #-}
txOutValueFromFields :: BI.BuiltinList BuiltinData -> Value
txOutValueFromFields txOutFields =
  PlutusTx.unsafeFromBuiltinData (field1 txOutFields)

{-# INLINABLE txOutValueFromData #-}
txOutValueFromData :: BuiltinData -> Value
txOutValueFromData txOut =
  txOutValueFromFields (constrFields txOut)

{-# INLINABLE decodeValidatedParams #-}
decodeValidatedParams :: BuiltinByteString -> BuiltinData -> BuiltinByteString
decodeValidatedParams paramsCurrencySymbol paramsOut =
  let !paramsOutFields = constrFields paramsOut
   in builtinIf
        (hasExactlyOneParamTokenFromFields paramsCurrencySymbol paramsOutFields)
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

{-# INLINABLE proofBytesConcat #-}
proofBytesConcat :: BI.BuiltinList BuiltinData -> BuiltinByteString
proofBytesConcat proofs =
  B.caseList
    (\() -> emptyByteString)
    ( \proofData moreProofs ->
        BI.unsafeDataAsB proofData <> proofBytesConcat moreProofs
    )
    proofs

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
zeroCredentialHash =
  go (28 :: Integer) emptyByteString
  where
    go :: Integer -> BuiltinByteString -> BuiltinByteString
    go !remaining !acc =
      if remaining == 0
        then acc
        else go (remaining - 1) (consByteString 0 acc)

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
  let !txOutFields = constrFields txOut
      !address = field0 txOutFields
      !addressFields = constrFields address
      !encoded =
        credentialAddressBytes (field0 addressFields)
          <> stakeAddressBytes (field1 addressFields)
   in if lengthOfByteString encoded == 58
        then encoded
        else traceError "destination address v1 must be 58 bytes"

{-# INLINABLE validateFreshReclaimProof #-}
validateFreshReclaimProof ::
  ParsedVerifyingKey ->
  BuiltinByteString ->
  BuiltinByteString ->
  BuiltinByteString ->
  CommittedProofCheck
validateFreshReclaimProof parsedVerifierKey paymentKeyHash destinationAddress proof =
  builtinIf
    (BI.equalsInteger (lengthOfByteString paymentKeyHash) 28)
    (verifyOwnershipDestinationWithParsedVKKnown28NoPok parsedVerifierKey proof paymentKeyHash destinationAddress)
    (traceError "reclaim payment key hash must be 28 bytes")

{-# INLINABLE nextBatchPower #-}
nextBatchPower :: Integer -> Integer -> Integer
nextBatchPower batchChallenge batchPower =
  (batchPower * batchChallenge) `B.modInteger` blsScalarFieldOrder

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
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G2_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  ( BuiltinBLS12_381_G1_Element
  , BuiltinBLS12_381_G1_Element
  , BuiltinBLS12_381_MlResult
  , BuiltinBLS12_381_G1_Element
  , BuiltinBLS12_381_G1_Element
  )
foldBatchProof batchPower foldedCommitment foldedPok foldedGrothLhs foldedVkX foldedC commitment pok a b c vkX =
  let !scaledCommitment = batchPower `bls12_381_G1_scalarMul` commitment
      !scaledPok = batchPower `bls12_381_G1_scalarMul` pok
      !scaledA = batchPower `bls12_381_G1_scalarMul` a
      !scaledVkX = batchPower `bls12_381_G1_scalarMul` vkX
      !scaledC = batchPower `bls12_381_G1_scalarMul` c
   in ( foldedCommitment `bls12_381_G1_add` scaledCommitment
      , foldedPok `bls12_381_G1_add` scaledPok
      , foldedGrothLhs `bls12_381_mulMlResult` bls12_381_millerLoop scaledA b
      , foldedVkX `bls12_381_G1_add` scaledVkX
      , foldedC `bls12_381_G1_add` scaledC
      )

{-# INLINABLE validateReclaimInputs #-}
validateReclaimInputs ::
  BuiltinByteString ->
  ParsedVerifyingKey ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinBool
validateReclaimInputs baseScriptHash parsedVerifierKey proofs inputs destinationOutputs =
  goFirst inputs proofs destinationOutputs
  where
    !batchChallenge = ownershipProofBatchChallenge (proofBytesConcat proofs)

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
                                let !proof = BI.unsafeDataAsB proofData
                                    !paymentKeyHash = decodeBasePaymentKeyHashFromFields txOutFields
                                    !destinationAddress = destinationAddressV1FromTxOutData destinationOut
                                    !destinationValue = txOutValueFromData destinationOut
                                    !inputValue = txOutValueFromFields txOutFields
                                 in builtinIf
                                      (boolToBuiltin (inputValue `Value.leq` destinationValue))
                                      ( let !proofCheck = validateFreshReclaimProof parsedVerifierKey paymentKeyHash destinationAddress proof
                                         in case proofCheck of
                                              CommittedProofCheck commitment pok a b c vkX ->
                                                goCached
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

    goCached
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
                        (boolToBuiltin (verifyCommittedProofPokBatch parsedVerifierKey foldedCommitment foldedPok))
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
                                let !proof = BI.unsafeDataAsB proofData
                                    !paymentKeyHash = decodeBasePaymentKeyHashFromFields txOutFields
                                    !destinationAddress = destinationAddressV1FromTxOutData destinationOut
                                    !destinationValue = txOutValueFromData destinationOut
                                    !inputValue = txOutValueFromFields txOutFields
                                 in builtinIf
                                      (boolToBuiltin (inputValue `Value.leq` destinationValue))
                                      ( builtinIf
                                          ( BI.equalsByteString previousPaymentKeyHash paymentKeyHash
                                              `builtinAnd` BI.equalsByteString previousDestinationAddress destinationAddress
                                              `builtinAnd` BI.equalsByteString previousProof proof
                                          )
                                          (goCached rest moreProofs moreDestinationOutputs paymentKeyHash destinationAddress proof foldedCommitment foldedPok foldedGrothLhs foldedVkX foldedC batchCoefficientSum batchPower)
                                          ( let !proofCheck = validateFreshReclaimProof parsedVerifierKey paymentKeyHash destinationAddress proof
                                             in case proofCheck of
                                                  CommittedProofCheck commitment pok a b c vkX ->
                                                    let !(!newFoldedCommitment, !newFoldedPok, !newFoldedGrothLhs, !newFoldedVkX, !newFoldedC) =
                                                          foldBatchProof batchPower foldedCommitment foldedPok foldedGrothLhs foldedVkX foldedC commitment pok a b c vkX
                                                        !newBatchCoefficientSum =
                                                          (batchCoefficientSum + batchPower) `B.modInteger` blsScalarFieldOrder
                                                     in goCached
                                                          rest
                                                          moreProofs
                                                          moreDestinationOutputs
                                                          paymentKeyHash
                                                          destinationAddress
                                                          proof
                                                          newFoldedCommitment
                                                          newFoldedPok
                                                          newFoldedGrothLhs
                                                          newFoldedVkX
                                                          newFoldedC
                                                          newBatchCoefficientSum
                                                          (nextBatchPower batchChallenge batchPower)
                                          )
                                      )
                                      (traceError "destination output underpays reclaim input")
                            )
                            remainingDestinationOutputs
                      )
                      remainingProofs
                  )
                  (goCached rest remainingProofs remainingDestinationOutputs previousPaymentKeyHash previousDestinationAddress previousProof foldedCommitment foldedPok foldedGrothLhs foldedVkX foldedC batchCoefficientSum batchPower)
        )
        remainingInputs

{-# INLINABLE reclaimGlobalValidatorBuiltin #-}
reclaimGlobalValidatorBuiltin :: CurrencySymbol -> BuiltinByteString -> BuiltinData -> BI.BuiltinBool
reclaimGlobalValidatorBuiltin (CurrencySymbol paramsCurrencySymbol) verifierKey ctx =
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
          !baseScriptHash = decodeValidatedParams paramsCurrencySymbol paramsOut
          !parsedVerifierKey = parseVerifyingKey verifierKey
          !destinationOutputs = dropAtData "invalid destination output start index" destinationOutStartIdx (BI.unsafeDataAsList txInfoOutputs)
       in validateReclaimInputs
            baseScriptHash
            parsedVerifierKey
            reclaimProofsData
            (BI.unsafeDataAsList txInfoInputs)
            destinationOutputs

{-# INLINABLE reclaimGlobalValidator #-}
reclaimGlobalValidator :: CurrencySymbol -> BuiltinByteString -> BuiltinData -> Bool
reclaimGlobalValidator paramsCurrencySymbol verifierKey ctx =
  builtinToBool $
    reclaimGlobalValidatorBuiltin
      paramsCurrencySymbol
      verifierKey
      ctx

{-# INLINABLE reclaimGlobalValidatorUntyped #-}
reclaimGlobalValidatorUntyped :: CurrencySymbol -> BuiltinByteString -> BuiltinData -> BuiltinUnit
reclaimGlobalValidatorUntyped paramsCurrencySymbol verifierKey ctx =
  builtinIf
    (reclaimGlobalValidatorBuiltin paramsCurrencySymbol verifierKey ctx)
    BI.unitval
    (traceError "reclaim global validation failed")

reclaimGlobalValidatorCode :: CompiledCode (CurrencySymbol -> BuiltinByteString -> BuiltinData -> BuiltinUnit)
reclaimGlobalValidatorCode =
  $$(PlutusTx.compile [||reclaimGlobalValidatorUntyped||])
