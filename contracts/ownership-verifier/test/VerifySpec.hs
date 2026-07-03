{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

module Main (main) where

import Control.Exception (SomeException, evaluate, try)
import Data.Char (digitToInt, isHexDigit)

import qualified PlutusTx.Builtins as B
import PlutusTx.Builtins (BuiltinByteString)

import Ownership.Verify (ownershipDomain, ownershipPublicInputDigest, verifyOwnershipWithVK)

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

safeVerify :: BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> IO Bool
safeVerify vk proof pkh = do
  r <- try (evaluate (verifyOwnershipWithVK vk proof pkh))
  pure $ case r of
    Left (_ :: SomeException) -> False
    Right ok                  -> ok

main :: IO ()
main = do
  vk <- readBuiltinHex "testdata/ownership-vk.hex"
  proof <- readBuiltinHex "testdata/ownership-proof.hex"
  let pkh = bytesToBuiltin (decodeHex "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")
      wrongPkh = bytesToBuiltin (decodeHex "18e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")

  defaultMain $ testGroup "Ownership.Verify"
    [ testCase "public input digest binds the ownership domain and payment key hash" $
        ownershipPublicInputDigest pkh @?= B.blake2b_256 (ownershipDomain <> pkh)
    , testCase "rejects non-28-byte payment key hashes before proof parsing" $
        verifyOwnershipWithVK "" "" "short" @?= False
    , testCase "accepts the exported real ownership proof for its payment key hash" $ do
        ok <- safeVerify vk proof pkh
        ok @?= True
    , testCase "rejects the exported proof for a different payment key hash" $ do
        ok <- safeVerify vk proof wrongPkh
        ok @?= False
    ]
