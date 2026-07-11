{-# LANGUAGE NoImplicitPrelude #-}

-- | Production-facing name for the statement-bound V2 reclaim validator.
-- The shared low-level parser and elliptic-curve machinery stay alongside the
-- V1 implementation; this module deliberately exposes only the V2 entry
-- points so deployment tooling cannot select marker/cache semantics by
-- accident.
module Ownership.ReclaimGlobalV2
  ( reclaimBatchTranscriptV2
  , reclaimGlobalRedeemerDataV2
  , reclaimGlobalValidatorV2
  , reclaimGlobalValidatorV2Code
  , reclaimGlobalValidatorV2Untyped
  , validateReclaimInputsV2
  , v2VerifierKeyParametersMatch
  ) where

import qualified PlutusTx.Builtins as B
import qualified PlutusTx.Builtins.Internal as BI
import PlutusTx.Prelude

import Ownership.ReclaimGlobal
  ( reclaimBatchTranscriptV2
  , reclaimGlobalRedeemerDataV2
  , reclaimGlobalValidatorV2
  , reclaimGlobalValidatorV2Code
  , reclaimGlobalValidatorV2Untyped
  , validateReclaimInputsV2
  )

-- | Host-side export/build guard for the two V2 script parameters. The
-- validator deliberately does not hash the 672-byte verification key at
-- execution time; this check must succeed before a script is finalized.
{-# INLINABLE v2VerifierKeyParametersMatch #-}
v2VerifierKeyParametersMatch :: BuiltinByteString -> BuiltinByteString -> Bool
v2VerifierKeyParametersMatch verifierKey verifierKeyHash =
  lengthOfByteString verifierKey == 672
    && lengthOfByteString verifierKeyHash == 32
    && builtinBoolToBool (BI.equalsByteString (B.blake2b_256 verifierKey) verifierKeyHash)

{-# INLINABLE builtinBoolToBool #-}
builtinBoolToBool :: BI.BuiltinBool -> Bool
builtinBoolToBool condition =
  BI.ifThenElse condition (\_ -> True) (\_ -> False) BI.unitval
