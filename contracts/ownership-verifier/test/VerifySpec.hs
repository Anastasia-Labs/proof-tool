{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

module Main (main) where

import Control.Exception (SomeException, evaluate, try)
import Data.Char (digitToInt, isHexDigit)

import qualified PlutusTx.Builtins as B
import PlutusTx.Builtins (BuiltinByteString, BuiltinData)
import qualified PlutusTx.Builtins.Internal as BI

import Ownership.OneShotNFT (oneShotNFTPolicy)
import Ownership.ReclaimBase (ReclaimBaseDatum (..), reclaimBaseValidator)
import Ownership.ReclaimGlobal
  ( reclaimGlobalParamsData
  , reclaimGlobalRedeemerData
  , reclaimGlobalValidator
  )
import Ownership.ReclaimGlobalMulti
  ( destinationAddressV1FromTxOutData
  , multiCredentialCountU16BE
  , multiCredentialPublicInputDigest
  , multiOwnershipDomain
  , reclaimGlobalMultiRedeemerData
  , reclaimGlobalMultiValidator
  , validateMultiReclaimInputsWithProofCheck
  )
import Ownership.Verify
  ( ownershipDestinationDomain
  , ownershipDestinationPublicInputDigest
  , ownershipDomain
  , ownershipPublicInputDigest
  , verifyOwnershipWithVK
  )
import qualified PlutusLedgerApi.V3 as V3
import ScriptContextBuilder

import Test.Tasty
import Test.Tasty.HUnit

decodeHex :: String -> [Integer]
decodeHex = go . filter isHexDigit
  where
    go (hi : lo : rest) = fromIntegral (digitToInt hi * 16 + digitToInt lo) : go rest
    go [] = []
    go [_] = error "decodeHex: odd number of hex digits"

bytesToBuiltin :: [Integer] -> BuiltinByteString
bytesToBuiltin = foldr B.consByteString B.emptyByteString

readBuiltinHex :: FilePath -> IO BuiltinByteString
readBuiltinHex path = bytesToBuiltin . decodeHex <$> readFile path

tamperProof :: BuiltinByteString -> BuiltinByteString
tamperProof proof =
  B.consByteString 0 (B.sliceByteString 1 335 proof)

safeVerify :: BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> IO Bool
safeVerify vk proof pkh = do
  r <- try (evaluate (verifyOwnershipWithVK vk proof pkh))
  pure $ case r of
    Left (_ :: SomeException) -> False
    Right ok                  -> ok

safeBool :: Bool -> IO Bool
safeBool value = do
  r <- try (evaluate value)
  pure $ case r of
    Left (_ :: SomeException) -> False
    Right ok                  -> ok

runReclaimGlobal :: BuiltinByteString -> V3.ScriptContext -> Bool
runReclaimGlobal verifierKey ctx =
  reclaimGlobalValidator paramCurrencySymbol verifierKey (V3.toBuiltinData ctx)

runReclaimGlobalMulti :: BuiltinByteString -> V3.ScriptContext -> Bool
runReclaimGlobalMulti verifierKey ctx =
  reclaimGlobalMultiValidator paramCurrencySymbol verifierKey (V3.toBuiltinData ctx)

main :: IO ()
main = do
  vk <- readBuiltinHex "testdata/ownership-vk.hex"
  proof <- readBuiltinHex "testdata/ownership-proof.hex"
  destinationVk <- readBuiltinHex "testdata/ownership-destination-vk.hex"
  destinationProof <- readBuiltinHex "testdata/ownership-destination-proof.hex"
  destinationPub <- readBuiltinHex "testdata/ownership-destination-pub.hex"
  multiVk <- readBuiltinHex "testdata/multi-count2-vk.hex"
  multiProof <- readBuiltinHex "testdata/multi-count2-proof.hex"
  multiPub <- readBuiltinHex "testdata/multi-count2-pub.hex"
  let pkh = goldenPaymentKeyHash
      wrongPkh = wrongPaymentKeyHash

  defaultMain $ testGroup "ownership-verifier"
    [ testGroup "Ownership.Verify"
        [ testCase "public input digest binds the ownership domain and payment key hash" $
            ownershipPublicInputDigest pkh @?= B.blake2b_256 (ownershipDomain <> pkh)
        , testCase "destination public input digest binds payment key hash and destination address" $ do
            ownershipDestinationPublicInputDigest pkh destinationAddressBytes
              @?= B.blake2b_256 (ownershipDestinationDomain <> pkh <> destinationAddressBytes)
            destinationPub @?= ownershipDestinationPublicInputDigest pkh destinationAddressBytes
        , testCase "rejects non-28-byte payment key hashes before proof parsing" $
            verifyOwnershipWithVK "" "" "short" @?= False
        , testCase "accepts the exported real ownership proof for its payment key hash" $ do
            ok <- safeVerify vk proof pkh
            ok @?= True
        , testCase "rejects the exported proof for a different payment key hash" $ do
            ok <- safeVerify vk proof wrongPkh
            ok @?= False
        ]
    , testGroup "Ownership.OneShotNFT"
        [ testCase "accepts when the seed UTxO is spent and one own token is minted" $
            oneShotNFTPolicy seedRef (mintingContext [seedRef] (mintValue [(ownSymbol, [(tokenName, 1)])]))
              @?= True
        , testCase "rejects when the seed UTxO is not spent" $
            oneShotNFTPolicy seedRef (mintingContext [otherRef] (mintValue [(ownSymbol, [(tokenName, 1)])]))
              @?= False
        , testCase "rejects multiple own tokens" $
            oneShotNFTPolicy seedRef (mintingContext [seedRef] (mintValue [(ownSymbol, [(tokenName, 2)])]))
              @?= False
        , testCase "rejects own burns mixed with the mint" $
            oneShotNFTPolicy seedRef (mintingContext [seedRef] (mintValue [(ownSymbol, [(tokenName, 1), (otherTokenName, -1)])]))
              @?= False
        , testCase "ignores minting under other policies when exactly one own token is minted" $
            oneShotNFTPolicy seedRef (mintingContext [seedRef] (mintValue [(ownSymbol, [(tokenName, 1)]), (otherSymbol, [(otherTokenName, 10)])]))
              @?= True
        ]
    , testGroup "Ownership.ReclaimBase"
        [ testCase "accepts a spending context with datum and global withdrawal" $
            reclaimBaseValidator globalCredential (reclaimBaseContext (Just validBaseDatum) [(globalCredential, 0)])
              @?= True
        , testCase "ignores the global withdrawal amount" $
            reclaimBaseValidator globalCredential (reclaimBaseContext (Just validBaseDatum) [(globalCredential, 1234567)])
              @?= True
        , testCase "rejects when the global withdrawal is missing" $
            reclaimBaseValidator globalCredential (reclaimBaseContext (Just validBaseDatum) [])
              @?= False
        , testCase "rejects missing datum" $
            reclaimBaseValidator globalCredential (reclaimBaseContext Nothing [(globalCredential, 0)])
              @?= False
        , testCase "rejects non-28-byte datum key hash" $
            reclaimBaseValidator globalCredential (reclaimBaseContext (Just invalidBaseDatum) [(globalCredential, 0)])
              @?= False
        , testCase "rejects a key credential even when its withdrawal is present" $
            reclaimBaseValidator keyGlobalCredential (reclaimBaseContext (Just validBaseDatum) [(keyGlobalCredential, 0)])
              @?= False
        ]
    , testGroup "Ownership.ReclaimGlobal"
        [ testCase "accepts one reclaim base input with its real proof" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [paramInput])
            ok @?= True
        , testCase "rejects spending-script context even with a valid reclaim proof" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalSpendingContext destinationProof 0 [reclaimBaseInput] [paramInput])
            ok @?= False
        , testCase "rejects minting-script context even with a valid reclaim proof" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalMintingContext destinationProof 0 [reclaimBaseInput] [paramInput])
            ok @?= False
        , testCase "rejects invalid parameter reference index" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 1 [reclaimBaseInput] [paramInput])
            ok @?= False
        , testCase "rejects proof for a different base datum owner" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInputWithDatum (ReclaimBaseDatum wrongPaymentKeyHash)] [paramInput])
            ok @?= False
        , testCase "rejects parameter reference without the parameter NFT" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [paramInputWithValue mempty])
            ok @?= False
        , testCase "rejects parameter reference without inline params datum" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [paramInputWithoutDatum])
            ok @?= False
        , testCase "rejects unused proofs when no reclaim base inputs exist" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [txIn otherRef] [paramInput])
            ok @?= False
        , testCase "skips non-base inputs while consuming proofs for base inputs" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [txIn otherRef, reclaimBaseInput] [paramInput])
            ok @?= True
        , testCase "rejects missing proof for a reclaim base input" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithProofs [] 0 [reclaimBaseInput] [paramInput])
            ok @?= False
        , testCase "rejects malformed datum on a matching reclaim base input" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInputWithDatum invalidBaseDatum] [paramInput])
            ok @?= False
        , testCase "rejects destination redirection" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof]
                  0
                  [reclaimBaseInput]
                  [paramInput]
                  [pubKeyOutput wrongPaymentKeyHash reclaimValue])
            ok @?= False
        , testCase "accepts two inputs with duplicate owner proofs and corresponding destination outputs" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof, destinationProof]
                  0
                  [reclaimBaseInput, secondReclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, singleDestinationOutput])
            ok @?= True
        , testCase "rejects a destination output that underpays the input value" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof]
                  0
                  [reclaimBaseInput]
                  [paramInput]
                  [underpaidSingleDestinationOutput])
            ok @?= False
        , testCase "rejects a destination start index that points at another output" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputsAt
                  [destinationProof]
                  0
                  1
                  [reclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, changedSingleDestinationOutput])
            ok @?= False
        , testCase "accepts destination outputs after the provided start index" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputsAt
                  [destinationProof]
                  0
                  1
                  [reclaimBaseInput]
                  [paramInput]
                  [changedSingleDestinationOutput, singleDestinationOutput])
            ok @?= True
        , testCase "rejects a changed duplicate proof for the same owner" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithProofs
                  [destinationProof, tamperProof destinationProof]
                  0
                  [reclaimBaseInput, secondReclaimBaseInput]
                  [paramInput])
            ok @?= False
        ]
    , testGroup "Ownership.ReclaimGlobalMulti"
        [ testCase "encodes the fixed-byte multi public input digest" $
            multiCredentialPublicInputDigest 2 twoCredentialBytes destinationAddressBytes
              @?= B.blake2b_256
                ( multiOwnershipDomain
                    <> multiCredentialCountU16BE 2
                    <> twoCredentialBytes
                    <> destinationAddressBytes
                )
        , testCase "encodes destination addresses as payment tag/hash plus no-stake tag/zero hash" $
            destinationAddressV1FromTxOutData (V3.toBuiltinData exactDestinationOutput)
              @?= destinationAddressBytes
        , testCase "exported multi pub fixture equals the contract digest" $
            multiPub @?= multiCredentialPublicInputDigest 2 twoCredentialBytes destinationAddressBytes
        , testCase "core logic accepts two reclaim-base inputs when one multi proof matches the batch digest" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 2 twoCredentialBytes destinationAddressBytes)
                baseScriptHashData
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= True
        , testCase "rejects when the proof omits a matching credential" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 1 goldenPaymentKeyHash destinationAddressBytes)
                baseScriptHashData
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects when the proof changes a matching credential" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 2 (goldenPaymentKeyHash <> thirdPaymentKeyHash) destinationAddressBytes)
                baseScriptHashData
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects when the proof reorders credentials" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 2 (secondPaymentKeyHash <> goldenPaymentKeyHash) destinationAddressBytes)
                baseScriptHashData
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects when the destination output address changes" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 2 twoCredentialBytes destinationAddressBytes)
                baseScriptHashData
                (txOutListData [changedDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects aggregate underpayment" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashData
                (txOutListData [underpaidDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "accepts aggregate exact payment" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashData
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= True
        , testCase "accepts aggregate overpayment" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashData
                (txOutListData [overpaidDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= True
        , testCase "accepts aggregate split across contiguous destination outputs" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashData
                (txOutListData splitDestinationOutputs)
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= True
        , testCase "stops aggregate scan at the first different destination address" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashData
                (txOutListData splitDestinationOutputsWithGap)
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects native-asset underpayment even when lovelace is covered" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashData
                (txOutListData [missingNativeAssetDestinationOutput])
                (txInListData [multiAssetReclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects when no reclaim-base inputs are present" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashData
                (txOutListData [exactDestinationOutput])
                (txInListData [txIn otherRef])
            ok @?= False
        , testCase "rejects an out-of-bounds destination output index" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                vk
                (reclaimGlobalMultiContext proof 0 1 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= False
        , testCase "rejects a negative destination output index" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                vk
                (reclaimGlobalMultiContext proof 0 (-1) [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= False
        , testCase "allows duplicate credentials when every matching input is represented in order" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 2 (goldenPaymentKeyHash <> goldenPaymentKeyHash) destinationAddressBytes)
                baseScriptHashData
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, secondReclaimBaseInput])
            ok @?= True
        , testCase "does not accept the single-credential proof as a multi-credential proof" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                vk
                (reclaimGlobalMultiContext proof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= False
        , testCase "accepts two reclaim-base inputs with the exported real multi proof" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= True
        , testCase "real multi proof accepts contiguous same-address destination outputs" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] splitDestinationOutputs)
            ok @?= True
        , testCase "real multi proof accepts destination run after the provided start index" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 1 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] (changedDestinationOutput : splitDestinationOutputs))
            ok @?= True
        , testCase "real multi proof rejects swapped txInfoInputs order" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [differentOwnerReclaimBaseInput, reclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= False
        , testCase "real multi proof rejects a changed credential datum" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, thirdOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= False
        , testCase "real multi proof rejects a changed destination address" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [changedDestinationOutput])
            ok @?= False
        , testCase "real multi proof rejects when destination index points at another output" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 1 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput, changedDestinationOutput])
            ok @?= False
        , testCase "real multi proof rejects aggregate underpayment" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [underpaidDestinationOutput])
            ok @?= False
        , testCase "real multi proof ignores later same-address output after a gap" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] splitDestinationOutputsWithGap)
            ok @?= False
        , testCase "real multi proof rejects native-asset underpayment" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [multiAssetReclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [missingNativeAssetDestinationOutput])
            ok @?= False
        , testCase "real multi proof rejects no matching reclaim-base inputs" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [txIn otherRef] [paramInput] [exactDestinationOutput])
            ok @?= False
        ]
    ]

