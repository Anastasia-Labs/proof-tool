# Browser WASM Prover Results And Backlog

This is the durable benchmark ledger for the browser destination prover. Raw
traces and summaries live under `experiments/wasm-prover/output/`; regenerate
them when comparing branches because host load and browser/toolchain versions
matter.

## Current Accepted Route

The production defaults in
`apps/ownership-proof-web/lib/proving/browser-wasm.ts` are:

```text
engine:                  streampk-sharded-groth16
worker_count:            adaptive 8..16 (safe floor 8)
shard_count:             8 at w8; at least applied worker count (s16 at w16)
range_fetch_concurrency: 2
pinned_decode:           true
GOGC:                    50
GOMEMLIMIT:              3000MiB
opt_w1/w2/w3/w5/w6/w7:  true
```

The ideal-host reference trace is:

```text
trace:          output/o4-o2-section-commitment-w8-s32-rf2-local7.json
summary:        output/o4-o2-section-commitment-w8-s32-rf2-local7.summary.json
prove_ms:       111461
wall_seconds:   115.8995
peak_heap_gib:  2.3156
contaminated:   false
verified:       true
```

Gate G0 also accepts the guarded loaded-host replacement baseline
`baseline-pre-opt-2026-07-10.json` at `128202 ms` / `2.3152 GiB`; substantial
unrelated workloads were active, so the `111461 ms` trace remains the
ideal-host reference. Optimization promotion uses counterbalanced guarded
medians rather than comparing a candidate against only one of these numbers.

Its artifact passed the valid-proof check and rejected changed credential,
destination, public input, proof bytes, and `vk_hash`.

W2 is adopted behind its independent engine option; Gate G1 promotes the
cumulative W1-W7 settings to the production defaults.
The accepted same-profile evidence is
`w2-accept-loaded-2026-07-10-{baseline,candidate}-r1.json`. Both runs were
contaminated by unrelated concurrent builds, but the candidate still beat the
approved loaded-host G0 time (`120667 ms` versus `128202 ms`) and reduced peak
main heap from the paired `2.3386 GiB` to `1.7165 GiB` (26.60%). Its paired
time regression was 4.33%, inside the 5% secondary limit. The Goal explicitly
permits a contaminated result to establish adoption when it still beats the
current accepted best on the finding's designated metric; contamination may
not be used to turn a demonstrated win into a rejection. Relative to the
ideal-host accepted heap (`2.3156 GiB`), W2 saves about 25.9%.

The open-keys trace moved from `1352 ms` / `561,942,328` allocated bytes to
`522 ms` / `16,856,944` bytes: `-830 ms` and about `-545 MiB`. Both randomized
proofs passed local and compiled-contract verification with identical
PK/CCS/VK/manifest/deployment identities and exact 336-byte Cardano proofs;
both tamper matrices rejected changed credential, destination, public input,
proof, and VK hash. `fault-all.json` records the five-case fault suite on the
refreshed signed runtime. The current file is the later cumulative W2+W3 rerun
and therefore subsumes the independently reviewed W2-only configuration.

W3 was initially adopted behind `opt_w3` with its default deferred; Gate G1
later promoted it. On the same refreshed signed stage, cumulative W2+W3 measured `114564 ms`
/ `1.3327 GiB` versus W2-only `113835 ms` / `1.7146 GiB`: peak heap improved
22.27% while time regressed only 0.64%. At `release-ccs`, forced GC reduced
heap from `1,425,351,816` to `619,560,032` bytes (about 806 MiB) before the
post-solve MSM/FFT phase. The cumulative five-case fault suite passed; its
4-core/8-GB run verified at `1.4582 GiB`.

