{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Data.Aeson (Value, encode, object, (.=))
import qualified Data.ByteString as BS
import qualified Data.ByteString.Lazy as BL
import qualified Data.ByteString.Short as SBS
import Data.Char (digitToInt, intToDigit, isHexDigit)
import Data.Word (Word8)
import System.Environment (getArgs)
import System.Exit (die)

import qualified PlutusCore as PLC
import qualified PlutusCore.MkPlc as MkPlc
import PlutusCore.Evaluation.Machine.ExBudget
  ( ExBudget (..)
  , ExRestrictingBudget (..)
  )
import PlutusCore.Evaluation.Machine.ExBudgetingDefaults (defaultCekParametersForTesting)
import PlutusCore.Evaluation.Machine.ExMemory (ExCPU (..), ExMemory (..))
import PlutusLedgerApi.Common (ScriptNamedDeBruijn (..), deserialisedScript)
import qualified PlutusLedgerApi.V3 as V3
import PlutusTx (CompiledCode)
import qualified PlutusTx.Builtins as B
import qualified PlutusTx.Builtins.Internal as BI
import PlutusTx.Builtins (BuiltinByteString, BuiltinData)
import qualified UntypedPlutusCore as UPLC
import qualified UntypedPlutusCore.Evaluation.Machine.Cek as Cek

import FormalHelpers
  ( findReferenceInputAtEqualsCode
  , hasExactlyOneParamTokenCode
  , ownershipDestinationPublicInputDigestEqualsCode
  , reclaimBatchTranscriptV2EqualsCode
  , valueCoversDataCode
  )
import Ownership.OneShotNFT (oneShotNFTPolicy, oneShotNFTPolicyCode)
import Ownership.ReclaimBase
  ( ReclaimBaseDatum (..)
  , reclaimBaseValidatorCode
  )
import Ownership.ReclaimGlobalV2
  ( reclaimGlobalParamsData
  , reclaimGlobalRedeemerDataV2
  , reclaimGlobalValidatorV2
  )
import Ownership.Verify (ownershipDestinationPublicInputDigest)
import ReclaimBaseOracle (reclaimBaseValidatorOracle)
import ScriptContextBuilder

main :: IO ()
main = do
  args <- getArgs
  case args of
    [ jsonOutputPath
      , leanOutputPath
      , verifierKeyPath
      , proofPath
      , activeOneShotPath
      , activeReclaimBasePath
      , activeReclaimGlobalV2Path
      , candidateReclaimBasePath
      , candidateReclaimGlobalV2Path
      , candidateReclaimBaseHashHex
      , candidateReclaimGlobalV2HashHex
      , parameterizedReclaimBasePath
      , parameterizedOneShotPath
      , findReferenceInputPath
      , hasParamTokenPath
      , valueCoversPath
      , statementDigestPath
      , batchTranscriptPath
      ] -> do
      verifierKey <- builtinFromHex <$> readFile verifierKeyPath
      proof <- builtinFromHex <$> readFile proofPath
      activeOneShotScript <- scriptFromCborHex <$> readFile activeOneShotPath
      activeReclaimBaseScript <- scriptFromCborHex <$> readFile activeReclaimBasePath
      activeReclaimGlobalV2Script <- scriptFromCborHex <$> readFile activeReclaimGlobalV2Path
      candidateReclaimBaseScript <- scriptFromCborHex <$> readFile candidateReclaimBasePath
      candidateReclaimGlobalV2Script <- scriptFromCborHex <$> readFile candidateReclaimGlobalV2Path
      BL.writeFile jsonOutputPath $ encode $
        document
          verifierKey
          proof
          activeOneShotScript
          activeReclaimBaseScript
          activeReclaimGlobalV2Script
          candidateReclaimBaseScript
          candidateReclaimGlobalV2Script
          candidateReclaimBaseHashHex
          candidateReclaimGlobalV2HashHex
      writeFile leanOutputPath
        (renderLeanModule proof candidateReclaimBaseHashHex candidateReclaimGlobalV2HashHex)
      writeFile parameterizedReclaimBasePath
        (shortByteStringHex (V3.serialiseCompiledCode reclaimBaseValidatorCode) <> "\n")
      writeFile parameterizedOneShotPath
        (shortByteStringHex (V3.serialiseCompiledCode oneShotNFTPolicyCode) <> "\n")
      writeCompiledCode findReferenceInputPath findReferenceInputAtEqualsCode
      writeCompiledCode hasParamTokenPath hasExactlyOneParamTokenCode
      writeCompiledCode valueCoversPath valueCoversDataCode
      writeCompiledCode statementDigestPath ownershipDestinationPublicInputDigestEqualsCode
      writeCompiledCode batchTranscriptPath reclaimBatchTranscriptV2EqualsCode
    _ -> die "usage: generate-context-goldens <output-json> <output-lean> <verifier-key-hex> <proof-hex> <active-one-shot-cbor-hex> <active-reclaim-base-cbor-hex> <active-reclaim-global-v2-cbor-hex> <candidate-reclaim-base-cbor-hex> <candidate-reclaim-global-v2-cbor-hex> <candidate-reclaim-base-hash-hex> <candidate-reclaim-global-v2-hash-hex> <parameterized-reclaim-base-cbor-hex> <parameterized-one-shot-cbor-hex> <find-reference-input-cbor-hex> <has-param-token-cbor-hex> <value-covers-cbor-hex> <statement-digest-cbor-hex> <batch-transcript-cbor-hex>"

writeCompiledCode :: FilePath -> CompiledCode a -> IO ()
writeCompiledCode path code =
  writeFile path (shortByteStringHex (V3.serialiseCompiledCode code) <> "\n")

document :: BuiltinByteString -> BuiltinByteString -> Script -> Script -> Script -> Script -> Script -> String -> String -> Value
document verifierKey proof activeOneShotScript activeReclaimBaseScript activeReclaimGlobalV2Script candidateReclaimBaseScript candidateReclaimGlobalV2Script candidateReclaimBaseHashHex candidateReclaimGlobalV2HashHex =
  let candidateReclaimBaseHash = V3.ScriptHash (builtinFromHex candidateReclaimBaseHashHex)
      candidateReclaimGlobalV2Hash = V3.ScriptHash (builtinFromHex candidateReclaimGlobalV2HashHex)
      candidateReclaimGlobalV2Credential = V3.ScriptCredential candidateReclaimGlobalV2Hash
      candidateBaseContext = reclaimBaseContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential
      candidateBaseMissingContext = reclaimBaseMissingWithdrawalContextFor candidateReclaimBaseHash
      candidateBaseShortContext = reclaimBaseShortDatumContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential
      candidateBaseNoncanonicalContext = reclaimBaseNoncanonicalDatumContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential
      candidateGlobalSuccessContext = reclaimGlobalSuccessContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential proof
      candidateGlobalSubstitutedContext = reclaimGlobalSubstitutedDigestContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential proof
      candidateGlobalNoncanonicalParamContext = reclaimGlobalNoncanonicalParamDatumContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential proof
      candidateGlobalNoncanonicalBaseContext = reclaimGlobalNoncanonicalBaseDatumContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential proof
      candidateGlobalMalformedContext = reclaimGlobalMalformedRedeemerContextFor candidateReclaimGlobalV2Credential
   in
  object
    [ "schema" .= ("proof-tool-haskell-lean-context-goldens-v1" :: String)
    , "encoding" .= ("PlutusTx.Builtins.serialiseData(toBuiltinData value), lowercase CBOR hex" :: String)
    , "source_builder" .= ("contracts/ownership-verifier/test-support/ScriptContextBuilder.hs" :: String)
    , "fixtures"
        .= [ fixture
              "active-one-shot-ledger-shape"
              "minting"
              activePolicyHex
              oneShotContext
              (Just (oneShotNFTPolicy activeSeedRef oneShotContext))
              (evaluateCompiledScript activeOneShotScript oneShotContext)
           , fixture
              "active-reclaim-base-ledger-shape"
              "spending"
              activeBaseHashHex
              reclaimBaseContext
              Nothing
              (evaluateCompiledScript activeReclaimBaseScript reclaimBaseContext)
           , fixture
              "active-reclaim-base-missing-withdrawal"
              "spending"
              activeBaseHashHex
              reclaimBaseMissingWithdrawalContext
              Nothing
              (evaluateCompiledScript activeReclaimBaseScript reclaimBaseMissingWithdrawalContext)
           , fixture
              "active-reclaim-base-short-datum"
              "spending"
              activeBaseHashHex
              reclaimBaseShortDatumContext
              Nothing
              (evaluateCompiledScript activeReclaimBaseScript reclaimBaseShortDatumContext)
           , fixture
              "active-reclaim-base-noncanonical-datum-tag"
              "spending"
              activeBaseHashHex
              reclaimBaseNoncanonicalDatumContext
              Nothing
              (evaluateCompiledScript activeReclaimBaseScript reclaimBaseNoncanonicalDatumContext)
           , fixture
              "active-reclaim-global-v2-success"
              "rewarding"
              activeGlobalHashHex
              (reclaimGlobalSuccessContext proof)
              (Just (reclaimGlobalDecision verifierKey (reclaimGlobalSuccessContext proof)))
              (evaluateCompiledScript activeReclaimGlobalV2Script (reclaimGlobalSuccessContext proof))
           , fixture
              "active-reclaim-global-v2-substituted-digest"
              "rewarding"
              activeGlobalHashHex
              (reclaimGlobalSubstitutedDigestContext proof)
              Nothing
              (evaluateCompiledScript activeReclaimGlobalV2Script (reclaimGlobalSubstitutedDigestContext proof))
           , fixture
              "active-reclaim-global-v2-noncanonical-param-datum-tag"
              "rewarding"
              activeGlobalHashHex
              (reclaimGlobalNoncanonicalParamDatumContext proof)
              Nothing
              (evaluateCompiledScript activeReclaimGlobalV2Script (reclaimGlobalNoncanonicalParamDatumContext proof))
           , fixture
              "active-reclaim-global-v2-noncanonical-base-datum-tag"
              "rewarding"
              activeGlobalHashHex
              (reclaimGlobalNoncanonicalBaseDatumContext proof)
              Nothing
              (evaluateCompiledScript activeReclaimGlobalV2Script (reclaimGlobalNoncanonicalBaseDatumContext proof))
           , fixture
              "active-reclaim-global-v2-malformed-redeemer"
              "rewarding"
              activeGlobalHashHex
              reclaimGlobalMalformedRedeemerContext
              Nothing
              (evaluateCompiledScript activeReclaimGlobalV2Script reclaimGlobalMalformedRedeemerContext)
           , fixture
              "candidate-reclaim-base-ledger-shape"
              "spending"
              candidateReclaimBaseHashHex
              candidateBaseContext
              (Just (reclaimBaseValidatorOracle candidateReclaimGlobalV2Credential candidateBaseContext))
              (evaluateCompiledScript candidateReclaimBaseScript candidateBaseContext)
           , fixture
              "candidate-reclaim-base-missing-withdrawal"
              "spending"
              candidateReclaimBaseHashHex
              candidateBaseMissingContext
              (Just (reclaimBaseValidatorOracle candidateReclaimGlobalV2Credential candidateBaseMissingContext))
              (evaluateCompiledScript candidateReclaimBaseScript candidateBaseMissingContext)
           , fixture
              "candidate-reclaim-base-short-datum"
              "spending"
              candidateReclaimBaseHashHex
              candidateBaseShortContext
              (Just (reclaimBaseValidatorOracle candidateReclaimGlobalV2Credential candidateBaseShortContext))
              (evaluateCompiledScript candidateReclaimBaseScript candidateBaseShortContext)
           , fixture
              "candidate-reclaim-base-noncanonical-datum-tag"
              "spending"
              candidateReclaimBaseHashHex
              candidateBaseNoncanonicalContext
              (Just (reclaimBaseValidatorOracle candidateReclaimGlobalV2Credential candidateBaseNoncanonicalContext))
              (evaluateCompiledScript candidateReclaimBaseScript candidateBaseNoncanonicalContext)
           , fixture
              "candidate-reclaim-global-v2-success"
              "rewarding"
              candidateReclaimGlobalV2HashHex
              candidateGlobalSuccessContext
              (Just (reclaimGlobalDecision verifierKey candidateGlobalSuccessContext))
              (evaluateCompiledScript candidateReclaimGlobalV2Script candidateGlobalSuccessContext)
           , fixture
              "candidate-reclaim-global-v2-substituted-digest"
              "rewarding"
              candidateReclaimGlobalV2HashHex
              candidateGlobalSubstitutedContext
              Nothing
              (evaluateCompiledScript candidateReclaimGlobalV2Script candidateGlobalSubstitutedContext)
           , fixture
              "candidate-reclaim-global-v2-noncanonical-param-datum-tag"
              "rewarding"
              candidateReclaimGlobalV2HashHex
              candidateGlobalNoncanonicalParamContext
              Nothing
              (evaluateCompiledScript candidateReclaimGlobalV2Script candidateGlobalNoncanonicalParamContext)
           , fixture
              "candidate-reclaim-global-v2-noncanonical-base-datum-tag"
              "rewarding"
              candidateReclaimGlobalV2HashHex
              candidateGlobalNoncanonicalBaseContext
              Nothing
              (evaluateCompiledScript candidateReclaimGlobalV2Script candidateGlobalNoncanonicalBaseContext)
           , fixture
              "candidate-reclaim-global-v2-malformed-redeemer"
              "rewarding"
              candidateReclaimGlobalV2HashHex
              candidateGlobalMalformedContext
              Nothing
              (evaluateCompiledScript candidateReclaimGlobalV2Script candidateGlobalMalformedContext)
           ]
    ]

fixture :: String -> String -> String -> V3.ScriptContext -> Maybe Bool -> Bool -> Value
fixture fixtureName purpose artifactIdentity ctx haskellDecision compiledDecision =
  object
    [ "name" .= fixtureName
    , "purpose" .= purpose
    , "artifact_identity" .= artifactIdentity
    , "data_cbor_hex" .= builtinDataHex (V3.toBuiltinData ctx)
    , "haskell_typed_decision" .= haskellDecision
    , "haskell_compiled_decision" .= compiledDecision
    ]

renderLeanModule :: BuiltinByteString -> String -> String -> String
renderLeanModule proof candidateReclaimBaseHashHex candidateReclaimGlobalV2HashHex =
  unlines
    [ "/- This file is deterministically generated by formal/haskell/src/Main.hs. -/"
    , "namespace ProofToolFormal.ContextGoldens.Generated"
    , ""
    , "def oneShotDataCborHex : String := \"" <> contextHex oneShotContext <> "\""
    , ""
    , "def reclaimBaseDataCborHex : String := \"" <> contextHex reclaimBaseContext <> "\""
    , ""
    , "def reclaimBaseMissingWithdrawalDataCborHex : String := \"" <> contextHex reclaimBaseMissingWithdrawalContext <> "\""
    , ""
    , "def reclaimBaseShortDatumDataCborHex : String := \"" <> contextHex reclaimBaseShortDatumContext <> "\""
    , ""
    , "def reclaimBaseNoncanonicalDatumDataCborHex : String := \"" <> contextHex reclaimBaseNoncanonicalDatumContext <> "\""
    , ""
    , "def reclaimGlobalV2SuccessDataCborHex : String := \"" <> contextHex (reclaimGlobalSuccessContext proof) <> "\""
    , ""
    , "def reclaimGlobalV2SubstitutedDigestDataCborHex : String := \"" <> contextHex (reclaimGlobalSubstitutedDigestContext proof) <> "\""
    , ""
    , "def reclaimGlobalV2NoncanonicalParamDatumDataCborHex : String := \"" <> contextHex (reclaimGlobalNoncanonicalParamDatumContext proof) <> "\""
    , ""
    , "def reclaimGlobalV2NoncanonicalBaseDatumDataCborHex : String := \"" <> contextHex (reclaimGlobalNoncanonicalBaseDatumContext proof) <> "\""
    , ""
    , "def reclaimGlobalV2MalformedRedeemerDataCborHex : String := \"" <> contextHex reclaimGlobalMalformedRedeemerContext <> "\""
    , ""
    , "def candidateReclaimBaseDataCborHex : String := \"" <> contextHex candidateBaseContext <> "\""
    , ""
    , "def candidateReclaimBaseMissingWithdrawalDataCborHex : String := \"" <> contextHex candidateBaseMissingContext <> "\""
    , ""
    , "def candidateReclaimBaseShortDatumDataCborHex : String := \"" <> contextHex candidateBaseShortContext <> "\""
    , ""
    , "def candidateReclaimBaseNoncanonicalDatumDataCborHex : String := \"" <> contextHex candidateBaseNoncanonicalContext <> "\""
    , ""
    , "def candidateReclaimGlobalV2SuccessDataCborHex : String := \"" <> contextHex candidateGlobalSuccessContext <> "\""
    , ""
    , "def candidateReclaimGlobalV2SubstitutedDigestDataCborHex : String := \"" <> contextHex candidateGlobalSubstitutedContext <> "\""
    , ""
    , "def candidateReclaimGlobalV2NoncanonicalParamDatumDataCborHex : String := \"" <> contextHex candidateGlobalNoncanonicalParamContext <> "\""
    , ""
    , "def candidateReclaimGlobalV2NoncanonicalBaseDatumDataCborHex : String := \"" <> contextHex candidateGlobalNoncanonicalBaseContext <> "\""
    , ""
    , "def candidateReclaimGlobalV2MalformedRedeemerDataCborHex : String := \"" <> contextHex candidateGlobalMalformedContext <> "\""
    , ""
    , "end ProofToolFormal.ContextGoldens.Generated"
    ]
  where
    contextHex = builtinDataHex . V3.toBuiltinData
    candidateReclaimBaseHash = V3.ScriptHash (builtinFromHex candidateReclaimBaseHashHex)
    candidateReclaimGlobalV2Hash = V3.ScriptHash (builtinFromHex candidateReclaimGlobalV2HashHex)
    candidateReclaimGlobalV2Credential = V3.ScriptCredential candidateReclaimGlobalV2Hash
    candidateBaseContext = reclaimBaseContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential
    candidateBaseMissingContext = reclaimBaseMissingWithdrawalContextFor candidateReclaimBaseHash
    candidateBaseShortContext = reclaimBaseShortDatumContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential
    candidateBaseNoncanonicalContext = reclaimBaseNoncanonicalDatumContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential
    candidateGlobalSuccessContext = reclaimGlobalSuccessContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential proof
    candidateGlobalSubstitutedContext = reclaimGlobalSubstitutedDigestContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential proof
    candidateGlobalNoncanonicalParamContext = reclaimGlobalNoncanonicalParamDatumContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential proof
    candidateGlobalNoncanonicalBaseContext = reclaimGlobalNoncanonicalBaseDatumContextFor candidateReclaimBaseHash candidateReclaimGlobalV2Credential proof
    candidateGlobalMalformedContext = reclaimGlobalMalformedRedeemerContextFor candidateReclaimGlobalV2Credential

activePolicyHex, activeParamsHolderHashHex, activeBaseHashHex, activeGlobalHashHex :: String
activePolicyHex = "d6777b8c3be1c6c0c9baba52a880c1980a662c16ffc0885ecaa03119"
activeParamsHolderHashHex = "ebb18a12777410738fdeaa77ec0fd582685d677b6b34de9a6e3b6d7e"
activeBaseHashHex = "744cc4718e8149201c7e9cb3d3a550f34cb18dfc8076a33172d9354d"
activeGlobalHashHex = "a4da74e7cb6ea4f4e60456a0a6eabf0ccf83464ebe55664390ef39f8"

activePolicy :: V3.CurrencySymbol
activePolicy = V3.CurrencySymbol (builtinFromHex activePolicyHex)

activeParamsHolderHash, activeBaseHash, activeGlobalHash :: V3.ScriptHash
activeParamsHolderHash = V3.ScriptHash (builtinFromHex activeParamsHolderHashHex)
activeBaseHash = V3.ScriptHash (builtinFromHex activeBaseHashHex)
activeGlobalHash = V3.ScriptHash (builtinFromHex activeGlobalHashHex)

activeGlobalCredential :: V3.Credential
activeGlobalCredential = V3.ScriptCredential activeGlobalHash

activeSeedRef :: V3.TxOutRef
activeSeedRef =
  V3.TxOutRef
    { V3.txOutRefId =
        V3.TxId
          (builtinFromHex "a1fa4102a2db270b33a5c4d9f836f61bbfcd0847575376d5f1306429fef351db")
    , V3.txOutRefIdx = 3
    }

ordinaryInputRef :: V3.TxOutRef
ordinaryInputRef =
  V3.TxOutRef
    { V3.txOutRefId =
        V3.TxId
          (builtinFromHex "b1d0677b0b29281b422c0cd2fb6614d615d773e908d02eed20b6f98c772a0b8b")
    , V3.txOutRefIdx = 0
    }

paramsReferenceRef :: V3.TxOutRef
paramsReferenceRef =
  V3.TxOutRef
    { V3.txOutRefId =
        V3.TxId
          (builtinFromHex "c1d0677b0b29281b422c0cd2fb6614d615d773e908d02eed20b6f98c772a0b8b")
    , V3.txOutRefIdx = 0
    }

feeInputRef :: V3.TxOutRef
feeInputRef =
  V3.TxOutRef
    { V3.txOutRefId =
        V3.TxId
          (builtinFromHex "d1d0677b0b29281b422c0cd2fb6614d615d773e908d02eed20b6f98c772a0b8b")
    , V3.txOutRefIdx = 0
    }

goldenPaymentKeyHash :: BuiltinByteString
goldenPaymentKeyHash =
  builtinFromHex "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4"

destinationPaymentKeyHash :: V3.PubKeyHash
destinationPaymentKeyHash =
  V3.PubKeyHash
    (builtinFromHex "0038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da111")

paramsTokenName :: V3.TokenName
paramsTokenName = V3.TokenName "RECLAIMPARAMS"

inputAda, outputAda, feeAda :: Integer
inputAda = 3000000
outputAda = 2000000
feeAda = 1000000

ordinaryInput :: V3.TxInInfo
ordinaryInput =
  mkInput $
    withOutRef ordinaryInputRef
      <> withAddress (pubKeyAddress destinationPaymentKeyHash)
      <> withValue (mkAdaValue inputAda)

destinationOutput :: V3.TxOut
destinationOutput =
  mkTxOut $
    withTxOutAddress (pubKeyAddress destinationPaymentKeyHash)
      <> withTxOutValue (mkAdaValue outputAda)

oneShotContext :: V3.ScriptContext
oneShotContext =
  buildScriptContext $
    withInput
      ( withOutRef activeSeedRef
          <> withAddress (pubKeyAddress destinationPaymentKeyHash)
          <> withValue (mkAdaValue inputAda)
      )
      <> withOutput
        ( withTxOutAddress (pubKeyAddress destinationPaymentKeyHash)
            <> withTxOutValue (mkAdaValue outputAda)
            <> withTxOutValue mintedParamsValue
        )
      <> withMintValue mintedParamsValue
      <> withMintingPolicy activePolicy (V3.toBuiltinData ())
      <> withFee (V3.Lovelace feeAda)
  where
    mintedParamsValue = V3.singleton activePolicy paramsTokenName 1

reclaimBaseContext :: V3.ScriptContext
reclaimBaseContext =
  reclaimBaseContextFor activeBaseHash activeGlobalCredential

reclaimBaseContextFor :: V3.ScriptHash -> V3.Credential -> V3.ScriptContext
reclaimBaseContextFor baseHash globalCredential =
  buildScriptContext $
    withSpendingScript
      (V3.toBuiltinData ())
      ( withOutRef ordinaryInputRef
          <> withAddress (scriptAddress baseHash)
          <> withValue (mkAdaValue inputAda)
          <> withInlineDatum (V3.toBuiltinData (ReclaimBaseDatum goldenPaymentKeyHash))
      )
      <> withOutput (withTxOutAddress (pubKeyAddress destinationPaymentKeyHash) <> withTxOutValue (mkAdaValue outputAda))
      <> withWithdrawal globalCredential 0
      <> withFee (V3.Lovelace feeAda)

reclaimBaseMissingWithdrawalContext :: V3.ScriptContext
reclaimBaseMissingWithdrawalContext =
  reclaimBaseMissingWithdrawalContextFor activeBaseHash

reclaimBaseMissingWithdrawalContextFor :: V3.ScriptHash -> V3.ScriptContext
reclaimBaseMissingWithdrawalContextFor baseHash =
  buildScriptContext $
    withSpendingScript
      (V3.toBuiltinData ())
      ( withOutRef ordinaryInputRef
          <> withAddress (scriptAddress baseHash)
          <> withValue (mkAdaValue inputAda)
          <> withInlineDatum (V3.toBuiltinData (ReclaimBaseDatum goldenPaymentKeyHash))
      )
      <> withOutput (withTxOutAddress (pubKeyAddress destinationPaymentKeyHash) <> withTxOutValue (mkAdaValue outputAda))
      <> withFee (V3.Lovelace feeAda)

reclaimBaseShortDatumContext :: V3.ScriptContext
reclaimBaseShortDatumContext =
  reclaimBaseShortDatumContextFor activeBaseHash activeGlobalCredential

reclaimBaseShortDatumContextFor :: V3.ScriptHash -> V3.Credential -> V3.ScriptContext
reclaimBaseShortDatumContextFor baseHash globalCredential =
  buildScriptContext $
    withSpendingScript
      (V3.toBuiltinData ())
      ( withOutRef ordinaryInputRef
          <> withAddress (scriptAddress baseHash)
          <> withValue (mkAdaValue inputAda)
          <> withInlineDatum (V3.toBuiltinData (ReclaimBaseDatum "short"))
      )
      <> withOutput (withTxOutAddress (pubKeyAddress destinationPaymentKeyHash) <> withTxOutValue (mkAdaValue outputAda))
      <> withWithdrawal globalCredential 0
      <> withFee (V3.Lovelace feeAda)

reclaimBaseNoncanonicalDatumContext :: V3.ScriptContext
reclaimBaseNoncanonicalDatumContext =
  reclaimBaseNoncanonicalDatumContextFor activeBaseHash activeGlobalCredential

reclaimBaseNoncanonicalDatumContextFor :: V3.ScriptHash -> V3.Credential -> V3.ScriptContext
reclaimBaseNoncanonicalDatumContextFor baseHash globalCredential =
  buildScriptContext $
    withSpendingScript
      (V3.toBuiltinData ())
      ( withOutRef ordinaryInputRef
          <> withAddress (scriptAddress baseHash)
          <> withValue (mkAdaValue inputAda)
          <> withInlineDatum noncanonicalBaseDatum
      )
      <> withOutput (withTxOutAddress (pubKeyAddress destinationPaymentKeyHash) <> withTxOutValue (mkAdaValue outputAda))
      <> withWithdrawal globalCredential 0
      <> withFee (V3.Lovelace feeAda)

reclaimGlobalMalformedRedeemerContext :: V3.ScriptContext
reclaimGlobalMalformedRedeemerContext =
  reclaimGlobalMalformedRedeemerContextFor activeGlobalCredential

reclaimGlobalMalformedRedeemerContextFor :: V3.Credential -> V3.ScriptContext
reclaimGlobalMalformedRedeemerContextFor globalCredential =
  buildScriptContext $
    withTxIn ordinaryInput
      <> withTxOut destinationOutput
      <> withRewardingScript (V3.toBuiltinData ()) globalCredential 0
      <> withFee (V3.Lovelace feeAda)

reclaimGlobalSuccessContext :: BuiltinByteString -> V3.ScriptContext
reclaimGlobalSuccessContext proof =
  reclaimGlobalSuccessContextFor activeBaseHash activeGlobalCredential proof

reclaimGlobalSuccessContextFor :: V3.ScriptHash -> V3.Credential -> BuiltinByteString -> V3.ScriptContext
reclaimGlobalSuccessContextFor baseHash globalCredential proof =
  reclaimGlobalContextWithDigestFor baseHash globalCredential proof activePublicInputDigest

reclaimGlobalSubstitutedDigestContext :: BuiltinByteString -> V3.ScriptContext
reclaimGlobalSubstitutedDigestContext proof =
  reclaimGlobalSubstitutedDigestContextFor activeBaseHash activeGlobalCredential proof

reclaimGlobalSubstitutedDigestContextFor :: V3.ScriptHash -> V3.Credential -> BuiltinByteString -> V3.ScriptContext
reclaimGlobalSubstitutedDigestContextFor baseHash globalCredential proof =
  reclaimGlobalContextWithDigestFor
    baseHash
    globalCredential
    proof
    (flipFirstBit activePublicInputDigest)

reclaimGlobalNoncanonicalParamDatumContext :: BuiltinByteString -> V3.ScriptContext
reclaimGlobalNoncanonicalParamDatumContext proof =
  reclaimGlobalNoncanonicalParamDatumContextFor activeBaseHash activeGlobalCredential proof

reclaimGlobalNoncanonicalParamDatumContextFor :: V3.ScriptHash -> V3.Credential -> BuiltinByteString -> V3.ScriptContext
reclaimGlobalNoncanonicalParamDatumContextFor baseHash globalCredential proof =
  reclaimGlobalContextWithPartsFor
    globalCredential
    proof
    activePublicInputDigest
    (reclaimBaseInputWithDatumFor baseHash (V3.toBuiltinData (ReclaimBaseDatum goldenPaymentKeyHash)))
    (paramsReferenceInputWithDatum (noncanonicalParamsDatumFor baseHash))

reclaimGlobalNoncanonicalBaseDatumContext :: BuiltinByteString -> V3.ScriptContext
reclaimGlobalNoncanonicalBaseDatumContext proof =
  reclaimGlobalNoncanonicalBaseDatumContextFor activeBaseHash activeGlobalCredential proof

reclaimGlobalNoncanonicalBaseDatumContextFor :: V3.ScriptHash -> V3.Credential -> BuiltinByteString -> V3.ScriptContext
reclaimGlobalNoncanonicalBaseDatumContextFor baseHash globalCredential proof =
  reclaimGlobalContextWithPartsFor
    globalCredential
    proof
    activePublicInputDigest
    (reclaimBaseInputWithDatumFor baseHash noncanonicalBaseDatum)
    (paramsReferenceInputFor baseHash)

reclaimGlobalContextWithDigestFor :: V3.ScriptHash -> V3.Credential -> BuiltinByteString -> BuiltinByteString -> V3.ScriptContext
reclaimGlobalContextWithDigestFor baseHash globalCredential proof digest =
  reclaimGlobalContextWithPartsFor
    globalCredential
    proof
    digest
    (reclaimBaseInputWithDatumFor baseHash (V3.toBuiltinData (ReclaimBaseDatum goldenPaymentKeyHash)))
    (paramsReferenceInputFor baseHash)

reclaimGlobalContextWithPartsFor ::
  V3.Credential ->
  BuiltinByteString ->
  BuiltinByteString ->
  V3.TxInInfo ->
  V3.TxInInfo ->
  V3.ScriptContext
reclaimGlobalContextWithPartsFor globalCredential proof digest baseInput paramsInput =
  buildScriptContext $
    withTxIn baseInput
      <> withTxIn activeFeeInput
      <> withReferenceTxIn paramsInput
      <> withTxOut activeDestinationOutput
      <> withRewardingScript
        (reclaimGlobalRedeemerDataV2 0 0 [proof] [digest])
        globalCredential
        0
      <> withFee (V3.Lovelace feeAda)

reclaimBaseInputWithDatumFor :: V3.ScriptHash -> BuiltinData -> V3.TxInInfo
reclaimBaseInputWithDatumFor baseHash datum =
  mkInput $
    withOutRef ordinaryInputRef
      <> withAddress (scriptAddress baseHash)
      <> withValue (mkAdaValue outputAda)
      <> withInlineDatum datum

activeFeeInput :: V3.TxInInfo
activeFeeInput =
  mkInput $
    withOutRef feeInputRef
      <> withAddress (pubKeyAddress destinationPaymentKeyHash)
      <> withValue (mkAdaValue feeAda)

paramsReferenceInputFor :: V3.ScriptHash -> V3.TxInInfo
paramsReferenceInputFor baseHash =
  paramsReferenceInputWithDatum (reclaimGlobalParamsData baseHash)

paramsReferenceInputWithDatum :: BuiltinData -> V3.TxInInfo
paramsReferenceInputWithDatum datum =
  mkInput $
    withOutRef paramsReferenceRef
      <> withAddress (scriptAddress activeParamsHolderHash)
      <> withValue
        (mkAdaValue outputAda <> V3.singleton activePolicy paramsTokenName 1)
      <> withInlineDatum datum

noncanonicalParamsDatumFor :: V3.ScriptHash -> BuiltinData
noncanonicalParamsDatumFor baseHash =
  BI.mkConstr 1 (BI.mkCons (BI.mkB (scriptHashBytes baseHash)) (BI.mkNilData BI.unitval))

noncanonicalBaseDatum :: BuiltinData
noncanonicalBaseDatum =
  BI.mkConstr 1 (BI.mkCons (BI.mkB goldenPaymentKeyHash) (BI.mkNilData BI.unitval))

scriptHashBytes :: V3.ScriptHash -> BuiltinByteString
scriptHashBytes scriptHash =
  case scriptHash of
    V3.ScriptHash bytes -> bytes

activeDestinationOutput :: V3.TxOut
activeDestinationOutput =
  mkTxOut $
    withTxOutAddress (pubKeyAddress destinationPaymentKeyHash)
      <> withTxOutValue (mkAdaValue outputAda)

destinationAddressBytes :: BuiltinByteString
destinationAddressBytes =
  B.consByteString 1 (case destinationPaymentKeyHash of V3.PubKeyHash hashBytes -> hashBytes)
    <> B.consByteString 0 (B.replicateByte 28 0)

activePublicInputDigest :: BuiltinByteString
activePublicInputDigest =
  ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes

reclaimGlobalDecision :: BuiltinByteString -> V3.ScriptContext -> Bool
reclaimGlobalDecision verifierKey ctx =
  reclaimGlobalValidatorV2
    activePolicy
    paramsTokenName
    verifierKey
    verifierKeyHash
    (V3.toBuiltinData ctx)
  where
    verifierKeyHash =
      builtinFromHex "06ce913c931a53561fe5d022ed45a5fbc033b06d80eebdd9f646d23a05b7d5c4"

flipFirstBit :: BuiltinByteString -> BuiltinByteString
flipFirstBit bytes =
  let firstByte = B.indexByteString bytes 0
      flipped = if even firstByte then firstByte + 1 else firstByte - 1
   in B.consByteString flipped (B.sliceByteString 1 (B.lengthOfByteString bytes - 1) bytes)

type Script = UPLC.Program UPLC.DeBruijn PLC.DefaultUni PLC.DefaultFun ()

scriptFromCborHex :: String -> Script
scriptFromCborHex input =
  let serialised = SBS.toShort $ BS.pack $ fmap fromInteger $ decodeHex input
      script =
        either (error . ("failed to deserialise locked script: " <>) . show) id $
          V3.deserialiseScript protocolVersion serialised
      ScriptNamedDeBruijn program = deserialisedScript script
   in toNameless program

toNameless ::
  UPLC.Program UPLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun () ->
  Script
toNameless (UPLC.Program ann version term) =
  UPLC.Program ann version (UPLC.termMapNames UPLC.unNameDeBruijn term)

evaluateCompiledScript :: Script -> V3.ScriptContext -> Bool
evaluateCompiledScript script ctx =
  let UPLC.Program _ _ term = applyContextArgument script ctx
      namedTerm = UPLC.termMapNames UPLC.fakeNameDeBruijn term
   in case Cek.runCekDeBruijn
        defaultCekParametersForTesting
        (Cek.restricting (ExRestrictingBudget unlimitedBudget))
        Cek.noEmitter
        namedTerm of
        (Right _, _, _) -> True
        (Left _, _, _) -> False

applyContextArgument :: Script -> V3.ScriptContext -> Script
applyContextArgument (UPLC.Program ann version term) ctx =
  UPLC.Program ann version $
    MkPlc.mkIterAppNoAnn term [MkPlc.mkConstant () (V3.toData ctx)]

unlimitedBudget :: ExBudget
unlimitedBudget = ExBudget (ExCPU maxBound) (ExMemory maxBound)

protocolVersion :: V3.MajorProtocolVersion
protocolVersion = V3.MajorProtocolVersion 11

builtinDataHex :: BuiltinData -> String
builtinDataHex = builtinByteStringHex . B.serialiseData

builtinByteStringHex :: BuiltinByteString -> String
builtinByteStringHex bytes =
  concatMap (byteHex . fromInteger . B.indexByteString bytes)
    [0 .. B.lengthOfByteString bytes - 1]

byteHex :: Word8 -> String
byteHex byte =
  [ intToDigit (fromIntegral byte `div` 16)
  , intToDigit (fromIntegral byte `mod` 16)
  ]

shortByteStringHex :: SBS.ShortByteString -> String
shortByteStringHex = concatMap byteHex . BS.unpack . SBS.fromShort

builtinFromHex :: String -> BuiltinByteString
builtinFromHex = foldr B.consByteString B.emptyByteString . decodeHex

decodeHex :: String -> [Integer]
decodeHex = go . filter isHexDigit
  where
    go (hi : lo : rest) = fromIntegral (digitToInt hi * 16 + digitToInt lo) : go rest
    go [] = []
    go [_] = error "odd number of hex digits"
