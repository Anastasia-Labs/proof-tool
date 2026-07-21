# Plain-English Reclaim Contract Specification

## Purpose

This document states the security and correctness properties that the formal
assurance work is intended to prove—or, when a property is not true of the
deployed program, to falsify with a reproducible counterexample.

The primary safety property is:

> For every ledger-valid transaction that spends an input locked by the active
> `ReclaimBase`, if the active `ReclaimBase` and `ReclaimGlobalV2` artifacts
> both succeed, then the credential recorded in that input's datum is included
> in an accepted destination-bound ownership statement, and the input's
> complete value is paid to the authenticated destination.

Its completeness direction is:

> A correctly formed transaction containing a valid destination-bound proof
> for every reclaimed credential and complete value-covering outputs succeeds
> within the protocol budget.

Purpose, datum availability, field widths, and parameter shape are supporting
ledger, funding, parsing, or deployment preconditions. They are not themselves
evidence that a master key authorized a reclaim.

The strongest cryptographic interpretation is conditional:

> Assuming circuit correctness and Groth16 knowledge soundness, an accepted
> proof was generated from a master XPrv that derives the datum credential, and
> the contract forces the value to the destination bound into that proof.

A relayer may submit another person's valid proof; the transaction submitter
does not necessarily possess the master XPrv.

The machine-readable source of truth for proof status and evidence is
[`theorem-catalog.json`](theorem-catalog.json). This document describes the
properties themselves and must not be read as saying that every property is
already proved.

“Active” in the safety and completeness statements means the mutually coherent
Base and GlobalV2 artifacts selected by the deployment being analyzed. The
active Preprod pair is Base
`744cc4718e8149201c7e9cb3d3a550f34cb18dfc8076a33172d9354d`, parameterized by
GlobalV2 `a4da74e7cb6ea4f4e60456a0a6eabf0ccf83464ebe55664390ef39f8`. Current source
is byte-identical to both reference scripts.

## Scope and meaning of success

The deployment-critical pair is a parameterized `ReclaimBase` spending
validator and statement-bound `ReclaimGlobalV2` rewarding validator. The
supporting contracts are `OneShotNFT` and `ParamsHolder`. Every theorem and
counterexample must identify the exact deployed artifact under analysis.

A contract “succeeds” only when execution of the exact production-exported
Plutus V3 artifact reaches a successful CEK halt. Running out of the declared
execution budget is not contract rejection and must never be used as evidence
that an invalid transaction fails.

Ledger-validity alone does not identify the program being invoked. Every
top-level claim must also bind the context to the exact script identity under
proof: the spending script hash, rewarding credential, or minting policy ID.

## Artifact and model fidelity

### PROV-1 — Production artifact identity

Regenerating the active contracts from the recorded source, parameters, and
public verifier material must produce exactly the deployed bytes and Cardano
script hashes. A proof about a source-level approximation or differently
parameterized program is not a proof about the active deployment.
An intentional future source change must instead be exported, hashed, and
classified separately; its evidence cannot be relabeled as active until a
deployment updates the manifest, parameter datum, reference scripts, and
related coherence set.

### PROV-2 — Exact Lean import

Lean must import and execute the exporter-produced Plutus V3
`single_cbor_hex` artifacts. Re-encoding each imported program must reproduce
the locked exporter bytes exactly. Handwritten UPLC and fixture wrappers may be
used for supporting tests, but not as substitutes for top-level production
theorems.

### CTX-1 — Haskell/Lean context agreement

The Haskell ledger encoder and Lean model must agree on every Plutus V3
`ScriptContext` field consumed by the contracts, including purposes,
withdrawals, reference inputs, inline datums, values, redeemers, inputs, and
outputs. The exact Haskell and Lean evaluators must agree on representative
success and rejection decisions.

### CTX-2 — Ledger-valid scope

Security and correctness claims apply to ledger-valid contexts. Tests about
malformed raw `Data` remain separately labeled and cannot be presented as
ledger-valid guarantees. At least one real, source-backed valid context must
witness that each important theorem family is non-vacuous.

### CTX-3 — Exact artifact invocation

A spending context must identify the exact `ReclaimBase` script, a rewarding
context must identify the exact `ReclaimGlobalV2` credential, and a minting
context must identify the exact `OneShotNFT` policy. A context valid for a
different artifact cannot witness or refute a claim about the active one.

## ReclaimBase supporting properties

### RB-1 — Configured-withdrawal handoff

For the active `ReclaimBase`, successful execution is intended to be
equivalent to presence of the exact configured active GlobalV2 withdrawal
key in `txInfoWdrl`. The withdrawal amount is irrelevant. A different
withdrawal key or an absent key must fail, and genuine rejection must be
distinguished from execution-budget exhaustion.

