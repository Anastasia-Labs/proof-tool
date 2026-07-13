# G2/G3 Operator Acceptance — 2026-07-13

## Decision

The operator explicitly approves **G2** and **G3** for the optimized V2 Preprod
release after reviewing the remaining evidence gaps and the measured improvement.
Both gates are **PASS BY OPERATOR EXCEPTION**.

This decision changes the release disposition; it does not manufacture missing
evidence. In particular, no single accepted all-distinct-seven on-chain claim was
run, and the clean browser median was not below 60 seconds.

## G2 evidence and exception

- Circuit: root-ownership-destination-v2/bls12-381/groth16.
- Stage 2g all-distinct-seven provider evaluation: 8,974,493,908 CPU,
  1,715,363 memory, 7,966 transaction bytes.
- Selected ceiling: 90% of the 10,000,000,000 transaction CPU limit; the
  evaluator result passes at approximately 89.745%.
- Confirmed live V2 claim transactions:
  - 920023f0120374e21893a4317ce00f378548d7a20b06bbb398bfb8558047c143
    claimed six ReclaimBase inputs.
  - 5790e8b2597d7f03aa3cc6fd4d6605c8c5f46fbf97ef994e7ffa12d8a1c06258
    claimed four ReclaimBase inputs.
- Signed V2 deployment, proof bundle, VK/CCS coherence, live web cutover, and
  provider-visible on-chain V2 prove/build/submit flow passed.

**Exception:** the original G2 contract requested one accepted transaction with
seven pairwise-distinct credentials derived from the same root plus evaluator and
accepted on-chain ex-units. That exact transaction and receipt are waived. The
passing provider evaluation and the separate confirmed live V2 claims are
accepted as sufficient Preprod release evidence.

## G3 evidence and exception

- Optimized circuit constraints: 1,789,750, below 2^21.
- Local setup, signed bundle/coherence, Stage 2g, final V2 deployment, live web
  cutover, real V2 claim, and post-success R2 rotation passed.
- Clean reference-browser runs with 16 workers, 16 shards, range-fetch
  concurrency 2, pinned decode, GOGC 50, GOMEMLIMIT 3000MiB, and
  W1/W2/W3/W5/W6/W7 applied:

| Run | Prove time | Peak main heap | Locally verified | Contaminated |
| --- | ---: | ---: | --- | --- |
| r4 | 64,713 ms | 0.8362 GiB | yes | no |
| r5 | 67,688 ms | 0.8348 GiB | yes | no |
| r6 | 66,837 ms | 0.8358 GiB | yes | no |
| **Median** | **66,837 ms** | **0.8358 GiB** | **yes** | **no** |

The median passes the 1.2-GiB main-heap gate. It exceeds the former 60,000-ms
time gate by 6,837 ms, or 11.395%. The fastest clean run was 64,713 ms.

**Exception:** the operator accepts the measured clean median in place of the
former ≤60-second requirement because the V2 route remains a major improvement
over the pre-optimization route and materially reduces main prover heap.

The memory metric is main Go/WASM heap, not whole-browser RSS.

## Scope

This acceptance applies to the current optimized V2 **Preprod** release. It does
not waive mainnet ceremony, artifact coherence, verifier-hash pinning, secret
locality, or negative-test requirements.
