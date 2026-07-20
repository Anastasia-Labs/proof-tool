# Proof Tool formal verification

This directory is the Lean 4 workspace for proving properties of the compiled
Plutus V3 validators in `contracts/ownership-verifier`.

It locks and imports the exact deployed Preprod artifacts, and separately
imports the coherent current-source ReclaimBase and ReclaimGlobalV2 candidate
pair. It checks public deployment identities and establishes the
cross-language/model boundary used by subsequent generalized proofs. Concrete
golden replays are boundary tests, not substitutes for the universal
properties in the theorem catalog.

## Pinned baseline

The baseline was researched on 2026-07-15 and revalidated against contract
baseline `0003ac42b5a29309587ac163c9be93dad6c67a47` on 2026-07-20:

| Component | Revision/version |
| --- | --- |
| Lean | `leanprover/lean4:v4.24.0` |
| Z3 | `4.15.2` |
| Lean-blaster | `402f6d22c1fc42e6e26255faac77e15b2450e4ab` |
| PlutusCoreBlaster | `4ef48606303c45225d3ed2e2a87fc50280a763b7` |
| CardanoLedgerApiBlaster | `577e3eb03b5be09354cfdb1c0d0c12e9e16541a0` |

The historical USDCx workspace imported `PlutusCore`, `PlutusTx`, and test
helpers directly from the private `sc-fvt` monorepo. Those components have
since been split into the public `PlutusCoreBlaster` and
`CardanoLedgerApiBlaster` packages. Adding `sc-fvt` here would duplicate the
`PlutusCore` package and is not required by the current public stack.

All three Git dependencies are declared directly and pinned by commit. This is
intentional: the upstream packages still contain floating transitive branch
requirements, while this exact set has been tested as one coherent build.

## Build

The machine needs `elan`, `lake`, and Z3 `4.15.2` on `PATH`.

```bash
cd formal
z3 --version
node scripts/lock-active-artifacts.mjs
scripts/generate-context-goldens.sh
lake build
scripts/verify-formal-assurance.sh
scripts/verify-formal-assurance.sh --require-complete
```

`lock-active-artifacts.mjs` rebuilds the active artifacts from the deployment
commit pinned by the public manifest in an isolated temporary Git archive. It
does not rebuild deployed evidence from divergent current source.
`verify-current-candidates.mjs` independently rebuilds the current exporter
in deployment order: GlobalV2 first, then Base parameterized by the resulting
candidate credential. It checks both non-deployed candidates' bytes,
decoded-CBOR digests, Cardano script hashes, and pairing. Do not overwrite
`active-preprod` or the public manifest when working on candidates.

`lake update` is only needed when intentionally changing the pinned dependency
set. Commit the resulting `lake-manifest.json` so future builds resolve the same
revisions.

The expected smoke-build output includes:

```text
✅ Valid
declaration uses 'blasterProven' (SMT-verified, no proof term)
```

## Assurance boundary

Current Blaster does not reconstruct an SMT proof term. When Z3 reports a goal
as valid, Blaster closes it with the `blasterProven` axiom and emits the warning
above. Current PlutusCoreBlaster also contains an upstream `sorry` for the
termination proof of `runStepsWithBudget`.

Accordingly, a theorem discharged by `blaster` is SMT-backed assurance under
the Lean/Blaster/Z3 translation and those upstream axioms; it is not yet a
fully kernel-reconstructed proof. Do not disable the warning globally or
describe a successful build as eliminating these trust assumptions.

## Assurance program

The production-proof scope is recorded in these reviewable artifacts:

- [`assurance/plain-english-specification.md`](assurance/plain-english-specification.md)
  states the intended contract and composed-system properties in human-readable
  language and records known specification divergences.
- [`assurance/coverage-matrix.md`](assurance/coverage-matrix.md) inventories
  active, supporting, manually exportable, and excluded contract surfaces.
- [`assurance/theorem-catalog.json`](assurance/theorem-catalog.json) records
  every intended theorem, negative counterexample check, and evidence gate.
- [`assurance/provenance-lock.json`](assurance/provenance-lock.json) locks the
  public deployment, source/toolchain identity, and artifact regeneration
  status.
- [`assurance/context-goldens.json`](assurance/context-goldens.json) records
  Haskell-produced V3 `Data` bytes and compiled-evaluator decisions.
- [`assurance/cross-evaluator-decisions.json`](assurance/cross-evaluator-decisions.json)
  ties those decisions to finite, exhaustion-aware Lean CEK theorems.
- [`assurance/model-findings.md`](assurance/model-findings.md) records proof
  harness hazards and their mitigations.
- [`assurance/trust-report.md`](assurance/trust-report.md) separates
  kernel-checked, SMT-axiom-backed, native-replay, cryptographic, ledger-model,
  and operational assumptions.
- [`assurance/report.md`](assurance/report.md) gives the current overall
  classification and the exact open obligations.
- [`assurance/counterexamples/README.md`](assurance/counterexamples/README.md)
  defines the minimum evidence required before a solver model is called a
  contract counterexample.

All context-level claims require both the V3 ledger predicate and an explicit
binding from the context's spending, rewarding, or minting identity to the
exact artifact under proof. `validScriptContext` by itself does not say which
script is executing.

## Starting production proofs

The first production proof modules should follow this shape:

1. Export the exact compiled, parameterized Plutus V3 validator bytes used by
   the deployment path. Determine whether that artifact is `flat`, `flat_hex`,
   or `single_cbor_hex` and use the matching `#import_uplc` format. Do not use
   gnark proof JSON or hand-written UPLC as a substitute for the deployed
   script artifact.
2. Import the compiled program with `#import_uplc`. If `#prep_uplc` is used,
   separately prove the relevant execution terminates within its bound:
   upstream finite-step preprocessing collapses exhaustion to `State.Error`.
   Concrete decisions must use the exhaustion-aware wrapper in
   `ProofToolFormal.Result`.
3. Model the actual ledger invocation. `ReclaimBase` is deployed as a spending
   script and `ReclaimGlobalV2` as a rewarding/withdrawal script. The simplified
   Base does not inspect purpose locally, but composed production claims still
   require ledger validity, an exact artifact-identity binding, and a Base
   parameter equal to the paired GlobalV2 credential.
4. State universal properties over the relevant datum, redeemer, parameters,
   and `ScriptContext`. Single hard-coded successful or failing invocations are
   regression vectors, not correctness proofs.
5. Prove both positive implications and adversarial negatives: proof coverage,
   payment-credential matching, destination binding, parameter NFT/key
   coherence, malformed encodings, wrong script purpose, and missing or extra
   reclaim inputs.

Keep the exported UPLC, deployment manifest, verifier key/hash, contract
parameters, and proof modules pinned as one coherence set.

`scripts/verify-formal-assurance.sh` is the merge-oriented reproducibility and
classification gate. It rebuilds/regenerates the locked evidence, runs the
Lean, Haskell, Go, and focused TypeScript checks, rejects inconsistent or
unsupported catalog classifications, and reports every pending obligation.

`scripts/verify-formal-assurance.sh --require-complete` is the stricter formal
promotion gate. It additionally exits nonzero while any catalog entry remains
`Pending`. A green workspace gate means the partial assurance package is
reproducible and honest; it does not mean the contracts are fully formally
verified.
