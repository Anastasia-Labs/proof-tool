# Trust report

Status: current for the 2026-07-20 formal-assurance run.

## Claim boundary

This package provides **compiled-UPLC, ledger-constrained, SMT-backed formal
assurance**. It is not a proof checked solely by the Lean kernel. The active
Preprod OneShotNFT, ParamsHolder, and historical ReclaimBase results are
classified. The coherent current-source ReclaimBase/ReclaimGlobalV2 pair is
imported separately and has exact ledger-bound concrete replays; Base also has
generalized typed lemmas. The candidates' exact universal compiled bridges
remain pending. Current-source GlobalV2 helper semantics and exact active and
candidate replays are strong evidence, while exact classified-prefix
composition proves that every bounded success of the distinct active GlobalV2
has a rewarding purpose. This rejects deregistration-purpose execution that
could return the stake-address deposit and disable subsequent reclaim
withdrawals. The rest of the generalized exact-monolith bridge remains open.
The overall
contract family must not be described as verified while any critical catalog
entry is `Pending`.

Two typed-shape conformance properties are falsified: the exact active
ReclaimGlobalV2 accepts noncanonical inner constructor tags for both the
parameter datum and a matching base datum. They are cataloged separately from
the still-pending authoritative-field authorization properties. Their replay
and limited composed impact are recorded under
`formal/assurance/counterexamples/`.

## Mechanized trust roots

| Root | Where it enters | Consequence |
| --- | --- | --- |
| Lean 4.24.0 kernel and elaborator | Every module and theorem statement | Type checking, elaboration, reduction, and standard kernel soundness are trusted. |
| `Blaster.Tactic.blasterProven` | Every theorem closed by `by blaster` | Z3 validity is admitted through an axiom after translation; no proof term is reconstructed. |
| Lean-Blaster translation/optimization | Lean-to-SMT lowering and UPLC preprocessing | Incorrect encoding, rewriting, or dependency treatment could make an SMT result unsound. |
| Z3 4.15.2 | `blaster` validity queries | Z3's solver implementation and the fixed generated query are trusted. |
| `Lean.ofReduceBool` and `Lean.trustCompiler` | `native_decide` exact replays and concrete semantic predicates | The native compiler/evaluator is trusted for those closed computations. |
| Standard Lean axioms | `propext`, `Classical.choice`, and `Quot.sound` reported by `#print axioms` | These are conventional Lean foundations, not contract-specific assumptions. |
| PlutusCoreBlaster Flat decoder and CEK | `#import_uplc`, preprocessing, exact replay | The Lean UPLC AST, builtin semantics, and post-Conway Plutus V3 CEK must match the ledger implementation. |
| CardanoLedgerApiBlaster V3 model | `validScriptContext`, V3 `ScriptContext`, Value and address types | Its typed validity predicate and encodings must match ledger-valid Cardano V3 contexts. |
| Production Haskell exporter and `plutus-ledger-api` evaluator | artifact regeneration and cross-evaluator decisions | The exporter and independent evaluator must match the deployed serialization and ledger semantics. |

`#print axioms` is present for every published theorem in the proof modules.
The build output distinguishes three classes:

- exact/helper SMT theorems include `Blaster.Tactic.blasterProven`, often with
  `propext`, `Classical.choice`, and `Quot.sound`;
- inductive list/model theorems are kernel-checked up to standard Lean axioms;
- closed replay theorems use `Lean.ofReduceBool` and `Lean.trustCompiler`.

## Dependency admissions

The pinned PlutusCoreBlaster revision contains an upstream `sorry` in the
termination proof for `runStepsWithBudget` and additional unfinished lemmas in
the Bitwise and String lemma modules. The published `#print axioms` results do
not report those declarations for the current theorems, and the formal replay
wrapper uses `step` plus its own structurally recursive finite-step runner, not
`runStepsWithBudget`. They are still disclosed because the dependency is not
admission-free.

