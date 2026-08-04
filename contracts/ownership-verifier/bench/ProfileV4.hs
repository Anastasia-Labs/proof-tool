{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE DataKinds #-}
{-# LANGUAGE NumericUnderscores #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TemplateHaskell #-}

module Main (main) where

import Prelude (IO)
import qualified Prelude as P

import qualified PlutusCore as PLC
import PlutusCore.Evaluation.Machine.ExBudget
  ( ExBudget (..)
  , ExRestrictingBudget (..)
  , minusExBudget
  )
import PlutusCore.Evaluation.Machine.ExMemory (ExCPU (..), ExMemory (..))
import PlutusCore.Evaluation.Machine.MachineParameters.Default
  ( DefaultMachineParameters
  )
import qualified PlutusCore.MkPlc as PLC
import PlutusLedgerApi.Common (ScriptNamedDeBruijn (..), deserialisedScript)
import qualified PlutusLedgerApi.V1.Value as Value
import qualified PlutusLedgerApi.V3 as V3
import PlutusTx (CompiledCode)
import qualified PlutusTx
import qualified PlutusTx.AssocMap as Map
import qualified PlutusTx.Builtins.Internal as BI
import PlutusTx.Prelude
import qualified UntypedPlutusCore as UPLC
import qualified UntypedPlutusCore.Evaluation.Machine.Cek as Cek

import Ownership.ReclaimGlobalV2 (valueCoversData)
import Ownership.ReclaimGlobalMulti (destinationAddressV1FromTxOutData)
import Protocol11Snapshot
  ( Protocol11Snapshot (snapshotMachineParameters)
  , loadProtocol11Snapshot
  )
import ScriptContextBuilder

type Script = UPLC.Program UPLC.DeBruijn PLC.DefaultUni PLC.DefaultFun ()

data Budget = Budget
  { budgetMemory :: Integer
  , budgetCpu :: Integer
  }
  deriving (P.Show)

{-# INLINABLE firstField #-}
firstField :: BuiltinData -> BuiltinData
firstField pairData =
  BI.head (BI.snd (BI.unsafeDataAsConstr pairData))

{-# INLINABLE secondField #-}
secondField :: BuiltinData -> BuiltinData
secondField pairData =
  BI.head (BI.tail (BI.snd (BI.unsafeDataAsConstr pairData)))

{-# INLINABLE oldDecodedLeq #-}
oldDecodedLeq :: BuiltinData -> BuiltinUnit
oldDecodedLeq pairData =
  let required = PlutusTx.unsafeFromBuiltinData (firstField pairData) :: V3.Value
      paid = PlutusTx.unsafeFromBuiltinData (secondField pairData) :: V3.Value
   in if required `Value.leq` paid
        then BI.unitval
        else traceError "old decoded leq failed"

{-# INLINABLE ledgerValueCoverage #-}
ledgerValueCoverage :: BuiltinData -> BuiltinUnit
ledgerValueCoverage pairData =
  if valueCoversData (firstField pairData) (secondField pairData)
    then BI.unitval
    else traceError "ledger value coverage failed"

{-# INLINABLE typedLeq #-}
typedLeq :: V3.Value -> V3.Value -> BuiltinUnit
typedLeq required paid =
  if required `Value.leq` paid
    then BI.unitval
    else traceError "typed leq failed"

{-# INLINABLE addressOnly #-}
addressOnly :: BuiltinData -> BuiltinUnit
addressOnly txOutData =
  if lengthOfByteString (destinationAddressV1FromTxOutData txOutData) == 58
    then BI.unitval
    else traceError "address encoding failed"

{-# INLINABLE baseline #-}
baseline :: BuiltinData -> BuiltinUnit
baseline _ = BI.unitval

{-# INLINABLE listFieldChecksum3 #-}
listFieldChecksum3 :: BuiltinData -> BuiltinUnit
listFieldChecksum3 record =
  let fields = BI.snd (BI.unsafeDataAsConstr record)
      checksum =
        BI.unsafeDataAsI (BI.head fields)
          + BI.unsafeDataAsI (BI.head (BI.drop 1 fields))
          + BI.unsafeDataAsI (BI.head (BI.drop 2 fields))
   in if checksum == 6 then BI.unitval else traceError "list field checksum failed"

{-# INLINABLE arrayFieldChecksum3 #-}
arrayFieldChecksum3 :: BuiltinData -> BuiltinUnit
arrayFieldChecksum3 record =
  let fields = BI.listToArray (BI.snd (BI.unsafeDataAsConstr record))
      checksum =
        BI.unsafeDataAsI (BI.indexArray fields 0)
          + BI.unsafeDataAsI (BI.indexArray fields 1)
          + BI.unsafeDataAsI (BI.indexArray fields 2)
   in if checksum == 6 then BI.unitval else traceError "array field checksum failed"

{-# INLINABLE listFieldChecksum4 #-}
listFieldChecksum4 :: BuiltinData -> BuiltinUnit
listFieldChecksum4 record =
  let fields = BI.snd (BI.unsafeDataAsConstr record)
      checksum =
        BI.unsafeDataAsI (BI.head fields)
          + BI.unsafeDataAsI (BI.head (BI.drop 1 fields))
          + BI.unsafeDataAsI (BI.head (BI.drop 2 fields))
          + BI.unsafeDataAsI (BI.head (BI.drop 3 fields))
   in if checksum == 10 then BI.unitval else traceError "list field checksum failed"

{-# INLINABLE arrayFieldChecksum4 #-}
arrayFieldChecksum4 :: BuiltinData -> BuiltinUnit
arrayFieldChecksum4 record =
  let fields = BI.listToArray (BI.snd (BI.unsafeDataAsConstr record))
      checksum =
        BI.unsafeDataAsI (BI.indexArray fields 0)
          + BI.unsafeDataAsI (BI.indexArray fields 1)
          + BI.unsafeDataAsI (BI.indexArray fields 2)
          + BI.unsafeDataAsI (BI.indexArray fields 3)
   in if checksum == 10 then BI.unitval else traceError "array field checksum failed"

oldDecodedLeqCode :: CompiledCode (BuiltinData -> BuiltinUnit)
oldDecodedLeqCode = $$(PlutusTx.compile [||oldDecodedLeq||])

ledgerValueCoverageCode :: CompiledCode (BuiltinData -> BuiltinUnit)
ledgerValueCoverageCode = $$(PlutusTx.compile [||ledgerValueCoverage||])

typedLeqCode :: CompiledCode (V3.Value -> V3.Value -> BuiltinUnit)
typedLeqCode = $$(PlutusTx.compile [||typedLeq||])

addressOnlyCode :: CompiledCode (BuiltinData -> BuiltinUnit)
addressOnlyCode = $$(PlutusTx.compile [||addressOnly||])

baselineCode :: CompiledCode (BuiltinData -> BuiltinUnit)
baselineCode = $$(PlutusTx.compile [||baseline||])

listFieldChecksum3Code :: CompiledCode (BuiltinData -> BuiltinUnit)
listFieldChecksum3Code = $$(PlutusTx.compile [||listFieldChecksum3||])

arrayFieldChecksum3Code :: CompiledCode (BuiltinData -> BuiltinUnit)
arrayFieldChecksum3Code = $$(PlutusTx.compile [||arrayFieldChecksum3||])

listFieldChecksum4Code :: CompiledCode (BuiltinData -> BuiltinUnit)
listFieldChecksum4Code = $$(PlutusTx.compile [||listFieldChecksum4||])

arrayFieldChecksum4Code :: CompiledCode (BuiltinData -> BuiltinUnit)
arrayFieldChecksum4Code = $$(PlutusTx.compile [||arrayFieldChecksum4||])

main :: IO ()
main = do
  snapshotResult <- loadProtocol11Snapshot protocol11SnapshotPath
  snapshot <-
    case snapshotResult of
      Left err -> P.error err
      Right loaded -> P.pure loaded
  let machineParameters = snapshotMachineParameters snapshot
      required =
        canonicalValue
          [ (V3.adaSymbol, [(V3.adaToken, 10_000_000)])
          , (V3.CurrencySymbol "policy-a", [(V3.TokenName "", 3)])
          , (V3.CurrencySymbol "policy-b", [(V3.TokenName "token-b", 7)])
          ]
      paid =
        canonicalValue
          [ (V3.adaSymbol, [(V3.adaToken, 10_000_000)])
          , (V3.CurrencySymbol "policy-a", [(V3.TokenName "", 3), (V3.TokenName "extra", 11)])
          , (V3.CurrencySymbol "policy-b", [(V3.TokenName "token-b", 7)])
          , (V3.CurrencySymbol "policy-c", [(V3.TokenName "token-c", 13)])
          ]
      valuePair =
        BI.mkConstr
          0
          ( BI.mkCons
              (V3.toBuiltinData required)
              (BI.mkCons (V3.toBuiltinData paid) (BI.mkNilData BI.unitval))
          )
      adaRequired = canonicalValue [(V3.adaSymbol, [(V3.adaToken, 10_000_000)])]
      adaPaid = canonicalValue [(V3.adaSymbol, [(V3.adaToken, 10_000_001)])]
      adaValuePair =
        BI.mkConstr
          0
          ( BI.mkCons
              (V3.toBuiltinData adaRequired)
              (BI.mkCons (V3.toBuiltinData adaPaid) (BI.mkNilData BI.unitval))
          )
      destinationOutput =
        mkTxOut P.$
          withTxOutAddress (pubKeyAddress destinationPaymentKeyHash)
            P.<> withTxOutValue paid
      record3 =
        BI.mkConstr 0 P.$
          BI.mkCons (BI.mkI 1) P.$
            BI.mkCons (BI.mkI 2) P.$
              BI.mkCons (BI.mkI 3) (BI.mkNilData BI.unitval)
      record4 =
        BI.mkConstr 0 P.$
          BI.mkCons (BI.mkI 1) P.$
            BI.mkCons (BI.mkI 2) P.$
              BI.mkCons (BI.mkI 3) P.$
                BI.mkCons (BI.mkI 4) (BI.mkNilData BI.unitval)
      baselineBudget = evaluateApplied machineParameters baselineCode valuePair
      decodedLeqBudget = evaluateApplied machineParameters oldDecodedLeqCode valuePair
      rawCoverageBudget = evaluateApplied machineParameters ledgerValueCoverageCode valuePair
      adaDecodedLeqBudget = evaluateApplied machineParameters oldDecodedLeqCode adaValuePair
      adaRawCoverageBudget = evaluateApplied machineParameters ledgerValueCoverageCode adaValuePair
      typedLeqBudget =
        evaluateClosed machineParameters P.$
          typedLeqCode
            `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef required
            `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paid
      addressBudget = evaluateApplied machineParameters addressOnlyCode (V3.toBuiltinData destinationOutput)
      list3Budget = evaluateApplied machineParameters listFieldChecksum3Code record3
      array3Budget = evaluateApplied machineParameters arrayFieldChecksum3Code record3
      list4Budget = evaluateApplied machineParameters listFieldChecksum4Code record4
      array4Budget = evaluateApplied machineParameters arrayFieldChecksum4Code record4
  P.putStrLn "PV11 Value-builtin micro-profile (three-policy, five-asset paid value)"
  P.putStrLn "baseline data argument"
  P.print baselineBudget
  P.putStrLn "typed Value.leq (no unsafeFromBuiltinData boundary)"
  P.print typedLeqBudget
  P.putStrLn "unsafeFromBuiltinData + Value.leq"
  P.print decodedLeqBudget
  P.putStrLn "unsafeDataAsValue + native valueContains"
  P.print rawCoverageBudget
  P.putStrLn "destinationAddressV1 encoding"
  P.print addressBudget
  P.putStrLn "decode-boundary estimate = decoded+leq minus typed leq"
  P.print (minusBudget decodedLeqBudget typedLeqBudget)
  P.putStrLn "net address estimate = address minus baseline"
  P.print (minusBudget addressBudget baselineBudget)
  P.putStrLn "ADA-only unsafeFromBuiltinData + Value.leq"
  P.print adaDecodedLeqBudget
  P.putStrLn "ADA-only unsafeDataAsValue + native valueContains"
  P.print adaRawCoverageBudget
  P.putStrLn "three-field list/dropList projections"
  P.print list3Budget
  P.putStrLn "three-field listToArray/indexArray projections"
  P.print array3Budget
  P.putStrLn "four-field list/dropList projections"
  P.print list4Budget
  P.putStrLn "four-field listToArray/indexArray projections"
  P.print array4Budget

destinationPaymentKeyHash :: V3.PubKeyHash
destinationPaymentKeyHash =
  V3.PubKeyHash "1234567890123456789012345678"

evaluateApplied :: DefaultMachineParameters -> CompiledCode (BuiltinData -> BuiltinUnit) -> BuiltinData -> Budget
evaluateApplied machineParameters code argument =
  evaluateScript machineParameters P.$
    applyDataArgument (compiledToProgram code) argument

evaluateClosed :: DefaultMachineParameters -> CompiledCode BuiltinUnit -> Budget
evaluateClosed machineParameters = evaluateScript machineParameters . compiledToProgram

compiledToProgram :: CompiledCode a -> Script
compiledToProgram code =
  let script =
        either (P.error P.. ("failed to deserialise compiled script: " P.<>) P.. P.show) P.id P.$
          V3.deserialiseScript protocolVersion (V3.serialiseCompiledCode code)
      ScriptNamedDeBruijn program = deserialisedScript script
   in toNameless program

toNameless ::
  UPLC.Program UPLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun () ->
  Script
toNameless (UPLC.Program ann version term) =
  UPLC.Program ann version (UPLC.termMapNames UPLC.unNameDeBruijn term)

applyDataArgument :: Script -> BuiltinData -> Script
applyDataArgument (UPLC.Program ann version term) argument =
  UPLC.Program ann version P.$
    PLC.mkIterAppNoAnn term [PLC.mkConstant () (V3.toData argument)]

evaluateScript :: DefaultMachineParameters -> Script -> Budget
evaluateScript machineParameters (UPLC.Program _ _ term) =
  let namedTerm = UPLC.termMapNames UPLC.fakeNameDeBruijn term
   in case Cek.runCekDeBruijn
        machineParameters
        (Cek.restricting (ExRestrictingBudget countingBudget))
        Cek.logEmitter
        namedTerm of
        Cek.CekReport result (Cek.RestrictingSt (ExRestrictingBudget finalBudget)) logs ->
          case result of
            Cek.CekFailure err ->
              P.error ("script evaluation failed: " P.<> P.show err P.<> "; logs=" P.<> P.show logs)
            _ -> fromExBudget (countingBudget `minusExBudget` finalBudget)

countingBudget :: ExBudget
countingBudget = ExBudget (ExCPU P.maxBound) (ExMemory P.maxBound)

fromExBudget :: ExBudget -> Budget
fromExBudget (ExBudget (ExCPU cpu) (ExMemory memory)) =
  Budget
    { budgetMemory = V3.fromSatInt memory
    , budgetCpu = V3.fromSatInt cpu
    }

minusBudget :: Budget -> Budget -> Budget
minusBudget left right =
  Budget
    { budgetMemory = budgetMemory left - budgetMemory right
    , budgetCpu = budgetCpu left - budgetCpu right
    }

protocolVersion :: V3.MajorProtocolVersion
protocolVersion = V3.MajorProtocolVersion 11

protocol11SnapshotPath :: P.FilePath
protocol11SnapshotPath = "bench/results/preprod-protocol-v11-epoch-300.json"

-- | Benchmark fixtures use the same domain as the production walker: sorted,
-- unique policy/token lists with strictly positive represented quantities.
-- Constructing a typed Value first avoids measuring arbitrary raw Data that
-- cannot be a ledger-built TxOut value.
canonicalValue :: [(V3.CurrencySymbol, [(V3.TokenName, Integer)])] -> V3.Value
canonicalValue policies =
  V3.Value $
    Map.unsafeFromList
      [ (policyId, Map.unsafeFromList tokens)
      | (policyId, tokens) <- policies
      ]