W1 was initially adopted behind `opt_w1` under the operator's current-best
rule and was later promoted at G1. Cumulative
W1+W2+W3 measured `102564 ms` / `1.4597 GiB` versus W2+W3 at `114564 ms` /
`1.3327 GiB`: prove time improved 10.47% and the candidate beat the previous
uncontaminated `111461 ms` best by 7.98%. It did not hit the plan's 85-second
item target, and paired heap rose 9.52% rather than staying within ±5%; record
both misses. The absolute heap remains below G1's 1.6-GiB ceiling. Both root
and independent from-scratch cumulative fault runs passed, including real
queued-worker termination and 4-core/8-GB verified peaks of about 1.58 GiB.
`fault-all.json` now contains the latest independent W1+W2+W3 rerun.

W6 was adopted behind `opt_w6` and was later promoted at G1.
The exact-profile r5 pair is
`w6-r5-accept-loaded-2026-07-10-{baseline,candidate}-r1.json`: cumulative
W1+W2+W3 moved from `101868 ms` / `1.5842 GiB` to `102595 ms` /
`1.4577 GiB`. Peak heap improved 7.98% (about 126.5 MiB) for a 0.71% time
regression. This is 0.017 percentage points below the nominal 8% expectation,
but it establishes the best accepted heap on the designated metric under the
operator rule. The fixed-vector computeH differential, inverse-table storage
reuse, scoped lifetime review, and vendor replay all pass.

W7 was adopted behind `opt_w7` and was later promoted at G1.
The exact-profile signed r6 localhost pair is
`w7-r6-accept-loaded-2026-07-10-{baseline,candidate}-r1.json`: fetched and
hashed bytes fell `3,010,621,005 -> 2,305,977,933` (23.40%), with
`704,643,072` cache-hit bytes and 168 hits. The candidate wall time was not a
speed claim because its concurrent workload was substantially heavier. The
hosted pair `w7-r6-hosted-2026-07-10-{baseline,candidate}-r1.json` used a
fresh signed local manifest plus the existing immutable 16-MiB preprod R2/CDN
objects: fetched/hashed bytes fell `5,819,026,151 -> 3,002,232,397` (48.41%),
`2,816,793,754` bytes came from 168 verified hits, aggregate hash time fell
about 48.6%, and contaminated prove time improved `168491 -> 145288 ms`
(13.77%) with heap within 0.14%. Both pairs passed local and compiled-contract
verification, exact 336-byte export, identity coherence, and tamper rejection.

W5 is adopted behind `opt_w5`. On signed r5 with W1/W2/W3/W6 enabled, w16
measured `79805 ms` / `1.4579 GiB` versus w8 at `102595 ms` / `1.4577 GiB`:
22.21% faster with effectively flat main heap. The corrected signed r7
cumulative fault suite proved an actual sharded worker16 pool and all W flags
in successful result+trace, never relabeled request echoes as applied state,
and required definitive no-CPU-fallback evidence. Worker termination, corrupt
chunk, bounded network abort, and reload all passed. The emulated 4-core/8-GB
case independently selected a real worker4 pool, completed at `1.3342 GiB`,
verified locally, and reported no fallback. The first r7 suite attempt reached
that final case but its old 180-second external watchdog fired under heavy host
load; the accepted report is the complete bounded 360-second rerun.

