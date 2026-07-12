# Browser WASM Prover Benchmark Harness

This directory is the experiment/benchmark harness for the production browser
prover. Production entrypoints and reusable packages live in `cmd/wasm-prover`,
`cmd/msmworker`, `internal/{msmengine,streampk,streamprove,proofassets}`, and
`apps/ownership-proof-web/lib/proving`. Keep new probes here until they have
real destination-proof, verification, tamper, Cardano-byte, and browser
performance evidence.

The experiment deliberately fails closed: it loads an existing signed/pinned key
bundle and never creates fresh proving keys. Backend-bound proof artifacts omit
path metadata by default.

## Commands

Build the proving-key section index:

```sh
go run ./experiments/wasm-prover/cmd/pkindex \
  --pk output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3/ownership.pk \
  --out experiments/wasm-prover/web/ownership.pk.idx.json
```

Build the destination constraint-system artifact:

```sh
go run ./experiments/wasm-prover/cmd/ccsgen \
  --out experiments/wasm-prover/web/ownership-destination.ccs
```

The generated file should match the staged manifest's `constraint_system_hash`:

```text
blake2b256:54da79a38f83d47447cd613bb41d16ef0a19e3c29b0b1a3267d0a1c16aeb577e
```

Run the experiment tests:

```sh
go test ./experiments/wasm-prover/... ./internal/msmengine/... ./internal/streampk/... ./internal/streamprove/...
node --test experiments/wasm-prover/tests/*.test.mjs
MSMWORKER_WASM=dist/proof-runtime/msmworker.wasm GOROOT="$(go env GOROOT)" \
  node experiments/wasm-prover/tests/js-wasm-worker-telemetry.mjs
```

Build the Go wasm entrypoint and MSM worker kernel:

```sh
GOOS=js GOARCH=wasm go build \
  -mod=vendor \
  -o experiments/wasm-prover/web/proof-destination.wasm \
  ./cmd/wasm-prover

GOOS=js GOARCH=wasm go build \
  -mod=vendor \
  -o experiments/wasm-prover/web/msmworker.wasm \
  ./cmd/msmworker
```

Check the worker-sharded MSM transport with Node worker threads:

```sh
GOROOT="$(go env GOROOT)" N=2000 WORKERS=4 \
  node experiments/wasm-prover/web/node-msm-check/run.mjs
```

Run the Node wasm smoke:

```sh
GOROOT="$(go env GOROOT)" node experiments/wasm-prover/web/node-smoke.mjs
```

Verify the emitted artifact and tamper rejections:

```sh
node experiments/wasm-prover/scripts/verify-tamper.mjs
```

Serve the browser harness:

```sh
GOROOT="$(go env GOROOT)" node experiments/wasm-prover/web/server.mjs
```

The server prints a localhost URL and sets `Cross-Origin-Opener-Policy:
same-origin` plus `Cross-Origin-Embedder-Policy: require-corp`.

When the page is cross-origin isolated and `SharedArrayBuffer` is available, the
wasm prover selects the worker-sharded MSM engine. If worker startup or proving
fails, `msmengine.WithFallback` retries once with the CPU engine. During proof
generation, the progress bar advances through weighted `prove NN.N%` updates
computed as completed MSM scalars divided by the expected MSM scalar total for
the proof.

Run guarded browser benchmarks when comparing optimization candidates:

```sh
node experiments/wasm-prover/scripts/guarded-browser-benchmark.mjs \
  --case p0-over-w8-s32-rf2 \
  --workers 8 \
  --shards 32 \
  --rf 2 \
  --cpu-list 0-15
```

The guarded runner samples host load before and during the proof. It writes:

```text
experiments/wasm-prover/output/<case>.json
experiments/wasm-prover/output/<case>.telemetry.jsonl
experiments/wasm-prover/output/<case>.summary.json
```

By default, it refuses to start if the preflight window is busy and aborts a
run after sustained external CPU contamination. Use `--preflight-only` to check
whether the machine is idle enough before starting a long run. Use
`--no-abort-on-contamination` only when you want the proof to finish and be
marked contaminated instead of aborted. `--cpu-list` is optional; when `taskset`
is available, it pins the runner and browser descendants to the requested CPU
set so paired runs use the same scheduler boundary.

For close comparisons, run paired repeats and compare median `prove_ms` only
from summaries where `contaminated` is `false`:

```sh
for i in 1 2 3; do
  node experiments/wasm-prover/scripts/guarded-browser-benchmark.mjs \
    --case "decoded-s16-rf2-run${i}" --workers 8 --shards 16 --rf 2
  node experiments/wasm-prover/scripts/guarded-browser-benchmark.mjs \
    --case "raw-s16-rf2-run${i}" --workers 8 --shards 16 --rf 2
done
```

## Optimization Results And Backlog

The first completed sharded browser proof took about 587.62 seconds end to end.
The accepted production route is now about 115.9 seconds wall time on the
benchmark host. Durable results, rejected approaches, and remaining research
questions are tracked in:

```text
experiments/wasm-prover/optimization-backlog.md
```

Per-worker serialization, over-sharding, authenticated worker-owned chunk
fetch, pinned decode, section-backed commitment MSMs, and compute overlap are
implemented. Do not revive a rejected path from an old trace without reading
the current backlog and reproducing its correctness/performance evidence.

## Vendored Gnark Patch

The browser proof experiment needs `groth16/bls12-381.ProveStream`, which is not
exported by upstream `github.com/consensys/gnark v0.15.0`. The patch source is
copied from the sibling checkout's locally developed browser-prover branch and
stored at `experiments/wasm-prover/patches/prove-stream.patch`.

To restore the patched dependency from a clean tree:

```sh
bash scripts/bootstrap-vendor.sh
bash scripts/check-vendor-drift.sh
```

While `vendor/` exists, Go uses the patched gnark package for the whole module,
including production browser builds. Use `scripts/bootstrap-vendor.sh` and
`scripts/check-vendor-drift.sh`; do not regenerate vendor without the patch. A
reviewed fork or upstreamable gnark change remains preferable to a long-lived
vendored patch.
