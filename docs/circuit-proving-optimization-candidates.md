# Circuit and proving optimization candidates

**Original survey:** 2026-07-13

**Status refresh:** 2026-07-28

**Scope:** `root-ownership-destination-v2/bls12-381/groth16`, its browser
runtime, and its desktop/native proving path.

This document preserves the useful findings from the original optimization
worktree and reconciles them with the current codebase. It is a candidate
survey, not permission to change the production statement or coherence set.

## Current baseline

The production circuit itself has not adopted the surveyed circuit changes:

- 1,789,750 R1CS constraints;
- K=21;
- one commitment;
- circuit ID `root-ownership-destination-v2/bls12-381/groth16`.

The tracked gate in `internal/circuit/ownershipdest/gate_test.go` remains the
source of truth. A circuit change requires a new circuit identity, ceremony,
VK/PK/CCS, Cardano export, contract parameters, proof release, fixtures,
formal/negative evidence, and deployment coherence refresh.

Runtime work materially changed the wall-clock baseline without changing the
circuit. The current browser reference in
`browser-proving-remote-chunk-matrix.md` is:

- warm 16-worker: **41.46 s**;
- cold 16-worker: **47.68 s**;
- peak main heap: about **0.83 GiB**;
- locally verified proofs.

Those results supersede the original roughly 70-second browser baseline.
Therefore the old “2.9 seconds per 100k constraints” conversion and every
wall-clock projection derived from it must be remeasured; they are not current
performance promises.

## Constraint profile retained from the original survey

The original gnark profile compiled a 1,791,413-constraint module-cache build:

| Bucket | Constraints | Share | Interpretation |
| --- | ---: | ---: | --- |
| `BatchInvert` | 1,009,552 | 56.4% | Log-derivative lookup query inverses. |
| `AssertIsEqual` | 500,936 | 28.0% | Includes about 416,081 range-check recompositions. |
| `DivUnchecked` | 131,328 | 7.3% | Two 65,536-row byte tables and one 256-row range table. |
| `AssertIsBoolean` | 103,229 | 5.8% | Bit decompositions and small-width checks. |
| `MulAcc`/`Mul` | 44,135 | 2.5% | Mainly emulated ed25519 arithmetic. |

The +1,663 discrepancy from the 1,789,750 tracked gate was traced to
vendor-versus-module-cache resolution. Measurements used for adoption must be
repeated in the bootstrapped, drift-checked vendor environment and must match
the tracked constraint gate before comparison.

## Circuit candidates

| ID | Candidate | Original result | Current status | Decision notes |
| --- | --- | --- | --- | --- |
| R1 | Single-limb range-check fast path | Measured 1,789,750 → 1,396,464, a reduction of 393,286 (22.0%). Golden witnesses solved. | **Not adopted** | Highest-value circuit candidate. Recreate as a reviewed gnark patch, add malicious-hint negatives and drift provenance, then remeasure current browser/native proving. It changes the circuit and coherence set. |
| R2 | Reuse SHA-512 `Maj` cross-round XOR | Measured 1,789,750 → 1,772,020, a reduction of 17,730. SHA/HMAC differential tests passed. | **Not adopted** | Small, low-complexity pure identity/wire reuse. Reprototype on current source and combine only after independent circuit review. |
| S1 | Union-cut schedule-word decomposition | Estimated −23k before R1, roughly −14k…−18k after R1. | **Not prototyped/adopted** | Low mathematical risk, but validate exact-width recomposition and do not sum estimates naively with R1. |
| S2 | Constant-fold `sigmaRot` schedule words | Estimated −9k…−10k before R1, roughly −6k…−8k after R1. | **Not prototyped/adopted** | Reasonable bundle item; prove every folded input is compile-time constant. |
| E1 | ed25519 fixed-base window 4 → 5/6 | Estimated −25k…−35k. | **Not prototyped/adopted** | Compile/profile first; verify table/mux costs and all scalar edge cases. |
| E2 | ed25519 limbs 4×64 → 3×85 | Estimated −15k…−25k. | **Not prototyped/adopted** | Higher implementation risk. Audit gnark overflow and hidden limb-width assumptions before treating the estimate as feasible. |
| C7 | Incremental soft-parent points | Isolated measured saving about 10,968. | **Deferred** | Reopens the CKD proof argument and requires the residual `kL_child` top-bit pin. Do only if that audit surface is deliberately reopened. |

R1’s original mechanism remains technically plausible: gnark 0.15's
commit-based range checker decomposes and recomposes even a single limb. For
checks no wider than the eight-bit lookup base, querying the original value
(and its shifted copy for narrower widths) can preserve the same membership
facts with fewer wires. This must be reviewed as a soundness-sensitive vendor
change, not a mechanical performance patch.

R2 uses:

```text
Maj(a,b,c) = b XOR ((a XOR b) AND (b XOR c))
```

and reuses the prior round's rotated XOR. It introduces no hints or lookup-table
change, but still changes the R1CS and therefore requires the full release
coherence process.

## Lower-priority circuit ideas

| Candidate | Original estimate | Disposition |
| --- | ---: | --- |
| Drop selected redundant byte checks | −35k…−49k before R1 | **Do not pursue without an airtight consumption proof.** It touches the same hint/range assumption class that previously produced a soundness bug. |
| Trim genuinely unused HMAC feed-forward output | −450…−500 | Safe but low return; only fold into an already-reviewed bundle. |
| Deduplicate CKD `splitByte`/canonical-bit checks | −100…−190 | Audit churn exceeds value. |
| Remove ed25519 F1/F2 self-checks | About −800 | Keep the intentional defense in depth. |

Confirmed dead ends remain:

- no production OR/NOT table opportunity;
- range-check base is already circuit-wide appropriate;
- BLAKE2b is too small to justify a dedicated split table;
- `Ch` has no analogous cross-round reuse;
- the 28 SHA-512 compressions are statement-minimal;
- divergent HMAC messages prevent further prefix sharing;
- witness-supplied chain codes still require validation; and
- merged C6-style lookup shortcuts remain rejected as unsound.

## Runtime candidates reconciled with current code

| Candidate | Original status | Current status |
| --- | --- | --- |
| Chunk/range-aligned PK fetching | Candidate, estimated −8…−15 s | **Substantially implemented.** Signed chunks, exact range validation, sharded ranged MSM, prefetch controls, and hosted range evidence exist. This work helped move the reference from ~70 s to 41–48 s. Continue optimizing measured fetched-byte amplification rather than assuming the old 59.2% waste figure. |
| Native desktop MSM task fix | Measured 3.84 s after removing native `NbTasks:1` | **Implemented.** Native uses `runtime.NumCPU()` while JS/WASM retains one task per worker. Product routing and signed helper releases remain release-readiness work, not prover math work. |
| Persistent verified chunk cache | Candidate | **Not implemented as durable OPFS/IndexedDB cache.** Current worker verified-chunk caching is session/runtime scoped. Any durable cache must bind bytes to signed manifest identity and verify before activation. |
| Increase range-fetch concurrency | A/B candidate | **Tunable and implemented.** Keep workload/device/CDN A/B evidence; more concurrency can raise peak memory and contention. |
| WASM-specific MSM window | Research candidate | **Not adopted.** Benchmark only with identical proof verification and memory telemetry. |
| FFT or witness parallelism | Low expected return | Still low priority: the MSM window dominates and overlaps FFT; witness solve is a small fraction of the current run. |
| WebGPU/custom kernels | Long-term research | Separate audited research program, not a near-term release optimization. |

## Statement-level ideas are not optimizations

- Accepting an intermediate `m/1852'/1815'` key would remove substantial CKD
  work but weaken the claim. It would be a new statement, domain, circuit,
  ceremony, audit, UI claim, and deployment—not a faster implementation of the
  current claim.
- Replacing the destination BLAKE2b digest with a field hash remains
  unattractive: the in-circuit digest binding is small and Plutus has a native
  BLAKE2b primitive.
- Prefix-sharing across multiple credentials applies to the separate
  multi-credential circuit family. The deployed reclaim path intentionally uses
  one full destination-bound proof and digest per V2 slot.
- DRep role 3 is unsupported. Adding it would be a separately reviewed protocol
  release, not a proving optimization.

## Updated recommendation

1. **Do not change the circuit merely because the current production ceremony
   is still NO-GO.** First decide whether the roughly 41–48 second browser
   baseline is acceptable and whether a circuit refresh would delay the
   already-large Mainnet/MPC review surface.
2. Prefer ceremony-free work first: reduce fetched bytes and cold-start
   overhead, finish durable verified caching if justified, improve capability
   routing, and complete signed desktop-helper distribution.
3. If a circuit v3 is justified, start with isolated current-tree recreations of
   R1 and R2. Record constraint counts, compile/solve/prove/verify times,
   browser cold/warm results, native results, peak memory, and malicious witness
   tests before selecting a bundle.
4. Prototype S1/S2/E1/E2 independently. Do not add estimated savings; measure
   interactions after R1.
5. Require a written statement-equivalence review, full golden/differential and
   negative battery, formal-assurance refresh, new circuit ID, new ceremony,
   new native/Cardano keys, contract/script rebuild, signed proof release, and
   real Preprod contract-path evidence.

The original survey’s most important conclusion still holds: K=20 requires at
most 1,048,576 constraints, so even the proposed low-risk bundle was expected
to remain K=21. Chasing K=20 by weakening the statement or removing
soundness-relevant checks is not justified.