W4 and Gate G1 are accepted on the signed r8 stage. The complete guarded W4
matrix used W1/W2/W3/W6/W7, rf2, pinned decode, GOGC50, and complete real
per-Worker Go/W7 telemetry. Reference-host `{s8,s16,s32}` measured
`102140/104145/122497 ms`; the emulated 4-core/8-GB profile, with requested w8
independently proven to apply w4, measured `177232/186566/213613 ms`. Main heap
was flat at `1.458-1.464 GiB`. Maximum worker HeapAlloc fell about
`98.47 -> 49.89 -> 26.65 MiB`, but s8 was fastest on both profiles and its
worker memory fits the small-host envelope, so s8 is promoted for w8. A w16
profile must use at least s16 so every applied Worker receives a section
shard. The final all-flags w16/s16 trace
`g1-r8-final-w16-s16-rf2-allflags-2026-07-11-r1.json` completed at
`70400 ms` / `1.4593 GiB`, locally and compiled-contract verified, with exact
worker IDs 0..15 and all flags in result/trace. It beats both the G1 hard gate
and its 78-second/1.5-GiB stretch gate. All matrix/final traces are marked
contaminated and retain their concurrent-process telemetry; per the operator
rule, the positive wins remain valid. The final tamper matrix passed. The r8
five-case fault report under `output/fault-r8-final/fault-all.json` passed real
worker termination, corrupt-chunk and 3/3 network-abort fail-closed paths,
reload/persistence recovery, and a verified worker4 proof at `1.4597 GiB`,
all with definitive no-CPU-fallback evidence.
The production-host coherence rerun used the freshly signed 124-part 16-MiB
manifest `proof-assets-...-runtime-g1-r8` against the immutable preprod CDN,
qualified all 16 Workers, and locally/contract verified at `115770 ms` /
`1.4627 GiB`; its much heavier concurrent Go/Midgard build load makes that
wall time confirmation-only, not a G1 regression decision. Its tamper matrix
also passed. The public runtime, Worker JS/WASM, VK, signed manifest, and active
descriptor now match that exact r8 coherence set. A current-source proof-WASM
rebuild intentionally differs because the circuit track has since begun C3;
the public binary remains the benchmarked pre-C3 r8 until G3 replaces the full
v1 key/CCS/VK/runtime set with the coherent v2 ceremony artifacts.

## W8 / readahead / zstd-CCS candidate results (2026-07-14, branch optimize-browser-7-14-2026)

Local same-stage counterbalanced A/B on the v2 2-MiB tier (localhost harness,
w16/s16/rf2, gogc15/3200MiB, all W1-W7 on, signed local manifest, verified
proofs in every run; see `experiments/wasm-prover/browser-proving-efficiency-plan.md`
for the design):

- **opt-W8 (computeH transforms on 3 dedicated FFT workers)**: computeH span
  20.5-21.1 s -> 15.0-15.1 s (about -27%), order-independent across
  counterbalanced pairs; wall means about 45.1 -> 41.3 s on a noisy host. The
  engine self-gates to pools of >= 8 MSM workers; per-vector worker round-trip
  overhead (canonical scalar marshal + SAB copies + per-call table builds) is
  the remaining gap to the ideal, and a six-step full-pool FFT remains the
  follow-up (workstream B1b).
- **chunk_readahead=2 (dispatch-order HTTP-cache warm-up)**: engaged from the
  open-keys boundary (615 chunks); localhost cannot show the transfer win —
  the effect is a cold/remote-link lever. `range_bytes_network/disk_cache/opaque`
  telemetry was added to the shard measures to quantify it on real CDNs
  (requires Timing-Allow-Origin at the edge for full attribution).
- **zstd CCS transport**: 129,221,468 -> 38,327,673 bytes (29.7%) on the wire,
  decoded+double-digest-verified in the browser (`open-ccs` trace shows
  encoding=zstd), identity fallback on transport failure, fail-closed on
  digest mismatch. The `.zst` is uploaded next to the live identity CCS under
  `proof-assets/preprod-9fac96b-g3a-pk2m-r1/` (sha256 matches the pin);
  shipping it to production needs the v2-signed manifest refresh.
- Gates: guarded uncontaminated run 45,138 ms / verified / 16 workers
  qualified (`local-opt-candidate-w16-s16-rf2-r2`); full six-case tamper
  matrix passes (this work also fixed a verify-tamper.mjs no-op when vk_hash
  ends in `0`); native + vendored (`TestComputeHW8EngineMatchesSerial`,
  `TestHTransformMatchesSerialFFT`) + Node (`fft-transform-roundtrip.mjs`,
  `node-msm-check`) + web suites pass. Remote-matrix confirmation against the
  CDN is the remaining promotion step.

## Performance History

