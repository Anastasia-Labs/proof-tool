{-# LANGUAGE DataKinds #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TemplateHaskell #-}

module FormalHelpers
  ( findReferenceInputAtEqualsCode
  , hasExactlyOneParamTokenCode
  , ownershipDestinationPublicInputDigestEqualsCode
  , reclaimBatchTranscriptV2EqualsCode
  , valueCoversDataCode
  ) where

import PlutusTx (CompiledCode)
import qualified PlutusTx
import PlutusTx.Builtins (BuiltinByteString, BuiltinData)
import qualified PlutusTx.Builtins.Internal as BI
import PlutusTx.Prelude (BuiltinUnit, Integer, traceError, ($))

import Ownership.ReclaimGlobalV2
  ( findReferenceInputAt
  , hasExactlyOneParamTokenCheckCode
  , reclaimBatchTranscriptV2
  , valueCoversData
  )
import Ownership.Verify (ownershipDestinationPublicInputDigest)

{-# INLINABLE require #-}
require :: BI.BuiltinBool -> BuiltinUnit
require condition =
  BI.ifThenElse
    condition
    (\_ -> BI.unitval)
    (\_ -> traceError "formal helper predicate failed")
    BI.unitval

{-# INLINABLE findReferenceInputAtEquals #-}
findReferenceInputAtEquals :: Integer -> BuiltinData -> BuiltinData -> BuiltinUnit
findReferenceInputAtEquals index referenceInputs expected =
  require $
    BI.equalsData
      (findReferenceInputAt index (BI.unsafeDataAsList referenceInputs))
      expected

{-# INLINABLE valueCoversDataUnit #-}
valueCoversDataUnit :: BuiltinData -> BuiltinData -> BuiltinUnit
valueCoversDataUnit required paid = require (valueCoversData required paid)

{-# INLINABLE ownershipDestinationPublicInputDigestEquals #-}
ownershipDestinationPublicInputDigestEquals ::
  BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> BuiltinUnit
ownershipDestinationPublicInputDigestEquals credential destination expected =
  require $
    BI.equalsByteString
      (ownershipDestinationPublicInputDigest credential destination)
      expected

{-# INLINABLE reclaimBatchTranscriptV2Equals #-}
reclaimBatchTranscriptV2Equals ::
  BuiltinByteString -> BuiltinData -> BuiltinData -> BuiltinByteString -> BuiltinUnit
reclaimBatchTranscriptV2Equals verifierKeyHash proofs digests expected =
  require $
    BI.equalsByteString
      ( reclaimBatchTranscriptV2
          verifierKeyHash
          (BI.unsafeDataAsList proofs)
          (BI.unsafeDataAsList digests)
      )
      expected

findReferenceInputAtEqualsCode ::
  CompiledCode (Integer -> BuiltinData -> BuiltinData -> BuiltinUnit)
findReferenceInputAtEqualsCode =
  $$(PlutusTx.compile [||findReferenceInputAtEquals||])

hasExactlyOneParamTokenCode ::
  CompiledCode (BuiltinByteString -> BuiltinByteString -> BuiltinData -> BuiltinUnit)
hasExactlyOneParamTokenCode = hasExactlyOneParamTokenCheckCode

valueCoversDataCode :: CompiledCode (BuiltinData -> BuiltinData -> BuiltinUnit)
valueCoversDataCode =
  $$(PlutusTx.compile [||valueCoversDataUnit||])

ownershipDestinationPublicInputDigestEqualsCode ::
  CompiledCode
    (BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> BuiltinUnit)
ownershipDestinationPublicInputDigestEqualsCode =
  $$(PlutusTx.compile [||ownershipDestinationPublicInputDigestEquals||])

reclaimBatchTranscriptV2EqualsCode ::
  CompiledCode
    (BuiltinByteString -> BuiltinData -> BuiltinData -> BuiltinByteString -> BuiltinUnit)
reclaimBatchTranscriptV2EqualsCode =
  $$(PlutusTx.compile [||reclaimBatchTranscriptV2Equals||])
