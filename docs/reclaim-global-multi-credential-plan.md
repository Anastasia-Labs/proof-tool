# Reclaim Global Multi-Credential Plan

## Decision

Introduce a new `ReclaimGlobal` variant that verifies one proof for multiple
reclaim-base credentials in the same transaction.

The new variant is for this claim:

```text
I know the master private key that derives all listed payment key hashes, and I
authorize reclaiming their protected inputs to this destination address.
```

This should be a separate validator/module at first, not an in-place mutation of
the current one-proof-per-input global validator.

Suggested module names:

- `Ownership.ReclaimGlobalMulti`
- `Ownership.VerifyMulti`

Suggested circuit id:

```text
root-ownership-multi-destination-v1/bls12-381/groth16
```

## Proposed Public Input

The requested public input is:

```text
builtinListOfPublicKeyHashes :: BuiltinList BuiltinData

-- each element is:
B THE_PUBLIC_KEY_HASH_HERE

publicInputDigest =
  blake2b_256
    ( "ROOT-OWNERSHIP-v1"
   <> serialiseData(builtinListOfPublicKeyHashes)
   <> serialiseData(destinationAddress)
    )
```

Strictly in Plutus terms, `serialiseData` takes `BuiltinData`, not
`BuiltinList BuiltinData`, so the list must be wrapped as list data first:

```haskell
publicKeyHashesData :: BuiltinData
publicKeyHashesData = BI.mkList builtinListOfPublicKeyHashes

publicInputDigest =
  blake2b_256
    ( ownershipDomain
   <> serialiseData publicKeyHashesData
   <> serialiseData destinationAddressData
    )
```

`destinationAddressData` should be the `Address` field from the destination
`TxOut` as represented in the Plutus `TxOut` data.

## Efficiency Verdict

The serialized-list public input makes semantic sense, but I would not treat it
as the most ex-unit efficient encoding.

The main on-chain saving comes from verifying one Groth16 proof instead of one
proof per credential. That should dominate the design. After that, the public
input encoding still matters, and the proposed `serialiseData` form is probably
not the cheapest option because it:

- serializes a Plutus data list on-chain;
- serializes a Plutus address value on-chain;
- hashes more bytes than the raw credential hashes require;
- forces the circuit/off-chain side to reproduce Plutus data serialization
  exactly.

I have strong confidence that a fixed-width byte encoding will be more
ex-unit-efficient than the serialized-list form:

```text
publicInputDigest =
  blake2b_256
    ( "ROOT-OWNERSHIP-MULTI-v1"
   <> credentialCountU16BE
   <> credentialHash_0
   <> credentialHash_1
   <> ...
   <> credentialHash_n
   <> destinationAddressV1
    )
```

where:

- `credentialCountU16BE` is a 2-byte big-endian count;
- every credential hash is exactly 28 bytes;
- credentials are ordered by the matching reclaim-base inputs in `txInfoInputs`
  ledger order;
- `destinationAddressV1` is the fixed 58-byte address encoding from
  `docs/reclaim-destination-binding-plan.md`.

This avoids `serialiseData`, minimizes bytes, and keeps the destination encoding
compile-time-fixed for the gnark Blake2b gadget.

The exact ex-unit delta should still be benchmarked, but the direction is clear:
`count || concat(28-byte hashes) || fixed address bytes` is a better low-cost
public-input preimage than `serialiseData(list-of-B) || serialiseData(address)`.

## Non-Goals

- Do not support arbitrary variable-length address serialization in the first
  version.
- Do not accept a public-key-hash list from the redeemer without checking it
  against actual reclaim-base inputs.
- Do not aggregate unrelated users into one proof unless the circuit explicitly
  proves all credentials derive from the same master key.
- Do not replace the current single-credential global validator until the
  batched variant has its own fixtures, benchmarks, and audit context.

## Contract Plan

Add a new global redeemer:

```haskell
data ReclaimGlobalMultiRedeemer = ReclaimGlobalMultiRedeemer
  { reclaimParamsIdx :: Integer
  , reclaimDestinationOutIdx :: Integer
  , reclaimProof :: BuiltinByteString
  }
```

The contract should not need `reclaimProofs`; there is one proof for the whole
batch.

Validation flow:

1. Check the script purpose is `RewardingScript`.
2. Resolve the parameter reference input by `reclaimParamsIdx`, as the current
   global validator does.
3. Drop `reclaimDestinationOutIdx` outputs from `txInfoOutputs`; the first
   remaining output is the proof-bound destination output.
4. Accumulate the value of that first output and every immediately following
   output with the same ledger address. Stop at the first output with a
   different address.
5. Traverse `txInfoInputs` in ledger order.
6. For every input locked by the configured reclaim-base script hash:
   - decode the inline `ReclaimBaseDatum`;
   - require the payment key hash to be exactly 28 bytes;
   - append that key hash to the credential sequence;
   - add that input value into an aggregate required value.
7. Fail if no matching reclaim-base inputs were found.
8. Compute the public input digest from the collected credential sequence and
   the first destination output address.
9. Verify the single proof against that digest.
10. Require the accumulated contiguous destination-run value to be greater than
    or equal to the aggregate value from all matching reclaim-base inputs.

Value comparison must be full multi-asset comparison, not lovelace-only.

## Literal Serialized-Data Variant

If the first implementation intentionally follows the requested serialized-data
public input, build the credential list from the actual matching inputs:

```text
credentialDataList =
  [ B pkh | pkh <- reclaim-base inputs in txInfoInputs order ]

publicInputDigest =
  blake2b_256
    ( "ROOT-OWNERSHIP-v1"
   <> serialiseData(listData credentialDataList)
   <> serialiseData(destinationAddressData)
    )
```

