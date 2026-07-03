{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}

module Ownership.Verify
  ( VerifyingKey (..)
  , Proof (..)
  , Scalar (..)
  , ownershipDomain
  , ownershipPublicInputDigest
  , verifyOwnershipWithVK
  , groth16VerifyCommitted
  , groth16Verify
  ) where

import PlutusTx.Prelude
import PlutusTx.Builtins (ByteOrder (BigEndian, LittleEndian), modInteger)

newtype VerifyingKey = VerifyingKey BuiltinByteString
newtype Proof = Proof BuiltinByteString
newtype Scalar = Scalar BuiltinByteString

{-# INLINABLE ownershipDomain #-}
ownershipDomain :: BuiltinByteString
ownershipDomain = "ROOT-OWNERSHIP-v1"

{-# INLINABLE ownershipPublicInputDigest #-}
ownershipPublicInputDigest :: BuiltinByteString -> BuiltinByteString
ownershipPublicInputDigest paymentKeyHash = blake2b_256 (ownershipDomain <> paymentKeyHash)

-- | Verify that @proof@ proves knowledge of a master private key deriving to the
--   28-byte Cardano payment key hash. The verifying key is expected to be the
--   Cardano wire format exported by @proof-tool export-cardano@.
{-# INLINABLE verifyOwnershipWithVK #-}
verifyOwnershipWithVK :: BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> Bool
verifyOwnershipWithVK vk proof paymentKeyHash =
  if lengthOfByteString paymentKeyHash == 28
    then
      groth16VerifyCommitted
        (VerifyingKey vk)
        (Proof proof)
        (Scalar (ownershipPublicInputDigest paymentKeyHash))
    else False

{-# INLINABLE blsScalarFieldOrder #-}
blsScalarFieldOrder :: Integer
blsScalarFieldOrder =
  52435875175126190479447740508185965837690552500527637822603658699938581184513

{-# INLINABLE blsBaseFieldOrder #-}
blsBaseFieldOrder :: Integer
blsBaseFieldOrder =
  4002409555221667393417789825735904156556882819939007885332058136124031650490837864442687629129015664037894272559787

{-# INLINABLE leBytesToInteger #-}
leBytesToInteger :: BuiltinByteString -> Integer
leBytesToInteger bs = go 0 0 1
  where
    n = lengthOfByteString bs
    go i acc mul
      | i >= n    = acc
      | otherwise = go (i + 1) (acc + indexByteString bs i * mul) (mul * 256)

{-# INLINABLE groth16Verify #-}
groth16Verify :: VerifyingKey -> Proof -> Scalar -> Bool
groth16Verify (VerifyingKey vk) (Proof p) (Scalar pubBytes) =
  let alpha = bls12_381_G1_uncompress (sliceByteString 0   48 vk)
      beta  = bls12_381_G2_uncompress (sliceByteString 48  96 vk)
      gamma = bls12_381_G2_uncompress (sliceByteString 144 96 vk)
      delta = bls12_381_G2_uncompress (sliceByteString 240 96 vk)
      ic0   = bls12_381_G1_uncompress (sliceByteString 336 48 vk)
      ic1   = bls12_381_G1_uncompress (sliceByteString 384 48 vk)

      a = bls12_381_G1_uncompress (sliceByteString 0   48 p)
      b = bls12_381_G2_uncompress (sliceByteString 48  96 p)
      c = bls12_381_G1_uncompress (sliceByteString 144 48 p)

      pub = leBytesToInteger pubBytes `modInteger` blsScalarFieldOrder
      vkX = ic0 `bls12_381_G1_add` (pub `bls12_381_G1_scalarMul` ic1)
      lhs = bls12_381_millerLoop a b
      rhs = bls12_381_millerLoop alpha beta
              `bls12_381_mulMlResult` bls12_381_millerLoop vkX gamma
              `bls12_381_mulMlResult` bls12_381_millerLoop c delta
  in bls12_381_finalVerify lhs rhs

{-# INLINABLE commitmentDst #-}
commitmentDst :: BuiltinByteString
commitmentDst = "bsb22-commitment"

{-# INLINABLE expandMsgXmd48 #-}
expandMsgXmd48 :: BuiltinByteString -> BuiltinByteString
expandMsgXmd48 msg =
  let oneB     = consByteString 1 emptyByteString
      twoB     = consByteString 2 emptyByteString
      z00      = consByteString 0 emptyByteString
      dstPrime = commitmentDst <> consByteString 16 emptyByteString
      zPad     = integerToByteString BigEndian 64 0
      lib      = consByteString 0 (consByteString 48 emptyByteString)
      b0       = sha2_256 (zPad <> msg <> lib <> z00 <> dstPrime)
      b1       = sha2_256 (b0 <> oneB <> dstPrime)
      b2       = sha2_256 (xorByteString False b0 b1 <> twoB <> dstPrime)
  in b1 <> sliceByteString 0 16 b2

{-# INLINABLE groth16VerifyCommitted #-}
groth16VerifyCommitted :: VerifyingKey -> Proof -> Scalar -> Bool
groth16VerifyCommitted (VerifyingKey vk) (Proof p) (Scalar pubBytes) =
  let alpha = bls12_381_G1_uncompress (sliceByteString 0   48 vk)
      beta  = bls12_381_G2_uncompress (sliceByteString 48  96 vk)
      gamma = bls12_381_G2_uncompress (sliceByteString 144 96 vk)
      delta = bls12_381_G2_uncompress (sliceByteString 240 96 vk)
      ic0   = bls12_381_G1_uncompress (sliceByteString 336 48 vk)
      ic1   = bls12_381_G1_uncompress (sliceByteString 384 48 vk)

      k2    = bls12_381_G1_uncompress (sliceByteString 432 48 vk)
      ckG   = bls12_381_G2_uncompress (sliceByteString 480 96 vk)
      ckGSN = bls12_381_G2_uncompress (sliceByteString 576 96 vk)

      a = bls12_381_G1_uncompress (sliceByteString 0   48 p)
      b = bls12_381_G2_uncompress (sliceByteString 48  96 p)
      c = bls12_381_G1_uncompress (sliceByteString 144 48 p)

      cmtUncompressed = sliceByteString 192 96 p
      xBytes = sliceByteString 192 48 p
      yBytes = sliceByteString 240 48 p
      yInt   = byteStringToInteger BigEndian yBytes
      sortBit = if yInt > (blsBaseFieldOrder - yInt) then 32 else 0
      comp0  = indexByteString xBytes 0 + 128 + sortBit
      comp   = consByteString comp0 (sliceByteString 1 47 xBytes)

      commitment = bls12_381_G1_uncompress comp
      pok        = bls12_381_G1_uncompress (sliceByteString 288 48 p)
      pokOk = bls12_381_finalVerify
                (bls12_381_millerLoop pok ckG)
                (bls12_381_millerLoop (bls12_381_G1_neg commitment) ckGSN)

      eCmt = byteStringToInteger BigEndian (expandMsgXmd48 cmtUncompressed)
               `modInteger` blsScalarFieldOrder
      pub  = byteStringToInteger LittleEndian pubBytes `modInteger` blsScalarFieldOrder
      vkX  = ic0
               `bls12_381_G1_add` (pub  `bls12_381_G1_scalarMul` ic1)
               `bls12_381_G1_add` (eCmt `bls12_381_G1_scalarMul` k2)
               `bls12_381_G1_add` commitment

      lhs = bls12_381_millerLoop a b
      rhs = bls12_381_millerLoop alpha beta
              `bls12_381_mulMlResult` bls12_381_millerLoop vkX gamma
              `bls12_381_mulMlResult` bls12_381_millerLoop c delta
  in pokOk && bls12_381_finalVerify lhs rhs
