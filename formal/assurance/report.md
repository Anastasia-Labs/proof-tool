# Reclaim contract formal-assurance report

Recorded: 2026-07-20

## Outcome

**Current classification: incomplete, with two intended conformance properties
falsified and an intentional candidate/deployment divergence.** The exact active
deployment is not verified as a whole. The deployed artifacts and historical
ReclaimBase proofs remain locked. The simplified current-source ReclaimBase is
exported as a coherent pair with the current-source canonical GlobalV2; both
are non-deployed candidates with exact concrete replays. The Base candidate
also has generalized typed withdrawal semantics. Fifteen catalog entries
remain pending, including the candidates' exact universal bridges and
the mechanically checked bridge from every successful execution of the
3,648-byte exact ReclaimGlobalV2 artifact to the independent recursive
specifications.

The canonical-datum conformance properties
`RG-CEX-PARAM-DATUM-TAG` and `RG-CEX-BASE-DATUM-TAG` are false for the exact
active GlobalV2 script. Both findings are ledger-valid and replay in the Lean
and Haskell compiled evaluators. The separate authorization properties
`RG-PARAM-DATUM` and `RG-BASE-DATUM` remain pending.

## Exact production target

| Artifact | Cardano identity | CBOR SHA-256 | Result |
| --- | --- | --- | --- |
| OneShotNFT | `82c806809e8e2a65c153041db187ca96f2feeb87a3fe135bf3803174` | `63f75c395f950ac36f0d3465db66e16b03771161ca807017070e294979b9bc7e` | exact bytes locked; `NFT-1` valid |
| ParamsHolder | `ebb18a12777410738fdeaa77ec0fd582685d677b6b34de9a6e3b6d7e` | `b59ac3cea50e634b57f811c3d6ef95a8e5ad1837cb23706d249fb6c0cd4142ee` | exact identity locked; `PH-1` valid |
| ReclaimBase (deployed Preprod) | `a4cd2a3208a0788aedd1aeea087f8902c58052dc2fcfa2c228ea34dd` | `ac84e7cfad8e3b6972b2232aa003bb5fab6b3439c13ebf6f44f386d1650470af` | exact historical bytes and old-semantics theorems preserved |
| ReclaimBase (current source candidate) | `98c37bec5939bf320e387e54973bb2af68b7d839fc8ae96cc8b1ff50` | `a4933a8f68c8556bdbc90ca12860be7175cc04ab90e1a3d68e70a3599c15384f` | paired with candidate GlobalV2 credential `b88e02bd…eebb`; not deployed; concrete exact replays pass; `RB-1..3` universal compiled bridge pending |
| ReclaimGlobalV2 (deployed Preprod) | `1556d4b8968fc1bc2beb692634a8e1c7e4d476cce48a5969c007b2c5` | `ca80b672a1e9fb00818497a0a494633c9344ff59cf09d4d4f5747029a5259e7c` | exact bytes locked; two typed-shape properties falsified; generalized top-level properties pending |
| ReclaimGlobalV2 (current source candidate) | `b88e02bd9d6a9e711f11941729b437c04a27368bbb10f5f95c1deebb` | `4d9be0b824c60e97058fb4c2bd19827a9405679247e2f800795685aec19302c4` | not deployed; coherent candidate contexts and five exact positive/negative replays pass; universal compiled bridge pending |

The deployed script/policy identities remain matched to the public Preprod
manifest and reference-script evidence. Current source intentionally differs
from the active deployment for both Base and GlobalV2; OneShotNFT and
ParamsHolder remain byte-identical. The exporter/package also retire V1.
`#import_uplc` separately decodes the deployed artifacts and both candidate
`single_cbor_hex` files as Plutus V3 programs. No manifest, parameter datum,
reference script, or chain deployment was changed.

## Classified results

The catalog currently contains 31 entries:

- 2 `Valid` generalized theorem families;
- 8 `Falsified` adversarial or intended properties;
- 6 passed artifact/model/trust gates;
- 15 `Pending` obligations.

