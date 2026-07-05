# Reclaim Destination Binding Plan

## Status

This plan has been refreshed against the current repo state. The core goal is
still valid, and the repo now also has a separate destination-bound
multi-credential path:

- `Ownership.ReclaimGlobal` is still the ownership-only, one-proof-per-input
  validator. It does not read destination outputs and its public input is still
  `blake2b_256("ROOT-OWNERSHIP-v1" <> paymentKeyHash)`.
- `Ownership.ReclaimGlobalMulti` already implements one proof for all matching
  reclaim-base inputs, binds the proof to `destinationAddressV1`, and checks the
  aggregate reclaimed value against the indexed destination output.
- `internal/circuit/ownershipmulti`, `prove-multi`, `verify-multi`, and
  `export-cardano` already cover the current count-2 multi proof path.

Use this document only as the implementation plan for retrofitting
destination-binding into the single `Ownership.ReclaimGlobal` path. Do not use
it to reimplement or replace `Ownership.ReclaimGlobalMulti`.

## Decision

For the single `Ownership.ReclaimGlobal` path, change the reclaim proof
statement from:

```text
I own paymentKeyHash.
```

to:

```text
I own paymentKeyHash, and I authorize reclaiming that script input to the
corresponding destination output address.
```

The target public input digest for the destination-bound single path is:

```text
blake2b_256("ROOT-OWNERSHIP-DESTINATION-v1" <> paymentKeyHash <> destinationAddress)
```

where `paymentKeyHash` is the 28-byte key hash from the `ReclaimBaseDatum`, and
`destinationAddress` must be a canonical byte encoding of the destination
`TxOut` address seen by the on-chain validator.

The contract should also require, for each reclaimed base input, that the
corresponding destination output carries a value greater than or equal to the
entire value of that input.

## Current Baseline

The current single-credential public input is only:

```text
blake2b_256("ROOT-OWNERSHIP-v1" <> paymentKeyHash)
```

Current single-path code:

- `internal/circuit/ownership/circuit.go` computes the circuit binding.
- `Ownership.Verify.ownershipPublicInputDigest` computes the Plutus-side digest.
- `ReclaimGlobalRedeemer` currently contains `reclaimParamsIdx` and
  `reclaimProofs`.
- `validateReclaimInputs` consumes one proof per matching reclaim-base input.
- `ReclaimGlobal` intentionally does not constrain outputs today.
- Existing tests explicitly allow a valid proof to pay an arbitrary destination.

Current multi-path code, which should be treated as reusable reference material:

- `Ownership.ReclaimGlobalMulti.destinationAddressV1FromTxOutData` is the
  on-chain 58-byte destination encoder.
- `Ownership.ReclaimGlobalMulti.multiCredentialPublicInputDigest` binds
  `ROOT-OWNERSHIP-MULTI-v1`, credential count, ordered credentials, and the
  destination bytes.
- `Ownership.ReclaimGlobalMulti.validateMultiReclaimInputs` scans matching
  reclaim-base inputs, aggregates their value, and checks
  `requiredValue` with `Value.leq` against `destinationValue`.
- `internal/circuit/ownershipmulti` mirrors the fixed-byte public input encoding
  on the Go/circuit side.

This plan supersedes the caller-selected output policy only for the single
`ReclaimGlobal` path after implementation.

## Address Encoding

The main design point is what the word `destinationAddress` means as bytes.

Do not use Bech32 text in the proof statement. The validator sees the ledger
`Address` inside `TxOut`, not a Bech32 string, and Plutus does not expose a
network id in the same way a Shelley address string does.

Recommended first implementation:

```text
destinationAddressV1 =
  paymentCredentialTag
  || paymentCredentialHash
  || stakeCredentialTag
  || stakeCredentialHashOrZero
```

with:

```text
paymentCredentialTag:
  0x01 = PubKeyCredential
  0x02 = ScriptCredential

paymentCredentialHash:
  28 bytes

stakeCredentialTag:
  0x00 = no staking credential
  0x01 = staking PubKeyCredential
  0x02 = staking ScriptCredential

stakeCredentialHashOrZero:
  28 bytes when stakeCredentialTag is 0x01 or 0x02
  28 zero bytes when stakeCredentialTag is 0x00
```

Total length: 58 bytes.

These tag bytes are this proof-tool wire encoding, not the Plutus constructor
tags. The on-chain encoder should decode the Plutus `Address` data and map it
into this fixed wire format.

Implementation rules for the on-chain encoder:

```haskell
destinationAddressV1FromTxOutData :: BuiltinData -> BuiltinByteString
```

