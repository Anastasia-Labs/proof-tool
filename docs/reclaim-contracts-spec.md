# Reclaim Contracts Specification

This document specifies the reclaim contract family implemented in
`contracts/ownership-verifier/src/Ownership/ReclaimBase.hs` and
`contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs`. The aggregate
single-proof path is implemented in
`contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs`. The
supporting one-shot NFT minting policy lives in
`contracts/ownership-verifier/src/Ownership/OneShotNFT.hs`.

## Existing State

The repository contains `Ownership.Verify`, a reusable Plutus V3 ownership-proof
verifier, plus the reclaim-base spending validator and reclaim-global rewarding
validator described below.

## Contract 1: Reclaim Base Spending Validator

### Purpose

`ReclaimBase` is the script address where users deposit reclaimable UTxOs. Each
UTxO carries a datum containing the payment public key hash that must be proven
by the global reclaim script when the UTxO is spent.

### Parameters

- `globalCredential :: Credential`
  The staking/rewarding credential for the global reclaim script.
  This must be a `ScriptCredential`; key credentials are rejected even if a
  matching key-controlled withdrawal is present.

### Datum

```haskell
data ReclaimBaseDatum = ReclaimBaseDatum
  { reclaimPaymentKeyHash :: BuiltinByteString
  }
```

`reclaimPaymentKeyHash` must be exactly 28 bytes. It is the Cardano payment key
hash passed to `Ownership.Verify.verifyOwnershipWithVK`.

### Redeemer

The base validator does not need a semantic redeemer. Use unit unless a later
off-chain workflow needs tagging.

### Validation Rules

For every spend from `ReclaimBase(globalCredential)`:

1. The transaction must include a withdrawal under `globalCredential`.
2. `globalCredential` must be a `ScriptCredential`.
3. The validator must not validate proofs itself.
4. The validator must not inspect other reclaim-base inputs. Global proof
   coverage belongs to the rewarding script.
5. Missing datum or malformed datum should fail. For V3, the datum can be read
   from `scriptContextScriptInfo = SpendingScript ownRef (Just datum)`.

The minimal validator condition is equivalent to:

```haskell
globalCredential `elem` keys (txInfoWdrl txInfo)
```

The withdrawal amount is not meaningful; only the credential's presence is.

## Contract 2: Reclaim Global Rewarding Validator

### Purpose

`ReclaimGlobal` is invoked through withdrawals. It verifies ownership proofs for
all `ReclaimBase` inputs in the transaction, using a verifier key fixed by the
script instance and deployment metadata stored in an immutable NFT parameter
UTxO.

### Parameters

- `paramsCurrencySymbol :: CurrencySymbol`
  The currency symbol of the one-shot NFT that identifies the global parameter
  UTxO.
- `verifierKey :: BuiltinByteString`
  The committed Groth16 verifier key exported by `proof-tool export-cardano`.
  This is a script parameter, so the global validator hash commits to the key
  for a given deployment.

### Parameter UTxO

The transaction must include a reference input that:

1. Contains exactly one parameter NFT under `paramsCurrencySymbol`.
2. Is locked at an always-fails script address, making the parameter datum
   immutable after creation.
3. Has inline datum:

```haskell
data ReclaimGlobalParams = ReclaimGlobalParams
  { reclaimBaseScriptHash :: ScriptHash
  }
```

`reclaimBaseScriptHash` identifies the concrete `ReclaimBase` validator hash.

### Redeemer

```haskell
data ReclaimGlobalRedeemer = ReclaimGlobalRedeemer
  { reclaimParamsIdx :: Integer
  , reclaimDestinationOutStartIdx :: Integer
  , reclaimProofs :: [BuiltinByteString]
  }
```

`reclaimParamsIdx` is the index in `txInfoReferenceInputs` of the parameter
UTxO. `reclaimDestinationOutStartIdx` is the first `txInfoOutputs` index in the
run of destination outputs corresponding to matching reclaim-base inputs.
`reclaimProofs` is ordered to match the reclaim-base inputs as they appear in
`txInfoInputs`.

### Validation Rules

For every withdrawal under `ReclaimGlobal(paramsCurrencySymbol, verifierKey)`:

1. The script purpose must be `RewardingScript ownCredential`.
2. Resolve `txInfoReferenceInputs !! reclaimParamsIdx`; fail if the index is
   negative or out of bounds.
3. The referenced output must contain exactly one parameter NFT under
   `paramsCurrencySymbol`.
4. The referenced output must use inline datum and decode as
   `ReclaimGlobalParams`.
