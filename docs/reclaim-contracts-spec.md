# Reclaim Contracts Specification

This document specifies the reclaim contract family implemented in
`contracts/ownership-verifier/src/Ownership/ReclaimBase.hs` and
`contracts/ownership-verifier/src/Ownership/ReclaimGlobalV2.hs`. The separate
aggregate-proof path is implemented in
`contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs`. The
supporting one-shot NFT minting policy lives in
`contracts/ownership-verifier/src/Ownership/OneShotNFT.hs`.

## Existing State

The repository contains `Ownership.Verify`, a reusable Plutus V3 ownership-proof
verifier, plus the reclaim-base spending validator and reclaim-global rewarding
validator described below.

Developer entrypoints:

- `src/Ownership/Verify.hs`: committed Groth16/BSB22 parsing and ownership,
  destination, and multi public-input checks.
- `src/Ownership/ReclaimBase.hs`: spending validator that requires the global
  rewarding credential.
- `src/Ownership/ReclaimGlobalV2.hs`: the canonical single-proof global
  validator, with one full destination-bound proof and one authenticated
  statement digest per matching input.
- `src/Ownership/ReclaimGlobalMulti.hs`: one count-specific proof for an
  ordered set of matching inputs.
- `test/VerifySpec.hs`: real-proof positives plus proof/order/destination/value
  negative cases.
- `test-support/ScriptContextBuilder.hs`: transaction-context fixtures shared
  by tests and benchmarks.
- `bench/Bench.hs`: full validator-context execution budgets.
- `export/ReclaimDeploymentScripts.hs`: parameterized Plutus V3 deployment
  script export used by the Preprod deployer.

## Contract 1: Reclaim Base Spending Validator

### Purpose

`ReclaimBase` is the script address where users deposit reclaimable UTxOs. Each
UTxO carries a datum containing the payment public key hash that must be proven
by the global reclaim script when the UTxO is spent.

### Parameters

- `globalCredential :: Credential`
  The withdrawal-map key configured during the one-time deployment. The
  deployment must audit that this is the intended global rewarding script
  credential. `ReclaimBase` deliberately does not revalidate the constructor or
  compare the parameter with deployment metadata on every spend; it uses the
  applied value directly as the required withdrawal key.

### Datum

```haskell
data ReclaimBaseDatum = ReclaimBaseDatum
  { reclaimPaymentKeyHash :: BuiltinByteString
  }
```

`reclaimPaymentKeyHash` must be exactly 28 bytes. It is the Cardano payment key
hash passed to `Ownership.Verify.verifyOwnershipWithVK`.
This is a GlobalV2 proof-input requirement and datum-format conformance rule;
the minimal Base gate does not inspect it.

### Redeemer

The base validator does not need a semantic redeemer. Use unit unless a later
off-chain workflow needs tagging.

### Validation Rules

For every spend from `ReclaimBase(globalCredential)`:

1. The transaction must include a withdrawal under `globalCredential`.
2. The withdrawal amount is ignored.
3. A different withdrawal key does not satisfy the gate.
4. The validator does not inspect `ScriptInfo`, the datum, credential width,
   proofs, other reclaim inputs, destinations, or values. Those checks belong
   to ledger invocation and `ReclaimGlobalV2`.

The complete validator condition is equivalent to:

```haskell
globalCredential `elem` keys (txInfoWdrl txInfo)
```

The compiled Base projects `txInfoWdrl` directly from field 6 of the
ledger-built Plutus V3 `TxInfo`. It deliberately does not recheck the
single-constructor `ScriptContext`/`TxInfo` tags or recursively bounds-check
that fixed record projection. A layout regression test pins the field against
`plutus-ledger-api-1.38.0.0`; upgrading the ledger API requires rerunning that
test and the artifact/coherence gates.

For the intended deployment, ledger validation of the configured script
withdrawal executes `ReclaimGlobalV2`. GlobalV2 must then scan every matching
base input, extract its datum credential, enforce the 28-byte verifier input,
verify the destination-bound statement, and require complete value coverage.
A missing or malformed datum can pass this local base gate but must make the
composed transaction fail in GlobalV2.

A key credential can satisfy the local membership check if a deployment is
misconfigured that way. Preventing that configuration is an explicit one-time
deployment audit obligation rather than a repeated on-chain check.

