# PV11 N=9 ex-unit hotspot profile

> This dated report answers raw 10B ledger acceptance only. It is superseded
> for production release decisions by
> `pv11-n9-production-safety-profile-2026-08-03.md`, which applies the live
> 90% CPU safety policy and proves that the fixed N=9 interface cannot meet it.

Date: 2026-08-02
Scope: canonical statement-bound `ReclaimGlobalV2`, ledger-shaped claim
contexts, and the checked-in 350-entry protocol-v11 PlutusV3 cost model. A live
Mainnet epoch-647 query confirmed that Mainnet uses the identical 350 integers.

## Target and method

The post-upgrade N=9 baseline is `10,437,570,852` CPU, so raw acceptance
requires a reduction of exactly `437,570,852` CPU. Complete-script candidate
budgets below come from the non-instrumented CEK evaluator used by
`ownership-verifier-bench`. The hotspot attribution counts operations on the
accepted N=9 path and prices them with `builtinCostModelE.json`, which agrees
with the checked-in protocol-v11 model for these BLS builtins.

Plinth `profile-all` is useful for call nesting, but its trace instrumentation
changes optimization and execution cost. It is therefore not used as the
source of the exact candidate deltas.

## N=9 hotspot attribution

These six groups account for at least 97.14% of the complete transaction CPU.
Scalar-multiplication rows use the model intercept, so their totals are slight
lower bounds; scalar-size slopes and all remaining CEK, hashing, BLS-addition,
Miller-result multiplication, validator, and base-validator work are contained
in the final remainder.

| Accepted-path work | Count | CPU floor | Share of complete N=9 CPU |
| --- | ---: | ---: | ---: |
| Miller loops | 14 | 3,556,087,822 | 34.07% |
| Proof point decompression: 4 G1 + 1 G2 per proof | 9 proofs | 2,578,418,640 | 24.70% |
| Tail proof folding: commitment, PoK, A, and C G1 scalar multiplication | 32 | 2,445,856,192 | 23.43% |
| Two final verifications | 2 | 667,699,428 | 6.40% |
| Verifier-key decompression: 4 G1 + 5 G2 | 1 key | 585,284,848 | 5.61% |
| Terminal vkX/alpha G1 scalar multiplication | 4 | 305,732,024 | 2.93% |
| Accounted subtotal |  | 10,139,078,954 | 97.14% |
| Remaining work and scalar-size slopes |  | at most 298,491,898 | at most 2.86% |

The 14 Miller loops are the nine folded A/B terms plus five fixed Groth16/PoK
terms. The A column cannot be replaced by one G1 MSM because every A is paired
with a distinct B. The commitment, PoK, and C columns are ordinary weighted G1
sums and can use CIP-133 MSM directly.

## Native MSM measurements

The protocol-v11 G1 MSM model has a `321,837,444` CPU intercept and a
`25,087,669` slope. It is more expensive than individual scalar multiplication
for short columns and crosses over at seven tail points, i.e. total batch
N=8. An unconditional three-column MSM therefore badly regresses the normal
N=6 path. The retained candidate uses individual folding through N=7 and
native MSM for N>=8.

| Complete-script case | N=6 CPU | N=7 CPU | N=8 CPU | N=9 CPU | N=9 change |
| --- | ---: | ---: | ---: | ---: | ---: |
| PV11 scalar-fold baseline | 7,805,421,927 | 8,682,796,944 | 9,560,179,919 | 10,437,570,852 | -- |
| Unconditional native MSM | 7,997,580,964 | 8,719,384,721 | 9,441,196,436 | 10,163,016,109 | -274,554,743 |
| Thresholded hybrid fold | 7,812,973,927 | 8,691,516,944 | 9,442,924,436 | 10,164,744,109 | -272,826,743 |

The hybrid's small-batch overhead is list construction and terminal branch/fold
work: `+7,552,000` CPU at N=6 and `+8,720,000` at N=7. It avoids the
unconditional candidate's `+192,159,037` N=6 regression.

## Production statement-bound equation merge

