# MPC Ceremony Parallel Optimizations

This note explains the three multithreading optimizations applied to gnark's
BLS12-381 Groth16 MPC implementation for the proof-tool ceremony. They change
how independent work is scheduled; they do not change the circuit, proof
statement, elliptic-curve formulas, transcript layout, or verification rules.

The implementation is carried as reviewed patches against the repository's
pinned gnark v0.15.0 dependency:

- `experiments/wasm-prover/patches/mpc-phase1-parallel-update.patch`
- `experiments/wasm-prover/patches/mpc-phase1-parallel-codec.patch`
- `experiments/wasm-prover/patches/mpc-phase2-parallel-initialize.patch`

`scripts/bootstrap-vendor.sh` applies these patches when reconstructing the
gitignored `vendor/` tree. Vendor drift checks, release metadata, and SBOM
generation include all three patches.

## Results Summary

Controlled benchmarks were run on a 16-vCPU AMD EPYC host. The benchmark
fixtures use smaller domains than the complete ceremony, so these figures are
component measurements rather than end-to-end K=21 predictions.

| Hot path | Serial median | Parallel median | Speedup |
|---|---:|---:|---:|
| Phase 1 point update | 574 ms | 50.8 ms | 11.3× |
| Phase 1 encoding | 8.01 ms | 1.79 ms | 4.5× |
| Phase 1 decoding | 1.33 s | 151 ms | 8.9× |
| Phase 2 initialization | 9.97 s | 1.14 s | 8.7× |

The first result from the exact K=21 comparison rehearsal is:

| Exact K=21 stage | Previous run | Optimized run | Speedup |
|---|---:|---:|---:|
| Ceremony initialization | 12m16s | 1m34.76s | 7.8× |

The optimized initialization averaged 954% CPU according to GNU `time`, which
means it used about 9.54 CPU cores concurrently. It reached a peak resident set
size of approximately 3.38 GiB.

## 1. Parallel Phase 1 Point Updates

Each Phase 1 contribution updates millions of SRS points using fresh secret
scalars tau-prime, alpha-prime, and beta-prime. At index `i`, the work is
conceptually:

```text
Tau[i]      = Tau[i]      * tau-prime^i
AlphaTau[i] = AlphaTau[i] * alpha-prime * tau-prime^i
BetaTau[i]  = BetaTau[i]  * beta-prime  * tau-prime^i
```

### Previous behavior

One thread walked every index in sequence. It maintained one running power of
tau-prime and performed all G1 and G2 scalar multiplications serially.

### Parallel behavior

The updated implementation divides the arrays into disjoint ranges. Each
worker:

1. Computes `tau-prime^start` for the first index in its range.
2. Updates only the points in that range.
3. Advances its own local power of tau-prime after each point.

The expensive first range, which updates G1 Tau, G2 Tau, AlphaTau, and
BetaTau, is scheduled separately from the lighter G1-Tau-only tail. This
prevents the lighter tail from distorting load balancing for the four-operation
range.

```text
worker 0: [start 0 ................................ end 0)
worker 1:                         [start 1 ........ end 1)
worker 2:                                            [start 2 ... end 2)
```

### Correctness and race safety

- Worker ranges never overlap.
- Each worker owns its field elements and `big.Int` temporaries.
- Every index receives the same scalar as in the original serial loop.
- Alpha, beta, and the index-zero values retain their original handling.
- Equivalence tests compare the complete parallel SRS with the retained serial
  reference implementation.
- The Go race detector passes for the patched package.

## 2. Parallel Phase 1 Encoding and Decoding

An exact K=21 Phase 1 artifact is approximately 576 MiB and contains millions
of compressed G1 and G2 points.

### Previous behavior

Gnark constructed a large `[]any` containing an individual reference to every
point. Its generic encoder or decoder then processed those references one at a
time. Point decompression, curve checks, and subgroup checks therefore ran
serially.

### Parallel behavior

The new codec processes bounded chunks of 4,096 points.

Encoding:

```text
compress each point concurrently into its fixed byte offset
                              |
                              v
write the completed chunk in canonical point order
```

Decoding:

```text
read one fixed-width canonical chunk in point order
                              |
                              v
decode and validate each point concurrently
```

