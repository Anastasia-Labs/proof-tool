{-# LANGUAGE NoImplicitPrelude #-}

-- | The pre-V1 typed ReclaimBase implementation, retained only for
-- differential tests against the production raw-BuiltinData walker.
module ReclaimBaseOracle (reclaimBaseValidatorOracle) where

import Ownership.ReclaimBase (ReclaimBaseDatum (..))
import PlutusLedgerApi.V3
  ( Credential (ScriptCredential)
  , Datum (Datum)
  , ScriptContext
  , ScriptInfo (SpendingScript)
  , scriptContextScriptInfo
  , scriptContextTxInfo
  , txInfoWdrl
  )
import PlutusTx (fromBuiltinData)
import PlutusTx.Prelude
import qualified PlutusTx.AssocMap as Map

validReclaimPaymentKeyHash :: BuiltinByteString -> Bool
validReclaimPaymentKeyHash paymentKeyHash =
  lengthOfByteString paymentKeyHash == 28

parseReclaimBaseDatum :: Datum -> Maybe ReclaimBaseDatum
parseReclaimBaseDatum (Datum rawDatum) =
  fromBuiltinData rawDatum

reclaimBaseDatumFromContext :: ScriptContext -> Maybe ReclaimBaseDatum
reclaimBaseDatumFromContext ctx =
  case scriptContextScriptInfo ctx of
    SpendingScript _ (Just datum) -> parseReclaimBaseDatum datum
    _                            -> Nothing

hasReclaimWithdrawal :: Credential -> ScriptContext -> Bool
hasReclaimWithdrawal globalCredential ctx =
  case Map.lookup globalCredential (txInfoWdrl (scriptContextTxInfo ctx)) of
    Just _  -> True
    Nothing -> False

isScriptCredential :: Credential -> Bool
isScriptCredential credential =
  case credential of
    ScriptCredential _ -> True
    _                  -> False

reclaimBaseValidatorOracle :: Credential -> ScriptContext -> Bool
reclaimBaseValidatorOracle globalCredential ctx =
  isScriptCredential globalCredential
    && datumPresent
    && keyHashLengthOk
    && hasReclaimWithdrawal globalCredential ctx
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