- Read `txOutAddress` from field 0 of the destination `TxOut`.
- Decode the `Address` as credential plus optional staking credential.
- Decode `Credential` by Plutus constructor tag:
  - `PubKeyCredential` is constructor tag `0`;
  - `ScriptCredential` is constructor tag `1`.
- Extract the credential hash bytes and require length `28`.
- Encode the payment credential using proof-tool wire tags `0x01` or `0x02`.
- Decode the staking field:
  - `Nothing` encodes as wire tag `0x00` plus 28 zero bytes;
  - `Just (StakingHash (PubKeyCredential h))` encodes as `0x01 || h`;
  - `Just (StakingHash (ScriptCredential h))` encodes as `0x02 || h`;
  - `Just (StakingPtr _ _ _)` fails for v1.
- Require the final byte string length to be exactly `58`.

Before using this encoder in single-path proof verification, confirm the current
Haskell golden-vector tests cover the representative `Address` values needed by
the single path, or add the missing cases. Those tests should serialize
representative `Address` values with `V3.toBuiltinData` and prove the raw
constructor tags above match this repo's Plutus V3 snapshot. Do not rely on
memory or external documentation for those tags.

This gives the gnark circuit a compile-time-fixed address byte length while
still binding to the complete payment credential plus normal optional staking
hash. Reject staking-pointer destinations for v1 unless there is a concrete
need to support them.

Alternative: use `serialiseData` on the Plutus `Address`. That is closer to the
raw ledger value but likely makes the circuit change larger because the current
Blake2b gadget hashes compile-time-fixed input lengths. Supporting arbitrary
serialized address lengths would require either a bounded variable-length
Blake2b gadget or one compiled circuit per supported length. Avoid this unless
stake pointers or exact Plutus-data encoding are required.

For the rest of this document, `destinationAddress` means the 58-byte
`destinationAddressV1` value above.

## Contract Plan

This section targets `Ownership.ReclaimGlobal`. Keep
`Ownership.ReclaimGlobalMulti` intact unless a follow-up explicitly asks to
consolidate shared helpers.

Update the global redeemer:

```haskell
data ReclaimGlobalRedeemer = ReclaimGlobalRedeemer
  { reclaimParamsIdx :: Integer
  , reclaimDestinationOutStartIdx :: Integer
  , reclaimProofs :: [BuiltinByteString]
  }
```

Update `reclaimGlobalRedeemerData` to encode the new integer between
`reclaimParamsIdx` and `reclaimProofs`.

Reuse the current multi-path conventions where possible:

- keep the `destinationAddressV1` wire format byte-for-byte compatible with
  `Ownership.ReclaimGlobalMulti`;
- prefer extracting common address/value helpers into a small shared module only
  if it keeps both validators readable and compiles cleanly;
- otherwise copy the small helpers deliberately and keep golden-vector tests so
  the two encoders cannot drift.

In `reclaimGlobalValidator`:

1. Continue resolving `txInfoReferenceInputs !! reclaimParamsIdx`.
2. Extract `txInfoOutputs` from the V3 `TxInfo` field after inputs and
   reference inputs. The current raw-data decoder uses `field0 txInfoFields` for
   inputs and `field1 txInfoFields` for reference inputs, so outputs are
   `field2 txInfoFields`.
3. Drop `txInfoOutputs` by `reclaimDestinationOutStartIdx`.
4. Pass the dropped output suffix into `validateReclaimInputs`.

Add a helper equivalent to:

```haskell
dropAtData :: BuiltinString -> Integer -> BI.BuiltinList BuiltinData -> BI.BuiltinList BuiltinData
```

It should fail on negative indices or indices greater than the output list
length. If the index equals the number of outputs, it returns an empty list; the
first matching reclaim input then fails with a missing destination output.

Update `validateReclaimInputs` so it walks three ordered streams:

- transaction inputs in ledger order;
- proofs in redeemer order;
- destination outputs starting at `reclaimDestinationOutStartIdx`.

For each transaction input:

- If it is not from the configured reclaim-base script hash, skip it and do not
  consume a proof or destination output.
- If it is a reclaim-base input, consume exactly one proof and exactly one
  destination output.
- Decode the base datum payment key hash.
- Encode the destination output address with `destinationAddressV1`.
- Verify the proof against the destination-bound single public input:

```text
blake2b_256(
  "ROOT-OWNERSHIP-DESTINATION-v1"
  <> paymentKeyHash
  <> destinationAddressV1(correspondingOutput.address)
)
```

