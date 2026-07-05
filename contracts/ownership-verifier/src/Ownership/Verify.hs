{-# LANGUAGE BangPatterns #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}

module Ownership.Verify
  ( CommittedProofCheck (..)
  , ParsedVerifyingKey (..)
  , VerifyingKey (..)
  , Proof (..)
  , Scalar (..)
  , blsScalarFieldOrder
  , ownershipDestinationDomain
  , ownershipDestinationPublicInputDigest
  , ownershipDomain
  , ownershipProofBatchChallenge
  , ownershipPublicInputDigest
  , parseVerifyingKey
  , verifyOwnershipDestinationWithParsedVK
  , verifyOwnershipDestinationWithParsedVKKnown28
  , verifyOwnershipDestinationWithParsedVKKnown28NoPok
  , verifyOwnershipDestinationWithVK
  , verifyOwnershipWithParsedVK
  , verifyOwnershipWithParsedVKKnown28
  , verifyOwnershipWithParsedVKKnown28NoPok
  , verifyCommittedProofGrothBatch
  , verifyCommittedProofPokBatch
  , verifyOwnershipWithVK
  , groth16VerifyCommittedParsedNoPok
  , groth16VerifyCommittedParsed
  , groth16VerifyCommitted
  , groth16Verify
  ) where

import PlutusTx.Prelude
import PlutusTx.Builtins (ByteOrder (BigEndian, LittleEndian), modInteger)

newtype VerifyingKey = VerifyingKey BuiltinByteString
newtype Proof = Proof BuiltinByteString
newtype Scalar = Scalar BuiltinByteString

data CommittedProofCheck = CommittedProofCheck
  { committedProofCommitment :: BuiltinBLS12_381_G1_Element
  , committedProofPok :: BuiltinBLS12_381_G1_Element
  , committedProofA :: BuiltinBLS12_381_G1_Element
  , committedProofB :: BuiltinBLS12_381_G2_Element
  , committedProofC :: BuiltinBLS12_381_G1_Element
  , committedProofVkX :: BuiltinBLS12_381_G1_Element
  }

data ParsedVerifyingKey = ParsedVerifyingKey
  { parsedAlpha :: BuiltinBLS12_381_G1_Element
  , parsedBeta :: BuiltinBLS12_381_G2_Element
  , parsedAlphaBeta :: BuiltinBLS12_381_MlResult
  , parsedGamma :: BuiltinBLS12_381_G2_Element
  , parsedDelta :: BuiltinBLS12_381_G2_Element
  , parsedIc0 :: BuiltinBLS12_381_G1_Element
  , parsedIc1 :: BuiltinBLS12_381_G1_Element
  , parsedK2 :: BuiltinBLS12_381_G1_Element
  , parsedCkG :: BuiltinBLS12_381_G2_Element
  , parsedCkGSN :: BuiltinBLS12_381_G2_Element
  }

{-# INLINABLE ownershipDomain #-}
ownershipDomain :: BuiltinByteString
ownershipDomain = "ROOT-OWNERSHIP-v1"

{-# INLINABLE ownershipPublicInputDigest #-}
ownershipPublicInputDigest :: BuiltinByteString -> BuiltinByteString
ownershipPublicInputDigest paymentKeyHash = blake2b_256 (ownershipDomain <> paymentKeyHash)

{-# INLINABLE ownershipDestinationDomain #-}
ownershipDestinationDomain :: BuiltinByteString
ownershipDestinationDomain = "ROOT-OWNERSHIP-DESTINATION-v1"

{-# INLINABLE ownershipDestinationPublicInputDigest #-}
ownershipDestinationPublicInputDigest :: BuiltinByteString -> BuiltinByteString -> BuiltinByteString
ownershipDestinationPublicInputDigest paymentKeyHash destinationAddress =
  blake2b_256 (ownershipDestinationDomain <> paymentKeyHash <> destinationAddress)

{-# INLINABLE ownershipProofBatchDomain #-}
ownershipProofBatchDomain :: BuiltinByteString
ownershipProofBatchDomain = "ROOT-OWNERSHIP-POK-BATCH-v1"

{-# INLINABLE ownershipProofBatchChallenge #-}
ownershipProofBatchChallenge :: BuiltinByteString -> Integer
ownershipProofBatchChallenge proofBytes =
  1 + (byteStringToInteger BigEndian (blake2b_256 (ownershipProofBatchDomain <> proofBytes)) `modInteger` (blsScalarFieldOrder - 1))

-- | Verify that @proof@ proves knowledge of a master private key deriving to the
--   28-byte Cardano payment key hash. The verifying key is expected to be the
--   Cardano wire format exported by @proof-tool export-cardano@.
{-# INLINABLE verifyOwnershipWithVK #-}
verifyOwnershipWithVK :: BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> Bool
verifyOwnershipWithVK vk proof paymentKeyHash =
  verifyOwnershipWithParsedVK (parseVerifyingKey vk) proof paymentKeyHash

{-# INLINABLE verifyOwnershipDestinationWithVK #-}
verifyOwnershipDestinationWithVK :: BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> Bool
verifyOwnershipDestinationWithVK vk proof paymentKeyHash destinationAddress =
  if lengthOfByteString paymentKeyHash == 28 && lengthOfByteString destinationAddress == 58
    then verifyOwnershipDestinationWithParsedVKKnown28 (parseVerifyingKey vk) proof paymentKeyHash destinationAddress
    else False

{-# INLINABLE parseVerifyingKey #-}
parseVerifyingKey :: BuiltinByteString -> ParsedVerifyingKey
parseVerifyingKey vk =
  let alpha = bls12_381_G1_uncompress (sliceByteString 0   48 vk)
      beta  = bls12_381_G2_uncompress (sliceByteString 48  96 vk)
   in ParsedVerifyingKey
        { parsedAlpha = alpha
        , parsedBeta = beta
        , parsedAlphaBeta = bls12_381_millerLoop alpha beta
        , parsedGamma = bls12_381_G2_uncompress (sliceByteString 144 96 vk)
        , parsedDelta = bls12_381_G2_uncompress (sliceByteString 240 96 vk)
        , parsedIc0   = bls12_381_G1_uncompress (sliceByteString 336 48 vk)
        , parsedIc1   = bls12_381_G1_uncompress (sliceByteString 384 48 vk)
        , parsedK2    = bls12_381_G1_uncompress (sliceByteString 432 48 vk)
        , parsedCkG   = bls12_381_G2_uncompress (sliceByteString 480 96 vk)
        , parsedCkGSN = bls12_381_G2_uncompress (sliceByteString 576 96 vk)
        }

{-# INLINABLE verifyOwnershipWithParsedVK #-}
verifyOwnershipWithParsedVK :: ParsedVerifyingKey -> BuiltinByteString -> BuiltinByteString -> Bool
verifyOwnershipWithParsedVK parsedVk proof paymentKeyHash =
  if lengthOfByteString paymentKeyHash == 28
    then verifyOwnershipWithParsedVKKnown28 parsedVk proof paymentKeyHash
    else False

{-# INLINABLE verifyOwnershipDestinationWithParsedVK #-}
verifyOwnershipDestinationWithParsedVK :: ParsedVerifyingKey -> BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> Bool
verifyOwnershipDestinationWithParsedVK parsedVk proof paymentKeyHash destinationAddress =
  if lengthOfByteString paymentKeyHash == 28 && lengthOfByteString destinationAddress == 58
    then verifyOwnershipDestinationWithParsedVKKnown28 parsedVk proof paymentKeyHash destinationAddress
    else False

{-# INLINABLE verifyOwnershipWithParsedVKKnown28 #-}
verifyOwnershipWithParsedVKKnown28 :: ParsedVerifyingKey -> BuiltinByteString -> BuiltinByteString -> Bool
verifyOwnershipWithParsedVKKnown28 parsedVk proof paymentKeyHash =
  groth16VerifyCommittedParsed
    parsedVk
    (Proof proof)
    (Scalar (ownershipPublicInputDigest paymentKeyHash))

{-# INLINABLE verifyOwnershipDestinationWithParsedVKKnown28 #-}
verifyOwnershipDestinationWithParsedVKKnown28 :: ParsedVerifyingKey -> BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> Bool
verifyOwnershipDestinationWithParsedVKKnown28 parsedVk proof paymentKeyHash destinationAddress =
  if lengthOfByteString destinationAddress == 58
    then
      groth16VerifyCommittedParsed
        parsedVk
        (Proof proof)
        (Scalar (ownershipDestinationPublicInputDigest paymentKeyHash destinationAddress))
    else False

{-# INLINABLE verifyOwnershipWithParsedVKKnown28NoPok #-}
verifyOwnershipWithParsedVKKnown28NoPok :: ParsedVerifyingKey -> BuiltinByteString -> BuiltinByteString -> CommittedProofCheck
verifyOwnershipWithParsedVKKnown28NoPok parsedVk proof paymentKeyHash =
  groth16VerifyCommittedParsedNoPok
    parsedVk
    (Proof proof)
    (Scalar (ownershipPublicInputDigest paymentKeyHash))

{-# INLINABLE verifyOwnershipDestinationWithParsedVKKnown28NoPok #-}
verifyOwnershipDestinationWithParsedVKKnown28NoPok :: ParsedVerifyingKey -> BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> CommittedProofCheck
verifyOwnershipDestinationWithParsedVKKnown28NoPok parsedVk proof paymentKeyHash destinationAddress =
  if lengthOfByteString destinationAddress == 58
    then
      groth16VerifyCommittedParsedNoPok
        parsedVk
        (Proof proof)
        (Scalar (ownershipDestinationPublicInputDigest paymentKeyHash destinationAddress))
    else traceError "destination address v1 must be 58 bytes"

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
groth16VerifyCommitted (VerifyingKey vk) proof scalar =
  groth16VerifyCommittedParsed (parseVerifyingKey vk) proof scalar

{-# INLINABLE groth16VerifyCommittedParsedNoPok #-}
groth16VerifyCommittedParsedNoPok :: ParsedVerifyingKey -> Proof -> Scalar -> CommittedProofCheck
groth16VerifyCommittedParsedNoPok
  (ParsedVerifyingKey _ _ _ _ _ ic0 ic1 k2 _ _)
  (Proof p)
  (Scalar pubBytes) =
  let a = bls12_381_G1_uncompress (sliceByteString 0   48 p)
      b = bls12_381_G2_uncompress (sliceByteString 48  96 p)
      c = bls12_381_G1_uncompress (sliceByteString 144 48 p)

      cmtUncompressed = sliceByteString 192 96 p
      yBytes = sliceByteString 240 48 p
      yInt   = byteStringToInteger BigEndian yBytes
      sortBit = if (2 * yInt) > blsBaseFieldOrder then 32 else 0
      comp0  = indexByteString p 192 + 128 + sortBit
      comp   = consByteString comp0 (sliceByteString 193 47 p)

      commitment = bls12_381_G1_uncompress comp
      pok        = bls12_381_G1_uncompress (sliceByteString 288 48 p)

      eCmt = byteStringToInteger BigEndian (expandMsgXmd48 cmtUncompressed)
               `modInteger` blsScalarFieldOrder
      pub  = byteStringToInteger LittleEndian pubBytes `modInteger` blsScalarFieldOrder
      vkX  = ic0
               `bls12_381_G1_add` (pub  `bls12_381_G1_scalarMul` ic1)
               `bls12_381_G1_add` (eCmt `bls12_381_G1_scalarMul` k2)
               `bls12_381_G1_add` commitment
   in CommittedProofCheck commitment pok a b c vkX

{-# INLINABLE verifyCommittedProofGrothBatch #-}
verifyCommittedProofGrothBatch ::
  ParsedVerifyingKey ->
  Integer ->
  BuiltinBLS12_381_MlResult ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  Bool
verifyCommittedProofGrothBatch
  (ParsedVerifyingKey alpha beta _ gamma delta _ _ _ _ _)
  batchCoefficientSum
  foldedLhs
  foldedVkX
  foldedC =
  let !alphaTerm =
        bls12_381_millerLoop (batchCoefficientSum `bls12_381_G1_scalarMul` alpha) beta
      !rhs =
        alphaTerm
          `bls12_381_mulMlResult` bls12_381_millerLoop foldedVkX gamma
          `bls12_381_mulMlResult` bls12_381_millerLoop foldedC delta
   in bls12_381_finalVerify foldedLhs rhs

{-# INLINABLE verifyCommittedProofPokBatch #-}
verifyCommittedProofPokBatch ::
  ParsedVerifyingKey ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  Bool
verifyCommittedProofPokBatch
  (ParsedVerifyingKey _ _ _ _ _ _ _ _ ckG ckGSN)
  foldedCommitment
  foldedPok =
  bls12_381_finalVerify
    (bls12_381_millerLoop foldedPok ckG)
    (bls12_381_millerLoop (bls12_381_G1_neg foldedCommitment) ckGSN)

{-# INLINABLE groth16VerifyCommittedParsed #-}
groth16VerifyCommittedParsed :: ParsedVerifyingKey -> Proof -> Scalar -> Bool
groth16VerifyCommittedParsed parsedVk proof scalar =
  case groth16VerifyCommittedParsedNoPok parsedVk proof scalar of
    CommittedProofCheck commitment pok a b c vkX ->
      let !rhs =
            parsedAlphaBeta parsedVk
              `bls12_381_mulMlResult` bls12_381_millerLoop vkX (parsedGamma parsedVk)
              `bls12_381_mulMlResult` bls12_381_millerLoop c (parsedDelta parsedVk)
       in bls12_381_finalVerify (bls12_381_millerLoop a b) rhs
            && verifyCommittedProofPokBatch parsedVk commitment pok