Under Cardano ledger rules, a withdrawal keyed by a script credential causes
that rewarding script to be executed. The deployment ceremony applies the
chosen credential to `ReclaimBase` once; the validator does not spend execution
budget revalidating the parameter's constructor or comparing it with deployment
metadata.

### RB-2 — Purpose and datum are not local authorization checks

`ReclaimBase` deliberately does not inspect `ScriptInfo`, datum presence, datum
constructor, datum fields, or payment-credential width. Changing those values
must not change its decision when the configured withdrawal map is unchanged.
Those facts are supporting ledger/funding conditions and inputs to the global
authorization statement, not evidence of master-key possession.

### RB-3 — GlobalV2 owns credential validation

For an end-to-end reclaim, `ReclaimGlobalV2` must scan every input locked by the
selected base-script hash, extract the credential from each base datum, require
the 28-byte proof-input width, and bind that credential to the corresponding
proof and destination. A malformed or missing datum may pass the minimal base
gate, but it must make the composed reclaim transaction fail in GlobalV2.

A key-shaped deployment parameter can satisfy the local map-membership check;
preventing such a deployment is an audited one-time configuration obligation,
not a repeated on-chain check.

## ReclaimGlobalV2 properties

### RG-1 — Rewarding-only lifecycle and selected parameters

Successful execution must imply that the contract is invoked for the rewarding
purpose. Every non-rewarding purpose must fail, including a certifying purpose
that attempts to deregister the script stake credential. This is a security and
availability property: accepting deregistration could return the stake-address
deposit to the deregistering transaction and make later reclaim withdrawals
ledger-invalid until the credential is registered again.

The first four redeemer fields are authoritative, in order: the parameter
reference index, destination-output start index, proof list, and digest list.
The redeemer constructor tag and any trailing fields carry no authorization
meaning and are ignored. Failure of an index to select an existing reference
input or output suffix is ordinary decoding/transaction-coordination failure;
index sign and bounds are not independent security properties.

The selected reference input must contain the configured parameter NFT with
quantity exactly one. Other policies or token names in that output are allowed
because they do not weaken authentication by the configured NFT. The NFT-bearing
output must provide a readable parameter datum whose authoritative first field
is the base script hash, and that hash must select the reclaim inputs. Parameter
and base-datum constructor tags and trailing fields carry no authorization
meaning; GlobalV2 uses the authoritative first byte-string field, while the
credential consumed by the ownership statement must still have the required
28-byte width.

### RG-2 — Exact ordered slot coverage

A successful transaction must contain at least one matching `ReclaimBase`
input. Every matching input must consume exactly one proof, one digest, and one
corresponding destination output in ledger order. No matching input may be
skipped, and no proof or digest slot may be missing or left unused. A no-op
rewarding invocation cannot satisfy the validator.

### RG-3 — Credential and destination statement binding

For every matching input, the supplied digest must equal the on-chain statement
digest computed from that input’s 28-byte payment credential and the bytes of
its corresponding destination address. A proof or digest for one input or
destination must not authorize another. Reordering or substituting inputs,
proofs, digests, or destinations must not succeed.

### RG-4 — Destination and complete value fidelity

Every matching input must be paired with the destination authenticated by its
digest and proof. The corresponding output must componentwise cover the input’s
complete ledger-normalized multi-asset value, including ADA and every native
asset. The following must fail:

- payment to a wrong or unsupported destination address;
- ADA underpayment;
- omission of a native asset;
- policy-ID or token-name substitution; or
- insufficient quantity of any required asset.

Unrelated value elsewhere in the transaction must not compensate for
underpaying the paired destination.

### RG-5 — Batch transcript framing

The statement-bound batch transcript must commit to, in order:

1. the V2 domain separator;
2. the pinned verifier-key hash;
3. the exact big-endian `u16` statement count; and
4. every ordered 336-byte proof and 32-byte digest pair.

Unequal proof and digest lists, invalid proof or digest widths, V1 framing,
ordering changes, or a count greater than 65,535 must be rejected or produce a
different framed transcript as appropriate. The embedded verifier-key hash is
an immutable deployment parameter whose 32-byte width and equality to the
pinned verifier key are enforced by artifact-building and deployment checks;
the on-chain transcript builder does not repeat that static width check.

### RG-6 — Pinned verifier is on every success path

Every authenticated reclaim slot must be passed to the verifier machinery
bound to the pinned verifier key, and successful execution must require the
final folded batch-verification equations to accept. This is a contract
interface and control-flow property; it does not independently prove Groth16
knowledge soundness or correctness of the Go circuit.

