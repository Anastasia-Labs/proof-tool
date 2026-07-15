# Browser proving efficiency plan — end-user wall clock on the live web-app

Status: **design for review, no code written.** Branch `optimize-browser-7-14-2026`.
Baseline: **v2-opt-r1** (per `docs/browser-proving-asset-hosting.md` — the r8 G1
gate is acceptance evidence only, no longer the comparison baseline). Item 1 of
this branch (the `wasm-opt -O3` post-pass in `scripts/build-wasm-prover.sh`,
~9% smaller modules, small uniform speedup on all Go wasm code) is already
landed. `fc5846f` (precompiled worker modules + windowed chunk prefetch,
clamped 1–4) is also already landed and is assumed present below.

## What the v2-opt-r1 traces say

From `output/remote-browser-matrix-v2-opt-r1/results/`:
warm best `v2-2m-fresh-warm-w16-idle-pf4.json` (41,388 ms), cold best
`v2-2m-hit-cold-w16-idle-pf2.json` (47,612 ms); w16/s16, 2-MiB chunk tier,
gogc=15/gomemlimit=3200MiB, ~0.83 GiB peak heap.

**Warm critical path (sums to the wall clock):**

| segment | span | on critical path? |
| --- | ---: | --- |
| parse → solver → commitments | ~0–6.5 s | yes (solver 6.2 s of it) |
| computeH / FFT (main thread, single core) | 6.6–26.5 s (19.9 s) | **yes** |
| Z MSM (needs H, workers) | 26.5–41.4 s (14.9 s) | **yes** |
| A/B/K/G2B MSMs (workers, dispatched ~6.5 s) | K ends 37.7 s | hidden, barely |

Worker shard telemetry (112 shards): multiexp 323 s summed (~20 s/worker at
w16) — G1 dispatch 187 s, **G2 dispatch 134 s**, section-G1 3 s. Fetch 182 s
summed warm / 259 s cold; hash 13 s; decode 16 s. K's 31.2 s span vs the FFT's
19.9 s means the MSM pool is *nearly* critical — shrink the FFT and the MSMs
immediately bind, and vice versa. **Neither lever alone moves end-user time
much; both together do.** (The r8 traces showed the identical structure at
2× magnitude — the shape is stable across circuit revisions.)

**Transport per proof:** `range_bytes_fetched` 1.41 GiB, used 1.20 GiB —
**15.4% (0.21 GiB) fetched, hashed, and discarded** even at 2-MiB chunks,
because each of 112 shard ranges rounds to chunk boundaries at both ends.
Plus the CCS. The W7 verified cache is in-memory per session — nothing
persists across visits/reloads.

**Live end-users are not the bench box.**
- Bandwidth: 1.41 GiB ≈ 2 min @ 100 Mbps, ~8 min @ 25 Mbps — and without a
  persistent cache every visit is cold. The bench warm/cold delta (6.2 s) is a
  datacenter-link number, not an end-user number.
- Cores: the 8-worker floor lands at 63–81 s on the same matrix; 4-core hosts
  get a worker4 pool. At w4 the 323 s of summed multiexp is ~81 s/worker — on
  weak devices **MSM compute dominates**, not the FFT.

## Impact model (what each lever buys whom)

| lever | 16-core dev box | 4-core laptop | cold proof on real broadband |
| --- | --- | --- | --- |
| A. transport/caching | small | small | **dominant** (minutes) |
| B. parallel/SIMD FFT | **19.9 s → target <5 s** | modest (cores busy with MSM) | modest |
| C. SIMD MSM kernel | Z tail + K span | **dominant compute lever** | modest |
| D. head (solver) | ~6.5 s cap | same | overlaps download |

Rough end-state model, warm w16, B+C landed (FFT→~4 s, MSM×2):
`6.5 + max(4 + Z/2, pool/2) ≈ 17–21 s` (vs 41.4 s today). Cold hosted with A
≈ warm + residual fetch; first-visit proofs become download-bound at ~half
today's bytes once A5 lands.

---

## Workstream A — transport & persistence (no crypto risk, live-user dominant)

