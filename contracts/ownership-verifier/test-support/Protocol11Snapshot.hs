{-# LANGUAGE OverloadedStrings #-}

module Protocol11Snapshot
  ( Protocol11Snapshot (..)
  , loadProtocol11Snapshot
  ) where

import Control.Monad (unless)
import Control.Monad.Trans.Writer.Strict (runWriterT)
import Crypto.Hash (Digest, SHA256, hashlazy)
import Data.Aeson
  ( Value (..)
  , eitherDecode
  , parseJSON
  , withObject
  , (.:)
  )
import Data.Aeson.Types (Parser)
import qualified Data.Aeson
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KeyMap
import qualified Data.ByteString.Lazy as BL
import qualified Data.ByteString.Lazy.Char8 as BL8
import Data.Int (Int64)
import Data.List (sort)
import Data.Text (Text)
import qualified Data.Text as Text
import PlutusCore.Evaluation.Machine.MachineParameters.Default
  ( DefaultMachineParameters
  )
import PlutusCore.Evaluation.Machine.CostModelInterface
  ( CostModelApplyWarn (..)
  )
import qualified PlutusLedgerApi.V3 as V3
import qualified PlutusLedgerApi.V3.EvaluationContext as V3Evaluation
import System.Exit (ExitCode (..))
import System.Process (readProcessWithExitCode)

data Protocol11Snapshot = Protocol11Snapshot
  { snapshotCanonicalProtocolParametersHash :: String
  , snapshotPlutusV3ParameterCount :: Int
  , snapshotEvaluatorParameterCount :: Int
  , snapshotMachineParameters :: DefaultMachineParameters
  }

data ValidatedSnapshot = ValidatedSnapshot
  { validatedProtocolParametersHash :: String
  , validatedPlutusV3Parameters :: [Int64]
  }

expectedProtocolParametersHash :: String
expectedProtocolParametersHash =
  "e710abd050607fddc29d16a930bf222e465f053daed75ea4eebdac8134492bcb"

loadProtocol11Snapshot :: FilePath -> IO (Either String Protocol11Snapshot)
loadProtocol11Snapshot path = do
  canonicalHash <- canonicalProtocolParametersHash path
  decoded <- eitherDecode <$> BL.readFile path
  pure $ do
    validated <- decoded >>= parseValidatedSnapshot
    actualHash <- canonicalHash
    unless (actualHash == expectedProtocolParametersHash) $
      Left $
        "canonical protocol_parameters SHA256 mismatch: expected "
          <> expectedProtocolParametersHash
          <> ", found "
          <> actualHash
    let parameters = validatedPlutusV3Parameters validated
    unless (length parameters == 350) $
      Left $
        "PlutusV3 cost model must contain exactly 350 integers, found "
          <> show (length parameters)
    case runWriterT (V3Evaluation.mkEvaluationContext parameters) of
      Left err -> Left ("PlutusV3 cost model application failed: " <> show err)
      Right (evaluationContext, warnings) -> do
        evaluatorParameterCount <-
          case warnings of
            [] -> Right 350
            [CMTooManyParamsWarn expected actual]
              | expected == 297 && actual == 350 -> Right expected
            _ ->
              Left $
                "unexpected PlutusV3 cost model warning(s): "
                  <> renderWarnings warnings
        pure
          Protocol11Snapshot
            { snapshotCanonicalProtocolParametersHash =
                validatedProtocolParametersHash validated
            , snapshotPlutusV3ParameterCount = length parameters
            , snapshotEvaluatorParameterCount = evaluatorParameterCount
            , snapshotMachineParameters =
                V3Evaluation.toMachineParameters
                  (V3.MajorProtocolVersion 11)
                  evaluationContext
            }

renderWarnings :: [CostModelApplyWarn] -> String
renderWarnings = unwords . fmap renderWarning
  where
    renderWarning (CMTooManyParamsWarn expected actual) =
      "too-many(expected=" <> show expected <> ",actual=" <> show actual <> ")"
    renderWarning (CMTooFewParamsWarn expected actual) =
      "too-few(expected=" <> show expected <> ",actual=" <> show actual <> ")"

parseValidatedSnapshot :: Value -> Either String ValidatedSnapshot
parseValidatedSnapshot value =
  case Data.Aeson.fromJSON value of
    Data.Aeson.Error err -> Left err
    Data.Aeson.Success result -> Right result

instance Data.Aeson.FromJSON ValidatedSnapshot where
  parseJSON =
    withObject "protocol-v11 snapshot" $ \snapshot -> do
      exactKeys
        "snapshot"
        [ "network"
        , "network_magic"
        , "protocol_parameters"
        , "protocol_parameters_sha256"
        , "schema"
        , "source"
        ]
        snapshot
      schema <- snapshot .: "schema"
      expectEqual "schema" ("proof-tool-cardano-protocol-parameters-snapshot-v1" :: Text) schema
      network <- snapshot .: "network"
      expectEqual "network" ("preprod" :: Text) network
      networkMagic <- snapshot .: "network_magic"
      expectEqual "network_magic" (1 :: Int) networkMagic
      declaredHash <- snapshot .: "protocol_parameters_sha256"
      expectEqual
        "protocol_parameters_sha256"
        (Text.pack ("sha256:" <> expectedProtocolParametersHash))
        declaredHash
      source <- snapshot .: "source"
      validateSource source
      protocolParameters <- snapshot .: "protocol_parameters"
      validateProtocolVersion protocolParameters
      parameters <- parsePlutusV3Parameters protocolParameters
      pure
        ValidatedSnapshot
          { validatedProtocolParametersHash = expectedProtocolParametersHash
          , validatedPlutusV3Parameters = parameters
          }

validateSource :: Value -> Parser ()
validateSource =
  withObject "snapshot source" $ \source -> do
    exactKeys
      "source"
      [ "provider"
      , "protocol_parameters_url"
      , "retrieved_at"
      , "tip"
      , "tip_url"
      , "transport"
      ]
      source
    provider <- source .: "provider"
    expectEqual "source.provider" ("Koios" :: Text) provider
    protocolParametersUrl <- source .: "protocol_parameters_url"
    expectEqual
      "source.protocol_parameters_url"
      ("https://preprod.koios.rest/api/v1/cli_protocol_params" :: Text)
      protocolParametersUrl
    tipUrl <- source .: "tip_url"
    expectEqual "source.tip_url" ("https://preprod.koios.rest/api/v1/tip" :: Text) tipUrl
    retrievedAt <- source .: "retrieved_at"
    expectEqual "source.retrieved_at" ("2026-07-11T03:50:26.470Z" :: Text) retrievedAt
    transport <- source .: "transport"
    expectEqual "source.transport" ("HTTPS" :: Text) transport
    tip <- source .: "tip"
    validateTip tip

validateTip :: Value -> Parser ()
validateTip =
  withObject "snapshot tip" $ \tip -> do
    exactKeys
      "source.tip"
      [ "abs_slot"
      , "block_height"
      , "block_no"
      , "block_time"
      , "epoch_no"
      , "epoch_slot"
      , "era"
      , "hash"
      ]
      tip
    tipHash <- tip .: "hash"
    expectEqual
      "source.tip.hash"
      ("7570b012b31cca2beb7b6cbe297480d059996a27f383516b48a22e212fbf727c" :: Text)
      tipHash
    epoch <- tip .: "epoch_no"
    expectEqual "source.tip.epoch_no" (300 :: Int) epoch
    era <- tip .: "era"
    expectEqual "source.tip.era" ("Conway" :: Text) era
    absSlot <- tip .: "abs_slot"
    expectEqual "source.tip.abs_slot" (128058601 :: Integer) absSlot
    epochSlot <- tip .: "epoch_slot"
    expectEqual "source.tip.epoch_slot" (100201 :: Int) epochSlot
    blockHeight <- tip .: "block_height"
    expectEqual "source.tip.block_height" (4922475 :: Int) blockHeight
    blockNo <- tip .: "block_no"
    expectEqual "source.tip.block_no" (4922475 :: Int) blockNo
    blockTime <- tip .: "block_time"
    expectEqual "source.tip.block_time" (1783741801 :: Integer) blockTime

validateProtocolVersion :: Value -> Parser ()
validateProtocolVersion =
  withObject "protocol parameters" $ \parameters -> do
    version <- parameters .: "protocolVersion"
    withObject "protocolVersion" (\versionObject -> do
      exactKeys "protocolVersion" ["major", "minor"] versionObject
      major <- versionObject .: "major"
      expectEqual "protocolVersion.major" (11 :: Int) major
      minor <- versionObject .: "minor"
      expectEqual "protocolVersion.minor" (0 :: Int) minor
      ) version

parsePlutusV3Parameters :: Value -> Parser [Int64]
parsePlutusV3Parameters =
  withObject "protocol parameters" $ \parameters -> do
    costModels <- parameters .: "costModels"
    withObject "costModels" (\models -> do
      exactKeys "costModels" ["PlutusV1", "PlutusV2", "PlutusV3"] models
      model <- models .: "PlutusV3"
      parseJSON model
      ) costModels

canonicalProtocolParametersHash :: FilePath -> IO (Either String String)
canonicalProtocolParametersHash path = do
  (exitCode, canonicalJson, stderrOutput) <-
    readProcessWithExitCode "jq" ["-Sc", ".protocol_parameters", path] ""
  pure $
    case exitCode of
      ExitSuccess ->
        Right $
          show
            ( hashlazy (BL8.pack canonicalJson)
                :: Digest SHA256
            )
      ExitFailure status ->
        Left $
          "jq canonicalization failed with exit status "
            <> show status
            <> ": "
            <> stderrOutput

exactKeys :: String -> [Text] -> KeyMap.KeyMap Value -> Parser ()
exactKeys label expected object =
  unless (actual == sort expected) $
    fail $
      label
        <> " keys mismatch: expected "
        <> show (sort expected)
        <> ", found "
        <> show actual
  where
    actual = sort (fmap Key.toText (KeyMap.keys object))

expectEqual :: (Eq a, Show a) => String -> a -> a -> Parser ()
expectEqual label expected actual =
  unless (actual == expected) $
    fail $
      label
        <> " mismatch: expected "
        <> show expected
        <> ", found "
        <> show actual