The canonical validator now combines the Groth16 and BSB22 pairing products
with `s`, an independently suffix-separated challenge derived from the same
complete V2 transcript as `r`. That transcript binds the verification-key
hash, u16 count, ordered full proofs, and ordered authenticated statement
digests. This is the statement/count/VK absorption selected as the production
remedy by the earlier soundness review; it is not the historical proof-only
benchmark construction.

The production implementation also constructs the `s`-weighted PoK column
directly with one nine-point MSM instead of computing an eight-point unweighted
tail MSM and then scalar-multiplying the result. This saves another 46,495,564
CPU over the first merged implementation and is exactly equivalent by
linearity.

| N=9 implementation | Complete CPU | Reduction from baseline | Raw 10B headroom | Wired into canonical export? |
| --- | ---: | ---: | ---: | --- |
| Thresholded MSM, separate final checks | 10,164,744,109 | 272,826,743 | -164,744,109 | no |
| Thresholded MSM, terminal-scaled merged PoK | 9,993,941,319 | 443,629,533 | 6,058,681 | no |
| Direct-scaled PoK MSM + statement-bound merge | **9,947,445,755** | **490,125,097** | **52,554,245** | **yes** |

The finalized production-width parameter ablation is `9,947,936,777` CPU and
`843,708` memory, leaving `52,063,223` CPU below Mainnet's raw limit. The
representative multi-asset case, with three required policy/asset groups and a
four-policy/five-asset paid superset in every slot, is `9,993,470,198` CPU and
`854,103` memory, leaving `6,529,802` CPU. Builders must continue to evaluate
the exact transaction and split batches whose context or Values exceed the
network maximum; an input count alone cannot guarantee acceptance for every
possible transaction shape.

The production construction and assumptions are frozen in
`docs/v2-statement-bound-single-final-verify-production-memo.md`. Algebraic
tests cover N=1..9, and the compiled canonical N=9 script rejects isolated
valid-curve substitutions in Groth16 C and BSB22 PoK in addition to the full
existing negative matrix.

## Mainnet parameter check

A live Mainnet query on 2026-08-02 at epoch 647, tip
`3ecdd9ab506df0f363b69f5f16e4c4025b106733efdeedb6ef4d446f7640f831`,
reported protocol `11.0`, max transaction CPU `10,000,000,000`, max transaction
memory `16,500,000`, and 350 PlutusV3 cost-model entries. An exact array
comparison against the checked-in Preprod snapshot returned true. Consequently
the benchmark is not extrapolating BLS costs from a different network model.

## Ruled-out or low-impact paths

- Lifting the parsed verifier key as UPLC BLS constants would remove roughly
  585M CPU, but it is not serializable: Flat encoding rejects G1/G2 objects and
  requires compressed bytes. Runtime key decompression is therefore a hard
  cost with the current language.
- CIP-138 arrays do not improve these sums. CIP-133 MSM consumes aligned lists,
  and converting collected lists to arrays only adds work. Existing focused
  array profiles also regress CPU for the validator's sequential field access.
- `dropList`, native `Value`, and Bool/Integer builtin casing are already in the
  accepted path. Together, transcript/context/value/list plumbing is too small
  to recover the remaining 165M after MSM.
- Point decompression and Miller loops are the largest remaining floors, but removing
  either requires a different proof/circuit or batching equation, not a local
  Plinth rewrite.

## Disposition

Retain the thresholded commitment/C MSMs, direct challenge-scaled PoK MSM, and
statement-bound merged pairing product in the canonical production validator.
N=9 now fits the exact Mainnet PV11 model without a circuit, proof, redeemer,
public-input, or validator-parameter interface change. Preserve exact
transaction evaluation as the final admission check, especially for complex
multi-asset Values.

Primary references:

- Plinth budget profiling: https://plutus.cardano.intersectmbo.org/docs/working-with-scripts/profiling-budget-usage
- CIP-133 BLS12-381 multi-scalar multiplication: https://cips.cardano.org/cip/CIP-133
- CIP-138 Plutus arrays: https://cips.cardano.org/cip/CIP-138
- Cardano protocol-parameter guide: https://docs.cardano.org/about-cardano/explore-more/parameter-guide
- Mainnet protocol parameters query: https://api.koios.rest/api/v1/cli_protocol_params