goldenPaymentKeyHash :: BuiltinByteString
goldenPaymentKeyHash =
  bytesToBuiltin (decodeHex "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")

wrongPaymentKeyHash :: BuiltinByteString
wrongPaymentKeyHash =
  bytesToBuiltin (decodeHex "18e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")

secondPaymentKeyHash :: BuiltinByteString
secondPaymentKeyHash =
  bytesToBuiltin (decodeHex "155a68f5db6e170a0f0c7d211c24dce882b23e18244f1f142a5fa377")

thirdPaymentKeyHash :: BuiltinByteString
thirdPaymentKeyHash =
  bytesToBuiltin (decodeHex "17e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")

destinationPaymentKeyHash :: BuiltinByteString
destinationPaymentKeyHash =
  bytesToBuiltin (decodeHex "0038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da111")

seedRef :: V3.TxOutRef
seedRef =
  V3.TxOutRef
    { V3.txOutRefId = V3.TxId "seed"
    , V3.txOutRefIdx = 0
    }

otherRef :: V3.TxOutRef
otherRef =
  V3.TxOutRef
    { V3.txOutRefId = V3.TxId "other"
    , V3.txOutRefIdx = 1
    }

ownSymbol :: V3.CurrencySymbol
ownSymbol = V3.CurrencySymbol "own-policy"

