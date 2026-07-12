{-# LANGUAGE NumericUnderscores #-}
{-# LANGUAGE NamedFieldPuns #-}
{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Control.Monad (forM_, unless)
import Crypto.Hash (Blake2b_224, Blake2b_256, Digest, hash)
import Data.Aeson (FromJSON (..), eitherDecode, withObject, (.:))
import qualified Data.ByteString as BS
import qualified Data.ByteString.Lazy as BL
import qualified Data.ByteString.Short as SBS
import Data.Char (digitToInt, isHexDigit)
import Data.List (find, isPrefixOf, nub)
import Data.Maybe (fromMaybe)
import Text.Printf (printf)

import qualified PlutusCore as PLC
import PlutusCore.Evaluation.Machine.ExBudget
  ( ExBudget (..)
  , ExRestrictingBudget (..)
  , minusExBudget
  )
import PlutusCore.Evaluation.Machine.ExBudgetingDefaults (defaultCekParametersForTesting)
import PlutusCore.Evaluation.Machine.ExMemory (ExCPU (..), ExMemory (..))
import PlutusCore.Evaluation.Machine.MachineParameters.Default
  ( DefaultMachineParameters
  )
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
-- Historical comparison rows retained below.  New reconciliation rows use
-- only the production-facing StatementV2 module above.
import qualified Ownership.ReclaimGlobalV2Bench as V2Global
import Ownership.ReclaimGlobalMulti
  ( reclaimGlobalMultiRedeemerData
  , reclaimGlobalMultiValidatorCode
  )
import qualified Ownership.ReclaimGlobalMultiV2Bench as V2Multi
import Ownership.Verify (ownershipDestinationPublicInputDigest)
import Protocol11Snapshot
  ( Protocol11Snapshot (..)
  , loadProtocol11Snapshot
  )
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

-- | The historical local harness measured a minimal evaluator context.  The
-- ledger-shaped rows use the same claim semantics but include a normal wallet
-- input, fee, and signer.  Credential-width changes are separate ablations;
-- they are not deployment-hash claims.
data ClaimContextShape
  = OldLocalContext
  | LedgerShapedContext
  deriving (Eq, Show)

data Evaluator = Evaluator
  { evaluatorName :: String
  , evaluatorMachineParameters :: DefaultMachineParameters
  }

data ClaimProfile
  = CurrentBaseline
  | StatementBoundV2
  deriving (Eq, Show)

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
  snapshot <-
    either (error . ("failed to load checked-in Preprod protocol V11 snapshot: " <>)) pure =<<
      loadProtocol11Snapshot protocol11SnapshotPath
  let testingEvaluator = Evaluator "testing CEK" defaultCekParametersForTesting
      preprodV11Evaluator = Evaluator "Preprod V11 snapshot" (snapshotMachineParameters snapshot)
      repeatedFixture = OwnershipFixture goldenPaymentKeyHash destinationProof
      baseScript = compiledToProgram (baseValidatorCode globalCredential)
      repeatedGlobalScript = compiledToProgram (globalValidatorCode paramCurrencySymbol destinationVk)
      statementV2GlobalScript = compiledToProgram (statementV2GlobalValidatorCode paramCurrencySymbol destinationVk (B.blake2b_256 destinationVk))
      historicalV2GlobalScript = compiledToProgram (v2GlobalValidatorCode paramCurrencySymbol destinationVk)
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
      historicalV2RepeatedCases =
        [ benchmarkCase "historical V2 repeated proof" baseScript historicalV2GlobalScript (replicate inputCount repeatedFixture)
        | inputCount <- [1, 2, 5, 35]
        ]
      historicalV2DistinctCases =
        [ benchmarkCase "historical V2 distinct same-master" baseScript historicalV2GlobalScript (take inputCount distinctFixtures)
        | inputCount <- [1 .. 8]
        ]
      historicalV2MixedCases =
        case distinctFixtures of
          firstFixture : secondFixture : _ ->
            [ benchmarkCase "historical V2 mixed cache/distinct" baseScript historicalV2GlobalScript
                [firstFixture, firstFixture, secondFixture, secondFixture]
            ]
          _ -> error "historical V2 mixed benchmark needs two distinct fixtures"
      historicalV2MultiCases =
        fmap (multiBenchmarkCaseWith "historical V2 multi distinct same-master" v2MultiGlobalValidatorCode baseScript) multiFixtures
      statementV2DistinctCases =
        [ statementV2BenchmarkCase "ZK-02 statement-bound distinct" baseScript statementV2GlobalScript (take inputCount distinctFixtures)
        | inputCount <- [1 .. 9]
        ]
      statementV2RepeatedCases =
        [ statementV2BenchmarkCase "ZK-02 statement-bound repeated full proof" baseScript statementV2GlobalScript (replicate inputCount repeatedFixture)
        | inputCount <- [1, 2, 5, 35]
        ]
      reconciliationCases =
        [ reconciliationBenchmarkCase evaluator profile contextShape globalCredential14 destinationVk (take 7 distinctFixtures)
        | evaluator <- [testingEvaluator, preprodV11Evaluator]
        , contextShape <- [OldLocalContext, LedgerShapedContext]
        , profile <- [CurrentBaseline, StatementBoundV2]
        ]
      ledgerPreprodCapacityCases =
        [ reconciliationBenchmarkCase
            preprodV11Evaluator
            profile
            LedgerShapedContext
            globalCredential14
            destinationVk
            (take inputCount distinctFixtures)
        | profile <- [CurrentBaseline, StatementBoundV2]
        , inputCount <- [1 .. 9]
        ]
      defaultSix =
        reconciliationBenchmarkCase
          preprodV11Evaluator
          StatementBoundV2
          LedgerShapedContext
          globalCredential14
          destinationVk
          (take 6 distinctFixtures)
      duplicateCredentials =
        reconciliationBenchmarkCaseNamed
          "V2 N=7 same credential normal flow / ledger-shaped context / Preprod V11 snapshot"
          preprodV11Evaluator
          StatementBoundV2
          LedgerShapedContext
          globalCredential14
          destinationVk
          (replicate 7 repeatedFixture)
      walletInputAbsent =
        reconciliationBenchmarkCaseNamed
          "V2 ablation: no non-ReclaimBase wallet input / Preprod V11"
          preprodV11Evaluator
          StatementBoundV2
          OldLocalContext
          globalCredential14
          destinationVk
          (take 7 distinctFixtures)
      walletInputPresent =
        reconciliationBenchmarkCaseNamed
          "V2 ablation: one non-ReclaimBase wallet input / Preprod V11"
          preprodV11Evaluator
          StatementBoundV2
          LedgerShapedContext
          globalCredential14
          destinationVk
          (take 7 distinctFixtures)
      shortGlobalCredential =
        reconciliationBenchmarkCaseNamed
          "V2 ablation: 14-byte global credential parameter / Preprod V11"
          preprodV11Evaluator
          StatementBoundV2
          LedgerShapedContext
          globalCredential14
          destinationVk
          (take 7 distinctFixtures)
      fullGlobalCredential =
        reconciliationBenchmarkCaseNamed
          "V2 ablation: 28-byte global credential parameter / Preprod V11"
          preprodV11Evaluator
          StatementBoundV2
          LedgerShapedContext
          globalCredential28
          destinationVk
          (take 7 distinctFixtures)
      v2ProductionWidth =
        reconciliationBenchmarkCaseNamedWithParams
          "V2 production-width ablation: 28-byte policy CurrencySymbol + 28-byte global credential / Preprod V11"
          preprodV11Evaluator
          StatementBoundV2
          LedgerShapedContext
          globalCredential28
          paramCurrencySymbol28
          destinationVk
          (take 7 distinctFixtures)
      baselineProductionWidth =
        reconciliationBenchmarkCaseNamedWithParams
          "Current baseline production-width ablation: 28-byte policy CurrencySymbol + 28-byte global credential / Preprod V11"
          preprodV11Evaluator
          CurrentBaseline
          LedgerShapedContext
          globalCredential28
          paramCurrencySymbol28
          destinationVk
          (take 7 distinctFixtures)
      namedV2N7 =
        fromMaybe
          (error "missing V2 N=7 ledger-shaped Preprod V11 reconciliation row")
          (find ((== "V2 N=7 distinct credentials / ledger-shaped context / Preprod V11 snapshot") . benchCaseName) reconciliationCases)
      releaseCases =
        [ defaultSix
        , duplicateCredentials
        , walletInputAbsent
        , walletInputPresent
        , shortGlobalCredential
        , fullGlobalCredential
        , v2ProductionWidth
        , baselineProductionWidth
        ]

  assertPerRunBaseFlat repeatedCases
  assertV8DistinctCapacity distinctCases
  printV2ReleasePolicy defaultSix namedV2N7 duplicateCredentials
  printRawCapacityBoundary ledgerPreprodCapacityCases

  putStrLn "ownership-verifier ex-unit benchmarks"
  printf "protocol major version: %d\n" protocolMajorVersion
  putStrLn "reconciliation evaluators: CEK defaultCekParametersForTesting and checked-in Preprod V11 snapshot"
  printf "Preprod V11 snapshot SHA256: %s; source cost-model entries: %d; evaluator entries: %d\n"
    (snapshotCanonicalProtocolParametersHash snapshot)
    (snapshotPlutusV3ParameterCount snapshot)
    (snapshotEvaluatorParameterCount snapshot)
  printf "max tx memory: %d\n" maxTxMemory
  printf "max tx CPU:    %d\n" maxTxCpu
  putStrLn ""
  putStrLn "Each base validator budget is evaluated against the full claim transaction context, varying the spending purpose, and summed into the transaction total."
  putStrLn "The reconciliation rows compare current ReclaimBase+ReclaimGlobal with production ReclaimGlobalV2 code, preserving one output and one full proof/digest per reclaim-base input."
  putStrLn "They are evaluator-context reconciliation fixtures, not deployment artifacts; the generic 28-byte credential appears only in its named width ablation."
  putStrLn "Ledger-shaped rows add a non-ReclaimBase wallet input before all reclaim-base inputs; the candidate must skip that input while covering every ReclaimBase input."
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
  mapM_ printCase (repeatedCases <> distinctCases <> multiCases <> historicalV2RepeatedCases <> historicalV2DistinctCases <> historicalV2MixedCases <> historicalV2MultiCases <> statementV2DistinctCases <> statementV2RepeatedCases <> reconciliationCases <> ledgerPreprodCapacityCases <> releaseCases)
  putStrLn ""
  putStrLn "V5 repeated encoding sizes (exact Plutus Data CBOR; context size is not full transaction CBOR)"
  forM_ [35, 100] $ \inputCount ->
    printRepeatedEncodingSize inputCount (replicate inputCount repeatedFixture)
  putStrLn "ZK-02 all-distinct redeemer sizes (exact Plutus Data CBOR; not transaction CBOR)"
  forM_ [1 .. 9] $ \inputCount ->
    printStatementV2DistinctEncodingSize inputCount (take inputCount distinctFixtures)
  putStrLn ""
  printf "benchmark-applied script sizes (test parameters): base=%d bytes; current global=%d bytes; historical V2 global=%d bytes; production statement-bound V2 global=%d bytes\n"
    (compiledCodeSize (baseValidatorCode globalCredential))
    (compiledCodeSize (globalValidatorCode paramCurrencySymbol destinationVk))
    (compiledCodeSize (v2GlobalValidatorCode paramCurrencySymbol destinationVk))
    (compiledCodeSize (statementV2GlobalValidatorCode paramCurrencySymbol destinationVk (B.blake2b_256 destinationVk)))
  forM_ multiFixtures $ \fixture ->
    printf "  Multi count-%d: production=%d bytes; historical V2=%d bytes\n"
      (multiFixtureCredentialCount fixture)
      (compiledCodeSize (multiGlobalValidatorCode paramCurrencySymbol (multiFixtureVerifierKey fixture)))
      (compiledCodeSize (v2MultiGlobalValidatorCode paramCurrencySymbol (multiFixtureVerifierKey fixture)))
  let productionParamCurrencySymbol = V3.CurrencySymbol (bytesToBuiltin (replicate 28 0))
      productionGlobalCode = globalValidatorCode productionParamCurrencySymbol destinationVk
      productionV2GlobalCode = v2GlobalValidatorCode productionParamCurrencySymbol destinationVk
      productionStatementV2GlobalCode = statementV2GlobalValidatorCode productionParamCurrencySymbol destinationVk (B.blake2b_256 destinationVk)
      productionCurrentGlobalCredential =
        V3.ScriptCredential
          (V3.ScriptHash (bytesToBuiltin (decodeHex (compiledCodePlutusV3ScriptHash productionGlobalCode))))
      productionStatementV2GlobalCredential =
        V3.ScriptCredential
          (V3.ScriptHash (bytesToBuiltin (decodeHex (compiledCodePlutusV3ScriptHash productionStatementV2GlobalCode))))
      productionCurrentBaseCode = baseValidatorCode productionCurrentGlobalCredential
      productionStatementV2BaseCode = baseValidatorCode productionStatementV2GlobalCredential
  printf "28-byte parameter-width paired shape sizes: current base=%d bytes; current global=%d bytes; historical V2 global=%d bytes; statement-bound base=%d bytes; statement-bound global=%d bytes\n"
    (compiledCodeSize productionCurrentBaseCode)
    (compiledCodeSize productionGlobalCode)
    (compiledCodeSize productionV2GlobalCode)
    (compiledCodeSize productionStatementV2BaseCode)
    (compiledCodeSize productionStatementV2GlobalCode)
  printf "28-byte parameter-width paired PlutusV3 script hashes: current base=%s; current global=%s; statement-bound base=%s; statement-bound global=%s\n"
    (compiledCodePlutusV3ScriptHash productionCurrentBaseCode)
    (compiledCodePlutusV3ScriptHash productionGlobalCode)
    (compiledCodePlutusV3ScriptHash productionStatementV2BaseCode)
    (compiledCodePlutusV3ScriptHash productionStatementV2GlobalCode)
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

-- | Retained historical production-candidate rows.  The reconciliation rows
-- below add evaluator/context comparisons without changing this time series.
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

-- | Production reconciliation path.  The V2 branch uses
-- 'Ownership.ReclaimGlobalV2', never the historical benchmark-only module.
reconciliationBenchmarkCase ::
  Evaluator ->
  ClaimProfile ->
  ClaimContextShape ->
  V3.Credential ->
  BuiltinByteString ->
  [OwnershipFixture] ->
  BenchmarkCase
reconciliationBenchmarkCase evaluator profile contextShape credential verifierKey fixtures =
  reconciliationBenchmarkCaseNamed
    (reconciliationCaseName profile (length fixtures) contextShape (evaluatorName evaluator))
    evaluator
    profile
    contextShape
    credential
    verifierKey
    fixtures

reconciliationBenchmarkCaseNamed ::
  String ->
  Evaluator ->
  ClaimProfile ->
  ClaimContextShape ->
  V3.Credential ->
  BuiltinByteString ->
  [OwnershipFixture] ->
  BenchmarkCase
reconciliationBenchmarkCaseNamed name evaluator profile contextShape credential verifierKey fixtures =
  reconciliationBenchmarkCaseNamedWithParams
    name
    evaluator
    profile
    contextShape
    credential
    paramCurrencySymbol
    verifierKey
    fixtures

-- | Parameter-width ablations must change both the applied validator and the
-- parameter-holder reference input; otherwise they measure an inconsistent
-- transaction context rather than a policy-width effect.
reconciliationBenchmarkCaseNamedWithParams ::
  String ->
  Evaluator ->
  ClaimProfile ->
  ClaimContextShape ->
  V3.Credential ->
  V3.CurrencySymbol ->
  BuiltinByteString ->
  [OwnershipFixture] ->
  BenchmarkCase
reconciliationBenchmarkCaseNamedWithParams name evaluator profile contextShape credential paramsCurrencySymbol verifierKey fixtures =
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
    baseScript = compiledToProgram (baseValidatorCode credential)
    globalScript =
      compiledToProgram $
        case profile of
          CurrentBaseline -> globalValidatorCode paramsCurrencySymbol verifierKey
          StatementBoundV2 -> statementV2GlobalValidatorCode paramsCurrencySymbol verifierKey (B.blake2b_256 verifierKey)
    claimContext = reclaimClaimContext profile contextShape credential paramsCurrencySymbol fixtures
    baseRuns =
      [ evaluateBudgetWith evaluator baseScript $
          reclaimBaseContext claimContext index (ReclaimBaseDatum paymentKeyHash)
      | (index, OwnershipFixture paymentKeyHash _) <- indexedFixtures
      ]
    baseTotal = sumBudgets baseRuns
    globalBudget = evaluateBudgetWith evaluator globalScript claimContext

reconciliationCaseName :: ClaimProfile -> Int -> ClaimContextShape -> String -> String
reconciliationCaseName profile inputCount contextShape evaluator =
  profileLabel
    <> " N="
    <> show inputCount
    <> " distinct credentials / "
    <> contextLabel
    <> " context / "
    <> evaluator
  where
    profileLabel =
      case profile of
        CurrentBaseline -> "Current ReclaimGlobal"
        StatementBoundV2 -> "V2"
    contextLabel =
      case contextShape of
        OldLocalContext -> "old local"
        LedgerShapedContext -> "ledger-shaped"

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

-- | This local harness reports both the raw limit and the release policy.  It
-- must not promote its CEK approximation into the provider gate: Stage 2g
-- evaluation remains authoritative for the release decision.
printV2ReleasePolicy :: BenchmarkCase -> BenchmarkCase -> BenchmarkCase -> IO ()
printV2ReleasePolicy defaultSix distinctSeven duplicateCredentials = do
  putStrLn $
    "V2 local classification: default N=6 raw="
      <> rawLimitStatus (benchTotal defaultSix)
      <> "; policy="
      <> releaseStatus (benchTotal defaultSix)
  putStrLn $
    "V2 N=7 opt-in capacity classification (distinct benchmark material): raw="
      <> rawLimitStatus (benchTotal distinctSeven)
      <> "; policy="
      <> releaseStatus (benchTotal distinctSeven)
      <> " (Stage 2g provider evaluation is the release gate)"
  putStrLn $
    "V2 N=7 same-credential normal-flow regression: raw="
      <> rawLimitStatus (benchTotal duplicateCredentials)
      <> "; policy="
      <> releaseStatus (benchTotal duplicateCredentials)
      <> " (validity regression only; not a capacity gate)"

-- | Make the raw-exunit capacity boundary explicit instead of requiring a
-- reader to infer it from the per-N matrix.  These are local evaluator rows;
-- the provider remains the release authority.
printRawCapacityBoundary :: [BenchmarkCase] -> IO ()
printRawCapacityBoundary cases =
  forM_ [CurrentBaseline, StatementBoundV2] $ \profile -> do
    let profileCases = filter (matchesProfile profile) cases
        passing = filter (withinRawLimit . benchTotal) profileCases
        firstFailing = find (not . withinRawLimit . benchTotal) profileCases
        profileLabel =
          case profile of
            CurrentBaseline -> "Current ReclaimGlobal"
            StatementBoundV2 -> "V2 production candidate"
    case passing of
      [] -> putStrLn (profileLabel <> " ledger-shaped Preprod V11 raw-exunit capacity: no passing rows")
      _ -> do
        let largestPassing = last passing
        putStrLn $
          profileLabel
            <> " ledger-shaped Preprod V11 raw-exunit capacity: largest raw pass N="
            <> show (benchInputCount largestPassing)
            <> " ("
            <> renderBudget (benchTotal largestPassing)
            <> "); first raw failure="
            <> maybe "none in sweep" (show . benchInputCount) firstFailing
  where
    matchesProfile profile currentCase =
      case profile of
        CurrentBaseline -> "Current ReclaimGlobal N=" `isPrefixOf` benchCaseName currentCase
        StatementBoundV2 -> "V2 N=" `isPrefixOf` benchCaseName currentCase

renderBudget :: Budget -> String
renderBudget budget =
  "mem=" <> show (budgetMemory budget) <> ",cpu=" <> show (budgetCpu budget)

printCase :: BenchmarkCase -> IO ()
printCase BenchmarkCase {benchCaseName, benchInputCount, benchBase, benchGlobal, benchTotal} = do
  printf
    "%58s %5d | %12d %14d %7.3f%% %7.3f%% | %12d %14d %7.3f%% %7.3f%% | %12d %14d %7.3f%% %7.3f%%"
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
  printf " | raw=%s; policy=%s\n" (rawLimitStatus benchTotal) (releaseStatus benchTotal)

withinRawLimit :: Budget -> Bool
withinRawLimit budget =
  budgetMemory budget <= maxTxMemory
    && budgetCpu budget <= maxTxCpu

withinReleaseCeiling :: Budget -> Bool
withinReleaseCeiling budget =
  budgetMemory budget * 100 <= maxTxMemory * 80
    && budgetCpu budget * 100 <= maxTxCpu * 90

rawLimitStatus :: Budget -> String
rawLimitStatus budget =
  if withinRawLimit budget
    then "ACCEPT"
    else "REJECT"

releaseStatus :: Budget -> String
releaseStatus budget =
  if withinReleaseCeiling budget
    then "PASS"
    else "REJECT"

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
evaluateBudget = evaluateBudgetWith (Evaluator "testing CEK" defaultCekParametersForTesting)

evaluateBudgetWith :: Evaluator -> Script -> V3.ScriptContext -> Budget
evaluateBudgetWith Evaluator {evaluatorMachineParameters} script ctx =
  let UPLC.Program _ _ term = applyContextArgument script ctx
      namedTerm = UPLC.termMapNames UPLC.fakeNameDeBruijn term
   in case Cek.runCekDeBruijn
        evaluatorMachineParameters
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

protocol11SnapshotPath :: FilePath
protocol11SnapshotPath = "bench/results/preprod-protocol-v11-epoch-300.json"

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
globalCredential = globalCredential14

globalCredential14 :: V3.Credential
globalCredential14 = V3.ScriptCredential (V3.ScriptHash "global-reclaim")

globalCredential28 :: V3.Credential
globalCredential28 =
  V3.ScriptCredential (V3.ScriptHash (bytesToBuiltin (replicate 28 0)))
-- This is deliberately only a wire-width ablation.  It is not asserted to be
-- the hash of the corresponding applied global validator.

paramCurrencySymbol :: V3.CurrencySymbol
paramCurrencySymbol = V3.CurrencySymbol "param-policy"

paramCurrencySymbol28 :: V3.CurrencySymbol
paramCurrencySymbol28 = V3.CurrencySymbol (bytesToBuiltin (replicate 28 0))

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
reclaimGlobalStatementV2Context =
  reclaimClaimContext StatementBoundV2 OldLocalContext globalCredential paramCurrencySymbol

reclaimClaimContext ::
  ClaimProfile ->
  ClaimContextShape ->
  V3.Credential ->
  V3.CurrencySymbol ->
  [OwnershipFixture] ->
  V3.ScriptContext
reclaimClaimContext profile contextShape configuredGlobalCredential paramsCurrencySymbol fixtures =
  buildScriptContext $
    contextPrefix
      <> foldMap (withSpendingScript (V3.toBuiltinData ())) reclaimInputs
      <> withReferenceTxIn (paramInputWith paramsCurrencySymbol)
      <> foldMap (const (withTxOut (destinationOutput 1))) fixtures
      <> contextSuffix
      <> withRewardingScript
        redeemer
        configuredGlobalCredential
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
    redeemer =
      case profile of
        CurrentBaseline -> reclaimGlobalRedeemerData 0 0 (compressRepeatedProofs proofs)
        StatementBoundV2 -> StatementV2.reclaimGlobalRedeemerDataV2 0 0 proofs publicInputDigests
    contextPrefix =
      case contextShape of
        OldLocalContext -> mempty
        LedgerShapedContext ->
          withTxIn walletInput
            <> withFee 500_000
            <> withSigner (V3.PubKeyHash "safe-wallet-signer")
    -- The destination sequence always starts at output index zero.  Appending
    -- change after every reclaim destination matches the complete wallet
    -- transaction shape without allowing the change output into the fixed
    -- proof/destination slot sequence.
    contextSuffix =
      case contextShape of
        OldLocalContext -> mempty
        LedgerShapedContext -> withTxOut walletChangeOutput

-- | A normal key-controlled input is intentionally placed before all reclaim
-- inputs.  Production V2 must skip it rather than counting it as a reclaim
-- slot, while still consuming every later ReclaimBase input and output.
walletInput :: V3.TxInInfo
walletInput =
  mkInput $
    withOutRef
      ( V3.TxOutRef
          { V3.txOutRefId = V3.TxId "safe-wallet"
          , V3.txOutRefIdx = 0
          }
      )
      <> withAddress (pubKeyAddress (V3.PubKeyHash "safe-wallet-payment"))
      <> withValue (V3.singleton V3.adaSymbol V3.adaToken 10_000_000)

-- | Ordinary safe-wallet change.  It is deliberately appended after all
-- reclaim destinations by 'contextSuffix', so the V2 redeemer's destination
-- start index of zero cannot consume it as a reclaim payment.
walletChangeOutput :: V3.TxOut
walletChangeOutput =
  mkTxOut $
    withTxOutAddress (pubKeyAddress (V3.PubKeyHash "safe-wallet-change"))
      <> withTxOutValue (V3.singleton V3.adaSymbol V3.adaToken 9_500_000)

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

compiledCodePlutusV3ScriptHash :: CompiledCode a -> String
compiledCodePlutusV3ScriptHash code =
  show
    ( hash
        (BS.cons 3 (SBS.fromShort (V3.serialiseCompiledCode code))) ::
        Digest Blake2b_224
    )

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
paramInput = paramInputWith paramCurrencySymbol

paramInputWith :: V3.CurrencySymbol -> V3.TxInInfo
paramInputWith paramsCurrencySymbol =
  mkInput $
    withOutRef
      ( V3.TxOutRef
          { V3.txOutRefId = V3.TxId "params"
          , V3.txOutRefIdx = 0
          }
      )
      <> withAddress (scriptAddress (V3.ScriptHash "always-fails"))
      <> withValue (reclaimValue <> V3.singleton paramsCurrencySymbol paramTokenName 1)
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
