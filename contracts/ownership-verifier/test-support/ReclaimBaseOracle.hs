{-# LANGUAGE NoImplicitPrelude #-}

-- | Typed oracle for the production ReclaimBase withdrawal-presence gate.
module ReclaimBaseOracle (reclaimBaseValidatorOracle) where

import PlutusLedgerApi.V3
  ( Credential
  , ScriptContext
  , scriptContextTxInfo
  , txInfoWdrl
  )
import PlutusTx.Prelude
import qualified PlutusTx.AssocMap as Map

hasReclaimWithdrawal :: Credential -> ScriptContext -> Bool
hasReclaimWithdrawal globalCredential ctx =
  case Map.lookup globalCredential (txInfoWdrl (scriptContextTxInfo ctx)) of
    Just _  -> True
    Nothing -> False

reclaimBaseValidatorOracle :: Credential -> ScriptContext -> Bool
reclaimBaseValidatorOracle = hasReclaimWithdrawal