Deployment status: this specification describes the active Preprod source and
deployment. ReclaimBase hash
`744cc4718e8149201c7e9cb3d3a550f34cb18dfc8076a33172d9354d` is parameterized
by ReclaimGlobalV2 credential
`a4da74e7cb6ea4f4e60456a0a6eabf0ccf83464ebe55664390ef39f8`. The parameter
datum and both reference scripts were created by transaction
`c8d6d3b6ddd1a8aa43ee039acb54a79a4bb427f4bbacd95085754b09ecfada2f`;
the enabled public manifest pins those exact identities and output indices.

## Contract 2: ReclaimGlobalV2 Rewarding Validator

### Purpose

`ReclaimGlobalV2` is invoked through withdrawals. It verifies ownership proofs
for all `ReclaimBase` inputs in the transaction, using a verifier key fixed by
the script instance and deployment metadata stored in an immutable NFT
parameter UTxO. It is the sole supported single-proof global validator; there
is no V1 implementation or export mode.

### Parameters

- `paramsCurrencySymbol :: CurrencySymbol`
  The currency symbol of the one-shot NFT that identifies the global parameter
  UTxO.
- `paramsTokenName :: TokenName`
  The exact token name of that parameter NFT.
- `verifierKey :: BuiltinByteString`
  The committed Groth16 verifier key exported by `proof-tool export-cardano`.
  This is a script parameter, so the global validator hash commits to the key
  for a given deployment.
- `verifierKeyHash :: BuiltinByteString`
  The 32-byte BLAKE2b-256 hash of `verifierKey`, checked by export tooling before
  script finalization and committed as the V2 batch-transcript key identity.

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

The constructor-0 redeemer contains four ordered fields:

```text
[ reclaimParamsIdx
, reclaimDestinationOutStartIdx
, reclaimProofs
, reclaimPublicInputDigests
]
```

`reclaimParamsIdx` is the index in `txInfoReferenceInputs` of the parameter
UTxO. `reclaimDestinationOutStartIdx` is the first `txInfoOutputs` index in the
run of destination outputs corresponding to matching reclaim-base inputs.
`reclaimProofs` and `reclaimPublicInputDigests` are parallel lists ordered to
match the reclaim-base inputs as they appear in `txInfoInputs`. Every proof is
the complete 336-byte Cardano proof encoding; V2 has no proof-reuse marker or
credential/proof cache.

### Validation Rules

For every withdrawal under the parameterized `ReclaimGlobalV2` script:

1. The script purpose must be `RewardingScript ownCredential`.
2. Resolve `txInfoReferenceInputs !! reclaimParamsIdx`; fail if the index is
   negative or out of bounds.
3. The referenced output must contain exactly one parameter NFT under the exact
   `paramsCurrencySymbol` and `paramsTokenName` pair.
4. The referenced output must use inline datum and decode as
   `ReclaimGlobalParams`.
5. Traverse `txInfoInputs` in ledger order. For each input whose resolved output
   address has payment credential `ScriptCredential reclaimBaseScriptHash`:
   - require the next proof from `reclaimProofs`;
   - require the next public-input digest and destination output from
     `txInfoOutputs[reclaimDestinationOutStartIdx..]`;
   - decode that input's datum as `ReclaimBaseDatum`;
   - require `reclaimPaymentKeyHash` to be 28 bytes;
   - encode the corresponding destination output address as
     `destinationAddressV1`;
   - compute the domain-separated destination statement digest from
     `reclaimPaymentKeyHash` and `destinationAddressV1`, then require it to
     equal the corresponding redeemer digest;
   - decode the full proof into the committed-proof batch representation;
   - require the input value to be less than or equal to the destination output
     value using full multi-asset comparison;
6. Derive the statement-bound V2 batch challenge from the verifier-key hash and
   the complete ordered proof/digest lists, fold every slot exactly once, and
   require both the Groth16 batch equation and commitment proof-of-knowledge.
7. Fail if proofs or digests are missing or remain unused after all matching
   inputs are processed.
8. Fail if there are no matching reclaim-base inputs.

The rewarding script computes destination bytes from the corresponding output on
chain. The destination is not trusted when supplied by the redeemer or off-chain
builder. A valid proof authorizes the spend only to the proof-bound destination
address, and the protected input value must be covered by that output.

`destinationAddressV1` is a network-independent, fixed 58-byte encoding:

```text
payment_credential_tag || payment_credential_hash
|| stake_credential_tag || stake_credential_hash
```

