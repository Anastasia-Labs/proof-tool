# Formal model findings

## MF-1: finite `runSteps` exhaustion collapses to `State.Error`

Status: mitigated in this formal package; upstream trust caveat remains.

`PlutusCore.UPLC.CekMachine.runSteps` returns `State.Error` when its step count
reaches zero on a nonterminal state. `#prep_uplc` invokes
`cekExecuteProgram`, which uses that function. Consequently, an `Error` from a
finite preprocessed execution does not by itself prove validator rejection.

`ProofToolFormal.Result.runStepsClassified` preserves `halted`, genuine
`machineError`, and `stepLimitExhausted` outcomes. All concrete replay gates
must use that wrapper (or the budget evaluator's distinct result type), and
all symbolic theorems based on `#prep_uplc` need an independently established
within-fuel premise before classifying failure as logical rejection.

This is a proof-harness/model issue, not evidence of an on-chain contract bug.

## MF-2: arbitrary raw-Data Value equality trips a Blaster optimizer mismatch

Status: decomposed; exact arbitrary-Data converse remains unavailable.

The compiled `valueCoversData` fast path uses `equalsData` under a dependent
conditional. When both arbitrary Value maps remain symbolic, Lean-Blaster's
optimizer can produce a kernel type mismatch before Z3 receives a query. The
smallest stable decomposition is:

- exact compiled theorems over canonical ledger-shaped Values, including
  quantity, wrong-policy, and wrong-token cases; and
- kernel-checked induction over an independent typed merge model proving that
  every successful policy/token walk covers every required quantity.

The generalized direction is sound for successful merge walks. The converse
still relies on unique, ordered, ledger-normalized maps supplied by
`validScriptContext`. This is not reported as a contract counterexample.

## MF-3: exact-monolith GlobalV2 bridge is partial

Status: open critical obligation.

The active ReclaimGlobalV2 script is 3,648 CBOR bytes and a real-proof replay
needs roughly two million Lean CEK steps. A 500-step `#prep_uplc` probe is
already memory-heavy and reaches only an early structural prefix. Increasing
finite preprocessing does not solve the semantic problem: upstream
preprocessing maps exhaustion to `State.Error`, so its finite result cannot be
used as a completeness or rejection theorem.

The project now has a sound classified-prefix alternative.
`Result.runStepsClassified_add` proves that an exhausted prefix resumes to the
same longer execution, and that eventual success means the prefix cannot
already be a machine error. Applied to the exact imported artifact, a
500-step prefix plus SMT proves the universal top-level result
`exact_success_requires_rewarding_purpose`. This is nonvacuous because it is
composed with the successful two-million-step real-proof execution, not with a
prefix-success antecedent.

The approach also exposes the current tool boundary precisely. A 100-step
classified prefix does not yet enforce purpose, a 750-step prefix does not yet
reach the complete selected-parameter and slot-decoding path, and deeper symbolic prefix
translation reaches an unsupported instance-parameterized `Fin` datatype.
These are rejected proof attempts, not contract counterexamples.

Closed production helper exports now have generalized SMT/inductive results,
and the monolithic artifact has exact two-evaluator positive and negative
replays. What is still missing is a mechanically checked universal theorem
that every successful execution of the exact monolithic program traverses the
selected parameter/NFT checks and recursive slot, Value, transcript, and
verifier semantics. Source provenance and test coverage do not constitute
compiler-preserving equivalence. Consequently the combined `RG-1` entry and
`RG-2` through `RG-7` plus `SYS-1` and `SYS-2` remain `Pending`; the newly proved purpose
component is recorded as partial evidence rather than over-promoted.

## MF-4: upstream Flat import had no matching Lean encoder

Status: resolved for every deployed/supporting artifact and both current-source
candidates.

The pinned PlutusCoreBlaster exposes the Flat/single-CBOR decoder used by
`#import_uplc`, but no encoder for the imported UPLC AST. The formal package
now supplies an independent inverse encoder for the serializable term/constant
subset. Six closed `native_decide` theorems re-encode the imported OneShotNFT,
ParamsHolder, deployed ReclaimBase and ReclaimGlobalV2, and coherent
current-source Base and GlobalV2 candidate ASTs plus canonical CBOR wrappers to
their exact exporter bytes. See `FlatRoundTrip.lean` and
`import-fidelity.json`. This closes artifact fidelity but adds native compiler
trust for the closed equality computation.

## MF-5: arbitrary candidate withdrawal-list preprocessing is not induction

Status: open candidate theorem obligation.

The simplified ReclaimBase candidate recursively scans the raw withdrawal map.
Closed contexts replay quickly, but `#prep_uplc` on an arbitrary encoded list
expands a finite symbolic CEK prefix and becomes memory-heavy before yielding a
universal theorem. Lowering the step count merely weakens the finite expansion.
The formal package therefore keeps the exact candidate replays and no-axiom
typed membership lemmas as supporting evidence while `RB-1` through `RB-3`
remain `Pending`. A future exact bridge must use an inductive compiled-list
argument or a proven compiler-preserving decomposition; bounded unrolling is
not accepted as the desired generalized property.

## MF-6: Lake does not track external `#import_uplc` files

Status: resolved in the reproducibility gate.

`#import_uplc` reads the locked hex artifact during Lean elaboration, but Lake
does not record that external file as a module dependency. After candidate
bytes changed, an incremental build initially reused the previous
`Artifacts.olean`; the imported constant therefore lagged the locked file even
though the source module was unchanged. The golden-generation gate now
invalidates the generated `Artifacts` build outputs before rebuilding. The
round-trip theorems then force all downstream modules to use the current locked
bytes. A green incremental build without this invalidation is not accepted as
artifact-fidelity evidence.
