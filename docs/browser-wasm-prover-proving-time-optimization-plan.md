# Reduce Browser WASM Proving Time Below the Current 546s Plateau

This ExecPlan is a living document. The sections `Progress`, `Surprises &
Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to
date as work proceeds.

No `PLANS.md` file exists in this repository or its parent directories as of
2026-07-08. This document follows the same ExecPlan conventions as
`docs/browser-wasm-prover-experiment-plan.md`, which produced the experiment
this plan optimizes.

## Purpose / Big Picture

The browser WASM prover in `experiments/wasm-prover/` generates a real
destination-bound ownership proof that verifies against the pinned VK, but it
takes about 9 minutes. The first optimization track
(`experiments/wasm-prover/optimization-backlog.md`) has been executed through
its transport and tuning items and has plateaued: every measured configuration
since over-sharding landed within noise of 546-557 seconds, and the two
highest-hoped transport changes (raw PK range transport, scalar encoding cache)
produced no measurable win because per-shard trace data now proves transport
was never the bottleneck.

This plan targets what the traces show actually costs time now:

1. Redundant per-point subgroup checks inside the worker MSM kernel, paid on
   every one of the ~19 million proving-key points, for bytes that are already
   hash-pinned and that the main instance deliberately decodes *without*
   subgroup checks.
2. About 35 seconds of main-thread-only work (`computeH`, solver residue,
   commitment prefetch) that runs while all eight workers sit idle.
3. A worker pool capped at 8 by `defaultWorkerCap` on hosts with 16-24
   available threads.
4. Commitment-key vectors (385 MiB) resident in the main heap from before the
   solver until after PoK, pinning the heap near `GOMEMLIMIT` and blocking
   stage overlap.

After this plan, a browser proof on the benchmark host should complete in
roughly 3-5 minutes instead of 9, with main-instance peak heap no higher than
today's 2.80 GiB (and likely lower), and with every existing correctness,
pinning, and tamper guarantee intact. Each optimization is gated by a
measurement, so if an estimate is wrong the plan says what to do instead.

## Current Baseline

Best verified run: `experiments/wasm-prover/output/p6-gogc50-mem3000-w8-s32-rf2.json`
(that directory is gitignored; regenerate traces when comparing branches).

```text
engine:                  streampk-sharded-groth16
worker_count:            8
shard_count:             32
range_fetch_concurrency: 2
GOGC:                    50
GOMEMLIMIT:              3000MiB
wall_seconds:            550.36
prove_ms:                546308
peak_heap_gib:           2.7996   (heap_sys pinned at 95.5% of GOMEMLIMIT
                                   from computeH onward)
