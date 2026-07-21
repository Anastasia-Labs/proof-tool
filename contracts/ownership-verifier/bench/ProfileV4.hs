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
import PlutusCore.Evaluation.Machine.ExBudgetingDefaults (defaultCekParametersForTesting)
import PlutusCore.Evaluation.Machine.ExMemory (ExCPU (..), ExMemory (..))
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
  BI.ifThenElse
    (valueCoversData (firstField pairData) (secondField pairData))
    (\_ -> BI.unitval)
    (\_ -> traceError "ledger value coverage failed")
    BI.unitval

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

main :: IO ()
main = do
  let required =
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
      baselineBudget = evaluateApplied baselineCode valuePair
      decodedLeqBudget = evaluateApplied oldDecodedLeqCode valuePair
      rawCoverageBudget = evaluateApplied ledgerValueCoverageCode valuePair
      adaDecodedLeqBudget = evaluateApplied oldDecodedLeqCode adaValuePair
      adaRawCoverageBudget = evaluateApplied ledgerValueCoverageCode adaValuePair
      typedLeqBudget =
        evaluateClosed P.$
          typedLeqCode
            `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef required
            `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paid
      addressBudget = evaluateApplied addressOnlyCode (V3.toBuiltinData destinationOutput)
  P.putStrLn "Ledger-invariant V4 pre/post micro-profile (three-policy, five-asset paid value)"
  P.putStrLn "baseline data argument"
  P.print baselineBudget
  P.putStrLn "typed Value.leq (no unsafeFromBuiltinData boundary)"
  P.print typedLeqBudget
  P.putStrLn "unsafeFromBuiltinData + Value.leq"
  P.print decodedLeqBudget
  P.putStrLn "ledger-normalized raw Value-field coverage"
  P.print rawCoverageBudget
  P.putStrLn "destinationAddressV1 encoding"
  P.print addressBudget
  P.putStrLn "decode-boundary estimate = decoded+leq minus typed leq"
  P.print (minusBudget decodedLeqBudget typedLeqBudget)
  P.putStrLn "net address estimate = address minus baseline"
  P.print (minusBudget addressBudget baselineBudget)
  P.putStrLn "ADA-only unsafeFromBuiltinData + Value.leq"
  P.print adaDecodedLeqBudget
  P.putStrLn "ADA-only ledger-normalized raw Value-field coverage"
  P.print adaRawCoverageBudget

destinationPaymentKeyHash :: V3.PubKeyHash
destinationPaymentKeyHash =
  V3.PubKeyHash "1234567890123456789012345678"

evaluateApplied :: CompiledCode (BuiltinData -> BuiltinUnit) -> BuiltinData -> Budget
evaluateApplied code argument =
  evaluateScript P.$
    applyDataArgument (compiledToProgram code) argument

evaluateClosed :: CompiledCode BuiltinUnit -> Budget
evaluateClosed = evaluateScript . compiledToProgram

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

evaluateScript :: Script -> Budget
evaluateScript (UPLC.Program _ _ term) =
  let namedTerm = UPLC.termMapNames UPLC.fakeNameDeBruijn term
   in case Cek.runCekDeBruijn
        defaultCekParametersForTesting
        (Cek.restricting (ExRestrictingBudget countingBudget))
        Cek.logEmitter
        namedTerm of
        (Right _, Cek.RestrictingSt (ExRestrictingBudget finalBudget), _) ->
          fromExBudget (countingBudget `minusExBudget` finalBudget)
        (Left err, _, logs) ->
          P.error ("script evaluation failed: " P.<> P.show err P.<> "; logs=" P.<> P.show logs)

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
