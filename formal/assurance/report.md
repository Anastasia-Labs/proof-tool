# Reclaim contract formal-assurance report

Recorded: 2026-07-21

## Outcome

**Current classification: incomplete, with two intended conformance properties
falsified.** The exact active deployment is not verified as a whole. The
optimized current-source ReclaimBase and canonical GlobalV2 pair is deployed
on Preprod, locked to public chain evidence, and covered by exact concrete
replays. Base also has generalized typed withdrawal semantics. Fifteen catalog
entries remain pending, including the exact universal bridges and
the mechanically checked bridge from every successful execution of the
3,356-byte exact ReclaimGlobalV2 artifact to the independent recursive
specifications.

The canonical-datum conformance properties
`RG-CEX-PARAM-DATUM-TAG` and `RG-CEX-BASE-DATUM-TAG` are false for the exact
active GlobalV2 script. Both findings are ledger-valid and replay in the Lean
and Haskell compiled evaluators. The separate authorization properties
`RG-PARAM-DATUM` and `RG-BASE-DATUM` remain pending.

## Exact production target

| Artifact | Cardano identity | CBOR SHA-256 | Result |
| --- | --- | --- | --- |
| OneShotNFT | `d6777b8c3be1c6c0c9baba52a880c1980a662c16ffc0885ecaa03119` | `3c4f3fc40c01c81f11647e4af560996f40dd765d4af61aca99c11db912a7c0a3` | exact bytes locked; `NFT-1` valid |
| ParamsHolder | `ebb18a12777410738fdeaa77ec0fd582685d677b6b34de9a6e3b6d7e` | `b59ac3cea50e634b57f811c3d6ef95a8e5ad1837cb23706d249fb6c0cd4142ee` | exact identity locked; `PH-1` valid |
| ReclaimBase | `744cc4718e8149201c7e9cb3d3a550f34cb18dfc8076a33172d9354d` | `5a489b076c8ba7ff74e96c03f0353705967a31d6ac19d5d0fc880afd25e5b72e` | exact active bytes locked; concrete replays pass; `RB-1..3` universal compiled bridge pending |
| ReclaimGlobalV2 | `a4da74e7cb6ea4f4e60456a0a6eabf0ccf83464ebe55664390ef39f8` | `fa139639b03080ef17b4e5eda46b6a32dd020987d1dad06defff2f662424c8e6` | exact active bytes locked; two typed-shape properties falsified; generalized top-level properties pending |

The deployed script/policy identities match the public Preprod manifest,
parameter datum, and reference-script evidence. Current source is byte-identical
to active. The exporter/package also retire V1. `#import_uplc` decodes the
deployed `single_cbor_hex` files as Plutus V3 programs; legacy candidate-named
imports are byte-identical aliases retained for proof-history stability.

## Classified results

The catalog currently contains 31 entries:

- 2 `Valid` generalized theorem families;
- 8 `Falsified` adversarial or intended properties;
- 6 passed artifact/model/trust gates;
- 15 `Pending` obligations.

The completed generalized results cover the parameter holder, parameter NFT,
the active ReclaimBase behavior, reference-index selection, exact
parameter-token shape, statement digest, componentwise Value coverage, and V2
batch transcript framing. Current-source typed semantics and concrete replays
are supporting evidence only until the exact universal compiled
bridges are complete. Recursive Value and transcript list claims use Lean
induction rather than finite SMT unrolling.

The exact real-proof GlobalV2 context is ledger-valid, bound to the active
rewarding credential, and succeeds in both evaluators. Independent semantic
predicates show exact ordered coverage, statement/destination matching, and
componentwise value coverage for that witness. A substituted digest and
malformed redeemer reject within the classified replay bound. These are
nonvacuity and regression evidence, not universal top-level correctness.

## Findings

### F-1: noncanonical parameter datum constructor accepted

`RG-CEX-PARAM-DATUM-TAG` is falsified. Changing only the inner parameter datum from
constructor tag 0 to tag 1, while preserving its sole 28-byte base-script hash,
parameter NFT, real proof, digest, destination, and valid context, still
succeeds. The individual context-CBOR SHA-256 is
`03a75eb37cf2fde36a23b9b4505b1221051f82ee1fa07411131fcc44b158d31e`.

Impact is a broader-than-typed GlobalV2 acceptance set. The repository's
honest deployment fixture uses the canonical tag, so this evidence does not
show the active parameter UTxO is malformed.

### F-2: noncanonical matching ReclaimBase datum constructor accepted globally

`RG-CEX-BASE-DATUM-TAG` is falsified. Changing only a matching input's inner base
datum from constructor tag 0 to tag 1 still lets GlobalV2 succeed. The context
CBOR SHA-256 is
`0ee27094518d4fe649761caa2991e1ab28a301235076f55efbe155766c9a5272`.