Implementation notes:

- Preserve input order exactly. Prepending into an accumulator reverses order, so
  either reverse before serialization or use a recursive builder that emits the
  list in ledger order.
- Do not trust a redeemer-supplied list as the source of truth.
- Add golden vectors for the exact Plutus serialization bytes.
- Benchmark this against the fixed-byte encoding before committing to it for
  production.

## Recommended Fixed-Byte Variant

The lower-cost variant should build a byte string while scanning inputs:

```text
credentialBytes =
  credentialCountU16BE <> concat(publicKeyHashesInInputOrder)

destinationBytes =
  destinationAddressV1(destinationOutput.address)

publicInputDigest =
  blake2b_256
    ( "ROOT-OWNERSHIP-MULTI-v1"
   <> credentialBytes
   <> destinationBytes
    )
```

This variant should be the default unless exact Plutus data serialization is a
hard product or interoperability requirement.

Benefits:

- no `serialiseData` call for the credential list;
- no `serialiseData` call for the address;
- fewer bytes passed into `blake2b_256`;
- simpler golden vectors for Go, Haskell, and TypeScript;
- easier fixed-length circuit assignment for the destination address.

## Circuit Plan

A multi-credential proof is not just a different public input. The circuit must
prove derivation of every listed credential from the same master XPrv.

Open design choice:

- exact-count circuits: one circuit/key per credential count;
- max-count circuit: one circuit with `maxCredentials` slots and an enabled
  count/mask;
- small family of circuits: for example 1, 2, 4, 8, and 16 credentials.

For this repo, a small family of circuits is likely the best first production
shape. It keeps proof generation predictable while avoiding one huge
always-maxed circuit.

Circuit requirements:

- one private master XPrv;
- one private derivation path per credential;
- one derived 28-byte credential per path;
- an assertion that every derived credential equals the corresponding public
  input credential bytes;
- one public scalar for the digest;
- destination bytes included in the digest binding.

Changing the circuit requires a fresh proving key, verifying key, Cardano
verifier fixture, and pinned verifier hash.

## Artifact And CLI Plan

Add multi-proof artifact fields:

```json
{
  "circuit_id": "root-ownership-multi-destination-v1/bls12-381/groth16",
  "target_credentials": ["hex-28-byte-pkh", "..."],
  "destination_address_encoding": "destination-address-v1",
  "destination_address": "hex-58-byte-address",
  "credential_count": 2,
  "public_input_encoding": "multi-credential-fixed-v1"
}
```

CLI additions:

- `proof-tool prove-multi`
  - accepts repeated `--target-credential`;
  - accepts `--destination-address-bytes`;
  - finds or accepts one path per target credential;
  - emits one proof artifact.
- `proof-tool verify-multi`
  - recomputes public input from all credentials and destination bytes;
  - rejects reordered, missing, extra, or tampered credentials.
- `proof-tool export-cardano`
  - supports the multi-proof artifact and writes the matching `pub.hex`.

Helper/web additions:

- The helper `/prove` API should get a separate multi endpoint or protocol
  version field.
- The web app must preserve credential order between transaction construction,
  helper proof generation, and hosted/on-chain verification.

## Transaction Builder Plan

The transaction builder must make the proof input and contract input agree.

Rules:

1. Collect reclaim-base inputs.
2. Determine the final `txInfoInputs` order.
3. Extract the reclaim payment key hashes in that exact order.
4. Generate the multi-credential proof for that ordered list.
5. Place the first proof-bound destination output at `reclaimDestinationOutIdx`.
6. Put any additional destination outputs immediately after it, using the same
   destination address.
7. Ensure the contiguous same-address destination run carries at least the
   aggregate value of all matching reclaim-base inputs.
8. Pay fees from unrelated wallet inputs or add extra value to one or more
   outputs in the destination run.

The aggregate-run plan lets wallets split the reclaimed value across multiple
UTxOs while keeping the proof bound to a single destination address. Outputs
after the first different address are not counted.

## Test Plan

Contract tests:

- accepts two reclaim-base inputs with one valid multi proof;
- rejects if any matching input credential is omitted from the public input;
- rejects if credentials are reordered;
- rejects if destination output address changes;
- rejects if the contiguous destination-run value is below the aggregate input
  value;
- accepts destination-run value equal to the aggregate input value;
- accepts destination-run value greater than aggregate input value;
- accepts the aggregate value split across contiguous same-address destination
  outputs;
- rejects when a later same-address output appears after an intervening
  different-address output and the contiguous prefix underpays;
- rejects if no reclaim-base inputs are present;
- rejects if destination output index is negative or out of bounds;
- verifies duplicate credentials behavior explicitly.

Circuit/Go tests:

- public input golden vectors for the serialized-data variant if implemented;
- public input golden vectors for fixed-byte encoding;
- proof succeeds for all listed credentials;
- proof rejects when one listed credential is changed;
- proof rejects when credential order changes;
- proof rejects when destination changes;
- artifact verification rejects reordered `target_credentials`.

Benchmark tests:

- compare ex-units for serialized-list public input vs fixed-byte public input;
- run counts 1, 2, 4, 8, and 16 if feasible;
- compare one multi proof against N single proofs;
- record proof generation time separately from on-chain verification ex-units.

## Recommendation

Use the fixed-byte public input for production:

```text
blake2b_256(
  "ROOT-OWNERSHIP-MULTI-v1"
  <> credentialCountU16BE
  <> concat(publicKeyHashesInInputOrder)
  <> destinationAddressV1
)
```

Keep the serialized-data public input as a benchmarked prototype only if exact
Plutus-data compatibility is valuable.

The serialized form is reasonable and easy to reason about. It is probably not
the most ex-unit efficient form.