- Check `inputValue <= correspondingOutput.value` for every asset class.

The destination address bytes must always be computed from the corresponding
transaction output on-chain. They must not be accepted from the redeemer as a
trusted value.

Terminal behavior:

- Keep failing if no reclaim-base input was seen.
- Keep failing if any proofs remain unused.
- Do not fail solely because extra transaction outputs remain after all matching
  reclaim inputs are processed; those can be change outputs or unrelated
  transaction outputs.

## Value Check

The value check should compare full multi-asset `Value`, not only lovelace.

Required predicate:

```text
for every (policyId, tokenName, amount) in inputValue:
  outputValue[policyId, tokenName] >= amount
```

Use the same typed approach already proven in `Ownership.ReclaimGlobalMulti`:
decode both `TxOut` values to `Value` and compare with `Value.leq`.

If that becomes too expensive or fails to compile in the single validator, fall
back to a dedicated raw-data helper:

```haskell
valueLeqData :: BuiltinData -> BuiltinData -> BI.BuiltinBool
```

The fallback should scan every currency symbol and token name in the input
value, look up the same asset in the output value, and compare quantities. Do
not rely on the order of entries in the `Value` map. Keep tests for Ada-only,
multi-asset, missing-policy, missing-token, equal, greater, and less-than cases.

This allows the destination output to include extra lovelace for min-ADA or
additional tokens, but it prevents fees, token loss, or partial native-asset
redirection from being paid out of the protected reclaim input.

## Proof And Circuit Plan

The circuit must bind the proof to the same destination address bytes the
contract computes. It is not enough for the contract to check outputs while the
proof remains ownership-only.

Do not silently mutate `internal/circuit/ownership` in place unless the product
decision is to deprecate the current ownership-only proof artifact. The safer
implementation is a destination-specific single-credential circuit path, for
example:

```text
internal/circuit/ownershipdest
```

The new circuit should:

- Add a 58-byte destination address witness field to `Circuit`.
- Replace `BindCredential` with a binding over:

```text
"ROOT-OWNERSHIP-DESTINATION-v1" || credential || destinationAddress
```

Add Go helpers for the destination-bound single path:

```go
DestinationAddressV1Bytes(...)
PublicInputDigestForCredentialDestination(credential, destination []byte)
PublicInputForCredentialDestination(credential, destination []byte)
```

- Preserve little-endian digest-to-field conversion so it matches the existing
  verifier conventions.
- Add golden vectors for the address encoding and digest.
- Reuse the constants and validation behavior from `ownershipmulti` where they
  are generic, but keep the circuit id and key bundle separate from both
  `ownership` and `ownershipmulti`.

Add destination-bound verifier helpers in `Ownership.Verify` instead of changing
the existing ownership-only helper signatures:

```haskell
ownershipDestinationDomain :: BuiltinByteString

ownershipDestinationPublicInputDigest ::
  BuiltinByteString ->
  BuiltinByteString ->
  BuiltinByteString

verifyOwnershipDestinationWithVK ::
  BuiltinByteString ->
  BuiltinByteString ->
  BuiltinByteString ->
  BuiltinByteString ->
  Bool

verifyOwnershipDestinationWithParsedVK ::
  ParsedVerifyingKey ->
  BuiltinByteString ->
  BuiltinByteString ->
  BuiltinByteString ->
  Bool

verifyOwnershipDestinationWithParsedVKKnown28NoPok ::
  ParsedVerifyingKey ->
  BuiltinByteString ->
  BuiltinByteString ->
  BuiltinByteString ->
  CommittedProofCheck
```

Argument order should be:

```text
verifier key / parsed verifier key, proof, paymentKeyHash, destinationAddressV1
```

The destination-bound entrypoints should reject before proof parsing when
`paymentKeyHash` is not 28 bytes or `destinationAddressV1` is not 58 bytes. For
`verifyOwnershipDestinationWithVK`, perform this length guard before
`parseVerifyingKey` so malformed public-input material cannot force
verifier/proof deserialization.

The domain, circuit id, key version, and fixture names must be distinct from the
ownership-only path so old proofs, old proving keys, and old verifying keys
cannot be mistaken for destination-bound artifacts.

Suggested circuit id:

```text
root-ownership-destination-v1/bls12-381/groth16
```

Regenerate:

- proving key;
- verifying key;
- Cardano verifier fixture;
- destination-bound single proof fixture, for example
  `contracts/ownership-verifier/testdata/ownership-destination-proof.hex`;
- destination-bound single verifier fixture, for example
  `contracts/ownership-verifier/testdata/ownership-destination-vk.hex`;
