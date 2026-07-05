# Reclaim Global Multi-Proof Fixture Plan

## Purpose

Close the remaining verification gap for `Ownership.ReclaimGlobalMulti`:

```text
The production multi-credential validator accepts one real Groth16 proof for
multiple reclaim-base credentials and rejects the same proof when the input
order, destination, or credential list changes.
```

The contract-side binding exists, but the current positive tests use a
deterministic proof-check callback because the repo does not yet have a
multi-credential circuit, proving key, verifying key, or Cardano fixture. This
plan creates that missing fixture path.

## Decision

Implement the first fixture as an exact-count 2-credential circuit:

```text
root-ownership-multi-destination-v1-count2/bls12-381/groth16
```

This is intentionally narrower than the full production family. A count-2
fixture is enough to prove that the production `mkMultiReclaimGlobal` entrypoint
can accept a real multi proof while preserving the plan's core invariants:

- one master XPrv derives both credentials;
- credentials are bound in ledger/input order;
- the destination address bytes are part of the public input;
- the proof cannot be reused for reordered credentials or another destination.

After this is green, expand to a small circuit family such as counts 1, 2, 4,
8, and 16.

## Non-Goals

- Do not replace the existing single-credential circuit or `mkReclaimGlobal`.
- Do not make a max-count masked circuit in this pass.
- Do not wire web/helper transaction construction beyond what is necessary for
  CLI and fixture generation.
- Do not treat locally generated dev keys as ceremony-grade production keys.

## Circuit Plan

Add a new Go circuit package or file for count-2 multi ownership proofs, for
example:

```text
internal/circuit/ownershipmulti
```

Required public input:

```text
Pub = blake2b_256(
  "ROOT-OWNERSHIP-MULTI-v1"
  || credentialCountU16BE
  || credentialHash0
  || credentialHash1
  || destinationAddressV1
) as a little-endian BLS12-381 scalar
```

Required private inputs:

- one `MasterKL`, `MasterKR`, and `MasterCC`;
- two derivation paths: `(account0, role0, index0)` and
  `(account1, role1, index1)`;
- destination bytes as fixed public-input preimage bytes or circuit constants
  supplied in the assignment, matching the public input helper.

Required constraints:

1. Derive credential 0 from the master XPrv and path 0.
2. Derive credential 1 from the same master XPrv and path 1.
3. Hash the fixed preimage:
   `domain || 0x0002 || credential0 || credential1 || destinationAddressV1`.
4. Assert the digest-to-field value equals public `Pub`.

Implementation notes:

- Reuse `ckd.DeriveChain`, `Credential`, `BindCredential`-style primitives, and
  `bytesToFieldLE` semantics from `internal/circuit/ownership/circuit.go`.
- Keep the destination address length fixed at 58 bytes.
- Add pure Go helpers before the circuit is used:
  - `PublicInputDigestForCredentialsDestination(credentials [][]byte, destination []byte)`
  - `PublicInputForCredentialsDestination(credentials [][]byte, destination []byte)`
  - `DecodeDestinationAddressV1Hex`
  - `DecodeCredentialHex` reuse for each credential.
- Validate that credential count is exactly 2 for the first circuit.

## Prover And Artifact Plan

Add multi-specific prover paths instead of overloading the single-credential
artifact silently.

Suggested new artifact shape:

```json
{
  "schema": "proof-tool-proof-v1",
  "circuit_id": "root-ownership-multi-destination-v1-count2/bls12-381/groth16",
  "vk_hash": "blake2b256:...",
  "target_credentials": ["hex-28-byte-pkh-0", "hex-28-byte-pkh-1"],
  "destination_address_encoding": "destination-address-v1",
  "destination_address": "hex-58-byte-address",
  "credential_count": 2,
  "public_input_encoding": "multi-credential-fixed-v1",
  "public_input": "0x...",
  "proof": "base64..."
}
```

Required CLI additions:

- `proof-tool prove-multi`
  - accepts repeated `--target-credential`;
  - accepts repeated path flags or a JSON path list;
  - accepts `--destination-address-bytes`;
  - emits the multi artifact.
- `proof-tool verify-multi`
  - recomputes the fixed-byte public input;
  - rejects missing, extra, reordered, or tampered credentials;
  - rejects destination changes.
