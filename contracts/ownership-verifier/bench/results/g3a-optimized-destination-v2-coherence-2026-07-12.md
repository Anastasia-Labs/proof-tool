# Optimized destination V2 coherence benchmark — 2026-07-12

This result refreshes the current proof-only reclaim implementation versus the
statement-bound V2 reclaim implementation using the newly generated optimized
destination-circuit proof/VK coherence set.

## Identity and method

- Frozen source: `9fac96bc0669285433ca51e62873b1ab1fa274de`
  (signed local tag `root-ownership-destination-v2-g3a-freeze`).
- Circuit: `root-ownership-destination-v2/bls12-381/groth16`, 1,789,750
  constraints, K=21, one commitment.
- Statement domain remains `ROOT-OWNERSHIP-DESTINATION-v1`.
- Bundle VK hash:
  `blake2b256:b1c03cf24376bcd6c743cb372169ff71f93b210e0d8d52b2c6831808f50ded80`.
- Cardano VK hash:
  `blake2b256:06ce913c931a53561fe5d022ed45a5fbc033b06d80eebdd9f646d23a05b7d5c4`.
- CCS hash:
  `blake2b256:bf2243b3f4885357bbad0b6728582f56f0e00cd361e1e8af8a2d0dbe10a9f352`.
- Evaluator: checked-in Preprod protocol-V11 snapshot, raw limits 10,000,000,000
  CPU and 14,000,000 memory.
- Workload: N pairwise-distinct payment credentials derived from the same
  repository golden master private key, N ReclaimBase spends, N destination
  outputs, and one ReclaimGlobal withdrawal in a ledger-shaped context.
- Command: `cabal bench ownership-verifier-bench -v0`.

The 20 proof fixtures were regenerated and individually proved and verified
against the new signed bundle before the benchmark. The complete compiled
contract suite passed all 243 tests with the refreshed VK/proofs and transcript
vectors.

## Ex-unit comparison

| Distinct claims | Current CPU | Statement V2 CPU | Current memory | Statement V2 memory | Current result | V2 result |
| ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 3,309,160,504 | 3,319,221,193 | 311,497 | 347,672 | raw pass / policy pass | raw pass / policy pass |
| 2 | 4,537,149,335 | 4,384,824,626 | 536,275 | 559,890 | raw pass / policy pass | raw pass / policy pass |
| 3 | 5,449,157,715 | 5,297,371,061 | 747,339 | 771,318 | raw pass / policy pass | raw pass / policy pass |
| 4 | 6,361,173,361 | 6,209,925,454 | 958,445 | 982,792 | raw pass / policy pass | raw pass / policy pass |
| 5 | 7,273,196,273 | 7,122,487,805 | 1,169,593 | 1,194,312 | raw pass / policy pass | raw pass / policy pass |
| 6 | 8,185,226,451 | 8,035,058,114 | 1,380,783 | 1,405,878 | raw pass / policy pass | raw pass / policy pass |
| 7 | 9,097,263,895 | 8,947,636,381 | 1,592,015 | 1,617,490 | raw pass / policy reject | raw pass / policy pass |
| 8 | 10,009,308,605 | 9,860,222,606 | 1,803,289 | 1,829,148 | raw reject / policy reject | raw pass / policy reject |
| 9 | 10,921,360,581 | 10,772,816,789 | 2,014,605 | 2,040,852 | raw reject / policy reject | raw reject / policy reject |

At N=7, statement-bound V2 saves 149,627,514 CPU (1.6447%) while using
25,475 more memory (1.6002%). With production-width 28-byte policy and global
credentials, V2 measures 8,948,018,437 CPU (89.4802%) and 1,617,490 memory
(11.5535%), so the selected 90% CPU / 80% memory opt-in ceiling passes.
The corresponding current implementation measures 9,097,645,951 CPU
(90.9765%) and fails that policy ceiling.

## Capacity disposition

| Capacity definition | Current implementation | Statement-bound V2 |
| --- | ---: | ---: |
| Largest all-distinct batch below raw transaction ex-unit limits | 7 | 8 |
| Largest all-distinct batch below the selected 90% CPU ceiling | 6 | 7 |
| Product default | 6 | 6 |
| Explicit opt-in | none at 90% | distinct-7 |

Seven slots remain buildable regardless of credential duplication. The
same-credential seven-slot regression also passes at 8,947,636,381 CPU /
1,617,490 memory because V2 deliberately carries a full proof and digest for
every slot. Repeated/duplicate batches are correctness regressions, not the
capacity target.

## Operator disposition

This remains a deterministic local evaluator result, not an on-chain acceptance
claim. The coherent optimized-V2 Preprod deployment and real V2 six-input and
four-input claims were subsequently confirmed. On 2026-07-13 the operator
accepted G2 and G3 by explicit exception: the exact accepted all-distinct-seven
transaction and its on-chain ex-unit receipt are waived, and the clean
66,837 ms browser median is accepted despite exceeding the former 60-second
gate. The missing evidence is not inferred. See
g2-g3-operator-acceptance-2026-07-13.md for the evidence and variance record.
