{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Control.Monad (when)
import Data.Char (digitToInt, isHexDigit, isSpace)
import System.Environment (getArgs)
import System.Exit (die)

import qualified PlutusTx.Builtins as B
import PlutusTx.Builtins (BuiltinByteString)

import Ownership.Verify (verifyOwnershipDestinationWithVK)

main :: IO ()
main = do
  args <- getArgs
  case args of
    [vkPath, proofHex, credentialHex, destinationHex] -> do
      vkBytes <- decodeHex <$> readFile vkPath
      let proofBytes = decodeHex proofHex
          credentialBytes = decodeHex credentialHex
          destinationBytes = decodeHex destinationHex
      requireLength "verifier key" 672 vkBytes
      requireLength "proof" 336 proofBytes
      requireLength "credential" 28 credentialBytes
      requireLength "destination" 58 destinationBytes
      let vk = bytesToBuiltin vkBytes
          proof = bytesToBuiltin proofBytes
          credential = bytesToBuiltin credentialBytes
          destination = bytesToBuiltin destinationBytes
      if verifyOwnershipDestinationWithVK vk proof credential destination
        then putStrLn "ok"
        else die "contract destination-proof verifier rejected artifact"
    _ -> die "usage: verify-destination-proof VK_PATH PROOF_HEX CREDENTIAL_HEX DESTINATION_HEX"

decodeHex :: String -> [Integer]
decodeHex input
  | any (not . isHexDigit) cleaned = error "decodeHex: non-hex character"
  | otherwise = go cleaned
  where
    cleaned = filter (not . isSpace) input
    go (hi : lo : rest) = fromIntegral (digitToInt hi * 16 + digitToInt lo) : go rest
    go [] = []
    go [_] = error "decodeHex: odd number of hex digits"

bytesToBuiltin :: [Integer] -> BuiltinByteString
bytesToBuiltin = foldr B.consByteString B.emptyByteString

requireLength :: String -> Int -> [Integer] -> IO ()
requireLength label expected bytes =
  when (length bytes /= expected) $
    die (label <> " is " <> show (length bytes) <> " bytes, want " <> show expected)
