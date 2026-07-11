{-# LANGUAGE NumericUnderscores #-}
{-# LANGUAGE NamedFieldPuns #-}
{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Control.Monad (forM_, unless)
import Crypto.Hash (Blake2b_256, Digest, hash)
import Data.Aeson (FromJSON (..), eitherDecode, withObject, (.:))
import qualified Data.ByteString.Lazy as BL
import qualified Data.ByteString.Short as SBS
import Data.Char (digitToInt, isHexDigit)
import Data.List (find, nub)
import Text.Printf (printf)

import qualified PlutusCore as PLC
import PlutusCore.Evaluation.Machine.ExBudget
  ( ExBudget (..)
  , ExRestrictingBudget (..)
  , minusExBudget
  )
import PlutusCore.Evaluation.Machine.ExBudgetingDefaults (defaultCekParametersForTesting)
import PlutusCore.Evaluation.Machine.ExMemory (ExCPU (..), ExMemory (..))
import qualified PlutusCore.MkPlc as PLC
import PlutusLedgerApi.Common
  ( ScriptNamedDeBruijn (..)
  , deserialisedScript
  )
import qualified PlutusLedgerApi.V3 as V3
import PlutusTx (CompiledCode)
import qualified PlutusTx
import qualified PlutusTx.Builtins as B
import PlutusTx.Builtins (BuiltinByteString, BuiltinData)
import PlutusTx.Builtins.Internal (BuiltinUnit)
import qualified UntypedPlutusCore as UPLC
import qualified UntypedPlutusCore.Evaluation.Machine.Cek as Cek

import Ownership.ReclaimBase (ReclaimBaseDatum (..), reclaimBaseValidatorCode)
import Ownership.ReclaimGlobal
  ( reclaimGlobalParamsData
  , reclaimGlobalRedeemerData
  , reclaimSameAsPreviousProof
  , reclaimGlobalValidatorCode
  )
import qualified Ownership.ReclaimGlobalV2 as StatementV2
import qualified Ownership.ReclaimGlobalV2Bench as V2Global
import Ownership.ReclaimGlobalMulti
  ( reclaimGlobalMultiRedeemerData
  , reclaimGlobalMultiValidatorCode
  )
import qualified Ownership.ReclaimGlobalMultiV2Bench as V2Multi
import Ownership.Verify (ownershipDestinationPublicInputDigest)
import ScriptContextBuilder

type Script = UPLC.Program UPLC.DeBruijn PLC.DefaultUni PLC.DefaultFun ()

data Budget = Budget
  { budgetMemory :: Integer
  , budgetCpu :: Integer
  }

data BenchmarkCase = BenchmarkCase
  { benchCaseName :: String
  , benchInputCount :: Int
  , benchBaseRuns :: [Budget]
  , benchBase :: Budget
  , benchGlobal :: Budget
  , benchTotal :: Budget
  }

data OwnershipFixture = OwnershipFixture
  { fixturePaymentKeyHash :: BuiltinByteString
  , fixtureProof :: BuiltinByteString
  }

data MultiOwnershipFixture = MultiOwnershipFixture
  { multiFixtureCredentialCount :: Int
  , multiFixtureVerifierKey :: BuiltinByteString
  , multiFixtureProof :: BuiltinByteString
  , multiFixtureCredentials :: [BuiltinByteString]
  }

data MultiBenchmarkFile = MultiBenchmarkFile
  { multiBenchmarkSchema :: String
  , multiBenchmarkDestinationAddress :: String
  , multiBenchmarkFixtures :: [RawMultiBenchmarkFixture]
  }

data RawPath = RawPath
  { _rawPathAccount :: Int
  , _rawPathRole :: Int
  , _rawPathIndex :: Int
  }

data RawMultiBenchmarkFixture = RawMultiBenchmarkFixture
  { rawCredentialCount :: Int
  , rawCircuitId :: String
  , rawFormat :: String
  , rawPublicInputDigestHex :: String
  , rawProofHex :: String
  , rawVKHex :: String
  , rawTargetCredentials :: [String]
  , rawPaths :: [RawPath]
  }

instance FromJSON MultiBenchmarkFile where
  parseJSON =
    withObject "MultiBenchmarkFile" $ \obj ->
      MultiBenchmarkFile
        <$> obj .: "schema"
        <*> obj .: "destination_address"
        <*> obj .: "fixtures"

instance FromJSON RawPath where
  parseJSON =
    withObject "RawPath" $ \obj ->
      RawPath
        <$> obj .: "account"
        <*> obj .: "role"
        <*> obj .: "index"

instance FromJSON RawMultiBenchmarkFixture where
  parseJSON =
    withObject "RawMultiBenchmarkFixture" $ \obj ->
      RawMultiBenchmarkFixture
        <$> obj .: "credential_count"
        <*> obj .: "circuit_id"
        <*> obj .: "format"
        <*> obj .: "public_input_digest_hex"
        <*> obj .: "proof_hex"
        <*> obj .: "vk_hex"
        <*> obj .: "target_credentials"
        <*> obj .: "paths"

main :: IO ()
main = do
  destinationVk <- readBuiltinHex "testdata/ownership-destination-vk.hex"
  destinationProof <- readBuiltinHex "testdata/ownership-destination-proof.hex"
  distinctFixtures <- readDistinctFixtures "testdata/ownership-destination-distinct-proofs.txt"
  multiFixtures <- readMultiBenchmarkFixtures "testdata/multi-benchmark-fixtures.json"
  let repeatedFixture = OwnershipFixture goldenPaymentKeyHash destinationProof
      baseScript = compiledToProgram (baseValidatorCode globalCredential)
      repeatedGlobalScript = compiledToProgram (globalValidatorCode paramCurrencySymbol destinationVk)
      statementV2GlobalScript = compiledToProgram (statementV2GlobalValidatorCode paramCurrencySymbol destinationVk (B.blake2b_256 destinationVk))
      v2GlobalScript = compiledToProgram (v2GlobalValidatorCode paramCurrencySymbol destinationVk)
      repeatedCases =
        [ benchmarkCase "repeated proof" baseScript repeatedGlobalScript (replicate inputCount repeatedFixture)
        | inputCount <- repeatedBenchmarkInputCounts
        ]
      distinctCases =
        [ benchmarkCase "distinct same-master proofs" baseScript repeatedGlobalScript (take inputCount distinctFixtures)
        | inputCount <- distinctBenchmarkInputCounts
        ]
      multiCases =
        fmap (multiBenchmarkCase baseScript) multiFixtures
      v2RepeatedCases =
        [ benchmarkCase "V2 repeated proof" baseScript v2GlobalScript (replicate inputCount repeatedFixture)
        | inputCount <- [1, 2, 5, 35]
        ]
      v2DistinctCases =
        [ benchmarkCase "V2 distinct same-master" baseScript v2GlobalScript (take inputCount distinctFixtures)
        | inputCount <- [1 .. 8]
        ]
      v2MixedCases =
        case distinctFixtures of
          firstFixture : secondFixture : _ ->
            [ benchmarkCase "V2 mixed cache/distinct" baseScript v2GlobalScript
                [firstFixture, firstFixture, secondFixture, secondFixture]
            ]
          _ -> error "V2 mixed benchmark needs two distinct fixtures"
      v2MultiCases =
        fmap (multiBenchmarkCaseWith "V2 multi distinct same-master" v2MultiGlobalValidatorCode baseScript) multiFixtures
      statementV2DistinctCases =
        [ statementV2BenchmarkCase "ZK-02 statement-bound distinct" baseScript statementV2GlobalScript (take inputCount distinctFixtures)
        | inputCount <- [1 .. 9]
        ]

  assertPerRunBaseFlat repeatedCases
  assertV8DistinctCapacity distinctCases

  putStrLn "ownership-verifier ex-unit benchmarks"
  printf "protocol major version: %d\n" protocolMajorVersion
  putStrLn "evaluator: CEK defaultCekParametersForTesting with huge restricting budget"
  printf "max tx memory: %d\n" maxTxMemory
  printf "max tx CPU:    %d\n" maxTxCpu
  putStrLn ""
  putStrLn "Each base validator budget is evaluated against the full claim transaction context, varying the spending purpose, and summed into the transaction total."
  putStrLn "The single rows use destination-bound proofs and one corresponding destination output per reclaim-base input."
  putStrLn "The distinct single rows use credentials for m/1852'/1815'/0'/0/0..19 from the same master key, with one proof per credential."
  putStrLn "The multi rows use generated JSON fixtures with one destination-bound multi proof per requested input count."
  putStrLn ""
  let headerLabels :: [String]
      headerLabels =
        [ "case"
        , "utxos"
        , "base mem"
        , "base cpu"
        , "mem %"
        , "cpu %"
        , "global mem"
        , "global cpu"
        , "mem %"
        , "cpu %"
        , "total mem"
        , "total cpu"
        , "mem %"
        , "cpu %"
        ]
  putStr $
    printf
      "%28s %5s | %12s %14s %8s %8s | %12s %14s %8s %8s | %12s %14s %8s %8s\n"
      (headerLabels !! 0)
      (headerLabels !! 1)
      (headerLabels !! 2)
      (headerLabels !! 3)
      (headerLabels !! 4)
      (headerLabels !! 5)
      (headerLabels !! 6)
      (headerLabels !! 7)
      (headerLabels !! 8)
      (headerLabels !! 9)
      (headerLabels !! 10)
      (headerLabels !! 11)
      (headerLabels !! 12)
      (headerLabels !! 13)
  putStrLn (replicate 177 '-')
  mapM_ printCase (repeatedCases <> distinctCases <> multiCases <> v2RepeatedCases <> v2DistinctCases <> v2MixedCases <> v2MultiCases <> statementV2DistinctCases)
  putStrLn ""
  putStrLn "V5 repeated encoding sizes (exact Plutus Data CBOR; context size is not full transaction CBOR)"
  forM_ [35, 100] $ \inputCount ->
    printRepeatedEncodingSize inputCount (replicate inputCount repeatedFixture)
  putStrLn "ZK-02 all-distinct redeemer sizes (exact Plutus Data CBOR; not transaction CBOR)"
  forM_ [1 .. 9] $ \inputCount ->
    printStatementV2DistinctEncodingSize inputCount (take inputCount distinctFixtures)
  putStrLn ""
  printf "benchmark-applied script sizes (test parameters): base=%d bytes; global=%d bytes; V2 global=%d bytes; ZK-02 statement-bound global=%d bytes\n"
    (compiledCodeSize (baseValidatorCode globalCredential))
    (compiledCodeSize (globalValidatorCode paramCurrencySymbol destinationVk))
    (compiledCodeSize (v2GlobalValidatorCode paramCurrencySymbol destinationVk))
    (compiledCodeSize (statementV2GlobalValidatorCode paramCurrencySymbol destinationVk (B.blake2b_256 destinationVk)))
  forM_ multiFixtures $ \fixture ->
    printf "  Multi count-%d: production=%d bytes; V2=%d bytes\n"
      (multiFixtureCredentialCount fixture)
      (compiledCodeSize (multiGlobalValidatorCode paramCurrencySymbol (multiFixtureVerifierKey fixture)))
      (compiledCodeSize (v2MultiGlobalValidatorCode paramCurrencySymbol (multiFixtureVerifierKey fixture)))
  let productionParamCurrencySymbol = V3.CurrencySymbol (bytesToBuiltin (replicate 28 0))
      productionGlobalCredential = V3.ScriptCredential (V3.ScriptHash (bytesToBuiltin (replicate 28 0)))
      productionGlobalCode = globalValidatorCode productionParamCurrencySymbol destinationVk
      productionV2GlobalCode = v2GlobalValidatorCode productionParamCurrencySymbol destinationVk
      productionStatementV2GlobalCode = statementV2GlobalValidatorCode productionParamCurrencySymbol destinationVk (B.blake2b_256 destinationVk)
  printf "production-shaped applied sizes: base=%d bytes; global=%d bytes; V2 global=%d bytes; ZK-02 statement-bound global=%d bytes\n"
    (compiledCodeSize (baseValidatorCode productionGlobalCredential))
    (compiledCodeSize productionGlobalCode)
    (compiledCodeSize productionV2GlobalCode)
    (compiledCodeSize productionStatementV2GlobalCode)
  printf "production global serialized blake2b256 snapshot: %s\n"
    (compiledCodeDigest productionGlobalCode)

repeatedBenchmarkInputCounts :: [Int]
repeatedBenchmarkInputCounts = [1, 2, 5, 10, 15, 20, 35, 100]

distinctBenchmarkInputCounts :: [Int]
distinctBenchmarkInputCounts = [1 .. 8] <> [10, 15, 20]

multiBenchmarkInputCounts :: [Int]
multiBenchmarkInputCounts = [1, 5]

benchmarkCase ::
  String ->
  Script ->
  Script ->
  [OwnershipFixture] ->
  BenchmarkCase
benchmarkCase name baseScript globalScript fixtures =
  BenchmarkCase
    { benchCaseName = name
    , benchInputCount = inputCount
    , benchBaseRuns = baseRuns
    , benchBase = baseTotal
    , benchGlobal = globalBudget
    , benchTotal = addBudget baseTotal globalBudget
    }
  where
    inputCount = length fixtures
    indexedFixtures = zip [0 ..] fixtures
    claimContext = reclaimGlobalContext fixtures
    baseRuns =
      [ evaluateBudget baseScript $
          reclaimBaseContext claimContext index (ReclaimBaseDatum paymentKeyHash)
      | (index, OwnershipFixture paymentKeyHash _) <- indexedFixtures
      ]
    baseTotal = sumBudgets baseRuns
    globalBudget =
      evaluateBudget globalScript $
        claimContext

statementV2BenchmarkCase ::
  String ->
  Script ->
  Script ->
  [OwnershipFixture] ->
  BenchmarkCase
statementV2BenchmarkCase name baseScript globalScript fixtures =
  BenchmarkCase
    { benchCaseName = name
    , benchInputCount = inputCount
    , benchBaseRuns = baseRuns
    , benchBase = baseTotal
    , benchGlobal = globalBudget
    , benchTotal = addBudget baseTotal globalBudget
    }
  where
    inputCount = length fixtures
    indexedFixtures = zip [0 ..] fixtures
    claimContext = reclaimGlobalStatementV2Context fixtures
    baseRuns =
      [ evaluateBudget baseScript $
          reclaimBaseContext claimContext index (ReclaimBaseDatum paymentKeyHash)
      | (index, OwnershipFixture paymentKeyHash _) <- indexedFixtures
      ]
    baseTotal = sumBudgets baseRuns
    globalBudget = evaluateBudget globalScript claimContext

multiBenchmarkCase ::
  Script ->
  MultiOwnershipFixture ->
  BenchmarkCase
multiBenchmarkCase =
  multiBenchmarkCaseWith "multi distinct same-master" multiGlobalValidatorCode

multiBenchmarkCaseWith ::
  String ->
  (V3.CurrencySymbol -> BuiltinByteString -> CompiledCode (BuiltinData -> BuiltinUnit)) ->
  Script ->
  MultiOwnershipFixture ->
  BenchmarkCase
multiBenchmarkCaseWith name validatorCode baseScript fixture =
  BenchmarkCase
    { benchCaseName = name
    , benchInputCount = inputCount
    , benchBaseRuns = baseRuns
    , benchBase = baseTotal
    , benchGlobal = globalBudget
    , benchTotal = addBudget baseTotal globalBudget
    }
  where
    inputCount = multiFixtureCredentialCount fixture
    credentials = multiFixtureCredentials fixture
    indexedCredentials = zip [0 ..] credentials
    claimContext = reclaimGlobalMultiContext fixture
    baseRuns =
      [ evaluateBudget baseScript $
          reclaimBaseContext claimContext index (ReclaimBaseDatum paymentKeyHash)
      | (index, paymentKeyHash) <- indexedCredentials
      ]
    baseTotal = sumBudgets baseRuns
    globalScript =
      compiledToProgram $
        validatorCode paramCurrencySymbol (multiFixtureVerifierKey fixture)
    globalBudget =
      evaluateBudget globalScript $
        claimContext

assertPerRunBaseFlat :: [BenchmarkCase] -> IO ()
assertPerRunBaseFlat cases = do
  unless (all matchesReference cases) $
    error
      ( "V1 ReclaimBase per-run ex-units are not flat across full transaction contexts: "
          <> show (fmap caseRange cases)
      )
  case filter ((== 20) . benchInputCount) cases of
    [repeated20] ->
      unless (budgetMemory (benchTotal repeated20) < maxTxMemory) $
        error
          ( "V1 repeated-20 total memory exceeds the 14M transaction budget: "
              <> show (budgetMemory (benchTotal repeated20))
          )
    _ -> error "V1 benchmark must contain exactly one repeated-20 case"
  forM_ [35] $ \inputCount ->
    case find ((== inputCount) . benchInputCount) cases of
      Nothing -> error ("V5 benchmark is missing repeated-" <> show inputCount)
      Just capacityCase -> do
        unless (budgetMemory (benchTotal capacityCase) < maxTxMemory) $
          error
            ( "V5 repeated-"
                <> show inputCount
                <> " total memory exceeds the 14M transaction budget: "
                <> show (budgetMemory (benchTotal capacityCase))
            )
        unless (budgetCpu (benchTotal capacityCase) < maxTxCpu) $
          error
            ( "V5 repeated-"
                <> show inputCount
                <> " total CPU exceeds the 10B transaction budget: "
                <> show (budgetCpu (benchTotal capacityCase))
            )
  putStrLn "V1 corrected ReclaimBase per-run flatness and repeated-20 memory assertions: PASS"
  putStrLn "V5 repeated-35 raw ex-unit assertion: PASS (repeated-100 remains a measured stretch case)"
  where
    reference = head cases
    matchesReference current =
      minimumBudget budgetMemory current == minimumBudget budgetMemory reference
        && maximumBudget budgetMemory current == maximumBudget budgetMemory reference
        && minimumBudget budgetCpu current == minimumBudget budgetCpu reference
        && maximumBudget budgetCpu current == maximumBudget budgetCpu reference

    minimumBudget select benchCase = minimum (fmap select (benchBaseRuns benchCase))
    maximumBudget select benchCase = maximum (fmap select (benchBaseRuns benchCase))

    caseRange benchCase =
      ( benchInputCount benchCase
      , minimumBudget budgetMemory benchCase
      , maximumBudget budgetMemory benchCase
      , minimumBudget budgetCpu benchCase
      , maximumBudget budgetCpu benchCase
      )

assertV8DistinctCapacity :: [BenchmarkCase] -> IO ()
assertV8DistinctCapacity cases =
  case find ((== 7) . benchInputCount) cases of
    Nothing -> error "V8 benchmark is missing distinct N=7"
    Just distinct7 -> do
      unless (budgetMemory (benchTotal distinct7) < maxTxMemory) $
        error
          ( "V8 distinct N=7 total memory exceeds the 14M transaction budget: "
              <> show (budgetMemory (benchTotal distinct7))
          )
      unless (budgetCpu (benchTotal distinct7) <= 9_500_000_000) $
        error
          ( "V8 distinct N=7 lacks the required 5% raw CPU margin: "
              <> show (budgetCpu (benchTotal distinct7))
          )
      putStrLn "V8 distinct N=7 raw ex-unit assertion with >=5% CPU margin: PASS"

printCase :: BenchmarkCase -> IO ()
printCase BenchmarkCase {benchCaseName, benchInputCount, benchBase, benchGlobal, benchTotal} =
  printf
    "%28s %5d | %12d %14d %7.3f%% %7.3f%% | %12d %14d %7.3f%% %7.3f%% | %12d %14d %7.3f%% %7.3f%%\n"
    benchCaseName
    benchInputCount
    (budgetMemory benchBase)
    (budgetCpu benchBase)
    (memoryPercent benchBase)
    (cpuPercent benchBase)
    (budgetMemory benchGlobal)
    (budgetCpu benchGlobal)
    (memoryPercent benchGlobal)
    (cpuPercent benchGlobal)
    (budgetMemory benchTotal)
    (budgetCpu benchTotal)
    (memoryPercent benchTotal)
    (cpuPercent benchTotal)

baseValidatorCode :: V3.Credential -> CompiledCode (BuiltinData -> BuiltinUnit)
baseValidatorCode credential =
  reclaimBaseValidatorCode
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef (V3.toBuiltinData credential)

globalValidatorCode :: V3.CurrencySymbol -> BuiltinByteString -> CompiledCode (BuiltinData -> BuiltinUnit)
globalValidatorCode currencySymbol verifierKey =
  reclaimGlobalValidatorCode
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef currencySymbol
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramTokenName
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef verifierKey

v2GlobalValidatorCode :: V3.CurrencySymbol -> BuiltinByteString -> CompiledCode (BuiltinData -> BuiltinUnit)
v2GlobalValidatorCode currencySymbol verifierKey =
  V2Global.reclaimGlobalValidatorCode
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef currencySymbol
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramTokenName
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef verifierKey

statementV2GlobalValidatorCode :: V3.CurrencySymbol -> BuiltinByteString -> BuiltinByteString -> CompiledCode (BuiltinData -> BuiltinUnit)
statementV2GlobalValidatorCode currencySymbol verifierKey verifierKeyHash =
  StatementV2.reclaimGlobalValidatorV2Code
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef currencySymbol
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramTokenName
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef verifierKey
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef verifierKeyHash

multiGlobalValidatorCode :: V3.CurrencySymbol -> BuiltinByteString -> CompiledCode (BuiltinData -> BuiltinUnit)
multiGlobalValidatorCode currencySymbol verifierKey =
  reclaimGlobalMultiValidatorCode
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef currencySymbol
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramTokenName
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef verifierKey

v2MultiGlobalValidatorCode :: V3.CurrencySymbol -> BuiltinByteString -> CompiledCode (BuiltinData -> BuiltinUnit)
v2MultiGlobalValidatorCode currencySymbol verifierKey =
  V2Multi.reclaimGlobalMultiValidatorCode
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef currencySymbol
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramTokenName
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef verifierKey

compiledToProgram :: CompiledCode a -> Script
compiledToProgram code =
  let script =
        either (error . ("failed to deserialise compiled script: " <>) . show) id $
          V3.deserialiseScript protocolVersion (V3.serialiseCompiledCode code)
      ScriptNamedDeBruijn program = deserialisedScript script
   in toNameless program

toNameless ::
  UPLC.Program UPLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun () ->
  Script
toNameless (UPLC.Program ann version term) =
  UPLC.Program ann version (UPLC.termMapNames UPLC.unNameDeBruijn term)

evaluateBudget :: Script -> V3.ScriptContext -> Budget
evaluateBudget script ctx =
  let UPLC.Program _ _ term = applyContextArgument script ctx
      namedTerm = UPLC.termMapNames UPLC.fakeNameDeBruijn term
   in case Cek.runCekDeBruijn
        defaultCekParametersForTesting
        (Cek.restricting (ExRestrictingBudget countingBudget))
        Cek.logEmitter
        namedTerm of
        (Right _, Cek.RestrictingSt (ExRestrictingBudget finalBudget), _) ->
          fromExBudget (countingBudget `minusExBudget` finalBudget)
        (Left err, _, logs) ->
          error $
            "script evaluation failed: "
              <> show err
              <> "; logs="
              <> show logs

applyContextArgument :: Script -> V3.ScriptContext -> Script
applyContextArgument (UPLC.Program ann version term) ctx =
  UPLC.Program ann version $
    PLC.mkIterAppNoAnn term [PLC.mkConstant () (V3.toData ctx)]

countingBudget :: ExBudget
countingBudget = ExBudget (ExCPU maxBound) (ExMemory maxBound)

fromExBudget :: ExBudget -> Budget
fromExBudget (ExBudget (ExCPU cpu) (ExMemory memory)) =
  Budget
    { budgetMemory = V3.fromSatInt memory
    , budgetCpu = V3.fromSatInt cpu
    }

addBudget :: Budget -> Budget -> Budget
addBudget left right =
  Budget
    { budgetMemory = budgetMemory left + budgetMemory right
    , budgetCpu = budgetCpu left + budgetCpu right
    }

sumBudgets :: [Budget] -> Budget
sumBudgets =
  foldr addBudget (Budget 0 0)

memoryPercent :: Budget -> Double
memoryPercent budget =
  percentOf (budgetMemory budget) maxTxMemory

cpuPercent :: Budget -> Double
cpuPercent budget =
  percentOf (budgetCpu budget) maxTxCpu

percentOf :: Integer -> Integer -> Double
percentOf amount maximumAmount =
  (fromIntegral amount / fromIntegral maximumAmount) * 100

protocolVersion :: V3.MajorProtocolVersion
protocolVersion = V3.MajorProtocolVersion protocolMajorVersion

protocolMajorVersion :: Int
protocolMajorVersion = 11

maxTxMemory :: Integer
maxTxMemory = 14_000_000

maxTxCpu :: Integer
maxTxCpu = 10_000_000_000

decodeHex :: String -> [Integer]
decodeHex = go . filter isHexDigit
  where
    go (hi : lo : rest) = fromIntegral (digitToInt hi * 16 + digitToInt lo) : go rest
    go [] = []
    go [_] = error "decodeHex: odd number of hex digits"

bytesToBuiltin :: [Integer] -> BuiltinByteString
bytesToBuiltin = foldr B.consByteString B.emptyByteString

stringToBuiltin :: String -> BuiltinByteString
stringToBuiltin = bytesToBuiltin . fmap (fromIntegral . fromEnum)

readBuiltinHex :: FilePath -> IO BuiltinByteString
readBuiltinHex path = bytesToBuiltin . decodeHex <$> readFile path

readDistinctFixtures :: FilePath -> IO [OwnershipFixture]
readDistinctFixtures path = do
  raw <- readFile path
  let fixtures = fmap parseFixtureLine (filter (not . null) (lines raw))
      credentials = fmap fixturePaymentKeyHash fixtures
      proofs = fmap fixtureProof fixtures
  if length fixtures < maximum distinctBenchmarkInputCounts
    then error "distinct ownership fixture file has too few rows"
    else
      if length (nub credentials) /= length credentials
        then error "distinct ownership fixture credentials must be unique"
        else
          if length (nub proofs) /= length proofs
            then error "distinct ownership fixture proofs must be unique"
            else pure fixtures
  where
    parseFixtureLine line =
      case words line of
        [_idx, credentialHex, proofHex] ->
          OwnershipFixture
            { fixturePaymentKeyHash = bytesToBuiltin (decodeHex credentialHex)
            , fixtureProof = bytesToBuiltin (decodeHex proofHex)
            }
        _ -> error ("malformed distinct ownership fixture row: " <> line)

readMultiBenchmarkFixtures :: FilePath -> IO [MultiOwnershipFixture]
readMultiBenchmarkFixtures path = do
  raw <- BL.readFile path
  MultiBenchmarkFile {multiBenchmarkSchema, multiBenchmarkDestinationAddress, multiBenchmarkFixtures} <-
    either (error . ("failed to parse multi benchmark fixtures: " <>)) pure (eitherDecode raw)
  unless (multiBenchmarkSchema == "proof-tool-multi-benchmark-fixtures-v1") $
    error ("unexpected multi benchmark fixture schema: " <> multiBenchmarkSchema)
  unless (multiBenchmarkDestinationAddress == destinationAddressV1Hex) $
    error "multi benchmark fixture destination does not match benchmark destination"
  let fixtures = fmap convertMultiFixture multiBenchmarkFixtures
      counts = fmap multiFixtureCredentialCount fixtures
  unless (counts == multiBenchmarkInputCounts) $
    error ("multi benchmark fixture counts = " <> show counts <> ", want " <> show multiBenchmarkInputCounts)
  pure fixtures

convertMultiFixture :: RawMultiBenchmarkFixture -> MultiOwnershipFixture
convertMultiFixture raw =
  if rawCredentialCount raw <= 0
    then error "multi benchmark fixture credential count must be positive"
    else
      if length (rawTargetCredentials raw) /= rawCredentialCount raw
        then error ("multi benchmark fixture target count mismatch for " <> rawCircuitId raw)
        else
          if length (rawPaths raw) /= rawCredentialCount raw
            then error ("multi benchmark fixture path count mismatch for " <> rawCircuitId raw)
            else
              if rawFormat raw /= "groth16-bls12-381-bsb22"
                then error ("unexpected multi benchmark fixture format: " <> rawFormat raw)
                else
                  if length (decodeHex (rawPublicInputDigestHex raw)) /= 32
                    then error ("malformed public input digest for " <> rawCircuitId raw)
                    else
                      MultiOwnershipFixture
                        { multiFixtureCredentialCount = rawCredentialCount raw
                        , multiFixtureVerifierKey = bytesToBuiltin (decodeHex (rawVKHex raw))
                        , multiFixtureProof = bytesToBuiltin (decodeHex (rawProofHex raw))
                        , multiFixtureCredentials =
                            fmap (bytesToBuiltin . decodeHex) (rawTargetCredentials raw)
                        }

goldenPaymentKeyHash :: BuiltinByteString
goldenPaymentKeyHash =
  bytesToBuiltin (decodeHex "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")

destinationPaymentKeyHash :: V3.PubKeyHash
destinationPaymentKeyHash =
  V3.PubKeyHash (bytesToBuiltin (decodeHex "0038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da111"))

destinationAddressV1Hex :: String
destinationAddressV1Hex =
  "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000"

destinationAddressV1Bytes :: BuiltinByteString
destinationAddressV1Bytes =
  bytesToBuiltin (decodeHex destinationAddressV1Hex)

baseScriptHash :: V3.ScriptHash
baseScriptHash = V3.ScriptHash "reclaim-base"

globalCredential :: V3.Credential
globalCredential = V3.ScriptCredential (V3.ScriptHash "global-reclaim")

paramCurrencySymbol :: V3.CurrencySymbol
paramCurrencySymbol = V3.CurrencySymbol "param-policy"

paramTokenName :: V3.TokenName
paramTokenName = V3.TokenName "RECLAIMPARAMS"

reclaimValue :: V3.Value
reclaimValue = V3.singleton V3.adaSymbol V3.adaToken 2_000_000

reclaimBaseContext :: V3.ScriptContext -> Int -> ReclaimBaseDatum -> V3.ScriptContext
reclaimBaseContext claimContext inputIndex datum =
  claimContext
    { V3.scriptContextRedeemer = V3.Redeemer (V3.toBuiltinData ())
    , V3.scriptContextScriptInfo =
        V3.SpendingScript
          (reclaimBaseOutRef inputIndex)
          (Just (V3.Datum (V3.toBuiltinData datum)))
    }

reclaimGlobalContext :: [OwnershipFixture] -> V3.ScriptContext
reclaimGlobalContext fixtures =
  buildScriptContext $
    foldMap (withSpendingScript (V3.toBuiltinData ())) reclaimInputs
      <> withReferenceTxIn paramInput
      <> foldMap (const (withTxOut (destinationOutput 1))) fixtures
      <> withRewardingScript
        (reclaimGlobalRedeemerData 0 0 proofs)
        globalCredential
        0
  where
    indexedFixtures = zip [0 ..] fixtures
    proofs = compressRepeatedProofs (fmap fixtureProof fixtures)
    reclaimInputs =
      [ reclaimBaseInput index paymentKeyHash
      | (index, OwnershipFixture paymentKeyHash _) <- indexedFixtures
      ]

reclaimGlobalStatementV2Context :: [OwnershipFixture] -> V3.ScriptContext
reclaimGlobalStatementV2Context fixtures =
  buildScriptContext $
    foldMap (withSpendingScript (V3.toBuiltinData ())) reclaimInputs
      <> withReferenceTxIn paramInput
      <> foldMap (const (withTxOut (destinationOutput 1))) fixtures
      <> withRewardingScript
        (StatementV2.reclaimGlobalRedeemerDataV2 0 0 proofs publicInputDigests)
        globalCredential
        0
  where
    indexedFixtures = zip [0 ..] fixtures
    proofs = fmap fixtureProof fixtures
    publicInputDigests =
      [ ownershipDestinationPublicInputDigest paymentKeyHash destinationAddressV1Bytes
      | OwnershipFixture paymentKeyHash _ <- fixtures
      ]
    reclaimInputs =
      [ reclaimBaseInput index paymentKeyHash
      | (index, OwnershipFixture paymentKeyHash _) <- indexedFixtures
      ]

compressRepeatedProofs :: [BuiltinByteString] -> [BuiltinByteString]
compressRepeatedProofs [] = []
compressRepeatedProofs (proof : moreProofs) =
  proof : go proof moreProofs
  where
    go _ [] = []
    go previousProof (nextProof : remainingProofs) =
      ( if nextProof == previousProof
          then reclaimSameAsPreviousProof
          else nextProof
      )
        : go nextProof remainingProofs

printRepeatedEncodingSize :: Int -> [OwnershipFixture] -> IO ()
printRepeatedEncodingSize inputCount fixtures =
  printf
    "  repeated-%d: expanded redeemer=%d bytes; marker redeemer=%d bytes; marker ScriptContext=%d bytes\n"
    inputCount
    (serialisedDataSize expandedRedeemer)
    (serialisedDataSize markerRedeemer)
    (serialisedDataSize (V3.toBuiltinData (reclaimGlobalContext fixtures)))
  where
    expandedProofs = fmap fixtureProof fixtures
    markerProofs = compressRepeatedProofs expandedProofs
    expandedRedeemer = reclaimGlobalRedeemerData 0 0 expandedProofs
    markerRedeemer = reclaimGlobalRedeemerData 0 0 markerProofs

printStatementV2DistinctEncodingSize :: Int -> [OwnershipFixture] -> IO ()
printStatementV2DistinctEncodingSize inputCount fixtures =
  printf "  distinct-%d: baseline redeemer=%d bytes; statement-v2 redeemer=%d bytes\n"
    inputCount
    (serialisedDataSize baselineRedeemer)
    (serialisedDataSize statementV2Redeemer)
  where
    proofs = fmap fixtureProof fixtures
    publicInputDigests =
      [ ownershipDestinationPublicInputDigest paymentKeyHash destinationAddressV1Bytes
      | OwnershipFixture paymentKeyHash _ <- fixtures
      ]
    baselineRedeemer = reclaimGlobalRedeemerData 0 0 proofs
    statementV2Redeemer = StatementV2.reclaimGlobalRedeemerDataV2 0 0 proofs publicInputDigests

serialisedDataSize :: BuiltinData -> Integer
serialisedDataSize =
  B.lengthOfByteString . B.serialiseData

compiledCodeSize :: CompiledCode a -> Int
compiledCodeSize = SBS.length . V3.serialiseCompiledCode

compiledCodeDigest :: CompiledCode a -> String
compiledCodeDigest code =
  show (hash (SBS.fromShort (V3.serialiseCompiledCode code)) :: Digest Blake2b_256)

reclaimGlobalMultiContext :: MultiOwnershipFixture -> V3.ScriptContext
reclaimGlobalMultiContext fixture =
  buildScriptContext $
    foldMap (withSpendingScript (V3.toBuiltinData ())) reclaimInputs
      <> withReferenceTxIn paramInput
      <> withTxOut (destinationOutput inputCount)
      <> withRewardingScript
        (reclaimGlobalMultiRedeemerData 0 0 (multiFixtureProof fixture))
        globalCredential
        0
  where
    inputCount = multiFixtureCredentialCount fixture
    indexedCredentials = zip [0 ..] (multiFixtureCredentials fixture)
    reclaimInputs =
      [ reclaimBaseInput index paymentKeyHash
      | (index, paymentKeyHash) <- indexedCredentials
      ]

reclaimBaseInput :: Int -> BuiltinByteString -> InputBuilder
reclaimBaseInput index paymentKeyHash =
  withOutRef (reclaimBaseOutRef index)
    <> withAddress (scriptAddress baseScriptHash)
    <> withValue reclaimValue
    <> withInlineDatum (V3.toBuiltinData (ReclaimBaseDatum paymentKeyHash))

paramInput :: V3.TxInInfo
paramInput =
  mkInput $
    withOutRef
      ( V3.TxOutRef
          { V3.txOutRefId = V3.TxId "params"
          , V3.txOutRefIdx = 0
          }
      )
      <> withAddress (scriptAddress (V3.ScriptHash "always-fails"))
      <> withValue (reclaimValue <> V3.singleton paramCurrencySymbol paramTokenName 1)
      <> withInlineDatum
        (reclaimGlobalParamsData baseScriptHash)

destinationOutput :: Int -> V3.TxOut
destinationOutput inputCount =
  mkTxOut $
    withTxOutAddress (pubKeyAddress destinationPaymentKeyHash)
      <> withTxOutValue
        (V3.singleton V3.adaSymbol V3.adaToken (2_000_000 * fromIntegral inputCount))

reclaimBaseOutRef :: Int -> V3.TxOutRef
reclaimBaseOutRef index =
  V3.TxOutRef
    { V3.txOutRefId = V3.TxId (stringToBuiltin ("base-" <> show index))
    , V3.txOutRefIdx = fromIntegral index
    }