Lean-Blaster deliberately defines `blasterProven : forall {alpha}, alpha` as
an axiom. A successful SMT result assigns this axiom to the goal. Accordingly,
all `blaster` results are SMT-backed assurance, never kernel-reconstructed
proofs.

No project-authored `sorry`, `admit`, or axiom occurs under
`formal/ProofToolFormal`.

## Execution and fuel boundary

The default builtin semantics variant is post-Conway Plutus V3 variant E. A
finite `PlutusCore.UPLC.CekMachine.runSteps` returns `State.Error` both for a
real machine error and for exhaustion. `ProofToolFormal.Result` replaces that
classifier for concrete evidence with distinct `halted`, `machineError`, and
`stepLimitExhausted` outcomes. A negative result is called validator rejection
only when it is a genuine machine error within the declared bound.

The ordinary 500-step `#prep_uplc` probe cannot reach the deep verifier path and
is not a justified top-level completeness bound. Separately, the project proves
a kernel-checked resumption law for its exhaustion-preserving classified
runner. That law composes eventual exact success with an SMT-analyzed prefix and
supports the universal rewarding-purpose theorem without labeling exhaustion
as rejection. The real proof and negative mutations use a 2,000,000-step
classified replay. That closed replay establishes nonvacuity, not a universal
protocol fuel theorem.

## Cryptographic and protocol assumptions

The assurance proves or tests how bytes and statements reach the pinned
verifier interface. It does not re-prove:

- BLS12-381, Groth16, hash, or Fiat-Shamir security;
- soundness of the Go ownership circuit or that a generated proof represents
  more than its narrow 28-byte credential-derivation statement;
- correctness or secrecy of proving-key generation;
- seed phrase, master XPrv, path, helper, browser, or desktop secret handling;
- honesty of the already-created parameter NFT and selected parameter datum;
- immutability beyond the always-fails holder script and ordinary Cardano
  ledger/reference-script rules.

The claim remains narrow: it does not establish ownership of a wallet,
balance, arbitrary UTxO entitlement, stake credential, script credential, or
full address.

The strongest honest authorization interpretation is conditional on circuit
correctness and Groth16 knowledge soundness: an accepted proof was generated
from a master XPrv deriving the datum credential, and the on-chain composition
forces the reclaimed value to the destination bound into that proof. It does
not prove that the transaction submitter possesses the XPrv; a relayer may
submit another person's public proof without gaining redirection authority.

## Artifact and encoding assumptions

The deployed public exporter bytes remain compared to the active manifest and
public reference-script identities. The current-source Base and GlobalV2 are
separately exported and imported as a coherent non-deployed candidate pair.
Although
the PlutusCoreBlaster revision supplies no Flat encoder, the project now has an
independent inverse encoder for serializable UPLC. Closed `native_decide`
theorems re-encode every imported production AST and canonical single-CBOR
wrapper to the exact locked exporter file. This adds `Lean.ofReduceBool` and
`Lean.trustCompiler` to the round-trip trust boundary and is recorded in
`formal/assurance/import-fidelity.json`.

`validScriptContext` does not identify which artifact is executing. Every
ledger-valid exact-artifact witness therefore also uses
`validContextForArtifact` to bind the spending input, rewarding credential, or
minting currency symbol to the locked identity.

## Deployment and operational assumptions

The active public manifest, deployment source commit, verifier key/hash,
parameter NFT, token name, and reference scripts form one coherence set. The
active lock rebuilds that deployment from the manifest-pinned commit in an
isolated temporary archive. Current-source regeneration is checked in deployer
order: GlobalV2 first, then Base parameterized by the resulting candidate
credential. This completes `PROV-1`; it does not authorize a transaction or
deployment. The former `global` V1 export has been removed. `global-multi`
remains callable from the manual exporter and is not covered by the active V2
theorem set; its production guarding or retirement is an approval-gated
unresolved catalog item.
