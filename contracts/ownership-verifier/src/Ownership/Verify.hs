{-# LANGUAGE BangPatterns #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE OverloadedStrings #-}

module Ownership.Verify
  ( BatchCommittedProofCheck (..)
  , CommittedProofCheck (..)
  , ParsedBatchVerifyingKey (..)
  , ParsedVerifyingKey (..)
  , VerifyingKey (..)
  , Proof (..)
  , Scalar (..)
  , batchCoefficientUsesUnscaledAlpha
  , coefficientFirstVkX
  , expandMsgXmd48
  , blsBaseFieldOrder
  , blsScalarFieldOrder
  , commitmentYIsCanonical
  , committedProofChallengeScalar
  , ownershipDestinationDomain
  , ownershipDestinationPublicInputDigest
  , ownershipDestinationPublicInputScalar
  , ownershipDomain
  , ownershipProofBatchChallenge
  , ownershipProofBatchChallengeV2
  , ownershipProofBatchDomainV2
  , ownershipProofBatchMergeChallenge
  , ownershipProofBatchMergeChallengeV2
  , ownershipPublicInputDigest
  , parseVerifyingKey
  , parseVerifyingKeyBatch
  , verifyOwnershipDestinationWithParsedVK
  , verifyOwnershipDestinationWithParsedVKKnown28
  , verifyOwnershipDestinationWithParsedVKKnown28NoPok
  , verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok
  , verifyOwnershipDestinationWithParsedBatchVKLegacyKnown28NoPok
  , verifyOwnershipDestinationWithVK
  , verifyOwnershipWithParsedVK
  , verifyOwnershipWithParsedVKKnown28
  , verifyOwnershipWithParsedVKKnown28NoPok
  , verifyCommittedProofGrothBatch
  , verifyCommittedProofGrothBatchBuiltin
  , verifyCommittedProofMergedBatchWithBatchVK
  , verifyCommittedProofMergedWithVK
  , committedProofMergedBatchSidesWithBatchVK
  , committedProofMergedSidesWithVK
  , verifyCommittedProofPokBatch
  , verifyCommittedProofPokBatchWithBatchVK
  , verifyCommittedProofPokBatchWithBatchVKBuiltin
  , verifyOwnershipWithVK
  , groth16VerifyCommittedParsedNoPok
  , groth16VerifyCommittedParsedBatchNoPok
  , groth16VerifyCommittedParsed
  , groth16VerifyCommitted
  , groth16Verify
  ) where

import PlutusTx.Prelude
import PlutusTx.Builtins (ByteOrder (BigEndian, LittleEndian), modInteger)
import qualified PlutusTx.Builtins.Internal as BI

{-# INLINABLE builtinIf #-}
builtinIf :: BI.BuiltinBool -> a -> a -> a
builtinIf condition trueBranch falseBranch =
  BI.ifThenElse condition (\_ -> trueBranch) (\_ -> falseBranch) BI.unitval

{-# INLINABLE builtinToBool #-}
builtinToBool :: BI.BuiltinBool -> Bool
builtinToBool condition =
  builtinIf condition True False

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

-- | Batch-only proof material. Unlike 'CommittedProofCheck', this deliberately
-- keeps the authenticated public input and commitment challenge as field
-- integers instead of eagerly materializing vkX. ReclaimGlobal folds those
-- coefficients first and performs the three fixed-base multiplications once.
data BatchCommittedProofCheck = BatchCommittedProofCheck
  { batchCommittedProofCommitment :: BuiltinBLS12_381_G1_Element
  , batchCommittedProofPok :: BuiltinBLS12_381_G1_Element
  , batchCommittedProofA :: BuiltinBLS12_381_G1_Element
  , batchCommittedProofB :: BuiltinBLS12_381_G2_Element
  , batchCommittedProofC :: BuiltinBLS12_381_G1_Element
  , batchCommittedProofPub :: Integer
  , batchCommittedProofECmt :: Integer
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

data ParsedBatchVerifyingKey = ParsedBatchVerifyingKey
  { parsedBatchAlpha :: BuiltinBLS12_381_G1_Element
  , parsedBatchBeta :: BuiltinBLS12_381_G2_Element
  , parsedBatchGamma :: BuiltinBLS12_381_G2_Element
  , parsedBatchDelta :: BuiltinBLS12_381_G2_Element
  , parsedBatchIc0 :: BuiltinBLS12_381_G1_Element
  , parsedBatchIc1 :: BuiltinBLS12_381_G1_Element
  , parsedBatchK2 :: BuiltinBLS12_381_G1_Element
  , parsedBatchCkG :: BuiltinBLS12_381_G2_Element
  , parsedBatchCkGSN :: BuiltinBLS12_381_G2_Element
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
  blake2b_256 ((ownershipDestinationDomain <> paymentKeyHash) <> destinationAddress)

{-# INLINABLE ownershipDestinationPublicInputScalar #-}
ownershipDestinationPublicInputScalar :: BuiltinByteString -> BuiltinByteString -> Integer
ownershipDestinationPublicInputScalar paymentKeyHash destinationAddress =
  byteStringToInteger
    LittleEndian
    (ownershipDestinationPublicInputDigest paymentKeyHash destinationAddress)
    `modInteger` blsScalarFieldOrder

{-# INLINABLE ownershipProofBatchDomain #-}
ownershipProofBatchDomain :: BuiltinByteString
ownershipProofBatchDomain = "ROOT-OWNERSHIP-POK-BATCH-v1"

-- | The statement-bound transcript has its own domain. Callers first frame
-- the complete v2 transcript (key hash, count, and slot pairs), then derive
-- challenges from those exact bytes.
{-# INLINABLE ownershipProofBatchDomainV2 #-}
ownershipProofBatchDomainV2 :: BuiltinByteString
ownershipProofBatchDomainV2 = "ROOT-OWNERSHIP-POK-BATCH-v2"

{-# INLINABLE ownershipProofBatchChallenge #-}
ownershipProofBatchChallenge :: BuiltinByteString -> Integer
ownershipProofBatchChallenge proofBytes =
  1 + (byteStringToInteger BigEndian (blake2b_256 (ownershipProofBatchDomain <> proofBytes)) `modInteger` (blsScalarFieldOrder - 1))

{-# INLINABLE ownershipProofBatchChallengeV2 #-}
ownershipProofBatchChallengeV2 :: BuiltinByteString -> Integer
ownershipProofBatchChallengeV2 transcript =
  1 + (byteStringToInteger BigEndian (blake2b_256 transcript) `modInteger` (blsScalarFieldOrder - 1))

-- | Frozen V2 benchmark-only merge challenge. The suffix follows the complete
-- marker-expanded proof transcript and is not caller controlled.
{-# INLINABLE ownershipProofBatchMergeChallenge #-}
ownershipProofBatchMergeChallenge :: BuiltinByteString -> Integer
ownershipProofBatchMergeChallenge proofBytes =
  1
    + ( byteStringToInteger
          BigEndian
          (blake2b_256 (ownershipProofBatchDomain <> proofBytes <> consByteString 1 emptyByteString))
          `modInteger` (blsScalarFieldOrder - 1)
      )

-- | Suffix-separate the optional second challenge from the same complete v2
-- transcript; no alternate framing is permitted.
{-# INLINABLE ownershipProofBatchMergeChallengeV2 #-}
ownershipProofBatchMergeChallengeV2 :: BuiltinByteString -> Integer
ownershipProofBatchMergeChallengeV2 transcript =
  1
    + ( byteStringToInteger
          BigEndian
          (blake2b_256 (transcript <> consByteString 1 emptyByteString))
          `modInteger` (blsScalarFieldOrder - 1)
      )

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
  if lengthOfByteString vk == 672
    then
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
    else traceError "verifying key must be 672 bytes"

{-# INLINABLE parseVerifyingKeyBatch #-}
parseVerifyingKeyBatch :: BuiltinByteString -> ParsedBatchVerifyingKey
parseVerifyingKeyBatch vk =
  builtinIf
    (BI.equalsInteger (lengthOfByteString vk) 672)
    (
      let alpha = bls12_381_G1_uncompress (sliceByteString 0   48 vk)
          beta  = bls12_381_G2_uncompress (sliceByteString 48  96 vk)
       in ParsedBatchVerifyingKey
            { parsedBatchAlpha = alpha
            , parsedBatchBeta = beta
            , parsedBatchGamma = bls12_381_G2_uncompress (sliceByteString 144 96 vk)
            , parsedBatchDelta = bls12_381_G2_uncompress (sliceByteString 240 96 vk)
            , parsedBatchIc0   = bls12_381_G1_uncompress (sliceByteString 336 48 vk)
            , parsedBatchIc1   = bls12_381_G1_uncompress (sliceByteString 384 48 vk)
            , parsedBatchK2    = bls12_381_G1_uncompress (sliceByteString 432 48 vk)
            , parsedBatchCkG   = bls12_381_G2_uncompress (sliceByteString 480 96 vk)
            , parsedBatchCkGSN = bls12_381_G2_uncompress (sliceByteString 576 96 vk)
            }
    )
    (traceError "verifying key must be 672 bytes")

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

{-# INLINABLE verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok #-}
verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok :: ParsedBatchVerifyingKey -> BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> BatchCommittedProofCheck
verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok parsedVk proof paymentKeyHash destinationAddress =
  if lengthOfByteString destinationAddress == 58
    then
      groth16VerifyCommittedParsedBatchNoPok
        parsedVk
        (Proof proof)
        (Scalar (ownershipDestinationPublicInputDigest paymentKeyHash destinationAddress))
    else traceError "destination address v1 must be 58 bytes"

-- | Pre-V8 single-proof parser/check retained verbatim in shape for the N=1
-- ReclaimGlobal path. It uses the batch VK record (so V3's dead alpha-beta
-- Miller loop stays removed) but eagerly materializes vkX exactly as before
-- coefficient-first folding was introduced.
{-# INLINABLE verifyOwnershipDestinationWithParsedBatchVKLegacyKnown28NoPok #-}
verifyOwnershipDestinationWithParsedBatchVKLegacyKnown28NoPok :: ParsedBatchVerifyingKey -> BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> CommittedProofCheck
verifyOwnershipDestinationWithParsedBatchVKLegacyKnown28NoPok parsedVk proof paymentKeyHash destinationAddress =
  if lengthOfByteString destinationAddress == 58
    then
      groth16VerifyCommittedParsedBatchLegacyNoPok
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

{-# INLINABLE commitmentYIsCanonical #-}
commitmentYIsCanonical :: BuiltinByteString -> Bool
commitmentYIsCanonical proofBytes =
  byteStringToInteger BigEndian (sliceByteString 240 48 proofBytes) < blsBaseFieldOrder

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

-- | The BSB22 commitment challenge from the proof's exact 96-byte
-- uncompressed commitment encoding. Callers use this only after the proof has
-- passed the exact-length and canonical-Y checks.
{-# INLINABLE committedProofChallengeScalar #-}
committedProofChallengeScalar :: BuiltinByteString -> Integer
committedProofChallengeScalar proofBytes =
  byteStringToInteger
    BigEndian
    (expandMsgXmd48 (sliceByteString 192 96 proofBytes))
    `modInteger` blsScalarFieldOrder

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
  if lengthOfByteString p /= 336
    then traceError "proof must be 336 bytes"
    else if not (commitmentYIsCanonical p)
      then traceError "commitment Y must be canonical"
      else
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
  ParsedBatchVerifyingKey ->
  Integer ->
  BuiltinBLS12_381_MlResult ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  Bool
verifyCommittedProofGrothBatch
  parsedVk
  batchCoefficientSum
  foldedLhs
  foldedVkX
  foldedC =
  builtinToBool
    (verifyCommittedProofGrothBatchBuiltin parsedVk batchCoefficientSum foldedLhs foldedVkX foldedC)

{-# INLINABLE verifyCommittedProofGrothBatchBuiltin #-}
verifyCommittedProofGrothBatchBuiltin ::
  ParsedBatchVerifyingKey ->
  Integer ->
  BuiltinBLS12_381_MlResult ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BI.BuiltinBool
verifyCommittedProofGrothBatchBuiltin
  (ParsedBatchVerifyingKey alpha beta gamma delta _ _ _ _ _)
  batchCoefficientSum
  foldedLhs
  foldedVkX
  foldedC =
  let !batchAlpha =
        BI.ifThenElse
          (batchCoefficientUsesUnscaledAlpha batchCoefficientSum)
          (\_ -> alpha)
          (\_ -> batchCoefficientSum `bls12_381_G1_scalarMul` alpha)
          BI.unitval
      !alphaTerm = bls12_381_millerLoop batchAlpha beta
      !rhs =
        alphaTerm
          `bls12_381_mulMlResult` bls12_381_millerLoop foldedVkX gamma
          `bls12_381_mulMlResult` bls12_381_millerLoop foldedC delta
   in BI.bls12_381_finalVerify foldedLhs rhs

-- | Benchmark-only V2 merge of the folded Groth16 and BSB22 PoK equations.
-- The production validators continue to call the two independent checks.
{-# INLINABLE verifyCommittedProofMergedBatchWithBatchVK #-}
verifyCommittedProofMergedBatchWithBatchVK ::
  ParsedBatchVerifyingKey ->
  Integer ->
  BuiltinBLS12_381_MlResult ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  Integer ->
  Bool
verifyCommittedProofMergedBatchWithBatchVK
  parsedVk
  batchCoefficientSum
  foldedGrothLhs
  foldedVkX
  foldedC
  foldedCommitment
  foldedPok
  mergeChallenge =
    let !(!lhs, !rhs) =
          committedProofMergedBatchSidesWithBatchVK
            parsedVk
            batchCoefficientSum
            foldedGrothLhs
            foldedVkX
            foldedC
            foldedCommitment
            foldedPok
            mergeChallenge
     in bls12_381_finalVerify lhs rhs

-- | The two exact Miller-product sides consumed by the benchmark-only V2
-- batch verifier. Exposed so the immutable matrix can compare each side to an
-- independently constructed old-G times s-weighted-PoK oracle.
{-# INLINABLE committedProofMergedBatchSidesWithBatchVK #-}
committedProofMergedBatchSidesWithBatchVK ::
  ParsedBatchVerifyingKey ->
  Integer ->
  BuiltinBLS12_381_MlResult ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  Integer ->
  (BuiltinBLS12_381_MlResult, BuiltinBLS12_381_MlResult)
committedProofMergedBatchSidesWithBatchVK
  (ParsedBatchVerifyingKey alpha beta gamma delta _ _ _ ckG ckGSN)
  batchCoefficientSum
  foldedGrothLhs
  foldedVkX
  foldedC
  foldedCommitment
  foldedPok
  mergeChallenge =
    let !batchAlpha =
          BI.ifThenElse
            (batchCoefficientUsesUnscaledAlpha batchCoefficientSum)
            (\_ -> alpha)
            (\_ -> batchCoefficientSum `bls12_381_G1_scalarMul` alpha)
            BI.unitval
        !scaledPok = mergeChallenge `bls12_381_G1_scalarMul` foldedPok
        !scaledCommitment = mergeChallenge `bls12_381_G1_scalarMul` foldedCommitment
        !lhs =
          foldedGrothLhs
            `bls12_381_mulMlResult` bls12_381_millerLoop scaledPok ckG
        !rhs =
          bls12_381_millerLoop batchAlpha beta
            `bls12_381_mulMlResult` bls12_381_millerLoop foldedVkX gamma
            `bls12_381_mulMlResult` bls12_381_millerLoop foldedC delta
            `bls12_381_mulMlResult` bls12_381_millerLoop (bls12_381_G1_neg scaledCommitment) ckGSN
     in (lhs, rhs)

-- | Single-proof/Multi form of the benchmark-only V2 merged equation.
{-# INLINABLE verifyCommittedProofMergedWithVK #-}
verifyCommittedProofMergedWithVK ::
  ParsedVerifyingKey ->
  BuiltinBLS12_381_MlResult ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  Integer ->
  Bool
verifyCommittedProofMergedWithVK
  parsedVk
  grothLhs
  vkX
  c
  commitment
  pok
  mergeChallenge =
    let !(!lhs, !rhs) =
          committedProofMergedSidesWithVK
            parsedVk
            grothLhs
            vkX
            c
            commitment
            pok
            mergeChallenge
     in bls12_381_finalVerify lhs rhs

-- | Single-proof/Multi Miller-product sides for the benchmark-only V2 oracle.
{-# INLINABLE committedProofMergedSidesWithVK #-}
committedProofMergedSidesWithVK ::
  ParsedVerifyingKey ->
  BuiltinBLS12_381_MlResult ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  Integer ->
  (BuiltinBLS12_381_MlResult, BuiltinBLS12_381_MlResult)
committedProofMergedSidesWithVK
  (ParsedVerifyingKey _ _ alphaBeta gamma delta _ _ _ ckG ckGSN)
  grothLhs
  vkX
  c
  commitment
  pok
  mergeChallenge =
    let !scaledPok = mergeChallenge `bls12_381_G1_scalarMul` pok
        !scaledCommitment = mergeChallenge `bls12_381_G1_scalarMul` commitment
        !lhs =
          grothLhs
            `bls12_381_mulMlResult` bls12_381_millerLoop scaledPok ckG
        !rhs =
          alphaBeta
            `bls12_381_mulMlResult` bls12_381_millerLoop vkX gamma
            `bls12_381_mulMlResult` bls12_381_millerLoop c delta
            `bls12_381_mulMlResult` bls12_381_millerLoop (bls12_381_G1_neg scaledCommitment) ckGSN
     in (lhs, rhs)

-- | Materialize the folded vkX after integer coefficient folding:
--
--   (Σrᵢ)·IC0 + (Σrᵢ·pubᵢ)·IC1 + (Σrᵢ·eCmtᵢ)·K2 + Σrᵢ·commitmentᵢ
--
-- Each scalar accumulator is reduced modulo the BLS scalar-field order by the
-- caller. The exact-integer fast path preserves the N=1 point expression from
-- before V8 and must not accept 1+q as an unscaled coefficient.
{-# INLINABLE coefficientFirstVkX #-}
coefficientFirstVkX ::
  ParsedBatchVerifyingKey ->
  Integer ->
  Integer ->
  Integer ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element
coefficientFirstVkX
  (ParsedBatchVerifyingKey _ _ _ _ ic0 ic1 k2 _ _)
  coefficientSum
  foldedPub
  foldedECmt
  foldedCommitment =
    let !foldedIc0 =
          BI.ifThenElse
            (batchCoefficientUsesUnscaledAlpha coefficientSum)
            (\_ -> ic0)
            (\_ -> coefficientSum `bls12_381_G1_scalarMul` ic0)
            BI.unitval
     in foldedIc0
          `bls12_381_G1_add` (foldedPub `bls12_381_G1_scalarMul` ic1)
          `bls12_381_G1_add` (foldedECmt `bls12_381_G1_scalarMul` k2)
          `bls12_381_G1_add` foldedCommitment

{-# INLINABLE batchCoefficientUsesUnscaledAlpha #-}
batchCoefficientUsesUnscaledAlpha :: Integer -> BI.BuiltinBool
batchCoefficientUsesUnscaledAlpha batchCoefficientSum =
  BI.equalsInteger batchCoefficientSum 1

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

{-# INLINABLE verifyCommittedProofPokBatchWithBatchVK #-}
verifyCommittedProofPokBatchWithBatchVK ::
  ParsedBatchVerifyingKey ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  Bool
verifyCommittedProofPokBatchWithBatchVK
  parsedVk
  foldedCommitment
  foldedPok =
  builtinToBool
    (verifyCommittedProofPokBatchWithBatchVKBuiltin parsedVk foldedCommitment foldedPok)

{-# INLINABLE verifyCommittedProofPokBatchWithBatchVKBuiltin #-}
verifyCommittedProofPokBatchWithBatchVKBuiltin ::
  ParsedBatchVerifyingKey ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element ->
  BI.BuiltinBool
verifyCommittedProofPokBatchWithBatchVKBuiltin
  (ParsedBatchVerifyingKey _ _ _ _ _ _ _ ckG ckGSN)
  foldedCommitment
  foldedPok =
  BI.bls12_381_finalVerify
    (bls12_381_millerLoop foldedPok ckG)
    (bls12_381_millerLoop (bls12_381_G1_neg foldedCommitment) ckGSN)

{-# INLINABLE groth16VerifyCommittedParsedBatchNoPok #-}
groth16VerifyCommittedParsedBatchNoPok :: ParsedBatchVerifyingKey -> Proof -> Scalar -> BatchCommittedProofCheck
groth16VerifyCommittedParsedBatchNoPok
  (ParsedBatchVerifyingKey _ _ _ _ _ _ _ _ _)
  (Proof p)
  (Scalar pubBytes) =
  builtinIf
    (BI.equalsInteger (lengthOfByteString p) 336)
    (
      let yBytes = sliceByteString 240 48 p
          yInt = byteStringToInteger BigEndian yBytes
       in builtinIf
            (BI.lessThanInteger yInt blsBaseFieldOrder)
            (
              let a = bls12_381_G1_uncompress (sliceByteString 0   48 p)
                  b = bls12_381_G2_uncompress (sliceByteString 48  96 p)
                  c = bls12_381_G1_uncompress (sliceByteString 144 48 p)

                  cmtUncompressed = sliceByteString 192 96 p
                  sortBit =
                    builtinIf
                      (BI.lessThanInteger blsBaseFieldOrder (2 * yInt))
                      32
                      0
                  comp0  = indexByteString p 192 + 128 + sortBit
                  comp   = consByteString comp0 (sliceByteString 193 47 p)

                  commitment = bls12_381_G1_uncompress comp
                  pok        = bls12_381_G1_uncompress (sliceByteString 288 48 p)

                  eCmt = byteStringToInteger BigEndian (expandMsgXmd48 cmtUncompressed)
                           `modInteger` blsScalarFieldOrder
                  pub  = byteStringToInteger LittleEndian pubBytes `modInteger` blsScalarFieldOrder
               in BatchCommittedProofCheck commitment pok a b c pub eCmt
            )
            (traceError "commitment Y must be canonical")
    )
    (traceError "proof must be 336 bytes")

{-# INLINABLE groth16VerifyCommittedParsedBatchLegacyNoPok #-}
groth16VerifyCommittedParsedBatchLegacyNoPok :: ParsedBatchVerifyingKey -> Proof -> Scalar -> CommittedProofCheck
groth16VerifyCommittedParsedBatchLegacyNoPok
  (ParsedBatchVerifyingKey _ _ _ _ ic0 ic1 k2 _ _)
  (Proof p)
  (Scalar pubBytes) =
  if lengthOfByteString p /= 336
    then traceError "proof must be 336 bytes"
    else if not (commitmentYIsCanonical p)
      then traceError "commitment Y must be canonical"
      else
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