| Route | Prove time | Peak main heap | Disposition |
| --- | ---: | ---: | --- |
| First sharded browser proof, w8/s8/rf4 | 583711 ms | 2.636 GiB | Historical baseline |
| Safe over-sharding, w8/s32/rf2 | 546637 ms | 2.544 GiB | Superseded baseline |
| Authenticated worker-owned chunks, w16/s64 | median 349189 ms | max 2.771 GiB | Accepted transport milestone, superseded by decode work |
| Pinned decode, w8/s32/rf2 | 114600 ms | 2.797 GiB | Accepted |
| Section commitments + compute overlap | 111461 ms ideal / 128202 ms loaded-host G0 | 2.316 / 2.315 GiB | Superseded G0 route |
| W2 no-precompute domain reader, w8/s32/rf2 | 120667 ms contaminated loaded host | 1.717 GiB | Adopted checkpoint; later promoted at G1 |
| W2+W3 CCS release, w8/s32/rf2 | 114564 ms contaminated loaded host | 1.333 GiB | Adopted checkpoint; later promoted at G1 |
| W1+W2+W3 async dispatch, w8/s32/rf2 | 102564 ms contaminated loaded host | 1.460 GiB | W1 adopted under current-best rule; 85 s and ±5% item targets missed, G1 open |
| W1+W2+W3+W6 scoped computeH tables, w8/s32/rf2 | 102595 ms contaminated loaded host | 1.458 GiB | W6 adopted on 7.98% heap improvement; later promoted at G1 |
| +W7 verified chunk LRU/affinity, localhost 4-MiB chunks | 116990 ms under heavier contamination; transfer metric primary | 1.456 GiB | 23.40% fewer fetched/hashed bytes; adopted behind flag |
| +W7 against preprod R2/CDN 16-MiB chunks | 145288 ms vs 168491 ms baseline | 1.458 GiB | 48.41% fewer fetched/hashed bytes and 13.77% faster; adopted behind flag |
| W5 host-gated w16, cumulative W1/W2/W3/W6 (W7-off checkpoint) | 79805 ms vs 102595 ms w8 | 1.458 GiB | 22.21% faster; superseded checkpoint |
| Gate G1 full W1-W7, signed r8 w16/s16/rf2 | 70400 ms contaminated loaded host | 1.459 GiB | Accepted and promoted; all 16 Workers qualified, contract/tamper/final fault suite pass |

The original trace was dominated by point decode and MSM work, not path search,
verification, manifest loading, or serialization. Pinned decode removed the
largest avoidable cost. Section-backed commitment MSMs primarily recovered heap
headroom; overlap provided a smaller runtime improvement.

## Implemented Guardrails

- Each worker serializes requests, so more shards than workers cannot
  cross-consume replies.
- Per-shard traces include worker/range/fetch/hash/decode/copy/queue/kernel
  fields and failure state.
- A signed chunk manifest pins PK chunks, PK index, CCS, VK, Cardano VK,
  deployment identity, proof WASM, worker JS, and worker WASM.
- Worker-owned PK fetch verifies SHA-256 and BLAKE2b-256 before point decode.
- Pinned point decode is available only for authenticated bytes and retains
  on-curve checks.
- Scalar bytes and scalar `SharedArrayBuffer`s are zeroed after consumption.
- Generated proofs verify locally before leaving the provider.
- W2 validates every decoded canonical domain field against a freshly derived
  no-precompute domain before proving; malformed or doctored headers fail
  closed.
- Authenticated chunk, network, and worker-reply integrity failures do not
  demote to the CPU engine. Real silent worker termination is bounded by the
  engine's reply watchdog rather than a synthetic browser error event.

## Rejected Or Superseded Approaches

Do not reintroduce these without a new hypothesis and real proof evidence:

- Main-worker raw PK transport verified but regressed by about 10.3 seconds
  versus the then-current over-sharded baseline.
- Per-proof scalar encoding reuse hit the expected cache entries but regressed
  by about 10.3 seconds; marshal savings were too small.
