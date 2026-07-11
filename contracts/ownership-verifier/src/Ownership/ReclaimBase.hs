{-# LANGUAGE DataKinds #-}
{-# LANGUAGE MultiParamTypeClasses #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TemplateHaskell #-}
{-# LANGUAGE ViewPatterns #-}

module Ownership.ReclaimBase
  ( ReclaimBaseDatum (..)
  , reclaimBaseValidatorBuiltin
  , reclaimBaseValidatorCode
  , txInfoWdrlFieldIndex
  , txInfoWdrlFromContextData
  ) where

import PlutusTx (CompiledCode)
import qualified PlutusTx
import qualified PlutusTx.Builtins as B
import qualified PlutusTx.Builtins.Internal as BI
import PlutusTx.Prelude

data ReclaimBaseDatum = ReclaimBaseDatum
  { reclaimPaymentKeyHash :: BuiltinByteString
  }

PlutusTx.makeIsDataIndexed ''ReclaimBaseDatum [('ReclaimBaseDatum, 0)]
PlutusTx.makeLift ''ReclaimBaseDatum

-- | Zero-based field position in the Plutus V3 'TxInfo' Data constructor.
-- Verified against plutus-ledger-api-1.38.0.0
-- PlutusLedgerApi/V3/Data/Contexts.hs:498-524: txInfoWdrl is the seventh
-- declared field (after inputs, reference inputs, outputs, fee, mint, certs).
txInfoWdrlFieldIndex :: Integer
txInfoWdrlFieldIndex = 6

{-# INLINABLE builtinIf #-}
builtinIf :: BI.BuiltinBool -> a -> a -> a
builtinIf condition trueBranch falseBranch =
  BI.ifThenElse condition (\_ -> trueBranch) (\_ -> falseBranch) BI.unitval

{-# INLINABLE builtinAnd #-}
builtinAnd :: BI.BuiltinBool -> BI.BuiltinBool -> BI.BuiltinBool
builtinAnd left right = builtinIf left right BI.false

{-# INLINABLE builtinToBool #-}
builtinToBool :: BI.BuiltinBool -> Bool
builtinToBool condition = builtinIf condition True False

{-# INLINABLE field0 #-}
field0 :: BI.BuiltinList BuiltinData -> BuiltinData
field0 = BI.head

{-# INLINABLE field2 #-}
field2 :: BI.BuiltinList BuiltinData -> BuiltinData
field2 fields = BI.head (BI.tail (BI.tail fields))

{-# INLINABLE findDataAt #-}
findDataAt :: Integer -> BI.BuiltinList BuiltinData -> BuiltinData
findDataAt index values =
  B.caseList
    (\() -> traceError "invalid script context layout")
    ( \value rest ->
        builtinIf
          (BI.equalsInteger index 0)
          value
          (findDataAt (index - 1) rest)
    )
    values

-- | Extract the withdrawal map from a library-encoded V3 ScriptContext.
-- Keeping this walk shared by the validator and the layout test makes a
-- plutus-ledger-api field-order change fail loudly in the test suite.
{-# INLINABLE txInfoWdrlFromContextData #-}
txInfoWdrlFromContextData :: BuiltinData -> BuiltinData
txInfoWdrlFromContextData ctx =
  let ctxConstr = BI.unsafeDataAsConstr ctx
      txInfo = field0 (BI.snd ctxConstr)
      txInfoConstr = BI.unsafeDataAsConstr txInfo
   in builtinIf
        (BI.equalsInteger (BI.fst ctxConstr) 0 `builtinAnd` BI.equalsInteger (BI.fst txInfoConstr) 0)
        (findDataAt txInfoWdrlFieldIndex (BI.snd txInfoConstr))
        (traceError "invalid script context layout")

{-# INLINABLE hasExactlyOneField #-}
hasExactlyOneField :: BI.BuiltinList BuiltinData -> (BuiltinData -> BI.BuiltinBool) -> BI.BuiltinBool
hasExactlyOneField fields predicate =
  B.caseList
    (\() -> BI.false)
    ( \value rest ->
        B.caseList
          (\() -> predicate value)
          (\_ _ -> BI.false)
          rest
    )
    fields

{-# INLINABLE validBaseDatumData #-}
validBaseDatumData :: BuiltinData -> BI.BuiltinBool
validBaseDatumData datum =
  let datumConstr = BI.unsafeDataAsConstr datum
   in builtinIf
        (BI.equalsInteger (BI.fst datumConstr) 0)
        ( B.caseList
            (\() -> BI.false)
            ( \keyHashData _trailingFields ->
                -- The generated FromData decoder used by the pre-V1 validator
                -- reads the declared field and tolerates trailing constructor
                -- fields. Preserve that acceptance set during the raw-Data
                -- rewrite; only the first credential field is authoritative.
                BI.equalsInteger (BI.lengthOfByteString (BI.unsafeDataAsB keyHashData)) 28
            )
            (BI.snd datumConstr)
        )
        BI.false

{-# INLINABLE validInlineSpendingDatum #-}
validInlineSpendingDatum :: BuiltinData -> BI.BuiltinBool
validInlineSpendingDatum scriptInfo =
  let scriptInfoConstr = BI.unsafeDataAsConstr scriptInfo
   in builtinIf
        (BI.equalsInteger (BI.fst scriptInfoConstr) 1)
        ( B.caseList
            (\() -> BI.false)
            ( \_ownOutRef fieldsAfterOutRef ->
                B.caseList
                  (\() -> BI.false)
                  ( \maybeDatum trailingFields ->
                      B.caseList
                        ( \() ->
                            let maybeDatumConstr = BI.unsafeDataAsConstr maybeDatum
                             in builtinIf
                                  (BI.equalsInteger (BI.fst maybeDatumConstr) 0)
                                  (hasExactlyOneField (BI.snd maybeDatumConstr) validBaseDatumData)
                                  BI.false
                        )
                        (\_ _ -> BI.false)
                        trailingFields
                  )
                  fieldsAfterOutRef
            )
            (BI.snd scriptInfoConstr)
        )
        BI.false

{-# INLINABLE withdrawalKeyPresent #-}
withdrawalKeyPresent :: BuiltinData -> BI.BuiltinList (BI.BuiltinPair BuiltinData BuiltinData) -> BI.BuiltinBool
withdrawalKeyPresent expectedKey entries =
  B.caseList
    (\() -> BI.false)
    ( \entry rest ->
        builtinIf
          (BI.equalsData expectedKey (BI.fst entry))
          BI.true
          (withdrawalKeyPresent expectedKey rest)
    )
    entries

-- | Production raw-Data implementation. The pre-V1 typed validator is kept in
-- test-support/ReclaimBaseOracle.hs; compiled production code never decodes a
-- full ScriptContext.
{-# INLINABLE reclaimBaseValidatorBuiltin #-}
reclaimBaseValidatorBuiltin :: BuiltinData -> BuiltinData -> BI.BuiltinBool
reclaimBaseValidatorBuiltin globalCredentialData ctx =
  let globalCredentialConstr = BI.unsafeDataAsConstr globalCredentialData
      ctxConstr = BI.unsafeDataAsConstr ctx
      ctxFields = BI.snd ctxConstr
      scriptInfo = field2 ctxFields
      withdrawalEntries = BI.unsafeDataAsMap (txInfoWdrlFromContextData ctx)
   in BI.equalsInteger (BI.fst globalCredentialConstr) 1
        `builtinAnd` BI.equalsInteger (BI.fst ctxConstr) 0
        `builtinAnd` validInlineSpendingDatum scriptInfo
        `builtinAnd` withdrawalKeyPresent globalCredentialData withdrawalEntries

{-# INLINABLE reclaimBaseValidatorDataUntyped #-}
reclaimBaseValidatorDataUntyped :: BuiltinData -> BuiltinData -> BuiltinUnit
reclaimBaseValidatorDataUntyped globalCredentialData ctx =
  check $ builtinToBool $ reclaimBaseValidatorBuiltin globalCredentialData ctx

-- The deployment/export boundary applies the already encoded credential Data
-- to this code, so withdrawal-key Data is a compiled constant rather than
-- re-encoded for every validation.
reclaimBaseValidatorCode :: CompiledCode (BuiltinData -> BuiltinData -> BuiltinUnit)
reclaimBaseValidatorCode =
  $$(PlutusTx.compile [||reclaimBaseValidatorDataUntyped||])
