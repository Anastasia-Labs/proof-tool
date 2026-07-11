{-# LANGUAGE BangPatterns #-}
{-# LANGUAGE DataKinds #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TemplateHaskell #-}

module Ownership.ReclaimGlobalMultiV2Bench
  ( MultiReclaimScan
  , ReclaimGlobalMultiParams (..)
  , ReclaimGlobalMultiRedeemer (..)
  , destinationAddressV1FromTxOutData
  , mkMultiReclaimGlobal
  , mkMultiReclaimGlobalUntyped
  , multiCredentialCountU16BE
  , multiCredentialPublicInputDigest
  , multiOwnershipDomain
  , reclaimGlobalMultiParamsData
  , reclaimGlobalMultiRedeemerData
  , reclaimGlobalMultiValidator
  , reclaimGlobalMultiValidatorCode
  , scanMultiReclaimInputs
  , validateMultiReclaimInputs
  , validateMultiReclaimInputsWithProofCheck
  ) where

import PlutusLedgerApi.V3
  ( CurrencySymbol (CurrencySymbol)
  , ScriptHash (ScriptHash)
  , TokenName (TokenName)
  , Value
  )
import PlutusTx (CompiledCode)
import qualified PlutusTx
import PlutusTx.Builtins (ByteOrder (BigEndian))
import PlutusTx.Prelude
import qualified PlutusLedgerApi.V1.Value as Value
import qualified PlutusTx.Builtins as B
import qualified PlutusTx.Builtins.Internal as BI

import Ownership.Verify
  ( CommittedProofCheck (..)
  , ParsedVerifyingKey
  , Proof (Proof)
  , Scalar (Scalar)
  , groth16VerifyCommittedParsedNoPok
  , ownershipProofBatchMergeChallenge
  , parseVerifyingKey
  , verifyCommittedProofMergedWithVK
  )

data ReclaimGlobalMultiParams = ReclaimGlobalMultiParams
  { reclaimBaseScriptHash :: ScriptHash
  }

data ReclaimGlobalMultiRedeemer = ReclaimGlobalMultiRedeemer
  { reclaimParamsIdx :: Integer
  , reclaimDestinationOutIdx :: Integer
  , reclaimProof :: BuiltinByteString
  }

type MultiReclaimScan = (Integer, BuiltinByteString, Value)

{-# INLINABLE reclaimGlobalMultiParamsData #-}
reclaimGlobalMultiParamsData :: ScriptHash -> BuiltinData
reclaimGlobalMultiParamsData (ScriptHash baseScriptHash) =
  BI.mkConstr
    0
    ( BI.mkCons
        (BI.mkB baseScriptHash)
        (BI.mkNilData BI.unitval)
    )

{-# INLINABLE reclaimGlobalMultiRedeemerData #-}
reclaimGlobalMultiRedeemerData :: Integer -> Integer -> BuiltinByteString -> BuiltinData
reclaimGlobalMultiRedeemerData paramsIdx destinationOutIdx proof =
  BI.mkConstr
    0
    ( BI.mkCons
        (BI.mkI paramsIdx)
        ( BI.mkCons
            (BI.mkI destinationOutIdx)
            ( BI.mkCons
                (BI.mkB proof)
                (BI.mkNilData BI.unitval)
            )
        )
    )

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

{-# INLINABLE boolToBuiltin #-}
boolToBuiltin :: Bool -> BI.BuiltinBool
boolToBuiltin condition =
  if condition then BI.true else BI.false

{-# INLINABLE builtinToBool #-}
builtinToBool :: BI.BuiltinBool -> Bool
builtinToBool condition =
  builtinIf condition True False

{-# INLINABLE constrTag #-}
constrTag :: BuiltinData -> Integer
constrTag datum =
  BI.fst (BI.unsafeDataAsConstr datum)

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

{-# INLINABLE findReferenceInputAtData #-}
findReferenceInputAtData :: Integer -> BI.BuiltinList BuiltinData -> BuiltinData
findReferenceInputAtData =
  findDataAt "invalid parameter ref index"

{-# INLINABLE dropDataAt #-}
dropDataAt :: BuiltinString -> Integer -> BI.BuiltinList BuiltinData -> BI.BuiltinList BuiltinData
dropDataAt errorMessage idx values =
  if idx < 0
    then traceError errorMessage
    else go idx values
  where
    go !n !remaining =
      B.caseList
        (\() -> traceError errorMessage)
        ( \_ rest ->
            builtinIf
              (BI.equalsInteger n 0)
              remaining
              (go (n - 1) rest)
        )
        remaining

{-# INLINABLE hasExactlyOneParamToken #-}
hasExactlyOneParamToken :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> BI.BuiltinBool
hasExactlyOneParamToken paramsCurrencySymbol paramsTokenName txOut =
  let !valueEntries = BI.unsafeDataAsMap txOutValueData
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
    txOutFields = constrFields txOut
    txOutValueData = field1 txOutFields

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

{-# INLINABLE txInResolved #-}
txInResolved :: BuiltinData -> BuiltinData
txInResolved txIn =
  field1 (constrFields txIn)

{-# INLINABLE txOutValueFromData #-}
txOutValueFromData :: BuiltinData -> Value
txOutValueFromData txOut =
  PlutusTx.unsafeFromBuiltinData (field1 (constrFields txOut))

{-# INLINABLE txOutAddressFromData #-}
txOutAddressFromData :: BuiltinData -> BuiltinData
txOutAddressFromData txOut =
  field0 (constrFields txOut)

{-# INLINABLE inlineDatum #-}
inlineDatum :: BuiltinData -> BuiltinData
inlineDatum txOut =
  let !txOutFields = constrFields txOut
      !outputDatum = field2 txOutFields
      !datumConstr = BI.unsafeDataAsConstr outputDatum
   in BI.head (BI.snd datumConstr)

{-# INLINABLE decodeParamsScriptHash #-}
decodeParamsScriptHash :: BuiltinData -> BuiltinByteString
decodeParamsScriptHash paramsOut =
  let !paramsDatum = inlineDatum paramsOut
      !paramsConstr = BI.unsafeDataAsConstr paramsDatum
   in BI.unsafeDataAsB (BI.head (BI.snd paramsConstr))

{-# INLINABLE isReclaimBaseInput #-}
isReclaimBaseInput :: BuiltinByteString -> BuiltinData -> BI.BuiltinBool
isReclaimBaseInput baseScriptHash txIn =
  let !resolved = txInResolved txIn
      !txOutFields = constrFields resolved
      !address = field0 txOutFields
      !addressFields = constrFields address
      !credential = field0 addressFields
      !credentialConstr = BI.unsafeDataAsConstr credential
   in builtinIf
        (BI.equalsInteger (BI.fst credentialConstr) 1)
        (BI.equalsByteString (BI.unsafeDataAsB (BI.head (BI.snd credentialConstr))) baseScriptHash)
        BI.false

{-# INLINABLE decodeBasePaymentKeyHash #-}
decodeBasePaymentKeyHash :: BuiltinData -> BuiltinByteString
decodeBasePaymentKeyHash txOut =
  let !baseDatum = inlineDatum txOut
      !baseDatumConstr = BI.unsafeDataAsConstr baseDatum
   in BI.unsafeDataAsB (BI.head (BI.snd baseDatumConstr))

{-# INLINABLE scanMultiReclaimInputs #-}
scanMultiReclaimInputs :: BuiltinByteString -> BI.BuiltinList BuiltinData -> MultiReclaimScan
scanMultiReclaimInputs baseScriptHash inputs =
  go inputs 0 emptyByteString mempty BI.false
  where
    go !remainingInputs !credentialCount !credentialBytes !requiredValue !sawBase =
      B.caseList
        ( \() ->
            builtinIf
              sawBase
              (credentialCount, credentialBytes, requiredValue)
              (traceError "no reclaim base inputs")
        )
        ( \txIn rest ->
            builtinIf
              (isReclaimBaseInput baseScriptHash txIn)
              ( let !resolved = txInResolved txIn
                    !paymentKeyHash = decodeBasePaymentKeyHash resolved
                 in if lengthOfByteString paymentKeyHash == 28
                      then
                        go
                          rest
                          (credentialCount + 1)
                          (credentialBytes <> paymentKeyHash)
                          (requiredValue <> txOutValueFromData resolved)
                          BI.true
                      else traceError "reclaim payment key hash must be 28 bytes"
              )
              (go rest credentialCount credentialBytes requiredValue sawBase)
        )
        remainingInputs

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

{-# INLINABLE multiOwnershipDomain #-}
multiOwnershipDomain :: BuiltinByteString
multiOwnershipDomain = "ROOT-OWNERSHIP-MULTI-v1"

{-# INLINABLE multiCredentialCountU16BE #-}
multiCredentialCountU16BE :: Integer -> BuiltinByteString
multiCredentialCountU16BE credentialCount =
  if credentialCount >= 1 && credentialCount <= 65535
    then integerToByteString BigEndian 2 credentialCount
    else traceError "multi credential count out of range"

{-# INLINABLE multiCredentialPublicInputDigest #-}
multiCredentialPublicInputDigest :: Integer -> BuiltinByteString -> BuiltinByteString -> BuiltinByteString
multiCredentialPublicInputDigest credentialCount credentialBytes destinationBytes =
  if lengthOfByteString credentialBytes == credentialCount * 28
      && lengthOfByteString destinationBytes == 58
    then
      blake2b_256
        ( multiOwnershipDomain
            <> multiCredentialCountU16BE credentialCount
            <> credentialBytes
            <> destinationBytes
        )
    else traceError "malformed multi credential public input"

{-# INLINABLE verifyMultiOwnershipWithParsedVK #-}
verifyMultiOwnershipWithParsedVK ::
  ParsedVerifyingKey ->
  BuiltinByteString ->
  Integer ->
  BuiltinByteString ->
  BuiltinByteString ->
  Bool
verifyMultiOwnershipWithParsedVK parsedVerifierKey proof credentialCount credentialBytes destinationBytes =
  case
      groth16VerifyCommittedParsedNoPok
        parsedVerifierKey
        (Proof proof)
        (Scalar (multiCredentialPublicInputDigest credentialCount credentialBytes destinationBytes))
    of
      CommittedProofCheck commitment pok a b c vkX ->
        verifyCommittedProofMergedWithVK
          parsedVerifierKey
          (bls12_381_millerLoop a b)
          vkX
          c
          commitment
          pok
          (ownershipProofBatchMergeChallenge proof)

{-# INLINABLE scanDestinationOutputs #-}
scanDestinationOutputs :: BI.BuiltinList BuiltinData -> (BuiltinByteString, Value)
scanDestinationOutputs outputs =
  B.caseList
    (\() -> traceError "invalid destination output index")
    ( \firstOutput rest ->
        let !destinationAddress = txOutAddressFromData firstOutput
            !destinationBytes = destinationAddressV1FromTxOutData firstOutput
            !destinationValue =
              accumulateDestinationValue
                destinationAddress
                (txOutValueFromData firstOutput)
                rest
         in (destinationBytes, destinationValue)
    )
    outputs

{-# INLINABLE accumulateDestinationValue #-}
accumulateDestinationValue :: BuiltinData -> Value -> BI.BuiltinList BuiltinData -> Value
accumulateDestinationValue destinationAddress initialValue outputs =
  go initialValue outputs
  where
    go !acc !remaining =
      B.caseList
        (\() -> acc)
        ( \txOut rest ->
            builtinIf
              (BI.equalsData (txOutAddressFromData txOut) destinationAddress)
              (go (acc <> txOutValueFromData txOut) rest)
              acc
        )
        remaining

{-# INLINABLE validateMultiReclaimInputs #-}
validateMultiReclaimInputs ::
  BuiltinByteString ->
  ParsedVerifyingKey ->
  BuiltinByteString ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinBool
validateMultiReclaimInputs baseScriptHash parsedVerifierKey proof destinationOutputs inputs =
  let !(!credentialCount, !credentialBytes, !requiredValue) =
        scanMultiReclaimInputs baseScriptHash inputs
      !(!destinationBytes, !destinationValue) =
        scanDestinationOutputs destinationOutputs
   in builtinIf
        ( boolToBuiltin $
            verifyMultiOwnershipWithParsedVK
              parsedVerifierKey
              proof
              credentialCount
              credentialBytes
              destinationBytes
        )
        ( builtinIf
            (boolToBuiltin (requiredValue `Value.leq` destinationValue))
            BI.true
            (traceError "destination output underpays reclaim inputs")
        )
        (traceError "multi reclaim proof validation failed")

validateMultiReclaimInputsWithProofCheck ::
  (Integer -> BuiltinByteString -> BuiltinByteString -> Bool) ->
  BuiltinByteString ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  Bool
validateMultiReclaimInputsWithProofCheck proofCheck baseScriptHash destinationOutputs inputs =
  builtinToBool $
    let !(!credentialCount, !credentialBytes, !requiredValue) =
          scanMultiReclaimInputs baseScriptHash inputs
        !(!destinationBytes, !destinationValue) =
          scanDestinationOutputs destinationOutputs
     in builtinIf
          (boolToBuiltin (proofCheck credentialCount credentialBytes destinationBytes))
          ( builtinIf
              (boolToBuiltin (requiredValue `Value.leq` destinationValue))
              BI.true
              (traceError "destination output underpays reclaim inputs")
          )
          (traceError "multi reclaim proof validation failed")

{-# INLINABLE validateParams #-}
validateParams :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> BI.BuiltinBool
validateParams paramsCurrencySymbol paramsTokenName paramsOut =
  hasExactlyOneParamToken paramsCurrencySymbol paramsTokenName paramsOut

{-# INLINABLE mkMultiReclaimGlobal #-}
mkMultiReclaimGlobal :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinData -> Bool
mkMultiReclaimGlobal (CurrencySymbol paramsCurrencySymbol) (TokenName paramsTokenName) verifierKey ctx =
  builtinToBool $
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
    !destinationOutIdx = BI.unsafeDataAsI (field1 redeemerFields)
    !proof = BI.unsafeDataAsB (field2 redeemerFields)
    !parsedVerifierKey = parseVerifyingKey verifierKey

    isRewarding =
      BI.equalsInteger (constrTag scriptInfo) 2

    validateGlobal =
      let !paramsInput = findReferenceInputAtData paramsRefIdx (BI.unsafeDataAsList txInfoReferenceInputs)
          !paramsOut = txInResolved paramsInput
          !baseScriptHash = decodeParamsScriptHash paramsOut
          !destinationOutputs =
            dropDataAt "invalid destination output index" destinationOutIdx (BI.unsafeDataAsList txInfoOutputs)
       in validateParams paramsCurrencySymbol paramsTokenName paramsOut
            `builtinAnd` validateMultiReclaimInputs
              baseScriptHash
              parsedVerifierKey
              proof
              destinationOutputs
              (BI.unsafeDataAsList txInfoInputs)

{-# INLINABLE reclaimGlobalMultiValidator #-}
reclaimGlobalMultiValidator :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinData -> Bool
reclaimGlobalMultiValidator =
  mkMultiReclaimGlobal

{-# INLINABLE mkMultiReclaimGlobalUntyped #-}
mkMultiReclaimGlobalUntyped :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinData -> BuiltinUnit
mkMultiReclaimGlobalUntyped paramsCurrencySymbol paramsTokenName verifierKey ctx =
  check $
    mkMultiReclaimGlobal
      paramsCurrencySymbol
      paramsTokenName
      verifierKey
      ctx

reclaimGlobalMultiValidatorCode :: CompiledCode (CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinData -> BuiltinUnit)
reclaimGlobalMultiValidatorCode =
  $$(PlutusTx.compile [||mkMultiReclaimGlobalUntyped||])