- `proof-tool export-cardano`
  - accepts the multi artifact;
  - writes `proof.hex`, `vk.hex`, and `pub.hex` for the multi verifier.

Key-bundle plan:

- Keep multi keys in a separate bundle directory from ownership-v1 keys.
- Use a separate key version, for example `ownership-multi-destination-v1-count2`.
- Manifest `circuit_id` must match the multi circuit exactly.
- Do not let single-circuit verifier code load multi keys or vice versa.

## Contract Fixture Plan

Generate a checked-in or generated test fixture for the Haskell contract suite:

```text
contracts/ownership-verifier/testdata/multi-count2-proof.hex
contracts/ownership-verifier/testdata/multi-count2-vk.hex
contracts/ownership-verifier/testdata/multi-count2-pub.hex
```

Fixture inputs:

- one deterministic master XPrv already used by the single proof integration
  tests, if it can derive two known credentials within a small path range;
- credential 0 at path `(0, 0, 0)`;
- credential 1 at another deterministic path, for example `(0, 0, 1)`;
- one fixed destination address encoded with `destinationAddressV1`.

The Haskell test must build a real `ScriptContext` with:

- two reclaim-base inputs in `txInfoInputs` order;
- inline `ReclaimBaseDatum` values matching the two fixture credentials;
- the parameter reference input;
- the first proof-bound destination output at `reclaimDestinationOutIdx`;
- optional immediately following outputs with the same destination address;
- aggregate contiguous destination-run value at or above the two protected input
  values;
- `reclaimGlobalMultiRedeemerData 0 destinationIdx proof`.

Then it must call:

```haskell
reclaimGlobalMultiValidator paramCurrencySymbol multiVk (V3.toBuiltinData ctx)
```

and assert `True`.

## Required Rejection Tests

After the positive fixture passes, add production-entrypoint negative tests that
use the same real proof and verifying key:

- swapped `txInfoInputs` order rejects;
- one credential datum changed rejects;
- destination output address changed rejects;
- destination output index points at a different output rejects;
- contiguous destination-run underpayment rejects;
- split contiguous same-address destination outputs accept;
- same-address outputs after an intervening different address do not count;
- native-asset underpayment rejects;
- no matching reclaim-base inputs rejects;
- single-credential proof and verifying key still reject on the multi path.

These should not use the callback helper. They must exercise
`reclaimGlobalMultiValidator` directly.

## Verification Plan

Go/unit verification:

```sh
go test ./internal/circuit/ownershipmulti ./internal/prover ./internal/artifact ./cmd/proof-tool
```

Full proof verification, gated because it is expensive:

```sh
PROOF_TOOL_RUN_FULL_PROOF=1 go test ./internal/prover -run Multi
```

Contract verification:

```sh
cd contracts/ownership-verifier
cabal v2-test all
```

Cross-surface fixture verification:

1. Generate a count-2 multi proof artifact.
2. Run `proof-tool verify-multi` on it.
3. Run `proof-tool export-cardano` on it.
4. Confirm `pub.hex` equals the fixed-byte digest used in the Haskell fixture.
5. Confirm the Haskell `reclaimGlobalMultiValidator` positive test passes with
   the exported `proof.hex` and `vk.hex`.

Hygiene:

```sh
git diff --check
```

## Completion Criteria

This plan is complete only when all are true:

- the repo has a real count-2 multi circuit and public input helpers;
- `prove-multi`, `verify-multi`, and `export-cardano` handle the multi artifact;
- a real multi proof fixture is generated and consumed by the Haskell tests;
- `reclaimGlobalMultiValidator` has at least one positive real-proof test;
- production-entrypoint negative tests reject reorder, tamper, destination
  change, and aggregate underpayment;
- the existing single-credential circuit, artifact, and validator tests remain
  green;
- verification commands above pass locally.

## Follow-Up Production Work

After the count-2 fixture is green:

1. Generalize to a small circuit family: 1, 2, 4, 8, 16.
2. Add benchmarks comparing one multi proof against N single proofs.
3. Add setup-ceremony and manifest signing flow for each multi circuit family
   member.
4. Wire helper/web transaction construction so final `txInfoInputs` order,
   proof generation order, and on-chain validation order are identical.
5. Update audit context with the real multi proof fixture and ask for a fresh
   Cardano contract review.
