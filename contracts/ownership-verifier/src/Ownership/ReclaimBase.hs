{-# LANGUAGE DataKinds #-}
{-# LANGUAGE MultiParamTypeClasses #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TemplateHaskell #-}
{-# LANGUAGE ViewPatterns #-}

module Ownership.ReclaimBase
  ( ReclaimBaseDatum (..)
  , hasReclaimWithdrawal
  , isScriptCredential
  , parseReclaimBaseDatum
  , reclaimBaseDatumFromContext
  , reclaimBaseValidator
  , reclaimBaseValidatorCode
  , reclaimBaseValidatorUntyped
  , validReclaimPaymentKeyHash
  ) where

import PlutusLedgerApi.V3
  ( Credential (ScriptCredential)
  , Datum (Datum)
  , ScriptContext
  , ScriptInfo (SpendingScript)
  , scriptContextScriptInfo
  , scriptContextTxInfo
  , txInfoWdrl
  )
import PlutusTx (CompiledCode, fromBuiltinData, unsafeFromBuiltinData)
import qualified PlutusTx
import PlutusTx.Prelude
import qualified PlutusTx.AssocMap as Map

data ReclaimBaseDatum = ReclaimBaseDatum
  { reclaimPaymentKeyHash :: BuiltinByteString
  }

PlutusTx.makeIsDataIndexed ''ReclaimBaseDatum [('ReclaimBaseDatum, 0)]
PlutusTx.makeLift ''ReclaimBaseDatum

{-# INLINABLE validReclaimPaymentKeyHash #-}
validReclaimPaymentKeyHash :: BuiltinByteString -> Bool
validReclaimPaymentKeyHash paymentKeyHash =
  lengthOfByteString paymentKeyHash == 28

{-# INLINABLE parseReclaimBaseDatum #-}
parseReclaimBaseDatum :: Datum -> Maybe ReclaimBaseDatum
parseReclaimBaseDatum (Datum rawDatum) =
  fromBuiltinData rawDatum

{-# INLINABLE reclaimBaseDatumFromContext #-}
reclaimBaseDatumFromContext :: ScriptContext -> Maybe ReclaimBaseDatum
reclaimBaseDatumFromContext ctx =
  case scriptContextScriptInfo ctx of
    SpendingScript _ (Just datum) -> parseReclaimBaseDatum datum
    _                            -> Nothing

{-# INLINABLE hasReclaimWithdrawal #-}
hasReclaimWithdrawal :: Credential -> ScriptContext -> Bool
hasReclaimWithdrawal globalCredential ctx =
  case Map.lookup globalCredential (txInfoWdrl (scriptContextTxInfo ctx)) of
    Just _  -> True
    Nothing -> False

{-# INLINABLE isScriptCredential #-}
isScriptCredential :: Credential -> Bool
isScriptCredential credential =
  case credential of
    ScriptCredential _ -> True
    _                  -> False

{-# INLINABLE reclaimBaseValidator #-}
reclaimBaseValidator :: Credential -> ScriptContext -> Bool
reclaimBaseValidator globalCredential ctx =
  traceIfFalse "global credential must be script credential" (isScriptCredential globalCredential)
    && traceIfFalse "missing or malformed reclaim base datum" datumPresent
    && traceIfFalse "reclaim payment key hash must be 28 bytes" keyHashLengthOk
    && traceIfFalse "missing global reclaim withdrawal" withdrawalPresent
  where
    datum = reclaimBaseDatumFromContext ctx
    datumPresent =
      case datum of
        Just _  -> True
        Nothing -> False
    keyHashLengthOk =
      case datum of
        Just (ReclaimBaseDatum paymentKeyHash) -> validReclaimPaymentKeyHash paymentKeyHash
        Nothing                               -> False
    withdrawalPresent = hasReclaimWithdrawal globalCredential ctx

{-# INLINABLE reclaimBaseValidatorUntyped #-}
reclaimBaseValidatorUntyped :: Credential -> BuiltinData -> BuiltinUnit
reclaimBaseValidatorUntyped globalCredential ctx =
  check $
    reclaimBaseValidator
      globalCredential
      (unsafeFromBuiltinData ctx)

reclaimBaseValidatorCode :: CompiledCode (Credential -> BuiltinData -> BuiltinUnit)
reclaimBaseValidatorCode =
  $$(PlutusTx.compile [||reclaimBaseValidatorUntyped||])