A1. **Persistent verified chunk cache** (backlog #4, promoted from "open
question" to priority). Store W7-verified chunks in OPFS (fallback Cache API)
keyed by the signed manifest's chunk digests; re-verify SHA-256/BLAKE2b on
read-back so the fail-closed posture is unchanged (a poisoned cache entry is
just a corrupt chunk → existing fail-closed path). Repeat/retry/reload proofs
skip up to 1.41 GiB — this converts every returning live user from cold to
warm, which on real links is minutes, and makes reload-recovery near-instant.

A2. **Prefetch during the head.** The first ~6.5 s (parse/solver/commitments)
does no PK range traffic; section-G1 shards then stall 67 s summed on fetch
even warm. `fc5846f`'s windowed prefetch parallelizes fetches *within* a
dispatched shard; this item is different — start warming the first sections in
dispatch order into the verified cache as soon as the manifest is
signed-checked, before the solver finishes. Pure scheduling; no new formats.

A3. **Kill the 15.4% over-fetch.** 0.21 GiB/proof is fetched, hashed, and
discarded at shard-range chunk roundings. Options, in order of preference:
align section/shard boundaries to chunk boundaries at planning time (snap
range ends to chunk edges and re-partition remainders to the adjacent shard),
or align section offsets at asset build time.

A4. **CCS transport compression** (backlog #5). Constraint systems compress
well (unlike curve points); zstd at CDN with the manifest pinning *both*
compressed and decoded identities, exactly as the backlog prescribes.

A5. **Compressed-point PK variant, downlink-adaptive** (couples to C). 48-byte
G1 / 96-byte G2 halves PK transfer (~1.4 GiB → ~0.7 GiB) at the cost of a
batch sqrt decompression per point — prohibitive in Go wasm, affordable in the
Rust SIMD kernel (batch-affine + SIMD Montgomery). This is a *tradeoff*, not a
pure win: on fast links decompression costs more than transfer saves. Publish
both chunk tiers (immutable CDN objects, storage is cheap — the bucket already
holds multiple tiers); the client picks per connection from a measured
downlink probe. Requires a new signed manifest section — same signing
pipeline, both variants pinned. Do NOT gate A1–A4 on this; it lands with C
phase 3+.

## Workstream B — computeH/FFT off the single-threaded main path

The 19.9 s FFT is the largest single critical-path item and is untouched by
any MSM work. Go wasm has no threads; the main module is stuck on one core
while 16 workers idle-ish under it. (Note: the *rejected* "FFT domain
precomputation" finding traded heap for time on the same single core —
parallelizing the transform is a different hypothesis.)

- **B1 (preferred): shard the FFT passes + pointwise ops across the existing
  Go worker pool** over SharedArrayBuffers. Radix-split butterfly passes with
  1–2 transpose/barrier rounds; the workers already exist, already speak SAB,
  and stay in Go (no new language on this path). Target: 19.9 s → 3–5 s at
  w16; scales down gracefully on 4-core hosts.
- **B2 (alternative, rides C's toolchain): Rust FFT kernel with SIMD +
  wasm-threads** (rayon over the existing cross-origin-isolated context — SAB
  use means COOP/COEP is already in place). Single module doing the whole
  computeH; fewer barriers, more new surface.

Decision gate: spike B1 first — if transpose traffic over SAB keeps ≥8×
scaling at w16, B1 wins on risk; B2 only if B1's memory traffic disappoints.

Correctness gate either way: **H must be bit-exact**; the W6 fixed-vector
computeH differential harness already exists and is the acceptance test,
plus the standard full-proof/tamper/fault suite.

Sequencing note: B shrinks the segment that currently *hides* the worker MSMs
— landing B before C converts hidden MSM time into visible critical path (K
ends at 37.7 s; wall floors there until C lands). Land B and C in either order
but expect the full win only from both; promote against counterbalanced
medians per the benchmark protocol, not single traces.

## Workstream C — Rust + wasm-SIMD MSM kernel (arkworks)

**PHASE 0 RAN 2026-07-15: NO-GO.** `experiments/wasm-prover/rust-msm-spike/`
(bench.mjs, reproducible) measured arkworks 0.5 against the Go gnark kernel on
the exact worker wire format, single-threaded, same V8, bit-exact results
asserted on every run:

| n       | go-gnark | rust-portable | rust +simd128 |
|---------|---------:|--------------:|--------------:|
| 16,384  |   533 ms | 700 ms (0.76x) | 983 ms (0.54x) |
| 131,072 | 3,379 ms | 4,650 ms (0.73x) | 6,546 ms (0.52x) |
| 524,288 | 12,620 ms | 16,689 ms (0.76x) | 24,659 ms (0.51x) |

arkworks is ~1.3x SLOWER than gnark-on-Go-wasm, and `+simd128` makes it ~2x
slower (arkworks has no hand-written SIMD128 paths; LLVM autovectorization
pessimizes the bigint arithmetic). wasm-opt -O3 on the Rust module does not
change the verdict (0.71x). Per the kill criterion below, workstream C stops
here; the effort goes to B1b and workstream A. Two durable positives: the
two-runtime boundary and the hand-written ZCash serializer are PROVEN (byte-
identical partials through the real wasm boundary), so if a future kernel
with hand-written SIMD128 field arithmetic (not arkworks) shows a real win,
the integration path is de-risked. Any revival must first beat gnark's Go
wasm MSM by >=1.3x in this same spike harness.

**Follow-up spikes 2026-07-15 (js-kernels/): wasmcurves and mcl-wasm also
fail the bar.** Same harness discipline (Go-minted vectors, bit-exact results
asserted, single-threaded kernels, multiexp-to-multiexp timing):

| n       | go-gnark | wasmcurves (ffjavascript) | mcl-wasm |
|---------|---------:|--------------------------:|---------:|
| 16,384  |   548 ms | 520 ms (1.05x) | 899 ms (0.61x) |
| 131,072 | 3,194 ms | 3,349 ms (0.95x) | 7,200 ms (0.44x) |
| 524,288 | 12,481 ms | 12,200 ms (1.02x) | — |

wasmcurves (snarkjs's hand-written-WAT engine, 32-bit limbs) lands at DEAD
PARITY with gnark's Go — which empirically kills the "32-bit-limb rewrite
gives 1.2-1.6x" hypothesis: the scalar hand-written-wasm frontier is where
gnark already sits. mcl-wasm loses outright (0.44-0.61x; its fixed wasm
memory also cannot hold one production shard per mulVec call, and its heap
views detach on growth — chunked at 4096 with live-view shims to complete
the measurement at all). The only unexplored CPU lever left is hand-written
SIMD128 field arithmetic, which must now deliver >=1.3x over this scalar
frontier on its own — treat any such proposal as research, not a backlog
item.

Backend locked: **arkworks** (`ark-bls12-381`/`ark-ec`) — pure Rust, clean
`wasm32-unknown-unknown` + `+simd128` build, permissive licence, easy
differential testing. `blst` rejected: its speed is x86/aarch64 asm with no
wasm-SIMD path; a wasm build falls back to portable C and forfeits the goal.

**Honest speedup expectation: 1.5–2.5×, not 2–4×.** wasm SIMD128 has no
64×64→128 multiply; vectorized 384-bit Montgomery mul comes from
`i32x4.extmul` lanes, which published BLS12-381 wasm work puts at ~1.5–2.5×
over scalar. Two cheap upside surprises to measure in phase 0: (a) arkworks'
*portable scalar* wasm MSM may already beat gnark-on-Go-wasm from codegen
alone; (b) the item-1 `wasm-opt` pass narrowed that gap — benchmark, don't
assume. If phase-0 numbers say <1.3× end-to-end shard kernel, stop C and put
the effort into B + transport.

### The seam (verified in source)

- Swap site: `partial.MultiExp(...)` inside `shardG1Bytes`/`shardG2Bytes`
  (`internal/msmengine/serialize.go:217/:268`); transport, sharding, digest
  auth untouched. Native path: `cpuMSM.MSMG1` (`internal/msmengine/cpu.go:31`)
  behind a new engine.
- `cmd/msmworker/main.go` workers additionally instantiate the Rust module
  (precompiled-module passing from `fc5846f` extends naturally to a second
  module); bytes cross linear memory; the Rust module is a leaf: no JS, no
  network, no PK knowledge beyond public points (preserves the worker
  security posture).
- Wire format the kernel MUST speak (from `serialize.go:21-27`): gnark
  `RawBytes()` = ZCash/EIP-2537 uncompressed big-endian with 3 flag bits — NOT
  arkworks' native little-endian `CanonicalSerialize`. A hand-written, fuzzed
  (de)serializer is where bit-identity is won or lost; the MSM math is an
  exact group sum so any correct implementation matches once encoding does.
- Validation parity: pinned decode keeps on-curve, skips subgroup
  (`serialize.go:102`) — the Rust path must match exactly, no stricter, no
  looser.

### Priorities within C (from the v2-opt-r1 shard telemetry)

1. **G1** — dispatch 187 s summed, plus the Z-stage sections (Z is the 14.9 s
   critical-path tail).
2. **G2 is first-class, not a follow-on** — 134 s summed, 41% of dispatch
   multiexp; G2B's 17 s span binds once G1 shrinks.
3. **Pipelined Z dispatch:** Z shards can dispatch per coefficient-range as
   the final FFT pass / serialization streams H, instead of after the full
   computeH end event — shaves the FFT→Z junction on top of both workstreams.
4. **Batch point decompression** (enables A5) — batch-affine sqrt via
   Montgomery's trick in the kernel.

### Phases (each gated; no crypto merged before phase 2 is green)

0. **Spike + go/no-go benchmark:** Rust module in a worker round-tripping
   bytes; then a portable (non-SIMD) arkworks G1 MSM benchmarked against the
   Go kernel on real shard sizes. Decide direct Go↔Rust call vs
   worker.js-mediated on measured copy cost.
1. **Serializer first:** ZCash-format (de)serializer, fuzzed against gnark
   `RawBytes()` vectors (n=0/1, zero scalars, r−1, infinity, duplicates, large
   random n, matched-seed fuzz).
2. **Scalar MSM behind a fall-back-to-Go differential gate:** compute both,
   compare partial bytes, fall to Go on mismatch, telemetry on every
   divergence. Soak before removing double-compute.
3. **SIMD field layer** (`+simd128` Montgomery mul): bytes must not change;
   re-run everything; benchmark.
4. **G2 + pipelined Z + (optional) A5 decompression; rollout** as a capability
   rung above the Go kernel with the existing no-silent-fallback discipline
   (fail-closed classes stay fail-closed; only the *differential* gate may
   demote to Go, and loudly).

### Security review scope

New-language supply chain (pinned `rust-toolchain.toml` + `Cargo.lock`,
`cargo-audit`, vendored crates), the hand-written deserializer (the one
memory-unsafe-adjacent parsing surface — fuzz it), two-runtime memory boundary
in the worker, reproducible build (Rust wasm joins `runtime-manifest.json`
via the same `wasm-opt` + `hash-blake2b` path), and an explicit sign-off that
constant-time is *not* required here (public PK points; scalars in these
sections are witness-derived — confirm per-section sensitivity with the
reviewer before waiving CT, and zero scalar buffers as the Go path already
does).

## Workstream D — the ~6.5 s head (later, smaller)

Solver 6.2 s (single-threaded witness solve; hard to parallelize safely — the
async-hint crash in the rejected list is a warning), commitment MSMs ~5.7 s
(become C-kernel work automatically). Nothing here before A–C land.

## Order of execution

1. **A1 + A2 + A3** — pure transport, no crypto, immediately visible to every
   live user, independently promotable via the benchmark protocol.
2. **C phase 0** (go/no-go data) in parallel with **B1 spike** — both are
   cheap and decide the expensive work.
3. **B** and **C phases 1–3** by whichever spike wins its gate first; expect
   full compute win only when both land.
4. **A4, A5, C phase 4, D** — follow-on.

Every candidate goes through the existing benchmark protocol: guarded runner,
counterbalanced medians, full tamper/fault suites, 4-core/8-GB and 8-worker
profiles mandatory (that's the live user, and A/B/C trade off differently
there), plus a real-CDN cold/warm pair for anything in A.
