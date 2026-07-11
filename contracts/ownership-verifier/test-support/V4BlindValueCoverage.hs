{-# LANGUAGE NumericUnderscores #-}
{-# LANGUAGE OverloadedStrings #-}

-- | Blind V4 value-coverage vectors for the exported V1 comparator.
-- Fixtures are typed, canonical, positive V3 Values placed in TxOut value
-- fields, so the comparator receives the ledger-shaped data it relies on.
module V4BlindValueCoverage (v4BlindValueCoverageTests) where

import Ownership.ReclaimGlobal (valueCoversData)
import qualified PlutusLedgerApi.V3 as V3
import qualified PlutusTx.AssocMap as Map
import qualified PlutusTx.Builtins.Internal as BI
import ScriptContextBuilder
  ( mkTxOut
  , pubKeyAddress
  , withTxOutAddress
  , withTxOutValue
  )
import Test.Tasty (TestTree, testGroup)
import Test.Tasty.HUnit ((@?=), testCase)

v4BlindValueCoverageTests :: TestTree
v4BlindValueCoverageTests =
  testGroup
    "V4 blind value coverage vectors"
    [ testCase "accepts a canonical multi-policy TxOut-value superset" $
        assertCoverage
          True
          ( canonicalValue
              [ (V3.adaSymbol, [(V3.adaToken, 10_000_000)])
              , (policyA, [(V3.TokenName "", 3), (V3.TokenName "b", 5)])
              , (policyB, [(V3.TokenName "a", 7)])
              ]
          )
          ( canonicalValue
              [ (V3.adaSymbol, [(V3.adaToken, 10_000_000)])
              , (policyA, [(V3.TokenName "", 3), (V3.TokenName "a", 99), (V3.TokenName "b", 5)])
              , (policyB, [(V3.TokenName "a", 8)])
              , (policyC, [(V3.TokenName "", 1)])
              ]
          )
    , testCase "rejects a one-unit underpayment at the required policy and token" $
        assertCoverage
          False
          ( canonicalValue
              [ (V3.adaSymbol, [(V3.adaToken, 10_000_000)])
              , (policyA, [(V3.TokenName "", 5)])
              ]
          )
          ( canonicalValue
              [ (V3.adaSymbol, [(V3.adaToken, 11_000_000)])
              , (policyA, [(V3.TokenName "", 4)])
              , (policyB, [(V3.TokenName "", 5)])
              ]
          )
    , testCase "rejects a matching token name and quantity under the wrong policy" $
        assertCoverage
          False
          ( canonicalValue
              [ (V3.adaSymbol, [(V3.adaToken, 10_000_000)])
              , (policyA, [(V3.TokenName "", 5)])
              ]
          )
          ( canonicalValue
              [ (V3.adaSymbol, [(V3.adaToken, 10_000_000)])
              , (policyB, [(V3.TokenName "", 5)])
              ]
          )
    ]

assertCoverage :: Bool -> V3.Value -> V3.Value -> IO ()
assertCoverage expected required paid =
  builtinBoolToBool (valueCoversData (txOutValueData required) (txOutValueData paid)) @?= expected

builtinBoolToBool :: BI.BuiltinBool -> Bool
builtinBoolToBool condition =
  BI.ifThenElse condition (\_ -> True) (\_ -> False) BI.unitval

-- | All call sites list unique policies and token names in ledger byte order,
-- and use strictly positive quantities.  Keeping the construction typed avoids
-- testing hand-crafted BuiltinData maps rather than ledger TxOut values.
canonicalValue :: [(V3.CurrencySymbol, [(V3.TokenName, Integer)])] -> V3.Value
canonicalValue policies =
  V3.Value $
    Map.unsafeFromList
      [ (policyId, Map.unsafeFromList tokens)
      | (policyId, tokens) <- policies
      ]

-- | This mirrors the V1 call site: serialize the typed value that is actually
-- stored in a TxOut field instead of constructing Value Data directly.
txOutValueData :: V3.Value -> V3.BuiltinData
txOutValueData value =
  V3.toBuiltinData (V3.txOutValue (coverageOutput value))

coverageOutput :: V3.Value -> V3.TxOut
coverageOutput value =
  mkTxOut $
    withTxOutAddress (pubKeyAddress (V3.PubKeyHash "dddddddddddddddddddddddddddd"))
      <> withTxOutValue value

policyA :: V3.CurrencySymbol
policyA = V3.CurrencySymbol "1111111111111111111111111111"

policyB :: V3.CurrencySymbol
policyB = V3.CurrencySymbol "2222222222222222222222222222"

policyC :: V3.CurrencySymbol
policyC = V3.CurrencySymbol "3333333333333333333333333333"
