{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}

module Ownership.OneShotNFT
  ( mintsExactlyOneOwnToken
  , oneShotNFTPolicy
  , oneShotNFTPolicyUntyped
  , spendsTxOutRef
  ) where

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
import PlutusTx (unsafeFromBuiltinData)
import PlutusTx.Prelude
import qualified PlutusLedgerApi.V3 as V3
import qualified PlutusTx.AssocMap as Map

{-# INLINABLE spendsTxOutRef #-}
spendsTxOutRef :: TxOutRef -> TxInfo -> Bool
spendsTxOutRef seedRef txInfo =
  any
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
