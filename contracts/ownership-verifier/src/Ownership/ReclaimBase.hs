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

{-# INLINABLE builtinIf #-}
builtinIf :: BI.BuiltinBool -> a -> a -> a
builtinIf condition trueBranch falseBranch =
  BI.ifThenElse condition (\_ -> trueBranch) (\_ -> falseBranch) BI.unitval

-- | Extract the withdrawal map from a library-encoded V3 ScriptContext.
-- The ledger constructs both single-constructor records and guarantees their
-- field counts. In plutus-ledger-api-1.38.0.0, txInfoWdrl is fixed at field 6,
-- after inputs, reference inputs, outputs, fee, mint, and certificates. Use a
-- direct unsafe projection rather than rechecking ledger-owned tags or list
-- lengths on every ReclaimBase execution. The layout test keeps this pinned
-- field dependency visible across library upgrades.
{-# INLINABLE txInfoWdrlFromContextData #-}
txInfoWdrlFromContextData :: BuiltinData -> BuiltinData
txInfoWdrlFromContextData ctx =
  let txInfo = BI.head (BI.snd (BI.unsafeDataAsConstr ctx))
      txInfoFields = BI.snd (BI.unsafeDataAsConstr txInfo)
   in BI.head
        ( BI.tail
            ( BI.tail
                ( BI.tail
                    ( BI.tail
                        (BI.tail (BI.tail txInfoFields))
                    )
                )
            )
        )

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

-- | Production-only traversal that returns the validator result directly.
-- Keep 'withdrawalKeyPresent' as the observable Boolean helper used by tests,
-- while avoiding its BuiltinBool-to-Bool conversion in the compiled script.
{-# INLINABLE requireWithdrawalKey #-}
requireWithdrawalKey :: BuiltinData -> BI.BuiltinList (BI.BuiltinPair BuiltinData BuiltinData) -> BuiltinUnit
requireWithdrawalKey expectedKey entries =
  B.caseList
    (\() -> traceError "reclaim global withdrawal missing")
    ( \entry rest ->
        builtinIf
          (BI.equalsData expectedKey (BI.fst entry))
          BI.unitval
          (requireWithdrawalKey expectedKey rest)
    )
    entries

-- | Minimal production gate. The configured withdrawal key is applied at the
-- deployment boundary. For the audited script-credential deployment, its
-- presence causes the ledger to execute the corresponding global rewarding
-- validator. Purpose, datum, credential-width,
-- proof, destination, and value checks belong to the ledger invocation and the
-- global validator; duplicating them here adds cost without strengthening the
-- composed authorization property.
{-# INLINABLE reclaimBaseValidatorBuiltin #-}
reclaimBaseValidatorBuiltin :: BuiltinData -> BuiltinData -> BI.BuiltinBool
reclaimBaseValidatorBuiltin globalCredentialData ctx =
  withdrawalKeyPresent
    globalCredentialData
    (BI.unsafeDataAsMap (txInfoWdrlFromContextData ctx))

{-# INLINABLE reclaimBaseValidatorDataUntyped #-}
reclaimBaseValidatorDataUntyped :: BuiltinData -> BuiltinData -> BuiltinUnit
reclaimBaseValidatorDataUntyped globalCredentialData ctx =
  requireWithdrawalKey
    globalCredentialData
    (BI.unsafeDataAsMap (txInfoWdrlFromContextData ctx))

-- The deployment/export boundary applies the already encoded credential Data
-- to this code, so withdrawal-key Data is a compiled constant rather than
-- re-encoded for every validation.
reclaimBaseValidatorCode :: CompiledCode (BuiltinData -> BuiltinData -> BuiltinUnit)
reclaimBaseValidatorCode =
  $$(PlutusTx.compile [||reclaimBaseValidatorDataUntyped||])