- destination-bound single public input fixture, for example
  `contracts/ownership-verifier/testdata/ownership-destination-pub.hex`;
- any pinned verifier bytes and hashes for the destination-bound circuit.

Keep the existing ownership-only fixtures unless the implementation explicitly
removes or deprecates the ownership-only proof flow.

## CLI, Helper, And Artifact Plan

Add a destination-bound single proof artifact shape that carries the destination
binding explicitly:

```json
{
  "circuit_id": "root-ownership-destination-v1/bls12-381/groth16",
  "destination_address_encoding": "destination-address-v1",
  "destination_address": "hex-encoded-58-byte-value"
}
```

Update all public-input recomputation paths so they use both
`target_credential` and `destination_address`.

Affected surfaces:

- CLI proof generation
  - preferred: add explicit commands such as `prove-destination` and
    `verify-destination`;
  - acceptable alternative: extend `prove`/`verify` only if the artifact
    `circuit_id` keeps ownership-only and destination-bound proofs unambiguous;
  - require `--destination-address-bytes` for the first implementation;
  - optionally add `--destination-address` later once a Bech32-to-v1 parser is
    implemented and tested.
- destination-bound verification
  - recompute public input from artifact target credential plus destination.
- `proof-tool export-cardano`
  - route on the destination-bound circuit id, as it already does for the multi
    circuit id;
  - write `pub.hex` for the destination-bound digest.
- `internal/helper.ProveRequest`
  - require destination address bytes only for destination-bound reclaim proof
    requests;
  - do not break existing ownership-only helper requests unless the product flow
    is intentionally migrated.
- `internal/verifier.VerifyRequest`
  - optionally accept `expected_destination_address`;
  - never trust client-supplied `public_input` without recomputing it.
- `internal/prover.CardanoProofArtifact`
  - accept destination bytes when computing `public_input_digest_hex`.

The hosted verifier and helper must continue preserving the existing secret
boundary: no seed phrase, entropy, or master XPrv leaves the user's local helper
flow.

The first implementation can require raw `destination-address-v1` bytes at the
CLI/helper boundary. A later Bech32 address parser is product polish, not a
dependency for the contract/circuit work, as long as the raw bytes are generated
from the same encoding rules and covered by golden vectors.

## Transaction Builder Plan

The off-chain reclaim transaction builder must order outputs deliberately.

Builder rules:

1. Collect matching reclaim-base inputs in the ledger order that `txInfoInputs`
   will expose.
2. Build one destination output per reclaim-base input.
3. Place the first corresponding destination output at
   `reclaimDestinationOutStartIdx`.
4. Preserve one-to-one ordering:

```text
matchingBaseInput[0] -> txInfoOutputs[destinationOutStartIdx + 0]
matchingBaseInput[1] -> txInfoOutputs[destinationOutStartIdx + 1]
...
```

5. Ensure each corresponding output is addressed to the destination used when
   generating that proof.
6. Ensure each corresponding output value is greater than or equal to the
   matching input value.
7. Fund fees and any additional min-ADA from other wallet inputs, or add enough
   value to the destination outputs so the protected reclaim value is not
   reduced.

This v1 plan does not aggregate multiple reclaim inputs into one destination
output. If aggregation is desired later, it needs a different value-accounting
rule. The current aggregate design already exists in `Ownership.ReclaimGlobalMulti`;
use that path when one proof and one destination output for all matching inputs
is the desired product behavior.

This v1 plan also allows different reclaim inputs in the same transaction to use
different destination addresses, as long as each proof is bound to its own
corresponding output. If product policy requires one shared destination address
per transaction, add an extra equality check across all consumed destination
output addresses.

## Test Plan

Haskell contract tests:

- Public input digest binds domain, payment key hash, and destination address.
- Valid proof succeeds only when the corresponding output has the proof-bound
  destination address.
- Redirecting the corresponding output to another address rejects.
- Output with less lovelace than the input rejects.
- Output missing a native asset from the input rejects.
- Output with equal input value accepts.
- Output with greater value accepts.
- Negative `reclaimDestinationOutStartIdx` rejects.
- Out-of-bounds `reclaimDestinationOutStartIdx` rejects.
- Outputs before `reclaimDestinationOutStartIdx` are ignored.
- Non-base inputs do not consume proofs or destination outputs.
- Multiple base inputs consume destination outputs in matching base-input order.
- Missing destination output rejects.
- Extra trailing outputs after the consumed destination outputs are allowed.
- Missing proofs and unused proofs still reject.
- The old `ReclaimGlobal` tests that allow arbitrary destinations must be
  replaced or moved to a legacy validator test. After this plan is implemented,
  the active `ReclaimGlobal` entrypoint must reject destination redirection.
