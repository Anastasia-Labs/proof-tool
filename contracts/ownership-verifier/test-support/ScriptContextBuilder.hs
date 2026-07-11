{-# LANGUAGE BlockArguments #-}
{-# LANGUAGE OverloadedStrings #-}

-- | Vendored and trimmed from the Plutus testlib ScriptContextBuilder pattern.
-- The upstream module was added to plutus-ledger-api-testlib after this
-- package's CHaP snapshot, so this local copy keeps only the V3 builder surface
-- needed by these tests and benchmarks. It constructs evaluator fixtures, not
-- node-submittable transactions: it does not enforce UTxO existence, balance,
-- min-ADA, witnesses, or every ledger encoding invariant. Tests that rely on
-- ledger-normalized `TxOut.value` fields must construct sorted, unique,
-- strictly-positive values deliberately.
module ScriptContextBuilder
  ( InputBuilder (..)
  , TxOutBuilder (..)
  , ScriptContextBuilder (..)
  , buildScriptContext
  , builderPlaceHolderTxOutRef
  , mkAdaValue
  , mkInput
  , mkTxOut
  , pubKeyAddress
  , scriptAddress
  , singleCurrencySymbol
  , withAddress
  , withFee
  , withDatumHash
  , withInlineDatum
  , withInput
  , withMint
  , withMintValue
  , withMintingPolicy
  , withMintingScript
  , withOutRef
  , withOutput
  , withRedeemer
  , withReferenceInput
  , withReferenceScript
  , withReferenceTxIn
  , withRewardingScript
  , withCertifyingScript
  , withSigner
  , withSigners
  , withSpendingScript
  , withTxIn
  , withTxOut
  , withTxOutAddress
  , withTxOutInlineDatum
  , withTxOutReferenceScript
  , withTxOutValue
  , withValidRange
  , withValue
  , withWithdrawal
  ) where

import qualified PlutusLedgerApi.V1.Value as Value
import qualified PlutusLedgerApi.V3 as V3
import PlutusLedgerApi.V3.MintValue (MintValue (UnsafeMintValue))
import qualified PlutusTx.AssocMap as Map

data InputBuilderState = InputBuilderState
  { ibOutRef :: V3.TxOutRef
  , ibAddress :: V3.Address
  , ibValue :: V3.Value
  , ibDatum :: V3.OutputDatum
  , ibReferenceScript :: Maybe V3.ScriptHash
  }

newtype InputBuilder = InputBuilder
  { runInputBuilder :: InputBuilderState -> InputBuilderState
  }

instance Semigroup InputBuilder where
  InputBuilder f <> InputBuilder g = InputBuilder (g . f)

instance Monoid InputBuilder where
  mempty = InputBuilder id

builderPlaceHolderTxOutRef :: V3.TxOutRef
builderPlaceHolderTxOutRef =
  V3.TxOutRef
    { V3.txOutRefId = V3.TxId "deadbeef"
    , V3.txOutRefIdx = 0
    }

pubKeyAddress :: V3.PubKeyHash -> V3.Address
pubKeyAddress paymentKeyHash =
  V3.Address (V3.PubKeyCredential paymentKeyHash) Nothing

scriptAddress :: V3.ScriptHash -> V3.Address
scriptAddress scriptHash =
  V3.Address (V3.ScriptCredential scriptHash) Nothing

defaultInputBuilderState :: InputBuilderState
defaultInputBuilderState =
  InputBuilderState
    { ibOutRef = builderPlaceHolderTxOutRef
    , ibAddress = pubKeyAddress (V3.PubKeyHash "deadbeef")
    , ibValue = mempty
    , ibDatum = V3.NoOutputDatum
    , ibReferenceScript = Nothing
    }

withOutRef :: V3.TxOutRef -> InputBuilder
withOutRef outRef =
  InputBuilder \st -> st {ibOutRef = outRef}

withAddress :: V3.Address -> InputBuilder
withAddress address =
  InputBuilder \st -> st {ibAddress = address}

withValue :: V3.Value -> InputBuilder
withValue value =
  InputBuilder \st -> st {ibValue = value}

withInlineDatum :: V3.BuiltinData -> InputBuilder
withInlineDatum datum =
  InputBuilder \st -> st {ibDatum = V3.OutputDatum (V3.Datum datum)}

withDatumHash :: V3.DatumHash -> InputBuilder
withDatumHash datumHash =
  InputBuilder \st -> st {ibDatum = V3.OutputDatumHash datumHash}

withReferenceScript :: V3.ScriptHash -> InputBuilder
withReferenceScript scriptHash =
  InputBuilder \st -> st {ibReferenceScript = Just scriptHash}

mkInput :: InputBuilder -> V3.TxInInfo
mkInput (InputBuilder modify) =
  V3.TxInInfo
    { V3.txInInfoOutRef = ibOutRef finalState
    , V3.txInInfoResolved =
        V3.TxOut
          { V3.txOutAddress = ibAddress finalState
          , V3.txOutValue = ibValue finalState
          , V3.txOutDatum = ibDatum finalState
          , V3.txOutReferenceScript = ibReferenceScript finalState
          }
    }
  where
    finalState = modify defaultInputBuilderState

data TxOutBuilderState = TxOutBuilderState
  { tobAddress :: V3.Address
  , tobValue :: V3.Value
  , tobDatum :: V3.OutputDatum
  , tobReferenceScript :: Maybe V3.ScriptHash
  }

newtype TxOutBuilder = TxOutBuilder
  { runTxOutBuilder :: TxOutBuilderState -> TxOutBuilderState
  }

instance Semigroup TxOutBuilder where
  TxOutBuilder f <> TxOutBuilder g = TxOutBuilder (g . f)

instance Monoid TxOutBuilder where
  mempty = TxOutBuilder id

defaultTxOutBuilderState :: TxOutBuilderState
defaultTxOutBuilderState =
  TxOutBuilderState
    { tobAddress = pubKeyAddress (V3.PubKeyHash "deadbeef")
    , tobValue = mempty
    , tobDatum = V3.NoOutputDatum
    , tobReferenceScript = Nothing
    }

withTxOutAddress :: V3.Address -> TxOutBuilder
withTxOutAddress address =
  TxOutBuilder \st -> st {tobAddress = address}

withTxOutValue :: V3.Value -> TxOutBuilder
withTxOutValue value =
  TxOutBuilder \st -> st {tobValue = tobValue st <> value}

withTxOutInlineDatum :: V3.BuiltinData -> TxOutBuilder
withTxOutInlineDatum datum =
  TxOutBuilder \st -> st {tobDatum = V3.OutputDatum (V3.Datum datum)}

withTxOutReferenceScript :: V3.ScriptHash -> TxOutBuilder
withTxOutReferenceScript scriptHash =
  TxOutBuilder \st -> st {tobReferenceScript = Just scriptHash}

mkTxOut :: TxOutBuilder -> V3.TxOut
mkTxOut (TxOutBuilder modify) =
  V3.TxOut
    { V3.txOutAddress = tobAddress finalState
    , V3.txOutValue = tobValue finalState
    , V3.txOutDatum = tobDatum finalState
    , V3.txOutReferenceScript = tobReferenceScript finalState
    }
  where
    finalState = modify defaultTxOutBuilderState

data ScriptContextBuilderState = ScriptContextBuilderState
  { scbInputs :: [V3.TxInInfo]
  , scbReferenceInputs :: [V3.TxInInfo]
  , scbOutputs :: [V3.TxOut]
  , scbFee :: V3.Lovelace
  , scbMint :: V3.Value
  , scbTxCerts :: [V3.TxCert]
  , scbWithdrawals :: [(V3.Credential, V3.Lovelace)]
  , scbValidRange :: V3.POSIXTimeRange
  , scbSignatories :: [V3.PubKeyHash]
  , scbRedeemers :: [(V3.ScriptPurpose, V3.Redeemer)]
  , scbTxId :: V3.TxId
  , scbScriptInfo :: V3.ScriptInfo
  , scbRedeemer :: V3.BuiltinData
  }

newtype ScriptContextBuilder = ScriptContextBuilder
  { runScriptContextBuilder :: ScriptContextBuilderState -> ScriptContextBuilderState
  }

instance Semigroup ScriptContextBuilder where
  ScriptContextBuilder f <> ScriptContextBuilder g = ScriptContextBuilder (g . f)

instance Monoid ScriptContextBuilder where
  mempty = ScriptContextBuilder id

defaultScriptContextBuilderState :: ScriptContextBuilderState
defaultScriptContextBuilderState =
  ScriptContextBuilderState
    { scbInputs = []
    , scbReferenceInputs = []
    , scbOutputs = []
    , scbFee = 0
    , scbMint = mempty
    , scbTxCerts = []
    , scbWithdrawals = []
    , scbValidRange =
        V3.Interval
          { V3.ivFrom = V3.LowerBound V3.NegInf True
          , V3.ivTo = V3.UpperBound V3.PosInf True
          }
    , scbSignatories = []
    , scbRedeemers = []
    , scbTxId = V3.TxId ""
    , scbScriptInfo = V3.MintingScript (V3.CurrencySymbol "deadbeef")
    , scbRedeemer = V3.toBuiltinData ()
    }

withFee :: V3.Lovelace -> ScriptContextBuilder
withFee fee =
  ScriptContextBuilder \st -> st {scbFee = fee}

withValidRange :: V3.POSIXTimeRange -> ScriptContextBuilder
withValidRange validRange =
  ScriptContextBuilder \st -> st {scbValidRange = validRange}

withSigner :: V3.PubKeyHash -> ScriptContextBuilder
withSigner signer =
  ScriptContextBuilder \st -> st {scbSignatories = scbSignatories st <> [signer]}

withSigners :: [V3.PubKeyHash] -> ScriptContextBuilder
withSigners signers =
  ScriptContextBuilder \st -> st {scbSignatories = scbSignatories st <> signers}

withTxIn :: V3.TxInInfo -> ScriptContextBuilder
withTxIn txIn =
  ScriptContextBuilder \st -> st {scbInputs = scbInputs st <> [txIn]}

withInput :: InputBuilder -> ScriptContextBuilder
withInput inputBuilder =
  withTxIn (mkInput inputBuilder)

withReferenceTxIn :: V3.TxInInfo -> ScriptContextBuilder
withReferenceTxIn txIn =
  ScriptContextBuilder \st -> st {scbReferenceInputs = scbReferenceInputs st <> [txIn]}

withReferenceInput :: InputBuilder -> ScriptContextBuilder
withReferenceInput inputBuilder =
  withReferenceTxIn (mkInput inputBuilder)

withTxOut :: V3.TxOut -> ScriptContextBuilder
withTxOut txOut =
  ScriptContextBuilder \st -> st {scbOutputs = scbOutputs st <> [txOut]}

withOutput :: TxOutBuilder -> ScriptContextBuilder
withOutput txOutBuilder =
  withTxOut (mkTxOut txOutBuilder)

withWithdrawal :: V3.Credential -> V3.Lovelace -> ScriptContextBuilder
withWithdrawal credential amount =
  ScriptContextBuilder \st ->
    st {scbWithdrawals = scbWithdrawals st <> [(credential, amount)]}

withRedeemer :: V3.BuiltinData -> ScriptContextBuilder
withRedeemer redeemer =
  ScriptContextBuilder \st -> st {scbRedeemer = redeemer}

withMint :: V3.Value -> V3.BuiltinData -> ScriptContextBuilder
withMint value redeemer =
  withMintValue value
    <> ScriptContextBuilder \st ->
      st {scbRedeemers = scbRedeemers st <> [(V3.Minting (singleCurrencySymbol value), V3.Redeemer redeemer)]}

withMintValue :: V3.Value -> ScriptContextBuilder
withMintValue value =
  ScriptContextBuilder \st ->
    st {scbMint = scbMint st <> value}

withMintingPolicy :: V3.CurrencySymbol -> V3.BuiltinData -> ScriptContextBuilder
withMintingPolicy currencySymbol redeemer =
  ScriptContextBuilder \st ->
    st
      { scbRedeemers = scbRedeemers st <> [(V3.Minting currencySymbol, V3.Redeemer redeemer)]
      , scbScriptInfo = V3.MintingScript currencySymbol
      , scbRedeemer = redeemer
      }

withMintingScript :: V3.Value -> V3.BuiltinData -> ScriptContextBuilder
withMintingScript value redeemer =
  withMintValue value
    <> withMintingPolicy (singleCurrencySymbol value) redeemer

withSpendingScript :: V3.BuiltinData -> InputBuilder -> ScriptContextBuilder
withSpendingScript redeemer inputBuilder =
  ScriptContextBuilder \st ->
    st
      { scbInputs = scbInputs st <> [scriptInput]
      , scbRedeemers = scbRedeemers st <> [(V3.Spending outRef, V3.Redeemer redeemer)]
      , scbRedeemer = redeemer
      , scbScriptInfo = V3.SpendingScript outRef datum
      }
  where
    scriptInput = mkInput inputBuilder
    outRef = V3.txInInfoOutRef scriptInput
    datum =
      case V3.txOutDatum (V3.txInInfoResolved scriptInput) of
        V3.OutputDatum (V3.Datum rawDatum) -> Just (V3.Datum rawDatum)
        _ -> Nothing

withRewardingScript :: V3.BuiltinData -> V3.Credential -> V3.Lovelace -> ScriptContextBuilder
withRewardingScript redeemer credential amount =
  ScriptContextBuilder \st ->
    st
      { scbWithdrawals = scbWithdrawals st <> [(credential, amount)]
      , scbRedeemers = scbRedeemers st <> [(V3.Rewarding credential, V3.Redeemer redeemer)]
      , scbRedeemer = redeemer
      , scbScriptInfo = V3.RewardingScript credential
      }

withCertifyingScript :: V3.BuiltinData -> V3.TxCert -> ScriptContextBuilder
withCertifyingScript redeemer certificate =
  ScriptContextBuilder \st ->
    st
      { scbTxCerts = scbTxCerts st <> [certificate]
      , scbRedeemers = scbRedeemers st <> [(V3.Certifying 0 certificate, V3.Redeemer redeemer)]
      , scbRedeemer = redeemer
      , scbScriptInfo = V3.CertifyingScript 0 certificate
      }

buildScriptContext :: ScriptContextBuilder -> V3.ScriptContext
buildScriptContext (ScriptContextBuilder modify) =
  V3.ScriptContext
    { V3.scriptContextTxInfo =
        V3.TxInfo
          { V3.txInfoInputs = scbInputs finalState
          , V3.txInfoReferenceInputs = scbReferenceInputs finalState
          , V3.txInfoOutputs = scbOutputs finalState
          , V3.txInfoFee = scbFee finalState
          , V3.txInfoMint = UnsafeMintValue (Value.getValue (scbMint finalState))
          , V3.txInfoTxCerts = scbTxCerts finalState
          , V3.txInfoWdrl = Map.unsafeFromList (scbWithdrawals finalState)
          , V3.txInfoValidRange = scbValidRange finalState
          , V3.txInfoSignatories = scbSignatories finalState
          , V3.txInfoRedeemers = Map.unsafeFromList (scbRedeemers finalState)
          , V3.txInfoData = Map.empty
          , V3.txInfoId = scbTxId finalState
          , V3.txInfoVotes = Map.empty
          , V3.txInfoProposalProcedures = []
          , V3.txInfoCurrentTreasuryAmount = Nothing
          , V3.txInfoTreasuryDonation = Nothing
          }
    , V3.scriptContextRedeemer = V3.Redeemer (scbRedeemer finalState)
    , V3.scriptContextScriptInfo = scbScriptInfo finalState
    }
  where
    finalState = modify defaultScriptContextBuilderState

mkAdaValue :: Integer -> V3.Value
mkAdaValue amount =
  V3.singleton V3.adaSymbol V3.adaToken amount

singleCurrencySymbol :: V3.Value -> V3.CurrencySymbol
singleCurrencySymbol value =
  case Map.keys (Value.getValue value) of
    [currencySymbol] -> currencySymbol
    keys ->
      error $
        "singleCurrencySymbol: expected exactly one currency symbol, got "
          <> show (length keys)
