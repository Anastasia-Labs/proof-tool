{-# LANGUAGE BangPatterns #-}
{-# LANGUAGE DataKinds #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TemplateHaskell #-}

-- | Reference implementation of aggregate ownership-proof verification.
--
-- This validator is currently unused by the ownership-proof web app and
-- production deployments. 'Ownership.ReclaimGlobalV2' was selected instead
-- because its smaller proving key enables faster browser proving. This module
-- is retained so developers can reference a batched proof-verification
-- contract.
module Ownership.ReclaimGlobalMulti
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
  )
import PlutusTx (CompiledCode)
import qualified PlutusTx
import PlutusTx.Builtins (ByteOrder (BigEndian))
import PlutusTx.Prelude
import qualified PlutusTx.Builtins as B
import qualified PlutusTx.Builtins.Internal as BI

import Ownership.Verify
  ( ParsedVerifyingKey
  , Proof (Proof)
  , Scalar (Scalar)
  , groth16VerifyCommittedParsed
  , parseVerifyingKey
  )

data ReclaimGlobalMultiParams = ReclaimGlobalMultiParams
  { reclaimBaseScriptHash :: ScriptHash
  }

data ReclaimGlobalMultiRedeemer = ReclaimGlobalMultiRedeemer
  { reclaimParamsIdx :: Integer
  , reclaimDestinationOutIdx :: Integer
  , reclaimProof :: BuiltinByteString
  }

type MultiReclaimScan = (Integer, BuiltinByteString, BI.BuiltinValue)

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
  BI.head (BI.drop 1 fields)

{-# INLINABLE field2 #-}
field2 :: BI.BuiltinList BuiltinData -> BuiltinData
field2 fields =
  BI.head (BI.drop 2 fields)

{-# INLINABLE findDataAt #-}
findDataAt :: Integer -> BI.BuiltinList BuiltinData -> BuiltinData
findDataAt idx values =
  BI.head (BI.drop idx values)

{-# INLINABLE findReferenceInputAtData #-}
findReferenceInputAtData :: Integer -> BI.BuiltinList BuiltinData -> BuiltinData
findReferenceInputAtData =
  findDataAt

{-# INLINABLE dropDataAt #-}
dropDataAt :: Integer -> BI.BuiltinList BuiltinData -> BI.BuiltinList BuiltinData
dropDataAt =
  BI.drop

{-# INLINABLE hasExactlyOneParamToken #-}
hasExactlyOneParamToken :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> Bool
hasExactlyOneParamToken paramsCurrencySymbol paramsTokenName txOut =
  let !valueEntries = BI.unsafeDataAsMap txOutValueData
      !nonAdaEntries = BI.drop 1 valueEntries
   in B.caseList
        (\() -> False)
        ( \paramEntry morePolicies ->
            B.caseList
              (\() -> exactParamEntry paramEntry)
              (\_ _ -> False)
              morePolicies
        )
        nonAdaEntries
  where
    txOutFields = constrFields txOut
    txOutValueData = field1 txOutFields

    exactParamEntry !paramEntry =
      BI.equalsByteString (BI.unsafeDataAsB (BI.fst paramEntry)) paramsCurrencySymbol
        && hasExactToken (BI.unsafeDataAsMap (BI.snd paramEntry))

    hasExactToken !tokens =
      B.caseList
        (\() -> False)
        ( \token moreTokens ->
            B.caseList
              ( \() ->
                  BI.equalsByteString (BI.unsafeDataAsB (BI.fst token)) paramsTokenName
                    && BI.equalsInteger (BI.unsafeDataAsI (BI.snd token)) 1
              )
              (\_ _ -> False)
              moreTokens
        )
        tokens

{-# INLINABLE txInResolved #-}
txInResolved :: BuiltinData -> BuiltinData
txInResolved txIn =
  field1 (constrFields txIn)

{-# INLINABLE txOutValueFromData #-}
txOutValueFromData :: BuiltinData -> BI.BuiltinValue
txOutValueFromData txOut =
  BI.unsafeDataAsValue (field1 (constrFields txOut))

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
isReclaimBaseInput :: BuiltinByteString -> BuiltinData -> Bool
isReclaimBaseInput baseScriptHash txIn =
  let !resolved = txInResolved txIn
      !txOutFields = constrFields resolved
      !address = field0 txOutFields
      !addressFields = constrFields address
      !credential = field0 addressFields
      !credentialConstr = BI.unsafeDataAsConstr credential
   in B.caseInteger
        (BI.fst credentialConstr)
        [ False
        , BI.equalsByteString (BI.unsafeDataAsB (BI.head (BI.snd credentialConstr))) baseScriptHash
        ]

{-# INLINABLE decodeBasePaymentKeyHash #-}
decodeBasePaymentKeyHash :: BuiltinData -> BuiltinByteString
decodeBasePaymentKeyHash txOut =
  let !baseDatum = inlineDatum txOut
      !baseDatumConstr = BI.unsafeDataAsConstr baseDatum
   in BI.unsafeDataAsB (BI.head (BI.snd baseDatumConstr))

{-# INLINABLE scanMultiReclaimInputs #-}
scanMultiReclaimInputs :: BuiltinByteString -> BI.BuiltinList BuiltinData -> MultiReclaimScan
scanMultiReclaimInputs baseScriptHash inputs =
  first inputs
  where
    first !remainingInputs =
      B.caseList
        (\() -> traceError "no reclaim base inputs")
        ( \txIn rest ->
            if isReclaimBaseInput baseScriptHash txIn
              then
                let !resolved = txInResolved txIn
                    !paymentKeyHash = decodeBasePaymentKeyHash resolved
                 in if lengthOfByteString paymentKeyHash == 28
                      then
                        go
                          rest
                          1
                          paymentKeyHash
                          (txOutValueFromData resolved)
                      else traceError "reclaim payment key hash must be 28 bytes"
              else first rest
        )
        remainingInputs

    go !remainingInputs !credentialCount !credentialBytes !requiredValue =
      B.caseList
        (\() -> (credentialCount, credentialBytes, requiredValue))
        ( \txIn rest ->
            if isReclaimBaseInput baseScriptHash txIn
              then
                let !resolved = txInResolved txIn
                    !paymentKeyHash = decodeBasePaymentKeyHash resolved
                 in if lengthOfByteString paymentKeyHash == 28
                      then
                        go
                          rest
                          (credentialCount + 1)
                          (credentialBytes <> paymentKeyHash)
                          (BI.unionValue requiredValue (txOutValueFromData resolved))
                      else traceError "reclaim payment key hash must be 28 bytes"
              else go rest credentialCount credentialBytes requiredValue
        )
        remainingInputs

-- These helpers receive only Address components projected from ledger-built
-- TxOuts. The ledger fixes Credential/Maybe constructor ranges and credential
-- hash widths, so only the variants that change destination semantics remain
-- branched here. Pointer staking credentials are valid ledger values but are
-- deliberately unsupported by destinationAddressV1.
{-# INLINABLE credentialHashBytes #-}
credentialHashBytes :: BuiltinData -> BuiltinByteString
credentialHashBytes credential =
  BI.unsafeDataAsB (BI.head (constrFields credential))

{-# INLINABLE credentialWireTag #-}
credentialWireTag :: BuiltinData -> BuiltinByteString
credentialWireTag credential =
  let !credentialTag = constrTag credential
   in B.caseInteger
        credentialTag
        [ consByteString 1 emptyByteString
        , consByteString 2 emptyByteString
        ]

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
   in B.caseInteger
        maybeTag
        [ let !stakingCredential = BI.head (constrFields stakingCredentialMaybe)
           in B.caseInteger
                (constrTag stakingCredential)
                [ credentialAddressBytes (BI.head (constrFields stakingCredential))
                , traceError "staking pointers are unsupported"
                ]
        , consByteString 0 zeroCredentialHash
        ]

{-# INLINABLE destinationAddressV1FromTxOutData #-}
destinationAddressV1FromTxOutData :: BuiltinData -> BuiltinByteString
destinationAddressV1FromTxOutData txOut =
  let !txOutFields = constrFields txOut
      !address = field0 txOutFields
      !addressFields = constrFields address
   in credentialAddressBytes (field0 addressFields)
        <> stakeAddressBytes (field1 addressFields)

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
  groth16VerifyCommittedParsed
    parsedVerifierKey
    (Proof proof)
    (Scalar (multiCredentialPublicInputDigest credentialCount credentialBytes destinationBytes))

{-# INLINABLE scanDestinationOutputs #-}
scanDestinationOutputs :: BI.BuiltinList BuiltinData -> (BuiltinByteString, BI.BuiltinValue)
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
accumulateDestinationValue :: BuiltinData -> BI.BuiltinValue -> BI.BuiltinList BuiltinData -> BI.BuiltinValue
accumulateDestinationValue destinationAddress initialValue outputs =
  go initialValue outputs
  where
    go !acc !remaining =
      B.caseList
        (\() -> acc)
        ( \txOut rest ->
            if BI.equalsData (txOutAddressFromData txOut) destinationAddress
              then go (BI.unionValue acc (txOutValueFromData txOut)) rest
              else acc
        )
        remaining

{-# INLINABLE validateMultiReclaimInputs #-}
validateMultiReclaimInputs ::
  BuiltinByteString ->
  ParsedVerifyingKey ->
  BuiltinByteString ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  Bool
validateMultiReclaimInputs baseScriptHash parsedVerifierKey proof destinationOutputs inputs =
  let !(!credentialCount, !credentialBytes, !requiredValue) =
        scanMultiReclaimInputs baseScriptHash inputs
      !(!destinationBytes, !destinationValue) =
        scanDestinationOutputs destinationOutputs
   in if verifyMultiOwnershipWithParsedVK
          parsedVerifierKey
          proof
          credentialCount
          credentialBytes
          destinationBytes
        then
          if BI.valueContains destinationValue requiredValue
            then True
            else traceError "destination output underpays reclaim inputs"
        else traceError "multi reclaim proof validation failed"

validateMultiReclaimInputsWithProofCheck ::
  (Integer -> BuiltinByteString -> BuiltinByteString -> Bool) ->
  BuiltinByteString ->
  BI.BuiltinList BuiltinData ->
  BI.BuiltinList BuiltinData ->
  Bool
validateMultiReclaimInputsWithProofCheck proofCheck baseScriptHash destinationOutputs inputs =
  let !(!credentialCount, !credentialBytes, !requiredValue) =
        scanMultiReclaimInputs baseScriptHash inputs
      !(!destinationBytes, !destinationValue) =
        scanDestinationOutputs destinationOutputs
   in if proofCheck credentialCount credentialBytes destinationBytes
        then
          if BI.valueContains destinationValue requiredValue
            then True
            else traceError "destination output underpays reclaim inputs"
        else traceError "multi reclaim proof validation failed"

{-# INLINABLE validateParams #-}
validateParams :: BuiltinByteString -> BuiltinByteString -> BuiltinData -> Bool
validateParams paramsCurrencySymbol paramsTokenName paramsOut =
  hasExactlyOneParamToken paramsCurrencySymbol paramsTokenName paramsOut

{-# INLINABLE mkMultiReclaimGlobal #-}
mkMultiReclaimGlobal :: CurrencySymbol -> TokenName -> BuiltinByteString -> BuiltinData -> Bool
mkMultiReclaimGlobal (CurrencySymbol paramsCurrencySymbol) (TokenName paramsTokenName) verifierKey ctx =
  isRewarding && validateGlobal
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
      B.caseInteger
        (constrTag scriptInfo)
        [False, False, True, False, False, False]

    validateGlobal =
      let !paramsInput = findReferenceInputAtData paramsRefIdx (BI.unsafeDataAsList txInfoReferenceInputs)
          !paramsOut = txInResolved paramsInput
          !baseScriptHash = decodeParamsScriptHash paramsOut
          !destinationOutputs =
            dropDataAt destinationOutIdx (BI.unsafeDataAsList txInfoOutputs)
       in validateParams paramsCurrencySymbol paramsTokenName paramsOut
            && validateMultiReclaimInputs
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