### RG-7 — Honest reclaim completeness

Every independently well-formed, ledger-valid reclaim transaction must succeed
when all parameter, coverage, statement, destination, value, transcript, and
artifact-binding conditions hold, the pinned verifier accepts the ordered
statements, and execution stays within the justified protocol budget.

This reverse direction is required for functional correctness. Success-implies-
safety alone would still allow a validator that rejects legitimate reclaims.

## Supporting contract properties

### NFT-1 — One-shot parameter NFT

The parameterized `OneShotNFT` policy succeeds if and only if the configured
seed input is consumed and the transaction mints exactly one token name with
quantity one under the policy’s own currency symbol. Burns, multiple own-policy
tokens, or any other own-policy quantity must fail. Assets under unrelated
policies must not change the policy decision.

### PH-1 — Parameter holder is unspendable

The exact compiled `ParamsHolder` validator must never return a successful halt
for any possible argument within the modeled semantics. Execution-budget
exhaustion does not count as evidence of failure.

## Composed-system properties

### SYS-1 — Primary end-to-end safety property

For every ledger-valid transaction and every input locked by the active
`ReclaimBase`, successful execution of both active artifacts must imply that:

- the input's datum credential is included in an accepted destination-bound
  ownership statement;
- the proof, digest, input, and destination occupy the same authenticated
  ordered slot; and
- the paired destination output covers the input's complete multi-asset value.

The composition must not trust transaction-builder behavior, client-supplied
digests, client-supplied ordering, or an unchecked parameter index. Those facts
must follow from GlobalV2's on-chain checks. ReclaimBase contributes the
configured-withdrawal handoff and does not duplicate them.

### SYS-2 — Primary end-to-end completeness property

A correctly formed, ledger-valid transaction containing one valid
destination-bound proof for every reclaimed credential, exact ordered coverage,
complete value-covering outputs, valid selected parameters, and sufficient
protocol budget must make both active validators succeed.

### SYS-3 — Honest cryptographic interpretation and trust boundary

Assuming the circuit proves the documented CIP-1852 derivation relation and
Groth16 knowledge soundness holds for the pinned verifier key, acceptance means
that a proof generator knew a master XPrv deriving the datum credential. It
does not mean that the transaction submitter knew that key: a relayer can submit
the proof, but cannot redirect value away from its proof-bound destination.

Published claims must also state assumptions about the one-time audited
deployment configuration, parameter NFT and holder, compiler and ledger-model
fidelity, CEK semantics, solver and translation correctness, and safe local
handling of recovery secrets.

The result is described as compiled-UPLC, ledger-constrained, SMT-backed formal
assurance—not as a proof checked solely by the Lean kernel—while published
theorems depend on Blaster/Z3 results or reachable upstream admissions.

## Exported alternative validators

The former `ReclaimGlobal` V1 exporter mode has been retired and removed.
`ReclaimGlobalMulti` must have its own explicit property catalog and evidence
or be deliberately classified and guarded as non-authoritative for production.
Results about `ReclaimGlobalV2` must never be attributed to that different
aggregate-proof program.

## Required adversarial and non-vacuity checks

For important safety claims, the suite also states deliberately false inverse
claims and requires the solver to falsify them with ledger-valid successful
witnesses. For example, it must demonstrate that a real authorized transaction
can succeed, so “all successful transactions are safe” cannot pass merely
because the model has no successful executions.

These expected counterexamples are proof-quality checks, not contract bugs.
Unexpected counterexamples to the intended properties are findings and must be
preserved and replayed against the exact compiled artifact.

## Preserved ABI-conformance witnesses

The deployed `ReclaimGlobalV2` artifact accepts an inner parameter datum and a
matching base-input datum whose constructor tag is `1` rather than `0`. These
witnesses remain preserved, but they no longer falsify the authorization
specification: the authoritative first byte-string field is unchanged, and the
constructor tag carries no ownership or destination-binding meaning.

Canonical constructor tags may still be required by off-chain encoders or
deployment conventions. That is a separate ABI-conformance obligation. The
authorization theorem instead requires GlobalV2 to consume the same 28-byte
credential field, verify its destination-bound ownership statement, and enforce
complete value coverage.

## Completion criterion

The assurance work is complete only when every in-scope critical property is
either:

- proved for the exact production artifact within its stated ledger,
  artifact-identity, cryptographic-interface, and execution-budget boundary,
  with current-source candidate results distinguished from deployed results;
  or
- falsified by a minimized, ledger-valid, replayable counterexample whose
  affected artifact and composed-system impact are recorded.

An unknown solver result, finite unrolling presented as a universal list proof,
an unvalidated model-only counterexample, or an unexamined production export
surface is not completion.