verified_locally:        true
```

Stage timings inside `prove` for that run (from matched start/end trace
events):

| Stage | Seconds | Runs on |
| --- | ---: | --- |
| open-keys #2/#3 (commitment prefetch, 385 MB) | 2.55 | main thread, serial |
| solver excluding in-solver MSM | ~4.0 | main thread |
| commitment Basis MSM (inside solver) | 45.16 | workers |
| commitment BasisExpSigma MSM (PoK) | 45.27 | workers |
| computeH / FFT | 30.62 | main thread only |
| G2B | 100.54 | workers |
| A | 92.72 | workers |
| B | 64.91 | workers |
| Z | 106.98 | workers |
| K | 53.27 | workers |

Worker-bound MSM stages total ~508.9s (93% of prove time). Main-thread-only
work totals ~38s.

Per-shard trace facts that drive this plan (all from the same run):

- Workers are fully saturated within each MSM stage: `queue_wait_ms` for waves
  2-4 lands on near-exact integer multiples of one wave's compute time, and
  stage wall time ≈ 4 × per-shard compute (32 shards / 8 workers = 4 waves).
  There is no idle-worker problem *within* a stage.
- Transport is noise: median `marshal_ms` 27-61 per shard, `sab_copy_ms`
  1.7-13, `fetch_ms` 40-335, versus 11,000-27,600 of `worker_compute_ms`.
  Combined transport overhead is under 0.5%.
- Stop-the-world GC pause across the whole 550s run is ~3.85 ms. GC knobs are
  not where time is.
- Per-point worker cost is nearly constant across very different shard sizes:
  Basis 178 µs/pt at 62.7k points, A 186 µs/pt at 118k, B 206 µs/pt at 79.3k,
  Z 201 µs/pt at 131k, K 210 µs/pt at 61.8k (G1); G2B 329 µs/pt (G2). A
  bucket-method MSM's per-point cost should fall as shard size grows (larger
  window `c`); a flat per-point cost is the signature of a large fixed
  per-point term — decode plus subgroup check — dominating the kernel.

Already tried, measured, and now explicitly rejected as time levers (all in
`experiments/wasm-prover/output/`):

| Attempt | Case | Result vs 546.6s control |
| --- | --- | ---: |
| Raw PK range transport (backlog P1) | `p1-raw-w8-s32-rf2` | 557.0s, no win |
| Scalar encoding cache (backlog P1) | `p4-scalar-cache-w8-s32-rf2` | 556.9s, no win |
| computeH precomputed domain (backlog P2) | `p6-computeh-precompute-w8-s32-rf2` | 587.5s, worse |
| GOGC/GOMEMLIMIT sweep (backlog P2) | `p6-gogc*` | 546.3-549.1s, noise |
| Worker/shard/rf matrix at w=8 | `p0-*` | 546.6-583.1s; s32/rf2 best |

## Guardrails

Every optimization in this plan must preserve:

- Proof verifies against the current pinned VK
  (`blake2b256:6057da91...172d430a` per the staged manifest).
- Backend/Cardano proof artifact shape (`groth16-bls12-381-bsb22`) unchanged.
- BSB22 commitment semantics and artifact shape unchanged. Browser proofs must
  still verify against the pinned VK, retain the `groth16-bls12-381-bsb22`
  path, and reject tampering. Literal byte-equality to a separate stock proof
  is not a valid gate because stock committed proving samples fresh randomness
  and can produce different commitment bytes for the same witness; see
  Surprises & Discoveries and Decision Log.
- Tamper checks still fail (`node experiments/wasm-prover/scripts/verify-tamper.mjs`).
- No seed phrase, master XPrv, path metadata, or witness data leaves the local
  WASM/browser boundary.
- No unpinned artifact, worker URL, PK chunk, CCS, VK, or index accepted.
- Main-instance peak heap does not exceed the current 2.80 GiB; total browser
  RSS growth (extra worker instances) is measured and capped explicitly in O3.
- Circuit semantics and circuit size unchanged.
- Every comparison uses the guarded benchmark protocol: paired repeats via
  `scripts/guarded-browser-benchmark.mjs`, same `--cpu-list`, compare median
  `prove_ms` only from summaries with `contaminated: false`, before/after
  traces recorded in `experiments/wasm-prover/output/`.

Mandatory test gates for any kernel or ProveStream change:

```sh
go test ./experiments/wasm-prover/...
GOROOT="$(go env GOROOT)" N=2000 WORKERS=4 node experiments/wasm-prover/web/node-msm-check/run.mjs   # bit-exact
GOROOT="$(go env GOROOT)" node experiments/wasm-prover/web/node-smoke.mjs
node experiments/wasm-prover/scripts/verify-tamper.mjs
```

## Progress

- [x] M1: Kernel decode/MultiExp split instrumentation landed and one guarded
      run captured with the split fields.
- [x] O1: Pinned-input fast decode (no per-point subgroup check) in the worker
      kernel, behind a request flag, benchmarked and verified.
- [x] O2: computeH and scalar prep overlapped with worker MSM stages,
      benchmarked and verified.
- [ ] O3: Worker-count matrix at w=8/12/16 with per-worker memory telemetry;
      new default chosen.
- [x] O4: Commitment Basis/BasisExpSigma routed through the section plan;
      385 MB prefetch removed; indexed-section and native verify gate passing.
- [ ] O5: Worker heap/scalar-density telemetry landed; wave-inflation cause
      identified; fix applied if it is a real tax.
- [ ] O6 (conditional): Cross-stage shard queue, only if post-O3 traces show
      stage-tail idle above 10s total.
- [ ] O7: Final re-sweep (w/s/rf × GOGC/GOMEMLIMIT) on the winning kernel;
      three paired repeats; backlog and README updated with the new baseline.

## Ranked Optimizations

### O1 (P0): Stop subgroup-checking pinned proving-key points in the worker kernel

Problem and evidence:

The worker kernel decodes every shard's points with
`gnark-crypto`'s `SetBytes`:

```text
internal/msmengine/serialize.go:64   pts[i].SetBytes(...)  (G1)
internal/msmengine/serialize.go:79   pts[i].SetBytes(...)  (G2)
```

`SetBytes` calls `setBytes(buf, true)` — subgroup check enabled
(`vendor/github.com/consensys/gnark-crypto/ecc/bls12-381/marshal.go:891-895`,
check at `:944` for G1, `:1219` for G2). `IsInSubGroup` costs on the order of
an endomorphism-accelerated scalar multiplication per point — many tens of
point operations, versus ~20 effective bucket additions per point for the MSM
itself. Meanwhile the main instance decodes the *same* pinned bytes with
`curve.NoSubgroupChecks()`
(`internal/streampk/keysource.go:294,309`), and the
serialization module's own header comment says "inputs come from the trusted
proving key" (`msmengine/serialize.go:22-23`). The near-constant per-point
worker cost across shard sizes (see Current Baseline) independently points at
a dominant fixed per-point decode term.

Every MSM path pays this: the SAB path (`sharded_js.go` MSMG1/MSMG2 and the
ranged variants) ships marshaled points that the kernel re-decodes, and the
worker-owned-fetch section path (`worker.js` `runSectionRange` →
`__msmengineShardG1/G2` → `shardG1Bytes`/`shardG2Bytes`,
`msmengine/serialize.go:135-175`) decodes raw section bytes the same way.
Roughly 19.0M points per proof are affected.

Why skipping the check is sound here: worker inputs are authenticated before
decode. On the section path, `worker.js` `fetchVerifiedChunk` verifies each
chunk's pinned sha256/blake2b256 against the section plan before use
(`web/worker.js:65-85`); the plan itself comes from the pinned index/manifest.
On the SAB path, the bytes were produced by the main instance from the same
pinned key source. The subgroup property is a property of the ceremony-
produced proving key, which is fixed by those digests. The check is therefore
redundant per-proof work, not a live defense. (A malicious PK would already be
rejected by digest pinning; a PK that passes pinning but contains out-of-
subgroup points would produce a proof that fails verification against the
pinned VK — it cannot make a bad proof verify.)

Change:

1. Instrumentation first (M1). In `shardG1Bytes`/`shardG2Bytes`
   (`msmengine/serialize.go:135-175`), time the decode loop and the
   `MultiExp` separately and return both durations; plumb them through the
   kernel reply (`RegisterWorkerKernel` in `msmengine/sharded_js.go:75`) and
   `worker.js` (`timings.decode_ms` is currently hardcoded to 0 at
   `web/worker.js:132`) into the per-shard trace fields, alongside the
   existing `worker_compute_ms`. Run one guarded w8/s32/rf2 benchmark. This
   yields the exact decode share and makes O1's win measurable in isolation.
2. Add unchecked decode paths in `msmengine/serialize.go`:

   ```go
   // unmarshalG1PointsPinned decodes points whose bytes are covered by a
   // pinned digest (PK section plan chunk hashes or main-instance pinned
   // key source). It validates on-curve but skips the per-point subgroup
   // check, matching streampk's NoSubgroupChecks decode of the same bytes.
   func unmarshalG1PointsPinned(buf []byte) ([]bls12381.G1Affine, error)
   ```

   Implement with `curve.NewDecoder(r, curve.NoSubgroupChecks())` over the
   buffer using the same 4-byte count-prefix technique `streampk` uses
   (`internal/streampk/keysource.go:286-314`), or by decoding X/Y coordinates
   directly and checking `IsOnCurve`. Keep the on-curve check: it is a few
   field multiplications per point and catches corruption classes digests do
   not (bugs in slicing/offsets rather than tampering).
3. Gate it: extend the worker message and `tuningRequest`
   (`cmd/wasm-prover/main_js.go:75-81`) with
   `pinned_decode: true|false` (default true once verified; the flag exists so
   any investigation can flip back to checked decode without rebuilding).
   Thread the flag through `sharded_js.go` shard dispatch and `worker.js`.
4. The kernel test-vector generator (`cmd/msmworker/main.go`) and the Node
   bit-exact harness continue to use valid subgroup points, so bit-exactness
   is unaffected.

Expected impact:

Gated on M1. If decode-with-subgroup-check is 40-65% of `worker_compute_ms`
(consistent with the flat per-point cost), this removes 200-330s of the ~509s
of worker-bound stage time. Even at a conservative 25% share it saves ~125s.
This is the largest single candidate in the plan.

Memory impact: negative (slightly fewer allocations if the decoder writes into
a reusable slice; see O5). No main-heap change.

Correctness risk: low for algebra (points are unchanged; only a redundant
membership test is skipped), medium for process — the security argument must
be recorded in the Decision Log and the flag must fail closed (any worker
input that is not digest-authenticated must keep checked decode; today no such
path exists, and none may be added without revisiting this).

Evidence needed:

- M1 trace showing decode_ms/multiexp_ms split before the change, and the
  same fields after showing decode_ms collapsed.
- Native test: pinned decode of a section byte-range equals `SetBytes` decode
  point-for-point (and rejects off-curve bytes).
- Node worker bit-exact check passes for G1 and G2.
- Full browser proof verifies; tamper checks fail; one deliberately corrupted
  chunk (bad digest) is still rejected before decode.
- Guarded paired runs: `o1-pinned-decode-w8-s32-rf2` vs control, 3 repeats.

### O2 (P0): Overlap main-thread computeH and scalar prep with worker MSM stages

Problem and evidence:

`ProveStream` (vendored
`vendor/github.com/consensys/gnark/backend/groth16/bls12-381/prove.go`) is
strictly serial by design — its doc comment says the MSMs "run strictly
serially (on single-threaded wasm the concurrency buys no speed but multiplies
peak memory)". That rationale is only half right now: the *worker-bound* MSMs
should indeed stay serial with respect to each other (workers are saturated;
overlapping them buys nothing), but `computeH` (30.6s) and the solver-side
scalar prep run on the main thread while all workers idle. The main thread is
otherwise nearly free during worker MSMs (<0.5% transport work), and Go's
js/wasm scheduler interleaves goroutines whenever the dispatching goroutine
parks on worker replies — the sharded engine already relies on exactly this
(one goroutine per shard, `sharded_js.go:553-589`).

Change (in the vendored `prove.go`, mirrored into
`experiments/wasm-prover/patches/prove-stream.patch`):

1. Run `computeH` concurrently with the BasisExpSigma/PoK MSM stage. Today the
   order is: solver (ends with Basis MSM) → PoK MSM (~45s, workers) →
   computeH (~30.6s, main). Change to: after the solver returns, launch

   ```go
   hCh := make(chan []fr.Element, 1)
   go func() { hCh <- computeH(solution.A, solution.B, solution.C, domain) }()
   ```

   then run the PoK MSM + challenge/Fold chain as today, and receive from
   `hCh` before the Z MSM (its only consumer). Dependencies allow this:
   computeH needs only `solution.A/B/C`; the PoK chain needs only
   `privateCommittedValues` and the commitment bytes. The
   challenge → `Fold` ordering (currently `prove.go:452-475`) is untouched.
2. Move the `solution.A/B/C = nil` release and the first `runtime.GC()`
   (currently `prove.go:498-512`) into the computeH goroutine's completion
   path, and re-derive the second `runtime.GC()` point (currently `:571`) so
   it still runs after both the PoK stage and computeH have finished.
3. Overlap scalar prep with the G2B stage: today `wireValuesA`/`wireValuesB`
   filtering and `filterHeap` for K (`prove.go:516-541`) run serially before
   the big MSMs. Build `wireValuesB` first, dispatch G2B, then build
   `wireValuesA` and `_wireValues` in the dispatching goroutine's shadow while
   G2B's workers run. This saves a few seconds; it rides the same mechanism.
4. Trace schema: overlapped stages break the strict start/end nesting the
   trace assumes. Add an `overlapped_with` field on the computeH stage events
   rather than reordering events, so `tools/rank-traces.mjs` keeps working.
5. Progress reporting: the weighted `prove NN.N%` denominator
   (`streampk.ProveMSMScalarTotals`, `internal/streampk/keysource.go:225-265`)
   is unchanged; computeH contributes no scalars, so progress stays monotonic.

Memory constraint (why O4 is a companion): overlapping computeH with PoK keeps
`solution.A/B/C` (~384 MiB) alive while `BasisExpSigma` (~193 MiB) is still
resident. At today's layout that would push past the 3000 MiB heap_sys
plateau. O4 removes the 385 MiB commitment residency, which more than covers
it. Land O4 first or together, and verify peak_heap in the trace.

Expected impact: 25-32s (computeH fully hidden behind the 45s PoK stage, minus
scheduler interleaving losses; note after O1 the PoK stage shrinks — if it
drops below ~30s, the hidden fraction shrinks accordingly; the overlap is
still free).

Correctness risk: low/medium. The algebra is order-independent (Groth16 stage
dependencies: challenge chain ordering, `h` before Z, Krs additions last —
all preserved). The risk is memory-timing regressions; the before/after trace
peak_heap comparison is the gate.

Evidence needed: full proof verifies; tamper checks fail; peak_heap_gib ≤
2.80; guarded paired runs `o2-overlap-w8-s32-rf2` vs control.

### O3 (P1): Raise the worker count past the hardcoded cap of 8

Problem and evidence:

`defaultWorkerCap = 8` (`msmengine/sharded_js.go:347`) bounds
`workerCount()` regardless of `hardwareConcurrency` (`:476-496`). The
benchmark host exposes 24 threads and pins runs to 16 CPUs (`--cpu-list
0-15`), yet every recorded run uses 8 workers; the backlog's planned
w=4/8/12/16 slice was never run above 8. Stage wall time is `waves ×
per-shard compute` with saturated workers, so worker count is the only lever
that divides the ~509s of worker-bound time (post-O1, whatever remains).

The override path already exists:
`NewShardedWithOptions` honors `opts.WorkerCount > defaultWorkerCap`
(`sharded_js.go:406-409`), and the request plumbing passes `worker_count`
through (`cmd/wasm-prover/main_js.go:559-575`). So this is a benchmarking and
defaults task plus telemetry, not new machinery — but verify the `cap` wiring
for 1-8 (the `opts.WorkerCount ≤ 8` case flows through `workerCount(cap)`;
confirm the selector passes the requested count as `cap`, in
`msmengine/selector_js.go`).

Change:

1. Add per-worker memory telemetry first: in the kernel reply, include
   `runtime.ReadMemStats` heap_sys/heap_alloc of the worker instance; surface
   min/median/max worker heap in the trace. Without this, the RAM guardrail
   cannot be enforced.
2. Run the matrix: `w=8/12/16 × s=2w/4w × rf=2/4`, guarded, paired, 3 repeats
   of the best two cells. Example:

   ```sh
   node experiments/wasm-prover/scripts/guarded-browser-benchmark.mjs \
     --case o3-w16-s32-rf2 --workers 16 --shards 32 --rf 2 --cpu-list 0-15
   ```

3. Pick the new default as the smallest worker count within 5% of the best
   median `prove_ms` (workers are whole wasm instances; do not buy 2% with 8
   more instances). Update `defaultWorkerCap` or the harness default tuning
   (`web/browser-prover.js`, `scripts/playwright-benchmark-runner.js:9`)
   accordingly, keeping a `min(hardwareConcurrency - 1, chosen)` clamp for
   real users' machines.

Expected impact: ideal scaling w8→w16 halves worker-bound time; realistically
(memory bandwidth, browser scheduling, hyperthread sharing) expect 30-45%
off the worker-bound remainder. On the post-O1 timeline that is roughly
60-120s; on the current kernel it would be 150-220s. Interacts
multiplicatively with O1 — which is why O1 lands first and O3's matrix runs on
the O1 kernel.

Memory impact: this is the one item that increases total browser RSS: each
worker is an `msmworker.wasm` instance. The telemetry from step 1 gates it —
budget: additional workers' combined heap_sys must stay under 1.5 GiB beyond
the w8 configuration, and per-shard point slices shrink as shard count rises
(s=2w/4w), which caps per-worker working set. Main-instance heap is
unaffected. If w16 breaches the budget, w12 is the fallback.

Correctness risk: none beyond the existing demux path (already proven for
shards > workers by the p0 over-sharding runs).

Evidence needed: matrix medians; worker heap telemetry; full verify + tamper
gates on the chosen configuration.

### O4 (P1): Route commitment Basis/BasisExpSigma through the section plan; drop the 385 MB prefetch

Problem and evidence:

`ProveStream` loads both commitment vectors whole into the main heap before
the solver (`prove.go:378-394`; trace stages open-keys #2/#3, 2.55s serial,
+385 MB), holds them through solver + PoK, then frees them
(`prove.go:485-488`). The five big MSMs already avoid exactly this via
`msmG1SectionOrRange` → `MSMG1Section` worker-owned fetch (`prove.go:649-669`,
`sharded_js.go:922-1007`). The Basis/BasisExpSigma sections exist in the PK
index (the pkindex run recorded sections `A,B,Z,K,G2B,Basis,BasisExpSigma`),
so the machinery is already there.

Change:

1. Extend the PK section plan builder to include `Basis`/`BasisExpSigma`
   (and `_i` variants via `commitmentSectionName`) so `worker.js`
   `fetchSectionPointBytes` can serve them; the chunk digests already cover
   the whole PK file, so no new pinning surface.
2. In `ProveStream`, replace the whole-vector loads with section MSM calls:
   the in-solver Basis MSM (`prove.go:416`) and PoK MSM (`prove.go:460`)
   become `msmG1SectionOrRange(...)` with the commitment section name and the
   full range. Keep the CPU-engine fallback path loading whole vectors as
   today (`WithFallback` correctness path).
3. Regression gate: the indexed section bytes for `Basis` and `BasisExpSigma`
   must equal the typed proving key sections exactly; a stream proof using the
   section path must verify against the stock VK; the BSB22 commitment
   challenge must be present and well-formed. A literal stock-vs-stream proof
   byte comparison is not used because stock committed proving samples fresh
   randomness and is not byte-stable across runs.

Expected impact on time: small directly (~2.5s prefetch removed; the MSM
compute itself is unchanged and O1 covers the decode cost on either path).
The real value is memory: main peak drops by ~385 MiB in the pre-computeH
window, which is what makes O2 safe and gives O7's re-sweep room to consider
a lower GOMEMLIMIT for reliability.

Correctness risk: medium — this touches the BSB22 challenge path. The
regression test in step 3 is the gate, plus full verify + tamper.

Evidence needed: indexed-section equality/native verify test; trace shows
open-keys #2/#3 gone and commitment section shard fields present; peak_heap
reduced; verify + tamper.

### O5 (P2): Explain, then eliminate, the intra-stage compute inflation

Problem and evidence:

Within G2B, A, and B, later waves cost systematically more than the first
wave (G2B 18.7s → 27.6s, +47%; A +19%; B +26%), while Z, K, and both
commitment stages are flat (±3%). Two candidate mechanisms, with opposite
fixes:

- Worker-heap growth: workers run with default GC settings — `worker.js`
  constructs `new Go()` with no env (`web/worker.js:28`), so GOGC=100 and no
  GOMEMLIMIT — and the kernel allocates fresh point/scalar slices per shard
  (`serialize.go:62,77,91`), so garbage accumulates and Go wasm heaps never
  shrink. Predicts inflation growing across the *whole run*, which Z (late,
  flat) contradicts — unless stage working-set sizes reset the pattern.
- Scalar density: `wireValuesA/B` contain many zero/filtered scalars whose
  distribution varies along the section, so equal point-count shards are not
  equal work. Predicts stage-specific, position-correlated variation (A/B/G2B
  use filtered wire values; Z uses the dense `h` vector and is flat — fits).

Change:

1. Telemetry (rides O3 step 1): per-shard worker heap stats plus a
   `nonzero_scalars` count computed during scalar unmarshal.
2. If density: no time is actually being lost to waste — the "inflation" is
   real work unevenly placed, and the fix (only if the tail matters after O3)
   is density-weighted shard boundaries: partition by cumulative nonzero
   scalar count instead of point count. `partitionRanges`
   (`msmengine/partition.go`) grows a weighted variant; the main instance
   knows the scalars before dispatch, so weights are free to compute.
3. If heap: set `go.env = { GOGC: "200", GOMEMLIMIT: "512MiB" }` in
   `worker.js` (tune via one matrix column), reuse decode buffers across
   shards in the kernel (persistent slices sized to the stage's max shard),
   and optionally `runtime.GC()` after posting each reply.

Expected impact: if density, up to ~15-25s reclaimed at the stage tails via
weighted sharding (only the last wave's imbalance is pure loss); if heap,
20-50s across the inflating stages. Honest range: 10-50s, decided by
telemetry.

Correctness risk: low. Weighted partitioning must still produce a bit-exact
combine (existing partition/combine tests extend naturally).

### O6 (P2, conditional): Cross-stage shard queue

Only if post-O1/O3 traces show more than ~10s of cumulative worker idle at
stage tails (fewer waves per stage make quantization loss proportionally
worse: at w16/s32 each stage is 2 waves, so a half-empty last wave wastes 25%
of a stage). Replace per-stage dispatch barriers with a single work queue over
the independent MSMs — A, B, G2B, K shards enqueue as soon as their scalars
exist; Z shards enqueue when computeH delivers `h`; the PoK challenge chain
keeps its ordering. The per-stage partial combine already keys results by
shard index, so combining per-MSM results from an interleaved stream is
bookkeeping, not new math. Expected 10-30s; medium complexity; keep behind a
tuning flag for A/B benchmarking.

### O7 (P1): Re-sweep tuning on the winning kernel and lock the new baseline

Every knob optimum shifts after O1/O3 (shorter compute changes the
GC-per-stage picture, worker count changes shard sizes). Rerun:

```text
w = {chosen-4, chosen, chosen+4} × s = {2w, 4w} × rf = {2, 4}
GOGC = {50, 100} × GOMEMLIMIT = {2600, 3000} MiB   (main instance)
```

Three paired repeats of the two best cells, `--preflight-only` checks before
long runs, medians from uncontaminated summaries only. Then update
`optimization-backlog.md` (mark executed items with measured outcomes),
`README.md` baseline text, and the default tuning in `web/browser-prover.js`
and `scripts/guarded-browser-benchmark.mjs`.

## Explicitly Deprioritized

- WebGPU / non-Go MSM kernel: still the largest theoretical lever (the
  backlog's 150-350s estimate), still deferred — O1+O3 attack the same
  seconds at a fraction of the correctness risk, and their outcome changes
  the Amdahl math that would justify WebGPU. Revisit after O7 locks the new
  baseline.
- Raw PK transport, scalar encoding cache, computeH precomputed domain,
  GC knob sweeps: tried, measured, no win (table in Current Baseline). Do not
  re-attempt without new trace evidence.
- CCS compression, hosted CDN chunk caching: real for hosted cold starts,
  irrelevant to the 546s local proving plateau this plan targets.
- Circuit size reduction: out of scope for this track, unchanged.

## Projected End State

| Step | Pessimistic | Optimistic |
| --- | ---: | ---: |
| Baseline | 546s | 546s |
| + O1 (decode share 25% / 60%) | −125s → 421s | −300s → 246s |
| + O2 (computeH hidden) | −20s → 401s | −30s → 216s |
| + O3 (30% / 45% off worker remainder) | −95s → ~306s | −65s → ~151s |
| + O5/O6/O7 | −10s → ~296s | −35s → ~116s |

A verified browser proof in roughly 2-5 minutes, main heap at or below
today's peak, all pins and tamper behavior intact. The M1/O3 telemetry
decides where in that range reality lands, and each step's guarded paired
runs make the attribution durable.

## Execution Order

1. M1 kernel decode/MultiExp split telemetry (+ worker heap and nonzero-scalar
   fields from O3.1/O5.1 in the same schema bump — one instrumentation PR).
2. O1 pinned decode, benchmarked on w8/s32/rf2 against control.
3. O4 commitment section MSMs (unblocks O2's memory budget).
4. O2 computeH/scalar-prep overlap.
5. O3 worker matrix on the new kernel; choose default.
6. O5 fix per telemetry verdict; O6 only if tail idle justifies it.
7. O7 final sweep; update backlog, README, defaults; record Outcomes.

## Surprises & Discoveries

- Observation: The worker kernel subgroup-checks every PK point while the main
  instance decodes the same bytes with `NoSubgroupChecks()`.
  Evidence: `msmengine/serialize.go:64,79` (`SetBytes`) versus
  `internal/streampk/keysource.go:294,309`; vendored gnark-crypto
  `marshal.go:891-895,944,1219` confirms `SetBytes` defaults the check on.
- Observation: Per-point worker cost is nearly flat across shard sizes
  (178-210 µs/pt for G1 at 62k-131k points/shard), which a bucket-method MSM
  alone would not produce; a fixed per-point decode term dominates.
  Evidence: per-shard `worker_compute_ms` in
  `output/p6-gogc50-mem3000-w8-s32-rf2.json`.
- Observation: Transport was never the bottleneck — marshal + SAB copy +
  fetch are under 0.5% of shard cost, which is why the P1 raw-transport and
  P4 scalar-cache attempts measured as no-ops.
  Evidence: per-shard timing fields in the same trace; `p1-raw-*` and
  `p4-scalar-cache-*` results.
- Observation: Workers are fully saturated within stages (queue waits are
  exact multiples of wave time), so intra-stage scheduling is already
  optimal; only worker count, kernel cost, and stage boundaries remain.
  Evidence: `queue_wait_ms` distributions in the same trace.
- Observation: The main instance runs pinned at 95.5% of GOMEMLIMIT from
  computeH onward, yet total STW GC pause is ~3.85 ms — GC pause is a dead
  end, but headroom for stage overlap is the real memory story.
  Evidence: `heap_sys` trajectory and `gc_pause_delta_ns` fields in the same
  trace.
- Observation: Routing commitment `Basis`/`BasisExpSigma` through worker-owned
  sections exposed a browser-only Go wasm heap bad-pointer crash during
  `r1cs.Solve`. A serial section diagnostic still crashed, so the worker
  callback was not the sole cause. Suspending wasm GC and the wasm memory
  limit only around the solver, then restoring both immediately after, fixed
  the O4 route.
  Evidence: failed guarded/manual traces for
  `o4-o2-section-commitment-w8-s32-rf2-local5`; passing final trace records
  `solver` start field `gc_suspended:true`.
- Observation: A literal stock-proof byte-equality gate is invalid for
  committed Groth16 proofs. A tiny committed-circuit diagnostic produced
  different BSB22 commitment bytes across two stock `groth16.Prove` calls,
  even before introducing the stream section path.
  Evidence: the O4 native gate was changed to exact indexed-section byte
  equality for `Basis`/`BasisExpSigma`, stock-VK verification of the stream
  proof, and a well-formed BSB22 challenge check.
- Observation: After O1 removed the dominant subgroup-check cost, O4/O2
  reduced peak heap substantially but only modestly improved prove time:
  `prove_ms` moved from `114600` to `111461` (2.74% faster) while
  `peak_heap_gib` moved from `2.797119140625` to `2.31561279296875`.
  Evidence: `o1-pinned-decode-w8-s32-rf2.summary.json` versus
  `o4-o2-section-commitment-w8-s32-rf2-local7.summary.json`.

## Decision Log

- Decision: Treat digest-pinned PK bytes as authenticated inputs and skip
  per-point subgroup checks in the worker kernel (O1), keeping on-curve
  checks and a fail-closed flag.
  Rationale: The pins (manifest, index, chunk sha256/blake2b256) fix the
  exact bytes of a ceremony-verified key; the check re-proves a property the
  pins already commit to, at dominant per-point cost. Any future worker input
  that is not digest-authenticated must not use the pinned decode path.
  Date/Author: 2026-07-08 / Claude (plan)
- Decision: Keep worker-bound MSM stages serial with respect to each other;
  overlap only main-thread work (computeH, scalar prep) with worker stages.
  Rationale: Workers are measured-saturated; overlapping worker stages adds
  peak memory for no throughput, which is the same reasoning ProveStream's
  author recorded — the refinement is that main-thread work is exempt.
  Date/Author: 2026-07-08 / Claude (plan)
- Decision: Defer WebGPU again despite the plateau.
  Rationale: O1/O3 target the same seconds with low correctness risk; their
  results change whether WebGPU is worth its verification burden.
  Date/Author: 2026-07-08 / Claude (plan)
- Decision: Gate every estimate on a named measurement (M1, O3 telemetry, O5
  telemetry) rather than committing to savings numbers.
  Rationale: This track already produced three no-op optimizations built on
  plausible but unmeasured assumptions; the per-shard trace work proved the
  cure is instrumentation-first.
  Date/Author: 2026-07-08 / Claude (plan)
- Decision: Keep O4 on the active route and fix the browser-only crash by
  temporarily suspending wasm GC/memory-limit enforcement around `r1cs.Solve`.
  Rationale: O2's memory constraint requires removing commitment-vector
  residency. The crash reproduced even with a serial section path, and the
  final guarded benchmark passed with solver GC suspension recorded in trace;
  GC settings are restored immediately after solver completion.
  Date/Author: 2026-07-08 / Claude (implementation)
- Decision: Replace O4's literal stock-vs-stream byte-equality gate with
  indexed-section byte equality plus stream proof verification and BSB22
  challenge-shape checks.
  Rationale: Stock committed proofs are not byte-stable across independent
  `groth16.Prove` calls because commitment randomness is freshly sampled, so
  that original gate would reject valid unchanged behavior. The replacement
  checks the data-path equivalence that O4 actually changes and keeps the
  pinned-VK/tamper gates for proof validity.
  Date/Author: 2026-07-08 / Claude (implementation)

## Outcomes & Retrospective

M1/O1 results, 2026-07-08:

- M1 valid checked-decode control:
  `experiments/wasm-prover/output/m1-checked-decode-w8-s32-rf2-local2.json`
  (`summary.json` sidecar same stem). Guard: `contaminated=false`; engine:
  `streampk-sharded-groth16`; `prove_ms=558503`;
  `wall_seconds=563.112879872`; `peak_heap_gib=2.794677734375`;
  local verification true.
- M1 invalid earlier control:
  `experiments/wasm-prover/output/m1-checked-decode-w8-s32-rf2.json` verified
  only after fallback to `streampk-cpu-groth16` because the local chunk
  manifest lacked `transport.base_url`; it is not a comparison trace.
- M1 confirmed decode dominance. Aggregate worker timing in the valid control:
  `MSMG1` decode 718590.118 ms / 98.85% of worker time; `MSMG2Section`
  decode 620570.871 ms / 76.49%; `MSMG1Section` decode 2211726.500 ms /
  88.27%.
- O1 pinned-decode result:
  `experiments/wasm-prover/output/o1-pinned-decode-w8-s32-rf2.json`
  (`summary.json` sidecar same stem). Guard: `contaminated=false`; engine:
  `streampk-sharded-groth16`; `prove_ms=114600`;
  `wall_seconds=118.83814016`; `peak_heap_gib=2.797119140625`;
  local verification true.
- O1 improvement versus valid checked control: `-443903 ms` prove time
  (79.48% faster). Decode collapsed to 4127.221 ms / 32.64% for `MSMG1`,
  5311.418 ms / 2.74% for `MSMG2Section`, and 13093.903 ms / 4.28% for
  `MSMG1Section`.
- O1 tamper evidence:
  `node experiments/wasm-prover/scripts/verify-tamper.mjs experiments/wasm-prover/output/o1-pinned-decode-w8-s32-rf2-artifact.json`
  passed; the valid artifact verified and tampered target credential,
  destination address, public input, proof bytes, and `vk_hash` all rejected.

O4/O2 results, 2026-07-08:

- Implementation route: commitment `Basis` and `BasisExpSigma` now use the
  worker-owned `MSMG1Section` path instead of whole-vector prefetch; `computeH`
  starts immediately after solver completion and overlaps
  `BasisExpSigma`/G2B/A/B; scalar prep overlaps G2B; wasm GC/memory-limit
  enforcement is suspended only during `r1cs.Solve` and restored immediately
  after.
- Native O4 gate:
  `go test ./internal/streamprove -run TestProveStreamCommitmentSectionsVerifyWithIndexedKey -count=1 -v`
  passed. The test checks exact indexed-section bytes for `Basis` and
  `BasisExpSigma`, verifies the stream proof against the stock VK, and checks
  the BSB22 challenge shape.
- Final guarded benchmark:
  `experiments/wasm-prover/output/o4-o2-section-commitment-w8-s32-rf2-local7.json`
  (`summary.json` sidecar same stem). Guard: `contaminated=false`;
  `aborted=false`; engine: `streampk-sharded-groth16`;
  `prove_ms=111461`; `wall_seconds=115.89951488`;
  `playwright_wall_seconds=110.988`;
  `peak_heap_gib=2.31561279296875`; local verification true;
  trace events: 281.
- O4 trace evidence: only the initial `open-keys` URL/index stage remains;
  the old commitment whole-vector prefetch stages are gone. Commitment
  section stages record `section:"Basis"` and `section:"BasisExpSigma"`;
  shard operations include `MSMG1Section` count 192 and `MSMG2Section` count
  32.
- O2 trace evidence: `computeH / FFT` starts at 10582 ms and ends at 42909 ms
  with `overlapped_with:"commitment BasisExpSigma MSM,G2B,A,B"`.
  `commitment BasisExpSigma MSM` runs from 10581 ms to 44219 ms, so computeH
  is hidden under worker-bound work. Solver start records
  `gc_suspended:true`.
- Delta versus O1: `-3139 ms` prove time (2.74% faster) and
  `-0.48150634765625 GiB` peak main heap. The primary O4/O2 value on this
  post-O1 kernel is memory headroom; the time win is small because O1 already
  collapsed the commitment MSM duration.
- Correctness gates: `go test ./experiments/wasm-prover/...` passed;
  `GOROOT="$(go env GOROOT)" N=2000 WORKERS=4 node experiments/wasm-prover/web/node-msm-check/run.mjs`
  passed with `bit-exact=true`; tamper verification passed for
  `experiments/wasm-prover/output/o4-o2-section-commitment-w8-s32-rf2-local7-artifact.json`
  (target credential, destination address, public input, proof bytes, and
  wrong `vk_hash` all rejected).
- Remaining stale harness gap:
  `GOROOT="$(go env GOROOT)" node experiments/wasm-prover/web/node-smoke.mjs`
  still fails before the MSM/proof benchmark path because the script sends a
  key-bundle request without `ccs_url`, causing compile fallback and wasm32
  OOM. This is not an O4/O2 proof failure, but the smoke script should be
  repaired before using it as a release gate.