otherSymbol :: V3.CurrencySymbol
otherSymbol = V3.CurrencySymbol "other-policy"

tokenName :: V3.TokenName
tokenName = V3.TokenName "params"

otherTokenName :: V3.TokenName
otherTokenName = V3.TokenName "other"

globalCredential :: V3.Credential
globalCredential = V3.ScriptCredential globalScriptHash

globalScriptHash :: V3.ScriptHash
globalScriptHash = V3.ScriptHash "global-reclaim"

keyGlobalCredential :: V3.Credential
keyGlobalCredential = V3.PubKeyCredential (V3.PubKeyHash "key-global")

baseScriptHash :: V3.ScriptHash
baseScriptHash = V3.ScriptHash "reclaim-base"

paramCurrencySymbol :: V3.CurrencySymbol
paramCurrencySymbol = V3.CurrencySymbol "param-policy"

paramTokenName :: V3.TokenName
paramTokenName = V3.TokenName "params"

validBaseDatum :: ReclaimBaseDatum
validBaseDatum = ReclaimBaseDatum goldenPaymentKeyHash

invalidBaseDatum :: ReclaimBaseDatum
invalidBaseDatum = ReclaimBaseDatum "short"

reclaimValue :: V3.Value
reclaimValue = V3.singleton V3.adaSymbol V3.adaToken 2000000