The active Preprod ReclaimBase intentionally ignores datum shape and accepts
the corresponding local withdrawal gate; GlobalV2 is the component that reads
and authenticates the authoritative credential field. This remains a
typed-encoding conformance mismatch, but
the witness does not by itself bypass authorization: GlobalV2 still extracts
the same 28-byte credential field, verifies the destination-bound statement,
and enforces complete value coverage.

Both replay packages are in
`formal/assurance/counterexamples/global-v2-noncanonical-datum-tags.json`.
The user authorized simplifying ReclaimBase and the resulting coherent pair is
now the exact active Preprod deployment.

## Independent verification evidence

- `lake build +ProofToolFormal` passes on Lean 4.24.0 and Z3 4.15.2.
- Exact imported artifact decoding succeeds for all four deployed scripts,
  both legacy-named active aliases, and seven parameterized/helper artifacts.
- The replay record contains 19 agreeing exact Haskell/Lean compiled
  decisions: 10 through the canonical active imports and nine through the
  byte-identical legacy proof aliases.
- Full Haskell ownership-verifier suite: all 114 tests pass, including 25,600
  randomized ReclaimBase differential cases in the latest
  coverage-expanded runs and
  1,000 randomized Value cases.
- Go transcript/proof-asset packages pass.
- TypeScript transcript, address/claim, and in-process manifest suites: 40
  tests pass.
- The active manifest verifier passes directly and reports the statement-bound
  V2 profile and explicit seven-slot policy.
- The source verifier rebuilds in deployment order and reproduces GlobalV2
  hash `a4da74e7cb6ea4f4e60456a0a6eabf0ccf83464ebe55664390ef39f8`, then Base hash
  `744cc4718e8149201c7e9cb3d3a550f34cb18dfc8076a33172d9354d` parameterized by
  that exact GlobalV2 credential.
- The default assurance workspace gate rebuilds active artifacts from the
  manifest-pinned deployment commit, requires the current-source pair to match
  active bytes, passes every executable build/test and classification check, and
  reports 15 pending obligations without converting them into proof claims.
- The strict `--require-complete` promotion gate exits nonzero on those 15
  obligations, as intended.

The six Vitest tests that invoke the manifest verifier through nested
`child_process.execFile` cannot capture child stdout/stderr in the managed
Codex sandbox; direct execution and the 27 in-process manifest tests pass.
The primary gate retains those wrapper tests outside this sandbox and uses the
direct verifier plus in-process tests here.

## Open exact obligations

`RB-1` through `RB-3`, `RG-1` through `RG-7`, `RG-PARAM-DATUM`,
`RG-BASE-DATUM`, `SYS-1` through `SYS-2`, and `EXPORT-ALTERNATIVES` remain
pending as exact combined catalog entries. The Base blocker is narrow:
the typed withdrawal-membership lemmas and exact concrete replays exist, but
symbolically preprocessing an arbitrary recursive withdrawal list expands a
finite CEK term rather than providing induction. It is not promoted as a
universal compiled theorem.

For GlobalV2, the rewarding-purpose component of `RG-1` remains pending for the
exact monolithic active UPLC program. A 100-step prepared feasibility model
proves that successful prepared execution requires `RewardingScriptInfo`, and
the exact real-proof witness independently has rewarding purpose, but neither
result is a universal bridge for the active artifact. The missing bridge covers
rewarding-purpose enforcement, selected parameter and NFT checks, recursive
slots, Value, transcript, and verifier paths.
`#prep_uplc` still maps exhaustion to `State.Error`; full symbolic unrolling is
currently infeasible, and the helper exports do not by themselves prove
compiler-preserving equivalence to every path in the monolith.

`PROV-2` is complete: an independent Lean encoder re-encodes all four active
and both legacy-named alias ASTs to the exact canonical single-CBOR exporter bytes.
`PROV-1` is complete: the active deployment is regenerated from its pinned
source commit and the coherent current Base/GlobalV2 pair is verified
independently against active bytes.
`EXPORT-ALTERNATIVES` remains pending because the manual `global-multi` export
is not yet formally cataloged or guarded/retired. The former `global` V1 export
has been removed.

## Conclusion

The work already finds two real specification/implementation mismatches and
substantially narrows the contract trust boundary, but it does not yet justify
the sentence “the reclaim smart contracts are correct.” The primary target is
now the end-to-end safety/completeness pair: accepted credential-bound proofs
must force complete value to their authenticated destinations, and honest
proof-complete/value-complete transactions must succeed within budget. The
only accurate current claim is partial compiled-UPLC, ledger-constrained,
SMT-backed assurance with two falsified conformance properties, one coherent
active Base/GlobalV2 pair, and explicit open top-level
obligations.