5. Traverse `txInfoInputs` in ledger order. For each input whose resolved output
   address has payment credential `ScriptCredential reclaimBaseScriptHash`:
   - require the next proof from `reclaimProofs`;
   - require the next destination output from
     `txInfoOutputs[reclaimDestinationOutStartIdx..]`;
   - decode that input's datum as `ReclaimBaseDatum`;
   - require `reclaimPaymentKeyHash` to be 28 bytes;
   - encode the corresponding destination output address as
     `destinationAddressV1`;
   - call the destination-bound verifier with
     `reclaimPaymentKeyHash` and `destinationAddressV1`;
   - require the input value to be less than or equal to the destination output
     value using full multi-asset comparison;
   - fail if proof verification returns false.
6. Fail if there are unused proofs after all reclaim-base inputs are processed.
7. Fail if at least one reclaim-base input is present but no matching proof is
   supplied.

The rewarding script computes destination bytes from the corresponding output on
chain. The destination is not trusted when supplied by the redeemer or off-chain
builder. A valid proof authorizes the spend only to the proof-bound destination
address, and the protected input value must be covered by that output.

Transactions with no reclaim-base inputs should fail by default. The rewarding
script exists only to authorize reclaim spends; allowing no-op withdrawals makes
off-chain mistakes harder to detect.

## Contract 3: Reclaim Global Multi Rewarding Validator

### Purpose

`ReclaimGlobalMulti` authorizes a batch of matching `ReclaimBase` inputs with one
destination-bound proof. It scans all spending inputs whose payment credential is
the deployed `ReclaimBase` script hash, aggregates their credential hashes and
values, and requires one proof that covers the full ordered credential set and
the destination address.

### Parameters

The parameters mirror `ReclaimGlobal`:

- `paramsCurrencySymbol :: CurrencySymbol`
- `verifierKey :: BuiltinByteString`

The referenced parameter UTxO uses the same `ReclaimGlobalParams` datum shape
with the concrete `reclaimBaseScriptHash`.

### Redeemer

```haskell
data ReclaimGlobalMultiRedeemer = ReclaimGlobalMultiRedeemer
  { reclaimParamsIdx :: Integer
  , reclaimDestinationOutIdx :: Integer
  , reclaimProof :: BuiltinByteString
  }
```

`reclaimDestinationOutIdx` is the first `txInfoOutputs` index in the destination
run. The validator derives the 58-byte `destinationAddressV1` value from that
output and aggregates the value of that output plus immediately following
outputs with the same address. The run stops at the first output with a different
address.

### Public Input

The multi-proof public input is:

```text
blake2b_256(
  "ROOT-OWNERSHIP-MULTI-v1"
  || credential_count_u16_be
  || credential_hash_0
  || ...
  || credential_hash_n
  || destinationAddressV1
)
```

Each credential hash is the 28-byte `reclaimPaymentKeyHash` from a matching
`ReclaimBase` input's inline datum, traversed in `txInfoInputs` order.
`credential_count_u16_be` must be between 1 and 65535. `destinationAddressV1`
must be exactly 58 bytes.

### Validation Rules

For every withdrawal under
`ReclaimGlobalMulti(paramsCurrencySymbol, verifierKey)`:

1. The script purpose must be `RewardingScript ownCredential`.
2. Resolve and validate the parameter reference input selected by
   `reclaimParamsIdx`.
3. Traverse `txInfoInputs` in ledger order and include every input whose payment
   credential is `ScriptCredential reclaimBaseScriptHash`.
4. Fail if no matching `ReclaimBase` input is present.
5. Decode each matching input's inline `ReclaimBaseDatum`; each payment key hash
   must be exactly 28 bytes.
6. Derive `destinationAddressV1` from `txInfoOutputs[reclaimDestinationOutIdx]`.
   Enterprise addresses are encoded with a zero stake credential; base addresses
   encode the stake credential; pointer staking credentials are unsupported.
7. Verify the single proof against the multi-proof public input.
8. Require the aggregate protected value from all matching base inputs to be
   less than or equal to the aggregate contiguous destination-run value using
   full multi-asset comparison.

### Invariants

- `ReclaimBase` enforces invocation of `ReclaimGlobal`.
- `ReclaimGlobal` enforces proof coverage for every matching `ReclaimBase`
  input.
- `ReclaimGlobal` enforces one proof-bound corresponding destination output per
  matching input, and each destination output must cover the full input value.
- `ReclaimGlobalMulti` enforces one proof-bound destination address for every
  matching `ReclaimBase` input in the transaction, and its contiguous
  destination output run must cover the aggregate protected value.
- The parameter NFT fixes the reclaim-base script hash.
- The global script hash commits to the verifier key script parameter.
- The always-fails holder script prevents silent parameter mutation.

## Supporting Contract: One-Shot NFT Policy

The supporting minting policy is parameterized by a `TxOutRef` and succeeds only
when:

1. the transaction spends that exact `TxOutRef`; and
2. the policy authorizes exactly one token under its own currency symbol.

The policy does not constrain token name; the deployment transaction chooses the
NFT token name when minting the immutable parameter token.