Chunks themselves are always read and written sequentially, so scheduling
cannot reorder artifact bytes.

### Wire format and validation

The encoded layout remains:

```text
N
G2 Beta
G1 Tau[1:]
G2 Tau[1:]
G1 BetaTau
G1 AlphaTau
```

Every decoded point still undergoes:

- canonical field-element decoding;
- curve membership validation;
- subgroup validation; and
- deterministic error selection in point order.

The new reader consumes fixed compressed widths and therefore rejects
uncompressed encodings that gnark's generic decoder previously could consume.
This is intentional for proof-tool's strict canonical-artifact boundary, but it
is a behavior change in the patched gnark `SrsCommons.ReadFrom` method and must
remain explicitly documented and tested.

Temporary codec memory is bounded by one chunk rather than scaling with the
number of SRS point references.

## 3. Parallel Phase 2 Initialization

Phase 2 derives circuit-specific Groth16 parameters from the sealed Phase 1 SRS
and the compiled R1CS. The optimization covers three areas.

### 3.1 Lagrange group FFTs

Initialization computes four large group transforms:

- Tau in G1;
- Tau in G2;
- AlphaTau in G1; and
- BetaTau in G1.

Gnark's previous recursive FFT split its two recursive halves across workers,
but each recursion node first completed a large butterfly pass serially. The
largest top-level pass therefore delayed all recursive parallelism.

The new implementation parallelizes the butterfly pass itself under a fixed
CPU budget:

```text
stage 0:  1 branch  x 16 workers
stage 1:  2 branches x 8 workers
stage 2:  4 branches x 4 workers
stage 3:  8 branches x 2 workers
stage 4: 16 branches x 1 worker
```

Each butterfly operates on a distinct pair of points. No two workers write the
same point during a stage, and the total intended concurrency remains bounded
by the selected worker budget.

### 3.2 Constraint accumulation

Each R1CS constraint contributes to A, B, and C evaluations associated with
particular wires. Parallelizing constraints directly would allow multiple
workers to mutate the same wire.

The implementation instead:

1. Reads constraints sequentially in bounded batches of 16,384.
2. Assigns each wire to exactly one worker using `wireID % workerCount`.
3. Queues left, right, and output terms for the owning worker.
4. Processes those queues concurrently.
5. Completes the batch before reading the next one.

Terms for a particular wire and expression side retain their original order.
Because a wire has exactly one owner, no locks are required and workers cannot
race on the output arrays.

### 3.3 Independent point loops

Two additional loops operate on independent output points and are now
parallel:

- construction of the Z polynomial points; and
- computation of `beta*A + alpha*B + C` for every wire.

## Security and Determinism Invariants

The optimizations are designed around the following invariants:

- Transcript and SRS bytes must not depend on goroutine scheduling.
- Workers may read shared immutable data but must own every point they mutate.
- Point decoding must retain canonical, curve, and subgroup validation.
- Additional memory must remain bounded at K=21.
- The pinned gnark version and all local patches must be represented in build
  provenance and SBOM evidence.
- Serial and parallel implementations must produce byte-identical outputs for
  deterministic fixtures.

Focused equivalence and negative tests, the race detector, ceremony integration
tests, and vendor regeneration/drift checks pass.

The equivalence fixtures use deterministic, distinct curve points. The Phase 2
test compares both one- and four-worker execution with a retained copy of
gnark v0.15.0's serial initialization algorithm, including its serial group
FFTs. It also asserts that the fixture's inverse FFT is dense, preventing a
constant-vector delta from making most accumulation operations no-ops. The
codec test crosses the 4,096-point chunk boundary with a different point at
every serialized position, and a negative test records the intentional
rejection of otherwise valid uncompressed Phase 1 points.

## Remaining Review Follow-up

Execute FFT butterfly loops directly when a recursion node has only one
assigned task, avoiding unnecessary one-worker goroutine creation. This is a
small scheduling cleanup rather than a correctness requirement.

The full exact K=21 comparison rehearsal remains the final performance and
coherence check. Its ceremony binary is pinned independently by SHA-256, and
its measurements record wall time, CPU time, peak memory, filesystem activity,
and exact command outputs for every stage.