- Existing `ReclaimGlobalMulti` real-proof tests must continue to pass.

Go tests:

- Destination address v1 encoding golden vectors.
- Public input digest golden vectors.
- Circuit accepts the correct destination and rejects a changed destination.
- Destination-bound proof generation emits destination-bound artifacts.
- Destination-bound verification rejects artifacts whose destination field is
  tampered.
- `export-cardano` writes `pub.hex` matching the destination-bound digest.
- Cardano proof artifact uses the destination-bound digest.
- Existing ownership-only `prove`/`verify` tests still pass unless that flow is
  intentionally deprecated.
- Existing `prove-multi`/`verify-multi` tests still pass.

TypeScript/web/helper tests:

- Destination-bound helper prove requests require destination address bytes.
- Web flow sends destination address bytes to the local helper.
- Hosted verifier request carries expected destination material when available.
- UI tests continue proving that seed phrase and master XPrv are not sent to the
  hosted verifier.

## Implementation Order

1. Confirm the current `Ownership.ReclaimGlobalMulti` encoder/value behavior with
   the existing tests; treat it as the reference for `destinationAddressV1` and
   full-value comparison.
2. Add or extract shared `destinationAddressV1` helpers in Haskell and Go plus
   golden vectors.
3. Add destination-bound single public input helpers in Haskell and Go.
4. Add the destination-specific single circuit shape, circuit id, assignment, and
   public input binding.
5. Regenerate destination-bound proving/verifying keys and Cardano proof
   fixtures without overwriting ownership-only or multi fixtures.
6. Add the Plutus destination-bound verifier helpers and unit tests.
7. Update `ReclaimGlobalRedeemer`, output indexing, proof verification, and value
   checks.
8. Update CLI, helper, verifier, artifact, and web request/response types for
   the destination-bound single artifact.
9. Run the real derive/prove/verify/export flow and then the contract tests with
   the exported fixture.

## Verification Commands

Run at least:

```bash
go test ./...
pnpm --dir packages/client-ts test
pnpm --dir apps/ownership-proof-web test
pnpm --dir apps/ownership-proof-web build
cd contracts/ownership-verifier && cabal v2-test all -v0
```

If the desktop helper surface changes, also run:

```bash
pnpm --dir apps/proof-helper-desktop test
pnpm --dir apps/proof-helper-desktop build
```

For final readiness, run a real derive/prove/verify/export flow with a fresh
destination-bound proof and use the exported `proof.hex`, `vk.hex`, and `pub.hex`
in the Haskell contract tests.

Also keep the existing multi fixture green:

```bash
PROOF_TOOL_RUN_FULL_PROOF=1 go test ./internal/prover -run Multi
cd contracts/ownership-verifier && cabal v2-test all -v0
```

## Work Estimate

Contract-only output threading is small to moderate, but the full change is
larger because it adds a new proof statement and new proof/key fixtures. The
current multi path reduces uncertainty around destination encoding, value
comparison, artifact routing, and Cardano fixture export, but it does not remove
the need for a destination-bound single circuit and verifier key.

Expected size with the recommended fixed 58-byte destination encoding:

- Address encoding decision and golden vectors: 0.5 day.
- Circuit/prover/artifact/helper/verifier updates: 1 to 2 days, less if the
  single-destination path can reuse multi helper structure cleanly.
- Contract redeemer/output/value checks: 0.5 to 1 day.
- Fixture regeneration and verification cleanup: 0.5 to 1 day.
- Product UI/parser polish, if using Bech32 input instead of raw bytes: 0.5 to
  1.5 days.

Total: roughly 2.5 to 5 engineer-days, depending mostly on how much UI/address
parsing polish is included in the first pass.

If raw variable-length serialized Plutus `Address` bytes are required instead
of fixed `destinationAddressV1`, expect the circuit work to be materially larger
because the Blake2b gadget and proof assignment need a robust variable-length
address strategy.

## Documentation Updates During Implementation

When implementing this plan, update:

- `docs/reclaim-contracts-spec.md`
- `docs/reclaim-contract-audit-context.md`
- `docs/ownership-proof-app-architecture-plan.md`
- `docs/non-technical-ownership-proof-runbook.md`

The spec should no longer say that reclaimed value destination is
caller-selected after proof acceptance. The new invariant is that every
reclaim-base input has a proof-bound corresponding destination output with value
greater than or equal to the input value.