- FFT domain precomputation shortened `computeH` but increased total proof time
  by about 40.9 seconds and increased heap.
- Relaxed `GOGC`/memory sweeps did not materially improve runtime and generally
  increased heap.
- The first w8/s32 worker-owned chunk route was correct but slower than its
  decoded-range baseline; higher worker parallelism was required before it
  became a useful milestone.
- Asynchronous commitment section work inside solver hints caused a Go WASM
  bad-pointer crash. The accepted route keeps section work outside that unsafe
  lifetime and suspends WASM GC/memory-limit enforcement only around
  `r1cs.Solve`.
- `GOMEMLIMIT=2500MiB,GOGC=5` destroyed the browser execution context before a
  valid benchmark completed.
- WebGPU/specialized MSM was deferred. It is a separate high-risk research
  project, not an unimplemented switch.
- An arkworks (Rust) wasm MSM kernel was benchmarked (2026-07-15,
  `experiments/wasm-prover/rust-msm-spike/`) and REJECTED: bit-exact with the
  Go kernel but 0.73-0.76x its speed portable, 0.51-0.54x with +simd128
  (arkworks has no hand-written SIMD paths; autovectorization pessimizes).
  Do not reintroduce a non-Go CPU kernel without first beating gnark's Go
  wasm MSM by >=1.3x in that spike harness — hand-written SIMD128 field
  arithmetic would be the only plausible route.

## Open Research Questions

These are optional optimization/reliability work, not blockers for the current
provider:

1. Re-run worker-count and w/s/rf matrices on representative 4-core/8-GB and
   high-end hosted profiles. Memory telemetry must include worker heaps, not
   only the main WASM heap.
2. Explain remaining intra-stage worker-wave inflation using current
   decode/MultiExp/nonzero-scalar telemetry before changing scheduling.
3. Add a cross-stage shard queue only if traces show idle workers between
   independent stages and prove the gnark transcript/data dependencies allow
   it.
4. Evaluate persistent verified public-chunk caching for hosted retry/cold-load
   reliability. It is not expected to dominate localhost proof time.
5. Consider CCS transport compression only with explicit compressed and decoded
   identity pins.
6. Replace the vendored gnark streaming patch with a reviewed fork or upstream
   API while preserving byte-for-byte proof behavior and vendor-drift checks.
7. Treat WebGPU or a non-Go MSM kernel as a separate security project with
   fixed/random vector, infinity, zero-scalar, subgroup, combine, full-proof,
   and tamper gates.

## Benchmark Protocol

Every candidate must preserve:

- current circuit, proof artifact, Cardano proof/VK byte formats, and VK hash;
- signed asset/deployment coherence and fail-closed tamper behavior;
- local-only phrase/master/path handling;
- successful real destination proof and local verification;
- tamper rejection for credential, destination, public input, proof, and VK;
- a before/after trace and summary with complete contamination telemetry;
- an approved memory result on the target browser profile.

Use the guarded runner and prefer counterbalanced medians from uncontaminated
summaries. A contaminated candidate may still establish adoption when it beats
the current accepted best on the finding's designated metric; retain its
complete telemetry and never use contamination alone to reject a demonstrated
improvement:

```bash
node experiments/wasm-prover/scripts/guarded-browser-benchmark.mjs \
  --case candidate-w8-s32-rf2 \
  --workers 8 --shards 32 --rf 2 --cpu-list 0-15
```

Supporting gates:

```bash
go test ./internal/msmengine ./internal/streampk ./internal/streamprove ./internal/proofassets
# vendored computeH differentials (W6/W8) — `go test ./...` skips vendor/:
go test ./vendor/github.com/consensys/gnark/backend/groth16/bls12-381/ -run 'TestComputeH|TestW6' 
GOROOT="$(go env GOROOT)" N=2000 WORKERS=4 \
  node experiments/wasm-prover/web/node-msm-check/run.mjs
node experiments/wasm-prover/scripts/verify-tamper.mjs <artifact.json>
```