aggregateTwoReclaimValue :: V3.Value
aggregateTwoReclaimValue =
  V3.singleton V3.adaSymbol V3.adaToken 4000000

underpaidTwoReclaimValue :: V3.Value
underpaidTwoReclaimValue =
  V3.singleton V3.adaSymbol V3.adaToken 3999999

overpaidTwoReclaimValue :: V3.Value
overpaidTwoReclaimValue =
  V3.singleton V3.adaSymbol V3.adaToken 5000000

multiAssetReclaimValue :: V3.Value
multiAssetReclaimValue =
  reclaimValue <> V3.singleton otherSymbol otherTokenName 5

mintValue :: [(V3.CurrencySymbol, [(V3.TokenName, Integer)])] -> V3.Value
mintValue entries =
  mconcat
    [ V3.singleton currencySymbol tokenName' amount
    | (currencySymbol, tokens) <- entries
    , (tokenName', amount) <- tokens
    ]

mintingContext :: [V3.TxOutRef] -> V3.Value -> V3.ScriptContext
mintingContext inputs minted =
  buildScriptContext $
    foldMap (withTxIn . txIn) inputs
      <> withMintValue minted
      <> withMintingPolicy ownSymbol (V3.toBuiltinData ())

reclaimBaseContext :: Maybe ReclaimBaseDatum -> [(V3.Credential, V3.Lovelace)] -> V3.ScriptContext
reclaimBaseContext datum withdrawals =
  buildScriptContext $
    foldMap (uncurry withWithdrawal) withdrawals
      <> withSpendingScript
        (V3.toBuiltinData ())
        ( withOutRef seedRef
            <> withAddress (scriptAddress baseScriptHash)
            <> maybe mempty (withInlineDatum . V3.toBuiltinData) datum
        )

reclaimGlobalContext ::
  BuiltinByteString ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  V3.ScriptContext
reclaimGlobalContext proof paramsIdx inputs refs =
  reclaimGlobalContextWithProofs [proof] paramsIdx inputs refs

reclaimGlobalContextWithProofs ::
  [BuiltinByteString] ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  V3.ScriptContext
reclaimGlobalContextWithProofs proofs paramsIdx inputs refs =
  reclaimGlobalContextWithOutputs proofs paramsIdx inputs refs (replicate (length proofs) singleDestinationOutput)

reclaimGlobalContextWithOutputs ::
  [BuiltinByteString] ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  [V3.TxOut] ->
  V3.ScriptContext
reclaimGlobalContextWithOutputs proofs paramsIdx inputs refs outputs =
  reclaimGlobalContextWithOutputsAt proofs paramsIdx 0 inputs refs outputs

reclaimGlobalContextWithOutputsAt ::
  [BuiltinByteString] ->
  Integer ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  [V3.TxOut] ->
  V3.ScriptContext
reclaimGlobalContextWithOutputsAt proofs paramsIdx destinationOutStartIdx inputs refs outputs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> foldMap withTxOut outputs
      <> withRewardingScript
        (reclaimGlobalRedeemerData paramsIdx destinationOutStartIdx proofs)
        globalCredential
        0

reclaimGlobalSpendingContext ::
  BuiltinByteString ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  V3.ScriptContext
reclaimGlobalSpendingContext proof paramsIdx inputs refs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> withTxOut singleDestinationOutput
      <> withSpendingScript
        (reclaimGlobalRedeemerData paramsIdx 0 [proof])
        ( withOutRef otherRef
            <> withAddress (scriptAddress globalScriptHash)
            <> withValue reclaimValue
            <> withInlineDatum (V3.toBuiltinData ())
        )

reclaimGlobalMintingContext ::
  BuiltinByteString ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  V3.ScriptContext
reclaimGlobalMintingContext proof paramsIdx inputs refs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> withTxOut singleDestinationOutput
      <> withMintingScript
        (V3.singleton ownSymbol tokenName 1)
        (reclaimGlobalRedeemerData paramsIdx 0 [proof])

reclaimGlobalMultiContext ::
  BuiltinByteString ->
  Integer ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  [V3.TxOut] ->
  V3.ScriptContext
reclaimGlobalMultiContext proof paramsIdx destinationIdx inputs refs outputs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> foldMap withTxOut outputs
      <> withRewardingScript
        (reclaimGlobalMultiRedeemerData paramsIdx destinationIdx proof)
        globalCredential
        0

pubKeyOutput :: BuiltinByteString -> V3.Value -> V3.TxOut
pubKeyOutput paymentKeyHash value =
  mkTxOut $
    withTxOutAddress (pubKeyAddress (V3.PubKeyHash paymentKeyHash))
      <> withTxOutValue value

txIn :: V3.TxOutRef -> V3.TxInInfo
txIn ref =
  mkInput $
    withOutRef ref
      <> withAddress (pubKeyAddress (V3.PubKeyHash "owner"))

reclaimBaseInput :: V3.TxInInfo
reclaimBaseInput = reclaimBaseInputAt "base" 0

secondReclaimBaseInput :: V3.TxInInfo
secondReclaimBaseInput = reclaimBaseInputAt "base-2" 1

differentOwnerReclaimBaseInput :: V3.TxInInfo
differentOwnerReclaimBaseInput =
  reclaimBaseInputAtWithDatum "base-different" 1 (ReclaimBaseDatum secondPaymentKeyHash)

thirdOwnerReclaimBaseInput :: V3.TxInInfo
thirdOwnerReclaimBaseInput =
  reclaimBaseInputAtWithDatum "base-third" 1 (ReclaimBaseDatum thirdPaymentKeyHash)

multiAssetReclaimBaseInput :: V3.TxInInfo
multiAssetReclaimBaseInput =
  reclaimBaseInputAtWithValueAndDatum "base-token" 0 multiAssetReclaimValue validBaseDatum

reclaimBaseInputWithDatum :: ReclaimBaseDatum -> V3.TxInInfo
reclaimBaseInputWithDatum datum =
  reclaimBaseInputAtWithDatum "base-invalid" 0 datum

reclaimBaseInputAt :: BuiltinByteString -> Integer -> V3.TxInInfo
reclaimBaseInputAt txId idx =
  reclaimBaseInputAtWithDatum txId idx validBaseDatum

reclaimBaseInputAtWithDatum :: BuiltinByteString -> Integer -> ReclaimBaseDatum -> V3.TxInInfo
reclaimBaseInputAtWithDatum txId idx datum =
  reclaimBaseInputAtWithValueAndDatum txId idx reclaimValue datum

reclaimBaseInputAtWithValueAndDatum ::
  BuiltinByteString ->
  Integer ->
  V3.Value ->
  ReclaimBaseDatum ->
  V3.TxInInfo
reclaimBaseInputAtWithValueAndDatum txId idx value datum =
  mkInput $
    withOutRef
      ( V3.TxOutRef
        { V3.txOutRefId = V3.TxId txId
        , V3.txOutRefIdx = idx
        }
      )
      <> withAddress (scriptAddress baseScriptHash)
      <> withValue value
      <> withInlineDatum (V3.toBuiltinData datum)

paramInput :: V3.TxInInfo
paramInput =
  paramInputWithValue (V3.singleton paramCurrencySymbol paramTokenName 1)

paramInputWithValue :: V3.Value -> V3.TxInInfo
paramInputWithValue value =
  mkInput $
    paramInputBuilder
      <> withValue (paramAdaValue <> value)
      <> withInlineDatum
        (reclaimGlobalParamsData baseScriptHash)

paramInputWithoutDatum :: V3.TxInInfo
paramInputWithoutDatum =
  mkInput $
    paramInputBuilder
      <> withValue (paramAdaValue <> V3.singleton paramCurrencySymbol paramTokenName 1)

paramInputBuilder :: InputBuilder
paramInputBuilder =
  withOutRef
    ( V3.TxOutRef
      { V3.txOutRefId = V3.TxId "params"
      , V3.txOutRefIdx = 0
      }
    )
    <> withAddress (scriptAddress (V3.ScriptHash "always-fails"))

paramAdaValue :: V3.Value
paramAdaValue =
  V3.singleton V3.adaSymbol V3.adaToken 2000000

baseScriptHashData :: BuiltinData
baseScriptHashData =
  case baseScriptHash of
    V3.ScriptHash rawHash -> BI.mkB rawHash

txInListData :: [V3.TxInInfo] -> BI.BuiltinList BuiltinData
txInListData =
  BI.unsafeDataAsList . V3.toBuiltinData

txOutListData :: [V3.TxOut] -> BI.BuiltinList BuiltinData
txOutListData =
  BI.unsafeDataAsList . V3.toBuiltinData

proofMatches ::
  Integer ->
  BuiltinByteString ->
  BuiltinByteString ->
  Integer ->
  BuiltinByteString ->
  BuiltinByteString ->
  Bool
proofMatches expectedCount expectedCredentials expectedDestination actualCount actualCredentials actualDestination =
  actualCount == expectedCount
    && actualCredentials == expectedCredentials
    && actualDestination == expectedDestination

proofMatchesActual :: Integer -> BuiltinByteString -> BuiltinByteString -> Bool
proofMatchesActual _ _ _ = True

zeroBytes :: Int -> BuiltinByteString
zeroBytes count =
  bytesToBuiltin (replicate count 0)

destinationAddressBytesFor :: BuiltinByteString -> BuiltinByteString
destinationAddressBytesFor paymentKeyHash =
  bytesToBuiltin [1] <> paymentKeyHash <> bytesToBuiltin [0] <> zeroBytes 28

destinationAddressBytes :: BuiltinByteString
destinationAddressBytes =
  destinationAddressBytesFor destinationPaymentKeyHash

twoCredentialBytes :: BuiltinByteString
twoCredentialBytes =
  goldenPaymentKeyHash <> secondPaymentKeyHash

singleDestinationOutput :: V3.TxOut
singleDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash reclaimValue

underpaidSingleDestinationOutput :: V3.TxOut
underpaidSingleDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash (V3.singleton V3.adaSymbol V3.adaToken 1999999)

changedSingleDestinationOutput :: V3.TxOut
changedSingleDestinationOutput =
  pubKeyOutput thirdPaymentKeyHash reclaimValue

exactDestinationOutput :: V3.TxOut
exactDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash aggregateTwoReclaimValue

splitDestinationOutputs :: [V3.TxOut]
splitDestinationOutputs =
  [ pubKeyOutput destinationPaymentKeyHash reclaimValue
  , pubKeyOutput destinationPaymentKeyHash reclaimValue
  ]

splitDestinationOutputsWithGap :: [V3.TxOut]
splitDestinationOutputsWithGap =
  [ pubKeyOutput destinationPaymentKeyHash reclaimValue
  , changedDestinationOutput
  , pubKeyOutput destinationPaymentKeyHash reclaimValue
  ]

underpaidDestinationOutput :: V3.TxOut
underpaidDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash underpaidTwoReclaimValue

overpaidDestinationOutput :: V3.TxOut
overpaidDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash overpaidTwoReclaimValue

changedDestinationOutput :: V3.TxOut
changedDestinationOutput =
  pubKeyOutput thirdPaymentKeyHash aggregateTwoReclaimValue

missingNativeAssetDestinationOutput :: V3.TxOut
missingNativeAssetDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash overpaidTwoReclaimValue
