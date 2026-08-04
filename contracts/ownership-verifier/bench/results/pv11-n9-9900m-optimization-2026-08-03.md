# PV11 N=9 9.9B optimization result

Date: 2026-08-03
Scope: production-width statement-bound `ReclaimGlobalV2`, preserving the
ownership-destination circuit, 336-byte proof, redeemer, public input,
validator parameters, and deployment interface.

## Exact result

All figures use Plutus/Plinth `1.66.0.0`, UPLC `1.1.0`, builtin casing, and the
checked-in 350-entry protocol-v11 cost model (equal to the queried Mainnet
array recorded by the benchmark work).

| Complete N=9 transaction shape | Memory | CPU | Headroom below 10B |
| --- | ---: | ---: | ---: |
| Production-width policy and credential | 668,981 | 9,876,188,159 | 123,811,841 |
| Representative multi-asset paid superset | 671,159 | 9,895,276,763 | 104,723,237 |

The production-width result is `23,811,841` CPU below the requested
`9,900,000,000` target. Relative to the supplied `9,947,936,777` starting
measurement, it saves `71,748,618` CPU. Relative to the same-source Plinth
1.66 baseline (`9,944,944,777`), it saves `68,756,618` CPU. See the subsequent
[full-module audit](pv11-reclaimglobalv2-full-audit-2026-08-03.md) for retained
and rejected candidate measurements.

The production-width applied scripts are 377 bytes for ReclaimBase and 6,363
bytes for ReclaimGlobalV2. The global script remains well below the 16,384-byte
transaction-size ceiling and is smaller than the pre-optimization script.

## Changes

The batch coefficients for N>1 are now

```text
r, r^2, ..., r^(N-1), 1 - sum(r .. r^(N-1))
```

where `r` is the challenge over the digest of the complete statement-bound
batch transcript. Their integer sum is exactly one (and their field sum is
therefore one), so the terminal verifier uses unscaled Groth16
alpha and IC0 while retaining transcript dependence for every proof in a
multi-proof batch. If the individual verification errors are `e_i`, the
folded error is

```text
e_N + sum(r^i * (e_i - e_N))
```

This polynomial is identically zero only if every `e_i` is zero. Its degree is
at most N-1 (eight for N=9), retaining the standard random-linear-combination
soundness bound in the random-oracle model.

The transcript is hashed once; the independently domain-separated merge
challenge hashes `transcriptDigest || 0x01`. The terminal commitment/C/PoK columns use the protocol-v11 G1 MSM builtin at
the measured crossover and retain scalar folds below it. The PoK merge
challenge is fused into the MSM scalars. Sum-to-one-specialized terminal
helpers avoid reintroducing generic coefficient-sum work.

Builtin casing now uses ordinary `Bool` conditionals and conjunction directly
instead of identity, conditional, and conjunction wrappers. Indexed data
projection uses `head (dropList index values)` without canonicality guards. A
negative reference-input or destination-output index aliases index zero; this
is safe because the selected parameter NFT/datum and every destination-bound
proof/value condition are still validated. An oversized reference index still
fails at `head`, and an oversized destination index leaves no destination
output for the subsequent validator.

Using `null (dropList 7 coefficients)` to select the MSM path was also measured.
It is semantically equivalent to the retained eight-constructor match, but
regressed production N=9 by 3,584,202 CPU and 12,348 memory, yielding
9,902,705,427 CPU. It was therefore not adopted.

The production Plinth build uses callsite growth 300, the lowest-CPU setting
after the full-module cleanup, and permits optimization across logging
expressions. Scripts already compile with `remove-trace`, so this does not
remove production-visible diagnostics beyond the existing trace-stripped
policy.

## Historical pre-audit compiler sweep

Every candidate was compiled in an isolated build directory and measured as a
complete, non-instrumented script.

| Callsite growth | Production-width CPU | Applied global bytes | Result |
| ---: | ---: | ---: | --- |
| 105-110 | 9,900,936,655 | 6,137 | above target |
| 111-112 | 9,900,072,655 | 6,435 | 72,655 above target |
| 113-200 | 9,899,592,655 | 6,573 | closest measured result below target |
| 250 | 9,899,496,655 | 7,453 | farther below target |
| 300 | 9,897,864,655 | 9,324 | farther below target |
| 350-500 | 9,898,008,655 | 8,266 | farther below target |

Raising PIR/UPLC simplifier iterations did not improve CPU and produced an
oversized script. Increasing CSE iterations was neutral for CPU and nearly
filled the transaction-size limit.

This sweep originally selected callsite growth 113 to stay just below 9.9B.
After the full-module audit changed the optimization objective from proximity
to minimum CPU, growth 300 was remeasured at 9,876,188,159 CPU. Growth 350 was
48,000 CPU worse. The table remains historical evidence for the earlier source
rather than extrapolating its rows.

## Verification

- Exact protocol-v11 benchmark accepts complete N=9 production-width,
  ledger-shaped, and representative multi-asset rows under the Mainnet 10B
  limit.
- All 133 contract tests pass, including compiled production N=9 acceptance,
  malformed-width/list/count rejection, transcript-order rejection, and
  isolated Groth16-C and PoK substitutions.
- Unit tests cover affine coefficient canonicality/sum for N=1..9, the folded
  error polynomial identity, G1 fold equivalence for N=1..9, and merged PoK
  fold equivalence for N=1..9.
- The aggregate `pnpm test:all` gate passes all 19 runnable sections; its
  optional `golangci-lint` section is skipped because the tool is not installed.

This result satisfies the requested 9.9B benchmark target. It does not satisfy
the repository's older 90%-of-Mainnet CPU release policy; benchmark output
therefore continues to label N=9 `policy=REJECT` even though ledger raw
acceptance is `ACCEPT`.