The completed generalized results cover the parameter holder, parameter NFT,
the deployed historical ReclaimBase behavior, reference-index selection, exact
parameter-token shape, statement digest, componentwise Value coverage, and V2
batch transcript framing. Current-source candidate typed semantics and concrete
replays are supporting evidence only until the exact universal compiled
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
`78b0534f26b6145daf6bf5d9bf516265aaed75965fd178bc7b7aacb6233b2b4a`.

Impact is a broader-than-typed GlobalV2 acceptance set. The repository's
honest deployment fixture uses the canonical tag, so this evidence does not
show the active parameter UTxO is malformed.

### F-2: noncanonical matching ReclaimBase datum constructor accepted globally

`RG-CEX-BASE-DATUM-TAG` is falsified. Changing only a matching input's inner base
datum from constructor tag 0 to tag 1 still lets GlobalV2 succeed. The context
CBOR SHA-256 is
`337d591e8e4f255611a0d60514c97a99b2deff2071f777119553bac35cecba51`.

The deployed Preprod ReclaimBase rejects the corresponding spend in both
evaluators, while the simplified current-source candidate intentionally
ignores datum shape. This remains a typed-encoding conformance mismatch, but
the witness does not by itself bypass authorization: GlobalV2 still extracts
the same 28-byte credential field, verifies the destination-bound statement,
and enforces complete value coverage.

Both replay packages are in
`formal/assurance/counterexamples/global-v2-noncanonical-datum-tags.json`.
The user authorized simplifying the existing ReclaimBase source. That source
change was made without deploying or relabeling the resulting candidate.

## Independent verification evidence

- `lake build ProofToolFormal` passes on Lean 4.24.0 and Z3 4.15.2.
- Exact imported artifact decoding succeeds for all four deployed scripts,
  both current-source candidates, and seven parameterized/helper artifacts.
- The replay record contains 19 agreeing exact Haskell/Lean compiled
  decisions: 10 for locked deployed artifacts and nine for the coherent
  candidate pair. Candidate decisions are never promoted as deployed evidence.
- Full Haskell ownership-verifier suite: all 114 tests pass, including 25,600
  randomized ReclaimBase differential cases in the latest
  coverage-expanded runs and
  1,000 randomized Value cases.
- Go transcript/proof-asset packages pass.
- TypeScript transcript, address/claim, and in-process manifest suites: 40
  tests pass.
- The active manifest verifier passes directly and reports the statement-bound
  V2 profile and explicit seven-slot policy.
- The candidate verifier rebuilds in deployment order and reproduces GlobalV2
  hash `b88e02bd9d6a9e711f11941729b437c04a27368bbb10f5f95c1deebb`, then Base hash
  `98c37bec5939bf320e387e54973bb2af68b7d839fc8ae96cc8b1ff50` parameterized by
  that exact GlobalV2 credential.
- The default assurance workspace gate rebuilds active artifacts from the
  manifest-pinned deployment commit, rebuilds the coherent current-source
  candidate pair separately, passes every executable build/test and classification check, and
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

For GlobalV2, the rewarding-purpose component of `RG-1` is a universal theorem over the
exact monolithic active UPLC program: eventual classified success is decomposed
through a resumable 500-step prefix, and prefix survival implies
`RewardingScriptInfo`. This is a lifecycle-safety result: it rules out a
successful certifying invocation that deregisters the script stake credential,
returns its deposit, and prevents later reclaim withdrawals until registration
is restored. The remaining missing bridge covers selected parameter and NFT
checks plus recursive slots, Value, transcript, and verifier paths.
`#prep_uplc` still maps exhaustion to `State.Error`; full symbolic unrolling is
currently infeasible, and the helper exports do not by themselves prove
compiler-preserving equivalence to every path in the monolith.

`PROV-2` is complete: an independent Lean encoder re-encodes all four active
and both candidate ASTs to the exact canonical single-CBOR exporter bytes.
`PROV-1` is complete: the active deployment is regenerated from its pinned
source commit and the coherent current Base/GlobalV2 candidate pair is verified
independently.
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
non-deployed Base/GlobalV2 candidate pair, and explicit open top-level
obligations.
