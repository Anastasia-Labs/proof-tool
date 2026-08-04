{-# LANGUAGE DataKinds #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TemplateHaskell #-}

module Ownership.OneShotNFT
  ( mintsExactlyOneOwnToken
  , oneShotNFTPolicyCode
  , oneShotNFTPolicy
  , oneShotNFTPolicyUntyped
  , spendsTxOutRef
  ) where

import PlutusTx (CompiledCode)
import qualified PlutusTx
import PlutusLedgerApi.V3
  ( ScriptContext
  , TxInInfo (txInInfoOutRef)
  , TxInfo
  , TxOutRef
  , scriptContextTxInfo
  , txInfoInputs
  , txInfoMint
  )
import PlutusLedgerApi.V3.Contexts (ownCurrencySymbol)
import PlutusTx.Prelude
import qualified PlutusLedgerApi.V3 as V3
import qualified PlutusTx.AssocMap as Map
import qualified PlutusTx.List as List

{-# INLINABLE spendsTxOutRef #-}
spendsTxOutRef :: TxOutRef -> TxInfo -> Bool
spendsTxOutRef seedRef txInfo =
  List.any
    (\txIn -> txInInfoOutRef txIn == seedRef)
    (txInfoInputs txInfo)

{-# INLINABLE mintsExactlyOneOwnToken #-}
mintsExactlyOneOwnToken :: ScriptContext -> Bool
mintsExactlyOneOwnToken ctx =
  case Map.lookup ownSymbol (V3.mintValueToMap (txInfoMint txInfo)) of
    Just ownTokens ->
      case Map.toList ownTokens of
        [(_, quantity)] -> quantity == 1
        _ -> False
    Nothing -> False
  where
    ownSymbol = ownCurrencySymbol ctx
    txInfo = scriptContextTxInfo ctx

{-# INLINABLE oneShotNFTPolicy #-}
oneShotNFTPolicy :: TxOutRef -> ScriptContext -> Bool
oneShotNFTPolicy seedRef ctx =
  traceIfFalse "seed utxo not spent" seedSpent
    && traceIfFalse "expected exactly one own token" mintedOneOwnToken
  where
    txInfo = scriptContextTxInfo ctx
    seedSpent = spendsTxOutRef seedRef txInfo
    mintedOneOwnToken = mintsExactlyOneOwnToken ctx

{-# INLINABLE oneShotNFTPolicyUntyped #-}
oneShotNFTPolicyUntyped :: TxOutRef -> BuiltinData -> BuiltinUnit
oneShotNFTPolicyUntyped seedRef ctx =
  check $
    oneShotNFTPolicy
      seedRef
      (unsafeFromBuiltinData ctx)

oneShotNFTPolicyCode :: CompiledCode (TxOutRef -> BuiltinData -> BuiltinUnit)
oneShotNFTPolicyCode =
  $$(PlutusTx.compile [||oneShotNFTPolicyUntyped||])
