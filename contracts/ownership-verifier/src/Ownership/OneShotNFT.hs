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
import qualified PlutusTx.Builtins as B
import qualified PlutusTx.Builtins.Internal as BI
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
  seedSpent && mintedOneOwnToken
  where
    txInfo = scriptContextTxInfo ctx
    seedSpent = spendsTxOutRef seedRef txInfo
    mintedOneOwnToken = mintsExactlyOneOwnToken ctx

-- | The ledger constructs the V3 context, TxInfo, TxInInfo, ScriptInfo, and
-- MintValue encodings. Project only the fields this policy needs instead of
-- decoding the complete V3 ScriptContext. In plutus-ledger-api-1.66.0.0 the
-- context fields are TxInfo, redeemer, and ScriptInfo; TxInfo fields 0 and 4
-- are inputs and mint; a minting ScriptInfo has constructor 0 with the own
-- currency symbol as its sole field; and a TxInInfo has its out-ref at field
-- 0. Compiled-context tests below the typed policy pin these dependencies.
{-# INLINABLE contextFields #-}
contextFields :: BuiltinData -> BI.BuiltinList BuiltinData
contextFields ctx =
  BI.snd (BI.unsafeDataAsConstr ctx)

{-# INLINABLE txInfoFields #-}
txInfoFields :: BI.BuiltinList BuiltinData -> BI.BuiltinList BuiltinData
txInfoFields ctxFields =
  BI.snd (BI.unsafeDataAsConstr (BI.head ctxFields))

{-# INLINABLE spendsTxOutRefData #-}
spendsTxOutRefData :: BuiltinData -> BI.BuiltinList BuiltinData -> Bool
spendsTxOutRefData seedRefData inputs =
  B.caseList
    (\() -> False)
    ( \txIn remainingInputs ->
        let txInFields = BI.snd (BI.unsafeDataAsConstr txIn)
         in if BI.equalsData seedRefData (BI.head txInFields)
              then True
              else spendsTxOutRefData seedRefData remainingInputs
    )
    inputs

{-# INLINABLE singleTokenQuantityIsOne #-}
singleTokenQuantityIsOne :: BI.BuiltinList (BI.BuiltinPair BuiltinData BuiltinData) -> Bool
singleTokenQuantityIsOne tokens =
  B.caseList
    (\() -> False)
    ( \token remainingTokens ->
        B.caseList
          (\() -> BI.equalsInteger (BI.unsafeDataAsI (BI.snd token)) 1)
          (\_ _ -> False)
          remainingTokens
    )
    tokens

{-# INLINABLE ownPolicyMintsSingleToken #-}
ownPolicyMintsSingleToken ::
  BuiltinData ->
  BI.BuiltinList (BI.BuiltinPair BuiltinData BuiltinData) ->
  Bool
ownPolicyMintsSingleToken ownSymbolData mintedPolicies =
  B.caseList
    (\() -> False)
    ( \mintedPolicy remainingPolicies ->
        if BI.equalsData ownSymbolData (BI.fst mintedPolicy)
          then singleTokenQuantityIsOne (BI.unsafeDataAsMap (BI.snd mintedPolicy))
          else ownPolicyMintsSingleToken ownSymbolData remainingPolicies
    )
    mintedPolicies

{-# INLINABLE oneShotNFTPolicyUntyped #-}
oneShotNFTPolicyUntyped :: BuiltinData -> BuiltinData -> BuiltinUnit
oneShotNFTPolicyUntyped seedRefData ctx =
  let ctxFields = contextFields ctx
      infoFields = txInfoFields ctxFields
      inputs = BI.unsafeDataAsList (BI.head infoFields)
      mint = BI.unsafeDataAsMap (BI.head (BI.drop 4 infoFields))
      scriptInfo = BI.head (BI.drop 2 ctxFields)
      ownSymbolData = BI.head (BI.snd (BI.unsafeDataAsConstr scriptInfo))
   in check $
        spendsTxOutRefData seedRefData inputs
          && ownPolicyMintsSingleToken ownSymbolData mint

oneShotNFTPolicyCode :: CompiledCode (BuiltinData -> BuiltinData -> BuiltinUnit)
oneShotNFTPolicyCode =
  $$(PlutusTx.compile [||oneShotNFTPolicyUntyped||])
