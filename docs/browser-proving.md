# Browser Proving

## Status And Scope

The destination-bound browser prover is implemented and locally accepted in
the production claim flow. Hosted enablement is still controlled entirely by
the deployment manifest's `proof.browser_proving` descriptor; absent or
disabled descriptors fail closed and keep Proof Helper Desktop available.

The browser provider changes where the same destination proof is computed. It
does not change the circuit, proof artifact, Cardano bytes, verifier key, or
contract semantics.

## Runtime Map

- `cmd/wasm-prover`: main Go WASM entrypoint. Registers
  `discoverCredentialPaths`, `proveDestination`, `preflightProofAssets`, and
  `__wasmProverReady`.
- `cmd/msmworker`: Go WASM MSM kernel used by nested workers.
- `internal/streampk`: proving-key section index and file/HTTP range source.
- `internal/streamprove`: streaming Groth16 adapter.
- `internal/msmengine`: CPU fallback, sharded worker transport, authenticated
  section fetch, pinned point decoding, scheduling, and trace hooks.
- `internal/proofassets`: signed chunk-manifest generation and validation.
- `apps/ownership-proof-web/public/proof-runtime/prover-worker.js`: dedicated
  proof-worker orchestrator.
- `apps/ownership-proof-web/public/proof-runtime/msm-worker.js`: nested MSM
  worker bootstrap.
- `apps/ownership-proof-web/lib/proving/capability.ts`: cheap browser
  capability checks.
- `apps/ownership-proof-web/lib/proving/browser-wasm.ts`: claim-provider
  preflight, sequential batch
  proving, cancellation, result gates, and error redaction.
- `experiments/wasm-prover`: benchmark harness and diagnostics for the same
  production packages; it is not a second production implementation.

## Execution Flow

The claim UI checks runtime capability before reading the recovery phrase. The
prover worker loads `wasm_exec.js` and `proof-destination.wasm`, then performs
automatic local credential discovery for all distinct proof targets in one
pass — unless every proof request already carries an explicit CIP-1852 `path`,
in which case discovery is skipped and each path is verified against its
target credential inside `proveDestination`. Only after every target is found
(or paths are supplied) does the browser open or prefetch the large proof
assets. The Go preflight then validates:

- key-manifest schema, signature, key version, circuit ID, and VK identity;
- chunk-manifest signature and coherence with the key/deployment manifests;
- CCS, VK, PK index, runtime WASM, worker JS, and worker WASM hashes/sizes;
- deployment ID and final `vk_hash` equality with the claim deployment.

Discovery derives the hardened purpose, coin, and account prefixes once,
traverses the soft role/index subtree from extended public keys, and
canonically re-derives every match privately before it is cached for the
current worker. It searches roles 0, 1, and 2 in staged index-major order over
accounts 0 through 9 and indexes 0 through 5000. Aggregate candidates, rate,
and ETA may reach the UI; credentials and paths may not.

During proving, the main worker uses the cached local path and sends scalar
material plus signed section/range descriptors to nested MSM workers. Workers
fetch public PK chunks, verify SHA-256 and BLAKE2b-256, decode pinned on-curve
points, compute partial MSMs, zero scalar buffers, and return only partial
results and timing data. The generated proof is verified locally before the
provider returns an artifact.

Proof requests in a claim batch run sequentially in one long-lived worker.
Parallel proofs would exceed reasonable memory. Cancellation terminates the Go
worker; discovery itself checks cancellation between candidates, while an
individual WASM MSM is not cooperatively cancellable.

## Secret Boundary

The phrase is normalized and converted to a 96-byte master XPrv in a local
derivation worker. Browser proving moves the XPrv into the dedicated prover
worker and never fetches a hosted API with it. Request JSON containing
`master_xprv_hex` must not be logged, thrown, persisted, included in progress,
or surfaced in diagnostics. The caller zeros its master byte array in
`finally`; the worker is terminated after use.

Only public, signed proof assets cross the network. Proof artifacts omit path
metadata and must still pass the claim backend's recomputation and VK gates.

## Accepted Tuning And Evidence

`apps/ownership-proof-web/lib/proving/browser-wasm.ts` defaults to the measured
production route:

```text
worker_count:            adaptive 8..16 when W5 is enabled and no explicit count is pinned
shard_count:             base 8; raised to at least the applied worker count
range_fetch_concurrency: 2
pinned_decode:           true
opt_w1/w2/w3/w5/w6/w7:  true
GOGC:                    50
GOMEMLIMIT:              3000MiB
```

The accepted Gate G1 signed-r8 run used `streampk-sharded-groth16` with all
W1-W7 flags, 16 applied Workers, 16 shards, and range-fetch concurrency two.
It completed proof construction in 70.400 seconds, peaked at 1.4593 GiB main
WASM heap, verified locally and through the compiled contract, and passed the
complete tamper and five-case fault suites. The production-host confirmation
completed in 115.770 seconds / 1.4627 GiB under substantially heavier
concurrent load; it confirms coherence rather than replacing the accepted G1
performance result. The old 111.461-second / 2.316-GiB O4/O2 run remains the
ideal-host pre-optimization reference only.

Credential-discovery release evidence uses immutable release
`proof-assets-ownership-destination-v2-preprod-9fac96b-g3a-2m-key-discovery-r1`.
Its signed runtime/chunk/deployment manifests passed the local release verifier,
and a cold Chromium proof for account 3, role 2, index 0 completed in 90.534
seconds with 0.833 GiB peak main-WASM heap and `verified_locally=true`. Heavy
unrelated host work contaminated the timing sample, so it qualifies the full
discovery-to-proof path and artifact coherence, not a new performance record.

These are browser-prover source defaults and proof-runtime measurements. They
do not change claim batching by themselves. Until the statement-bound V2
deployment is activated, the current Preprod V1 manifest remains authoritative
for its legacy claim policy; the selected V2 candidate separately uses
default/optimization/hard caps `6/6/7` with seven as explicit opt-in.

Pinned decode skips redundant subgroup checks only for digest-authenticated PK
chunks and still performs on-curve validation. Commitment Basis and
BasisExpSigma use section-backed MSMs; WASM GC/memory-limit enforcement is
temporarily suspended only around the solver to avoid the observed wasm32
bad-pointer failure, then restored. `computeH` and scalar preparation overlap
worker-bound stages without changing proof challenges.

## Dependency Strategy

Upstream gnark v0.15.0 does not expose all seams required by the reviewed
browser runtime. `vendor/` must equal a clean `go mod vendor` plus the ordered
runtime patch set managed by these scripts:

```bash
scripts/bootstrap-vendor.sh
scripts/check-vendor-drift.sh
```

Never run plain `go mod vendor` and commit or build silently; it removes the
streaming seam. Moving to a reviewed fork/upstream change remains preferable
for a final production provenance story.

## Build And Verification

Build reproducible runtime files:

```bash
scripts/build-wasm-prover.sh
```

Run correctness checks:

```bash
go test ./internal/msmengine ./internal/streampk ./internal/streamprove ./internal/proofassets
PROOF_WASM=dist/proof-runtime/proof-destination.wasm \
  WASM_EXEC_JS=dist/proof-runtime/wasm_exec.js \
  node experiments/wasm-prover/tests/key-discovery.mjs
node experiments/wasm-prover/scripts/key-discovery-browser-benchmark.mjs
GOROOT="$(go env GOROOT)" N=2000 WORKERS=4 \
  node experiments/wasm-prover/web/node-msm-check/run.mjs
node experiments/wasm-prover/scripts/verify-tamper.mjs \
  experiments/wasm-prover/output/o4-o2-section-commitment-w8-s32-rf2-local7-artifact.json
```

Run a guarded benchmark only on an otherwise idle host and compare
uncontaminated summaries:

```bash
node experiments/wasm-prover/scripts/guarded-browser-benchmark.mjs \
  --case local-check --workers 16 --shards 16 --rf 2 --cpu-list 0-15
```

See `browser-proving-asset-hosting.md` for asset generation/staging and
`vercel-preprod-browser-proving-deployment-plan.md` for the still-open hosted
rollout.

## Further Optimization

The durable results/backlog is `experiments/wasm-prover/optimization-backlog.md`.
Do not accept a tuning change from compile-only or microbenchmark evidence: it
must produce a real destination proof, verify locally, pass tamper tests,
preserve artifact/Cardano bytes, record uncontaminated trace evidence, and stay
within the approved memory envelope.
