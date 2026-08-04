# Protocol V11 Mainnet Builtins Benchmark

> The N=9 “pass” in this dated report means raw 10B acceptance, not the live
> production safety policy. See
> `pv11-n9-production-safety-profile-2026-08-03.md` for the current 1.66
> measurements and production disposition.

Date: 2026-08-02

## Scope

This benchmark accompanies the ownership-verifier upgrade to the first
protocol-v11 mainnet node package set: `cardano-node` 11.0.1 and Plutus
`1.63.0.0`. These dated measurements predate the compiler-only 1.66 upgrade;
see `pv11-n9-production-safety-profile-2026-08-03.md` for the current exact
budgets. The contract compiles for UPLC 1.1.0 with Plinth's temporary
`BuiltinCasing` lowering, and evaluation requires the complete 350-entry
protocol-v11 PlutusV3 cost model in
`preprod-protocol-v11-epoch-300.json`.

Production changes measured here are:

- fixed raw-data projections use `dropList`;
- `Bool` and `Integer` branches use protocol-v11 builtin casing;
- `ReclaimGlobalV2` uses `unsafeDataAsValue` and `valueContains` for each
  ledger-originated input/destination value comparison;
- `ReclaimGlobalMulti` aggregates ledger-originated values with `unionValue`
  and compares them with `valueContains`.

The one-shot NFT policy does not use the native `Value` comparison. Mint values
can contain negative burn quantities, while the native conversion/comparison
preconditions used by this design require positive, canonical `Value` data.

## Method

The before and after full-contract runs use the same repository-backed proof,
verifier key, transaction-context builders, and committed protocol-v11
snapshot. The old Plutus 1.38 evaluator could consume only the first 297 of the
snapshot's 350 entries; the upgraded evaluator rejects an incomplete model and
consumes all 350. The full-contract percentages therefore measure the complete
toolchain/protocol migration, not an isolated source-code substitution.

The focused `Value` rows below all use the upgraded evaluator and complete
cost model, so they isolate the builtin choice on one common stack. Reported
budgets include the shared CEK baseline of 500 memory and 64,100 CPU; it is
measured separately and is common to both paths.

Commands:

```text
cabal bench ownership-verifier-bench -v0
cabal bench ownership-verifier-v4-profile -v0
```

## Full ReclaimGlobalV2 Results

The builtins-only checkpoint initially left N=9 at `10,437,570,852` CPU. The
subsequent production batching work uses thresholded native MSM, a directly
merge-challenge-scaled PoK MSM, and one statement-bound merged pairing product.
The canonical exported validator now has this ledger-shaped ADA-only matrix:

| Batch | Builtins-only CPU | Final production CPU | Reduction | Final memory | Raw Mainnet result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 3,265,601,256 | 3,093,435,794 | 172,165,462 | 148,368 | pass |
| 6 | 7,805,421,927 | 7,641,058,135 | 164,363,792 | 567,359 | pass |
| 7 | 8,682,796,944 | 8,519,993,486 | 162,803,458 | 651,128 | pass |
| 8 | 9,560,179,919 | 9,224,596,891 | 335,583,028 | 758,451 | pass |
| 9 | 10,437,570,852 | **9,947,445,755** | **490,125,097** | 843,708 | **pass** |

The final production-width N=9 ablation is `9,947,936,777` CPU. A canonical
positive multi-asset context with three required policy/asset groups and a
four-policy/five-asset paid superset in each slot is `9,993,470,198` CPU at
N=9. Exact transaction evaluation remains mandatory because more complex
contexts or Values can cross the network maximum even at the same count.

## Native Value Builtins

The focused multi-asset case contains three required policy/asset groups and
five paid assets. The comparison includes conversion from `BuiltinData`.

| Implementation | Memory | CPU |
| --- | ---: | ---: |
| Typed `unsafeFromBuiltinData` + `Value.leq` | 226,379 | 37,831,785 |
| Native `unsafeDataAsValue` + `valueContains` | 5,384 | 7,388,369 |
| Reduction | **97.6%** | **80.5%** |

For ADA-only data, the native path uses 5,142 memory / 4,176,253 CPU versus
69,153 memory / 11,628,356 CPU for typed decode plus `Value.leq`: reductions of
92.6% memory and 64.1% CPU.

## Arrays

`listToArray` plus `indexArray` was profiled against the adopted `dropList`
fixed-field projections. Conversion cost is not amortized by only three or four
accesses:

| Fields accessed | `dropList` memory / CPU | Array memory / CPU | Array result |
| ---: | ---: | ---: | --- |
| 3 | 5,537 / 1,662,412 | 5,439 / 1,929,213 | 1.8% less memory, 16.0% more CPU |
| 4 | 7,007 / 2,214,096 | 6,606 / 2,484,013 | 5.7% less memory, 12.2% more CPU |

CPU is the limiting resource for this validator, so array conversion was not
adopted in the production field-access paths. Arrays remain suitable for a
future path that amortizes conversion over substantially more random accesses.

## Script Size

With production-width parameters, serialized scripts changed as follows:

| Script | Before | After | Change |
| --- | ---: | ---: | ---: |
| ReclaimBase | 132 bytes | 106 bytes | -19.7% |
| ReclaimGlobalV2 | 3,356 bytes | 3,429 bytes | +2.2% |

For the benchmark's synthetic 28-byte parameter policy, the paired candidate
PlutusV3 hashes are
`28d02e5fdde7cf5777a170ecfd5512270a222df3ec9a4b329acb66a3` (Base) and
`b2cb8223d9eb337797a9371d6e60c0dd76c0cf294c80a1a72666171b` (GlobalV2); the
serialized GlobalV2 BLAKE2b-256 digest is
`19d97000d0e889f851b8a3e58b52340de936ad641fa812820511d01043d93c92`.

These identities differ from deployed Preprod scripts and are not deployment
parameters. These source and benchmark results are not an authorization to
replace a deployment; normal artifact coherence, deployment review, and real
transaction gates still apply.

## Validation

- all 130 ownership-verifier tests pass, including 25,600 randomized value
  coverage cases and positive/negative proof, destination, NFT, and layout
  cases;
- the cost-model gate consumes all 350 parameters and rejects warnings or
  incomplete snapshots;
- both benchmark executables compile and run against the pinned package set;
- `reclaim-scripts-export` builds and emits a serialized PlutusV3 smoke-test
  script without mutating deployment artifacts;
- raw N=9 passes under the exact Mainnet PV11 cost model;
- `pnpm test:all` passes all 19 runnable repository sections; only
  `golangci-lint` is skipped because it is not installed.