Each tag is one byte (`0x01` for a key credential, `0x02` for a script
credential) and each hash is 28 bytes. Enterprise addresses use 29 zero bytes
for the absent stake part. Base addresses encode the actual stake credential.
Pointer stake credentials are intentionally unsupported. The browser encoder
is `apps/ownership-proof-web/lib/claim/addresses.ts`; both global validators
derive the same bytes from ledger `Address` data on chain. Network ID is not
part of the Plutus `Address` value, so the off-chain network check happens
before this encoding. The on-chain encoders rely on the ledger-built `Address`
constructor ranges and 28-byte credential hashes instead of revalidating those
invariants. They retain the branches that affect the wire encoding and the
explicit rejection of the valid-but-unsupported pointer staking variant.

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

The parameters mirror `ReclaimGlobalV2` except that the separate multi export
does not take the V2 transcript verifier-key-hash parameter:

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

- `ReclaimBase` enforces invocation of the configured global withdrawal
  credential; the canonical single-proof deployment binds that credential to
  `ReclaimGlobalV2`.
- `ReclaimGlobalV2` enforces proof coverage for every matching `ReclaimBase`
  input.
- `ReclaimGlobalV2` enforces one proof-bound corresponding destination output per
  matching input, and each destination output must cover the full input value.
- `ReclaimGlobalMulti` enforces one proof-bound destination address for every
  matching `ReclaimBase` input in the transaction, and its contiguous
  destination output run must cover the aggregate protected value.
- The parameter NFT fixes the reclaim-base script hash.
- The global script hash commits to the verifier key script parameter.
- The always-fails holder script prevents silent parameter mutation.

## Statement-Bound V2 Deployment Capacity Policy

The statement-bound V2 deployment profile is optimized for the normal reclaim
case. Its seven-UTxO capacity was benchmarked with payment credentials derived
from one root private key and distinct across the batch; that benchmark does not
impose a credential-uniqueness admission rule. Its deployment manifest fixes
the following policy:

- the default batch is six UTxOs;
- the optimization batch is six UTxOs;
- a seven-UTxO batch requires an explicit `maxUtxos: 7` request;
- evaluated transaction CPU must not exceed 90% of the network limit, and
  evaluated memory must not exceed 80%; and
- builders must always obtain and enforce measured execution units. A count is
  never a substitute for transaction evaluation.

Repeated full proofs remain valid inputs but are not the V2 high-capacity
benchmark target. The transcript always carries one full proof and one
authenticated statement digest per slot.

## Supporting Contract: One-Shot NFT Policy

The supporting minting policy is parameterized by a `TxOutRef` and succeeds only
when:

1. the transaction spends that exact `TxOutRef`; and
2. the policy authorizes exactly one token under its own currency symbol.

The policy does not constrain token name; the deployment transaction chooses the
NFT token name when minting the immutable parameter token.

## Proof Fixtures And Benchmarks

Checked fixtures under `testdata/` are generated from real Go proving and
Cardano export paths, not invented bytes:

- `ownership-destination-{proof,vk,pub}.hex`: active single-destination proof;
- `multi-count2-{proof,vk,pub}.hex`: count-2 multi proof;
- `multi-benchmark-fixtures.json`: count-1 and count-5 multi proofs plus
  credentials, destination, circuit/key identities, and Cardano bytes;
- `ownership-destination-distinct-proofs.txt`: distinct single proofs used by
  batch benchmarks.

The count is part of the multi circuit ID and key version; never reuse a VK or
proof across counts. Regenerate multi benchmark fixtures deliberately with a
local 96-byte golden-vector master XPrv (do not put a real secret in a command):

```bash
go run ./cmd/proof-tool generate-multi-benchmark-fixtures \
  --counts 1,5 \
  --master-xprv <repo-backed-test-master-xprv-hex> \
  --destination-address-bytes <58-byte-test-destination-hex>
```

Generation verifies each proof before updating JSON. Counts 10, 15, and 20
were intentionally deferred after the count-5 budget gate. The recorded full
context count-5 result used 2,418,229 memory and 3,790,755,057 CPU, about
17.273% memory and 37.908% CPU of the configured maximum transaction budget.
Treat those numbers as regression context, not a substitute for benchmarking
the current compiler/dependency set.

```bash
cd contracts/ownership-verifier
cabal v2-test all
cabal v2-bench ownership-verifier-bench
cabal v2-build exe:reclaim-scripts-export
```

Any verifier, redeemer, address-encoding, fixture, or compiler change requires
real positive and negative contract-path evidence. Compile-only evidence is not
sufficient for a mainnet-facing reclaim rule.
