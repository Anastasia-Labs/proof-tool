# Build an Isolated Browser WASM Prover Experiment

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

No `PLANS.md` file was found in this repository or its parent directories on 2026-07-07. This document is therefore maintained directly according to the ExecPlan requirements supplied in `/mnt/c/Users/phili/.codex/attachments/56e31fad-abd9-463e-ac4e-f167d25d80f2/pasted-text.txt`.

## Purpose / Big Picture

Today a user can keep their seed phrase local in the browser, but real proof generation still depends on a local desktop helper that runs the Go prover as a native sidecar. This experiment asks whether the same destination-bound ownership proof can be generated directly in the browser using Go WebAssembly, so a capable user could create the proof without installing or starting the desktop app.

After this plan is implemented, a person can open an experiment-only browser harness, enter or load a repo-backed test input, generate a real destination-bound ownership proof in a Web Worker, and see that the existing verifier accepts it. If browser proving is too slow or memory-heavy, the result is still useful: the experiment will record the exact blocker and preserve the desktop helper as the production path.

This plan intentionally starts as an experiment. It must not replace the desktop helper or change production reclaim behavior until it produces a real proof, verifier success, tamper rejection, Cardano proof bytes, and performance evidence.

## Progress

- [x] (2026-07-07 20:19Z) Read the ExecPlan requirements from the attached text and confirmed no `PLANS.md` exists in or above `/home/gumbo/playground/proof-zk-recovery/proof-tool`.
- [x] (2026-07-07 20:19Z) Created the initial browser-wasm prover plan as `docs/browser-wasm-prover-experiment-plan.md`.
- [x] (2026-07-07 20:19Z) Confirmed compile-level feasibility for the current repo's prover package by running `GOOS=js GOARCH=wasm go test -c ./internal/prover -o /tmp/proof-tool-prover.test.wasm`, which produced a 20 MB wasm test binary.
- [x] (2026-07-07 20:19Z) Inspected sibling browser-prover reference files under `/home/gumbo/playground/proof-zk-recovery/proof-zk-recovery/proto/`, including `vending/prover/cmd/webprove/main.go`, `browser/prover.js`, `vending/streampk/source.go`, and `browser/e2e-metrics.json`.
- [x] (2026-07-07 20:19Z) Converted the plan into this self-contained ExecPlan format.
- [x] (2026-07-07 20:41Z) Located the current local preprod destination proof assets and verified the staged release key bundle with `go run ./cmd/proof-tool verify-key-bundle`.
- [x] (2026-07-07 20:41Z) Added the current proof-assets path and the compromised-user golden vector to this ExecPlan.
- [x] (2026-07-07 20:46Z) Added the experiment skeleton under `experiments/wasm-prover/`, including README, wasm command, key-index command, web harness, scripts, and output/web ignore rules.
- [x] (2026-07-07 20:46Z) Implemented an experiment-local proving-key section index and HTTP range source under `internal/streampk/`, with tests for file-backed reads, HTTP range reads, truncated range failure, wrong index failure, and missing section failure.
- [x] (2026-07-07 20:46Z) Built the wasm entrypoint with `GOOS=js GOARCH=wasm go build -o experiments/wasm-prover/web/proof-destination.wasm ./cmd/wasm-prover`; the generated wasm was 18 MB.
- [x] (2026-07-07 20:47Z) Generated the current destination proving-key section index with `go run ./experiments/wasm-prover/cmd/pkindex --pk output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3/ownership.pk --out experiments/wasm-prover/web/ownership.pk.idx.json`.
- [x] (2026-07-07 20:52Z) Verified the experiment harness server sets COOP/COEP headers and serves ranged proving-key requests with `206 Partial Content`.
- [x] (2026-07-07 20:52Z) Confirmed browser/URL proving fails closed with the explicit blocker `artifact URL proving is not implemented in this stock wasm entrypoint; port a streaming ProveStream adapter before browser-range proving`.
- [x] (2026-07-07 23:17Z) Vendored gnark with the sibling `ProveStream` patch by running `go mod vendor` and `git apply -p0 experiments/wasm-prover/patches/prove-stream.patch`.
- [x] (2026-07-07 23:17Z) Added the experiment-local `streamprove` adapter and wired the wasm entrypoint to load local key bundles or browser artifact URLs through `streampk.KeySource` instead of stock full proving-key loading.
- [x] (2026-07-07 23:17Z) Rebuilt the wasm entrypoint with `GOOS=js GOARCH=wasm go build -mod=vendor -o experiments/wasm-prover/web/proof-destination.wasm ./cmd/wasm-prover`; after sharded engine wiring the generated wasm is 23,889,258 bytes.
- [x] (2026-07-07 23:31Z) Ported the sibling worker-sharded MSM engine into `internal/msmengine`, including selector/fallback, SharedArrayBuffer worker transport, serialization, and native equivalence tests.
- [x] (2026-07-07 23:31Z) Added the browser worker bootstrap `experiments/wasm-prover/web/worker.js`, the worker kernel command `cmd/msmworker`, and the served `msmworker.wasm` route.
- [x] (2026-07-07 23:31Z) Verified the sharded worker transport with `GOROOT="$(go env GOROOT)" N=2000 WORKERS=4 node experiments/wasm-prover/web/node-msm-check/run.mjs`, which printed `bit-exact=true` and `PASS: sharded == whole (bit-exact)`.
- [x] (2026-07-07 23:40Z) Improved proof-phase progress reporting by adding an MSM progress sink and mapping engine shard/chunk progress to proof-phase UI updates.
- [x] (2026-07-07 23:54Z) Replaced equal-weight `prove-msm-N/M` progress with weighted percent progress: completed MSM scalars divided by expected MSM scalar total.
- [x] (2026-07-07 23:47Z) Generated and served a pinned precompiled destination constraint system with `go run ./experiments/wasm-prover/cmd/ccsgen --out experiments/wasm-prover/web/ownership-destination.ccs`; the file is 187,120,157 bytes and has `blake2b256:54da79a38f83d47447cd613bb41d16ef0a19e3c29b0b1a3267d0a1c16aeb577e`, matching the staged manifest.
- [x] (2026-07-07 23:47Z) Wired browser WASM requests with `ccs_url` to fetch and `ReadFrom` the pinned CCS instead of calling `CompileOwnershipDestination()`; compile remains only as a fallback for requests without `ccs_url`.
- [ ] Run a Node-based wasm smoke test that emits a proof artifact and verifies it with the existing verifier. Attempted on 2026-07-07; the stock in-memory path remained in `open-keys` for more than five minutes and was stopped with Ctrl-C before compile/prove.
- [x] (2026-07-08 00:36Z) Ran a full sharded browser proof attempt from `http://127.0.0.1:8787/`; it completed with `engine: "streampk-sharded-groth16"`, `verified_locally: true`, `wall_seconds: 587.624679936`, `ms: 583711`, `peak_heap_gib: 2.636474609375`, 50 PK range requests, and 2,079,485,485 PK range bytes.
- [x] (2026-07-08 00:36Z) Saved the completed browser proof trace to `experiments/wasm-prover/output/browser-sharded-trace-2026-07-08.json` and the first trace-derived backlog to `experiments/wasm-prover/output/browser-sharded-backlog-2026-07-08.json`. The output directory is gitignored and should be regenerated for future comparisons.
- [x] (2026-07-08 00:55Z) Persisted the durable browser proof optimization backlog at `experiments/wasm-prover/optimization-backlog.md`, including the warning that `shard_multiplier > 1` is unsafe until worker reply demux or per-worker request queuing is implemented.
- [ ] Decide, with evidence, whether to continue toward production integration or keep the desktop helper as the only production proving path. Current evidence supports continuing the experiment and optimization track, but production promotion still requires tamper rejection evidence, hosted-behavior evidence, dependency provenance review, and a non-experiment dependency strategy.

## Surprises & Discoveries

- Observation: The current `internal/prover` package can compile to Go wasm without source changes.
  Evidence: From `/home/gumbo/playground/proof-zk-recovery/proof-tool`, the command `GOOS=js GOARCH=wasm go test -c ./internal/prover -o /tmp/proof-tool-prover.test.wasm` succeeded and produced `/tmp/proof-tool-prover.test.wasm` at about 20 MB.

- Observation: A plain `GOOS=js GOARCH=wasm go test ./internal/prover` is not a useful execution test in this shell because it tries to execute the wasm binary as a native program.
  Evidence: The command failed with `fork/exec /tmp/go-build.../prover.test: exec format error`. Treat that as a runner mismatch, not as a prover compilation failure.

- Observation: The sibling checkout already contains a real browser Go-wasm recovery prover with committed evidence.
  Evidence: `/home/gumbo/playground/proof-zk-recovery/proof-zk-recovery/proto/browser/e2e-metrics.json` records `verified: true`, `engine: "sharded"`, `peakHeapGiB: 2.621337890625`, `wallSeconds: 821.986`, `crossOriginIsolated: true`, `hardwareConcurrency: 24`, and `runtime: "headless-chromium-puppeteer"`.

- Observation: The most important risk is probably not "can Go compile to wasm" but "can this repo's current ownership-destination proving key be streamed and proved inside wasm without exceeding browser memory limits."
  Evidence: The sibling `streampk/source.go` explains that loading large proving-key vectors through intermediate raw byte slices can push wasm32 linear memory toward the 4 GiB ceiling, while indexed section streaming avoids that failure mode.

- Observation: The current preprod destination proof assets are present locally in both ceremony output and staged release output, and the staged release bundle matches the live preprod deployment verifier hash.
  Evidence: `deployments/reclaim/preprod/live.local.json` records proof `vk_hash` `blake2b256:6057da91b15dea8f8e93997f1b1944c35bc2c86faf9a9de17b814f6a172d430a`. The same hash appears in `output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3/manifest.json`, and `go run ./cmd/proof-tool verify-key-bundle --keys-dir output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3 --key-version ownership-destination-v1 --require-proving-key=true` printed `verified key bundle`.

- Observation: The originally expanded deterministic destination fixture was 59 bytes even though the stated pattern is 58 bytes.
  Evidence: `node -e` length checking showed the pasted hex string was 59 bytes, while the repo-backed pattern from `apps/ownership-proof-web/e2e/preprod/proof-stage.test.mjs`, `01 + "2a".repeat(28) + 00 + "00".repeat(28)`, is 58 bytes. The corrected hex is now recorded in this plan and used by the experiment scripts.

- Observation: This repo's upstream `github.com/consensys/gnark v0.15.0` does not expose the sibling checkout's streaming proof entrypoint.
  Evidence: `rg -n "ProveStream|VectorSource" $(go env GOPATH)/pkg/mod/github.com/consensys/gnark@v0.15.0 ...` found stock `Prove` functions but no `ProveStream` or `VectorSource`. The sibling streaming proof depends on `groth16_bls12381.ProveStream`, so section/range streaming alone is not enough to produce a proof in this repo.

- Observation: The current destination proving key can be indexed safely without loading its large vectors.
  Evidence: `go run ./experiments/wasm-prover/cmd/pkindex --pk .../ownership.pk --out experiments/wasm-prover/web/ownership.pk.idx.json` wrote an index for a 2,079,485,517-byte file with sections `A`, `B`, `Z`, `K`, `G2B`, `Basis`, and `BasisExpSigma`. The largest section was `G2B` at 487,374,144 bytes.

- Observation: The stock wasm path does not reach proof generation promptly with the current 2 GB proving key.
  Evidence: `GOROOT="$(go env GOROOT)" node experiments/wasm-prover/web/node-smoke.mjs` printed `wasm ready: true`, `proving stage: parse`, and `proving stage: open-keys`, then stayed in `open-keys` for more than five minutes with the Node process CPU-bound around 100% and around 1.4-1.5 GB RSS. The run was stopped with Ctrl-C before compile/prove and emitted no proof artifact.

- Observation: The browser harness can serve the page and proving key with the required isolation/range mechanics, but proof generation is blocked before a browser-worker attempt is meaningful.
  Evidence: `curl -sI http://127.0.0.1:8787/` showed `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; `curl -sI -H 'Range: bytes=0-15' http://127.0.0.1:8787/proof-assets/ownership.pk` returned `206 Partial Content` and `Content-Range: bytes 0-15/2079485517`. A direct wasm URL-artifact call returned `artifact URL proving is not implemented in this stock wasm entrypoint; port a streaming ProveStream adapter before browser-range proving`.

- Observation: The sibling `ProveStream` code cannot be used as an ordinary local Go package on top of an unmodified gnark dependency.
  Evidence: The patch adds `ProveStream` inside `github.com/consensys/gnark/backend/groth16/bls12-381/prove.go` so it can call gnark package-private helpers such as `computeH` and `filterHeap`, and it imports gnark internal packages that are only legal from inside the gnark module path. Therefore the workable experiment shapes are a vendored gnark patch or a gnark fork/`replace`, not a standalone `proof-tool/experiments/...` package.

- Observation: The vendored patch compiles against this repo's current dependency graph and does not immediately break the stock prover package.
  Evidence: After `go mod vendor` and `git apply -p0 experiments/wasm-prover/patches/prove-stream.patch`, `go test ./experiments/wasm-prover/...` passed, `go test ./internal/prover` passed, and `GOOS=js GOARCH=wasm go build -mod=vendor -o experiments/wasm-prover/web/proof-destination.wasm ./cmd/wasm-prover` succeeded.

- Observation: The worker-sharded MSM optimization is now ported far enough to prove transport-level exactness outside a full proof run.
  Evidence: `go test ./experiments/wasm-prover/...` passed with the copied partition, selector, serialization, and ranged-MSM tests. `GOOS=js GOARCH=wasm go build -mod=vendor -o experiments/wasm-prover/web/msmworker.wasm ./cmd/msmworker` succeeded. `GOROOT="$(go env GOROOT)" N=2000 WORKERS=4 node experiments/wasm-prover/web/node-msm-check/run.mjs` printed `shardedMSM Node proof: N=2000 workers=4 bit-exact=true` and `PASS: sharded == whole (bit-exact)`.

- Observation: The initial proof UI progress was too coarse for a long browser proof.
  Evidence: Before the progress sink, the entrypoint only emitted broad stages like `prove`, so the page could appear stuck while MSMs ran. The current build installs an MSM progress sink before `ProveStream`; the UI now receives monotonic weighted percent updates during the proof phase using completed MSM scalars divided by expected MSM scalar total. After rebuilding, Playwright loaded `http://127.0.0.1:8787/` and observed `crossOriginIsolated=true`, `engine=streampk-sharded-groth16`, and stage `ready`.

- Observation: Browser-side gnark circuit compilation is avoidable and was causing a slow `compile` stage before proving.
  Evidence: `CompileOwnershipDestination()` calls `frontend.Compile(..., r1cs.NewBuilder, &ownershipdest.Circuit{})`, which expands the full destination-bound circuit into 2,885,268 constraints. The generated serialized CCS has the manifest-pinned hash `blake2b256:54da79a38f83d47447cd613bb41d16ef0a19e3c29b0b1a3267d0a1c16aeb577e`, size 187,120,157 bytes, and is now served at `/proof-assets/ownership-destination.ccs`. Playwright observed the default browser request includes `ccs_url` and `ccs_blake2b256`.

- Observation: The sharded browser WASM prover can now generate a real destination-bound proof and verify it locally against the current pinned verifier.
  Evidence: A Playwright-driven run at `http://127.0.0.1:8787/` completed with stage `done`. The result reported `engine: "streampk-sharded-groth16"`, `verified_locally: true`, `wall_seconds: 587.624679936`, `ms: 583711`, `peak_heap_gib: 2.636474609375`, 50 PK range requests, 2,079,485,485 PK range bytes, and a Cardano proof artifact in the existing `groth16-bls12-381-bsb22` shape. The trace was saved locally at `experiments/wasm-prover/output/browser-sharded-trace-2026-07-08.json`, but that output directory is gitignored.

- Observation: The first completed trace says browser proof runtime is dominated by MSM scheduling and proving-key point movement, not CCS loading, path search, verification, or serialization.
  Evidence: The measured stage timings were `G2B: 113.235s`, `Z: 109.153s`, `A: 100.676s`, `B: 69.304s`, `K: 53.745s`, `solver: 52.851s`, `commitment BasisExpSigma MSM: 49.074s`, `commitment Basis MSM: 47.783s`, `computeH / FFT: 31.465s`, `open-ccs: 2.796s`, `find-path: 0.022s`, `verify: 0.015s`, and `serialize artifact: 0.001s`. The durable optimization backlog is now `experiments/wasm-prover/optimization-backlog.md`.

## Decision Log

- Decision: Keep all experimental code under `experiments/wasm-prover/` and do not import it from production packages.
  Rationale: The browser prover may be too slow, memory-heavy, or operationally awkward. Keeping it isolated prevents destabilizing the desktop helper, web reclaim flow, verifier pins, or contract-facing serialization.
  Date/Author: 2026-07-07 / Codex

- Decision: Target the current destination-bound ownership circuit first, not the older ownership-only proof.
  Rationale: The reclaim flow needs proof coverage plus destination binding. A successful browser proof for the older circuit would be interesting but would not prove the production-relevant path.
  Date/Author: 2026-07-07 / Codex

- Decision: Use the sibling `webprove` and `streampk` design as the first implementation model.
  Rationale: It has already demonstrated browser proving with sharded workers, range-read proving-key streaming, explicit memory tuning, and recorded end-to-end verification metrics.
  Date/Author: 2026-07-07 / Codex

- Decision: The wasm prover must fail closed when proving keys are absent; it must not silently create fresh keys.
  Rationale: A fresh local key would not match the hosted verifier or contract verifier, and silently generating one would make a proof artifact look meaningful when it is not usable in the real reclaim path.
  Date/Author: 2026-07-07 / Codex

- Decision: The experiment may use local dev fixtures only when clearly labeled, but promotion requires proof generation with the current pinned destination verifier artifacts.
  Rationale: Fixture mode proves control flow, not real credential proof validity or mainnet readiness.
  Date/Author: 2026-07-07 / Codex

- Decision: Use the staged preprod proof-assets release key bundle as the canonical local proving-key input for this experiment.
  Rationale: The staged release path has the same key identity as the deployment manifest and release inventory. The ceremony output is useful provenance, but the staged release is the closest local copy of what the desktop app and end-user proof-assets flow consume.
  Date/Author: 2026-07-07 / Codex

- Decision: Use the `compromised_user` preprod test wallet and the first payment credential in `deployments/reclaim/preprod/compromised_user_credentials.txt` as the first golden proof input.
  Rationale: The user identified this as the relevant golden vector, and the credential file is repo-backed evidence that the credential belongs to that seed phrase. Starting with path `m/1852'/1815'/0'/0/0` keeps the first proof smoke small and deterministic.
  Date/Author: 2026-07-07 / Codex

- Decision: Initially keep the wasm entrypoint as a stock-prover compatibility probe rather than presenting it as a browser proving implementation.
  Rationale: This was the safe first milestone because the repo did not yet have a streaming backend. It proved the stock path could compile and fail closed for browser URL artifacts instead of loading a 2 GB proving key through ad hoc JavaScript-visible buffers. This decision is now superseded for the experiment by the vendored `ProveStream` decision below.
  Date/Author: 2026-07-07 / Codex

- Decision: Vendor the sibling `ProveStream` patch for this experiment instead of copying it into a normal proof-tool package.
  Rationale: `ProveStream` must live in the gnark BLS12-381 Groth16 package to access unexported gnark helpers and internal packages. Vendoring lets the experiment build today while preserving the exact patch file under `experiments/wasm-prover/patches/`; a production path should use a reviewed fork or upstream change.
  Date/Author: 2026-07-07 / Codex

- Decision: Port the sibling worker-sharded MSM engine before treating browser proof performance as meaningful.
  Rationale: The CPU range-fetch engine tests memory streaming, but the sibling's best evidenced browser result used Web Workers and SharedArrayBuffer to split MSM work across cores. Sharded MSM is algebraically the same MSM partitioned into partial sums, and the port is guarded by native and Node worker-thread bit-exactness checks.
  Date/Author: 2026-07-07 / Codex

- Decision: Use a pinned precompiled destination CCS for browser proving.
  Rationale: The destination circuit is fixed for the current proof-assets bundle. Recompiling it in browser WASM wastes user time and memory before proof generation. Fetching a serialized CCS pinned by `constraint_system_hash` preserves circuit/key coherence while replacing `compile` with `open-ccs`.
  Date/Author: 2026-07-07 / Codex

- Decision: Keep the optimization track circuit-preserving and prioritize MSM scheduling, worker data movement, and proving-key transport before speculative prover or GPU rewrites.
  Rationale: The completed browser trace shows about 543 seconds in MSM-heavy stages out of about 588 seconds total. The highest-confidence near-term wins are safe worker over-sharding, raw PK range transport to workers, scalar encoding reuse, and commitment-vector range/raw streaming. Circuit size reduction is explicitly out of scope for this optimization pass.
  Date/Author: 2026-07-08 / Codex

## Outcomes & Retrospective

The experiment skeleton, key-section indexer, HTTP range source, wasm entrypoint, Node smoke script, tamper-check script, and browser harness have been added under `experiments/wasm-prover/`. The current implementation now includes a vendored gnark `ProveStream` patch, an experiment-local adapter that builds the small proving-key shell from `streampk.KeySource`, and the sibling worker-sharded MSM path.

The useful result so far is a precise dependency boundary plus a completed browser proof: this repo can index and range-serve the current destination proving key, the Go destination prover compiles to wasm, vendored gnark exposes the streaming `ProveStream` backend used by the sibling browser prover, the worker-sharded MSM transport has a bit-exact Node worker-thread check, and a sharded browser proof completed with local verification in about 587.62 seconds at about 2.636 GiB peak heap.

Do not promote this experiment into production. The next implementation step is to run tamper checks against the emitted artifact, add per-shard instrumentation, fix worker reply handling before over-sharding, and work through `experiments/wasm-prover/optimization-backlog.md`. A production path still needs a reviewed fork or upstreamable gnark change instead of quietly relying on a dirty vendor tree.

Update this section after each major milestone. At minimum, record whether tamper checks passed, which optimization was attempted, whether existing verification accepted the proof, which engine/config was used, wall-clock proof time, peak browser heap, and whether any secret-bearing value crossed into JavaScript-visible logs, storage, URLs, or network requests.

## Context and Orientation

The working repository is `/home/gumbo/playground/proof-zk-recovery/proof-tool`. All commands in this plan assume that directory as the working directory unless another path is explicitly named.

The project helps a Cardano user recover funds sent to contracts after a payment credential was compromised. The user proves that they control the uncompromised master private key that derives the affected 28-byte Cardano payment key credential. The proof must stay narrow: it proves derivability of a payment credential at a CIP-1852 path, not wallet balance, full wallet ownership, stake credential ownership, UTxO entitlement by itself, or address ownership beyond what the circuit and contracts actually bind.

Important terms used in this plan:

WebAssembly, or wasm, is a binary format that browsers can execute. Go can compile some programs to browser wasm with `GOOS=js GOARCH=wasm`.

A Web Worker is a browser background thread-like environment. Running proving work in a worker keeps the page responsive and reduces the chance that secret material is handled by visible UI code.

Groth16 is the zero-knowledge proof system used by this repo through the Go `gnark` library. A Groth16 proof lets a verifier check a statement without seeing the private witness. Here the private witness includes the master XPrv and derivation path.

A proving key is a large file used to create Groth16 proofs. It is not itself the user's secret, but it must match the circuit and verifying key. A verifying key is the matching public key used to verify proofs. A proof generated with the wrong proving key will not verify against the pinned verifier key.

A key bundle is this repo's local package of `manifest.json`, `ownership.pk`, and `ownership.vk`. The manifest records the key version, circuit id, hashes, and sizes. Production code must not silently create a new key bundle because that would break coherence with hosted and on-chain verifiers.

Destination-bound proof means a proof for `internal/circuit/ownershipdest`. It binds the target credential and a `destinationAddressV1` byte string into the public input. This is more relevant to reclaim than the older ownership-only proof because it helps prevent valid ownership proofs from being reused to redirect funds elsewhere.

Cardano proof bytes are not the same as the normal gnark proof JSON/base64 artifact. Contract-facing proof data must be emitted through this repo's serializer so it has the committed byte layout expected by the Plutus V3 verifier.

Cross-origin isolation is a browser security mode enabled by serving compatible `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers. It is required for `SharedArrayBuffer`, which the sibling sharded proof engine uses to split multi-scalar multiplication work across workers.

The current proof-tool code relevant to this experiment is:

- `packages/client-ts/src/index.ts` derives a 96-byte master XPrv from a seed phrase in browser TypeScript using WebCrypto.
- `internal/circuit/ownership/circuit.go` defines seed/master derivation helpers, `ownership.FindPath`, and the older ownership-only circuit.
- `internal/circuit/ownershipdest/circuit.go` defines the destination-bound circuit. Its circuit id is `root-ownership-destination-v1/bls12-381/groth16`, its public input encoding is `single-credential-destination-v1`, and its destination-address encoding is `destination-address-v1`.
- `internal/prover/prover.go` compiles circuits, loads key bundles, calls `groth16.Prove`, verifies proofs, and serializes Cardano proof and verifying-key bytes.
- `internal/helper/helper.go` contains the current native helper proof generator. `OwnershipGenerator.GenerateDestinationProofs` loads the destination proving key, compiles the destination circuit, finds the derivation path, builds the destination-bound assignment, proves, serializes the proof, and returns an `artifact.ProofArtifact`.
- `internal/artifact/artifact.go` defines the proof artifact JSON shape. Backend-bound artifacts must remove optional `path` and `paths` metadata unless the user explicitly opts into local debug/support export.
- `cmd/proof-tool/main.go` exposes CLI commands including `prove-destination`, `verify-destination`, `serve-helper`, and export commands.

The sibling browser-prover reference lives in `/home/gumbo/playground/proof-zk-recovery/proof-zk-recovery/proto/`. It is not the production proof-tool repo, but it contains useful working designs:

- `vending/prover/cmd/webprove/main.go` is a browser Go-wasm entrypoint. It registers `recoverProve(walletJSON, progressCb)` as a global JavaScript function, returns a Promise immediately, runs proving in a goroutine, loads artifacts over same-origin HTTP, chooses an MSM engine, and returns only public proof outputs and metrics.
- `browser/prover.js` loads `recovery-prover.wasm`, sets `GOMEMLIMIT=3200MiB` and `GOGC=15`, does not await the long-running `go.run(instance)`, waits for `__webproveReady`, and exposes test globals such as `__proveResult`.
- `vending/streampk/source.go` implements a `KeySource` that opens a proving key through a section index and streams large G1/G2 point vectors with bounded buffers instead of loading the full key into memory.
- `browser/e2e-metrics.json` records that the sibling browser proof verified in headless Chromium using a sharded engine with peak heap around 2.62 GiB and wall time around 822 seconds.

## Proof Assets and Golden Vector Preflight

Use this section before implementing the wasm prover. It identifies the current proof assets and the first proof input so a future agent does not lose time searching or accidentally proving against a fresh dev key.

The canonical local key bundle for this experiment is the staged preprod proof-assets release bundle:

    output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3

That directory must contain:

    manifest.json
    ownership.pk
    ownership.vk
    manifest.sig
    manifest-public-key.hex

The same key material also exists at:

    output/ceremony/ownership-destination-v1-preprod-d2c944d-r3

Treat the ceremony path as provenance and backup, not as the first input for the browser experiment. The staged release path is preferred because it matches the proof-assets release consumed by the desktop app.

The expected key identity is:

    key_version: ownership-destination-v1
    circuit_id: root-ownership-destination-v1/bls12-381/groth16
    vk_hash: blake2b256:6057da91b15dea8f8e93997f1b1944c35bc2c86faf9a9de17b814f6a172d430a
    proving_key_sha256: sha256:9222859a83740f21bebbbbdec3bad48b5369b6d432849410697b1612d71df550
    proving_key_blake2b256: blake2b256:853b407f842abe176030262e5da0c6035758c98a05306257222316b13001b1ef
    proving_key_size: 2079485517
    verifying_key_sha256: sha256:58adda429204f64b078d19362fdde8c9dad3cdc50763c5c75fe469391d2a1d94
    verifying_key_size: 784
    signature_key_id: preprod-local-destination-d2c944dd753c-r3

The matching preprod deployment manifest is:

    deployments/reclaim/preprod/live.local.json

It records the same verifier hash under `proof.vk_hash` and `reclaim_global.verifier_vk_hash`. It also records `proof.cardano_vk_blake2b256` as `blake2b256:d35ce80449fddb17cacbf922dfe27e57c28afcd59bee44bcef8eecbd7b317acf`.

The current release inventory is:

    docs/proof-assets-release-inventory.md

It identifies the public preprod proof-assets release tag as `proof-assets-ownership-destination-v1-preprod-d2c944d-r3`. This release is preprod-only and single-actor local setup provenance; it is not mainnet ceremony evidence.

For the first golden proof input, use the local preprod test wallet role `compromised_user`. This is a test mnemonic from `deployments/reclaim/preprod/test-wallets.local.json`; do not reuse it for mainnet or any real funds:

    gown cactus human cat slide give prepare update kite attitude author describe primary wise robot armor giraffe salon tide bomb assault there together bronze

The derived master XPrv can be regenerated with:

    go run ./cmd/proof-tool master-xprv-from-seed-phrase --seed-phrase "gown cactus human cat slide give prepare update kite attitude author describe primary wise robot armor giraffe salon tide bomb assault there together bronze"

On 2026-07-07 this printed:

    master_xprv: d890a94bf288d0ba559e7fd0e6052c4fea547286b72a40785542e3c83522c15a2d2c4fd23336a6525704951c484b92e1e49e749610531804fea7984bdd6dc96617520a156888c87d198bb685d2bf4c8b77a2d61ecd139b9f58b339962d3d116f

Use the first payment credential in `deployments/reclaim/preprod/compromised_user_credentials.txt` for the first proof smoke:

    path: m/1852'/1815'/0'/0/0
    target_credential: ebb6872afedbadc5ce334f36060562d36258aed3b5e436a3a5489786

The credential file contains additional payment credentials for indices 0 through 19 and stake credentials for role 2. For this wasm experiment, start with payment credentials only. Do not use stake credentials as proof targets because the destination-bound circuit proves payment credential derivation.

A destination-bound proof also needs a 58-byte `destinationAddressV1` value. The full claim flow normally derives this from the connected safe wallet and claim draft. For the first isolated wasm smoke, use the deterministic destination fixture pattern already present in `apps/ownership-proof-web/e2e/preprod/proof-stage.test.mjs`:

    safe_credential: 2a repeated 28 bytes
    destination_address_v1_hex: 01 + safe_credential + 00 + 00 repeated 28 bytes

Expanded, that destination is:

    012a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a0000000000000000000000000000000000000000000000000000000000

This destination is for proof mechanics only. Once the browser harness can prove and verify this fixture, add a UI field or safe-wallet-derived path so the user can supply a real `destinationAddressV1` value.

## Plan of Work

This plan has six implementation milestones. Each milestone must update `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` before stopping.

The first milestone creates an experiment skeleton only. Add `experiments/wasm-prover/README.md` explaining that the experiment is not production code, and add directories for a Go wasm entrypoint, a small browser harness, and local scripts. Do not wire this folder into `apps/ownership-proof-web` yet.

The second milestone proves whether the sibling streaming proving-key architecture can work with this repo's destination proving key. Start by reading `internal/prover/prover.go` functions `SavePK`, `LoadPK`, `ReadVK`, `SerializeCardanoProof`, and `SerializeCardanoVK`, then read the sibling `streampk` package. Add experiment-local code that can either reuse/adapt `streampk` or generate an equivalent section index for this repo's `ownership.pk`. The output of this milestone is a test or command that compares file-backed sections and HTTP-range-backed sections, and a stock verifier check that a streaming proof verifies.

The third milestone creates a Go wasm entrypoint under `cmd/wasm-prover/main.go`. It should expose `proveDestination(requestJson, progressCb)` to JavaScript. The request should include a master XPrv, target credential, destination address bytes, path search bounds, and artifact URLs or a local experiment descriptor for the circuit, verifying key, proving-key index, and proving key. The entrypoint must return a JavaScript Promise, run proving in a goroutine, keep the Go runtime parked, and return a JSON string or JavaScript object containing the backend proof artifact, Cardano proof fields, timing, engine name, and peak heap. It must not return the seed phrase, master XPrv, witness, or derivation path by default.

The fourth milestone runs the wasm module under Node before involving a browser. Use Go's `wasm_exec.js` from the local Go toolchain. Load repo-backed test inputs, call `proveDestination`, write the proof artifact to `experiments/wasm-prover/output/`, and verify it with the existing Go verifier path. This milestone is accepted only when the artifact verifies and deliberate tampering fails, or when the exact reproducible blocker is written into this ExecPlan.

The fifth milestone adds an experiment-only browser harness. It may be a tiny static page served by a local Go or Node server under `experiments/wasm-prover/web/`. The server must serve COOP and COEP headers so `crossOriginIsolated` is true. The harness should load the wasm module in a worker or worker-like isolated path, stream the proving key over HTTP range requests, show progress stages, and expose test-only globals for automation. It must not persist seed phrase, master XPrv, witness, or request bodies to localStorage, sessionStorage, URLs, analytics, logs, or server payloads.

The sixth milestone records a production-readiness verdict. If browser proving works, do not immediately replace the desktop helper. Instead, write a follow-up integration plan that keeps the desktop helper as fallback, adds browser capability checks, uses the same signed proof-assets descriptor and expected `vk_hash`, submits the same backend-bound artifact to the verifier, and preserves destination binding. If browser proving fails or is impractical, record the exact reason and keep the desktop helper as the production path.

## Concrete Steps

Start by confirming the repo and the current dirty tree. The tree may already contain unrelated user work; do not clean it.

    cd /home/gumbo/playground/proof-zk-recovery/proof-tool
    git status --short

Confirm the Go wasm runner files in the local Go toolchain. The exact path may vary by Go version, but on 2026-07-07 the local toolchain reported `/home/gumbo/.local/opt/go-1.26.0/lib/wasm/wasm_exec.js`.

    go env GOROOT
    find "$(go env GOROOT)" -name wasm_exec.js -o -name go_js_wasm_exec

Re-run the compile-level probe. This is idempotent because it writes only to `/tmp`.

    GOOS=js GOARCH=wasm go test -c ./internal/prover -o /tmp/proof-tool-prover.test.wasm
    ls -lh /tmp/proof-tool-prover.test.wasm

Expected observation: the first command exits zero and the second command shows a wasm file around tens of megabytes. If a later Go or dependency version fails to compile, record the exact compiler error in `Surprises & Discoveries` and make that the first implementation blocker.

Create the experiment skeleton. Use `apply_patch` or normal editor operations to add:

    experiments/wasm-prover/README.md
    cmd/wasm-prover/main.go
    experiments/wasm-prover/web/
    experiments/wasm-prover/output/.gitignore

The README must say this is an experiment, not production; it must list the exact commands added by the later milestones.

Inspect current destination prover behavior before writing the wasm entrypoint:

    rg -n "GenerateDestinationProofs|CompileOwnershipDestination|LoadOwnershipDestinationProver|CardanoProofArtifactWithDigest|SerializeCardanoProof|SavePK|LoadPK|ReadVK" internal cmd
    sed -n '240,330p' internal/helper/helper.go
    sed -n '120,190p' internal/prover/prover.go
    sed -n '345,540p' internal/prover/prover.go
    sed -n '560,710p' internal/prover/prover.go

Inspect the sibling reference if it exists on this machine:

    sed -n '1,260p' /home/gumbo/playground/proof-zk-recovery/proof-zk-recovery/proto/vending/prover/cmd/webprove/main.go
    sed -n '1,220p' /home/gumbo/playground/proof-zk-recovery/proof-zk-recovery/proto/browser/prover.js
    sed -n '1,340p' /home/gumbo/playground/proof-zk-recovery/proof-zk-recovery/proto/vending/streampk/source.go
    python3 -m json.tool /home/gumbo/playground/proof-zk-recovery/proof-zk-recovery/proto/browser/e2e-metrics.json

If the sibling checkout is absent, continue from the explanations in this ExecPlan. Do not block the experiment merely because the sibling source is unavailable.

Verify and record the current proof assets before writing experiment code:

    go run ./cmd/proof-tool verify-key-bundle --keys-dir output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3 --key-version ownership-destination-v1 --require-proving-key=true

Expected output includes:

    verified key bundle: output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3
    signature_key_id: preprod-local-destination-d2c944dd753c-r3
    vk_hash: blake2b256:6057da91b15dea8f8e93997f1b1944c35bc2c86faf9a9de17b814f6a172d430a

Derive the golden test master XPrv and confirm the first target credential exists:

    go run ./cmd/proof-tool master-xprv-from-seed-phrase --seed-phrase "gown cactus human cat slide give prepare update kite attitude author describe primary wise robot armor giraffe salon tide bomb assault there together bronze"
    sed -n '1,8p' deployments/reclaim/preprod/compromised_user_credentials.txt

Expected observations are the `master_xprv` shown in `Proof Assets and Golden Vector Preflight` and the first payment credential `ebb6872afedbadc5ce334f36060562d36258aed3b5e436a3a5489786` at path `m/1852'/1815'/0'/0/0`.

Build the streaming-key compatibility spike. Prefer copying/adapting only the minimal concepts needed: an index over the current proving key, an `io.ReaderAt` source, section readers for G1/G2 vectors, and bounded buffering. Do not import the sibling module directly unless the module boundaries are clean and tests prove it is safe. The destination proving key must be treated as an existing artifact; do not call `LoadOrCreateOwnershipDestinationBundle` from browser or production-shaped wasm code.

Add tests for the streaming source. At minimum, include:

    go test ./experiments/wasm-prover/...

Expected behavior: tests pass for file-backed section reads, HTTP range section reads, truncated range failure, wrong index failure, and missing section failure. If the experiment lives in the root Go module and package patterns make `./experiments/wasm-prover/...` awkward, document the exact replacement command here.

Build the wasm entrypoint:

    GOOS=js GOARCH=wasm go build -o experiments/wasm-prover/web/proof-destination.wasm ./cmd/wasm-prover

Expected behavior: the command exits zero and writes `experiments/wasm-prover/web/proof-destination.wasm`.

Run a Node smoke before browser work. The exact script name may be chosen during implementation, but it must live under `experiments/wasm-prover/web/` or `experiments/wasm-prover/scripts/`, and it must load Go's `wasm_exec.js`, instantiate the wasm, wait for the ready global, call `proveDestination`, and write a proof artifact under `experiments/wasm-prover/output/`.

    node experiments/wasm-prover/web/node-smoke.mjs

Expected behavior: the script prints the selected engine, elapsed time, peak heap or available memory metric, output artifact path, and verification result. A successful transcript should look like this shape:

    wasm ready: true
    proving stage: prove
    wrote experiments/wasm-prover/output/destination-proof.json
    verified: true

Run verifier and tamper checks. These may be a Go test, a Node script, or a CLI invocation, but they must prove both acceptance and rejection. Update this section with the exact command once implemented. The expected behavior is:

    valid artifact: verified true
    tampered target credential: rejected
    tampered destination address: rejected
    tampered public input: rejected
    tampered proof bytes: rejected
    wrong vk_hash: rejected

Run the browser harness. The harness server must set headers equivalent to:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

Start the harness with the implemented command, then open the printed URL in Chromium. The harness must display whether `crossOriginIsolated` is true, whether worker sharding is available, the current stage, proof time, wall time, peak heap, and verification status. If using Playwright or Puppeteer, the automation must read a test-only result global and write metrics to `experiments/wasm-prover/output/browser-e2e-metrics.json`.

Run baseline regression checks before considering any production integration:

    go test ./...
    pnpm --dir packages/client-ts test

If the local tree has unrelated dirty changes or missing dependencies that make full regression impractical, record the exact failure and run the narrower commands that exercise changed experiment code.

## Validation and Acceptance

The plan succeeds as an experiment only when a human can observe one of two clear outcomes.

The success outcome is a real destination-bound proof generated by Node wasm or browser wasm, verified by the existing proof-tool verifier. The proof artifact must have `schema` equal to `root-ownership-proof-artifact-v1`, `circuit_id` equal to `root-ownership-destination-v1/bls12-381/groth16`, `destination_address_encoding` equal to `destination-address-v1`, `public_input_encoding` equal to `single-credential-destination-v1`, and a `cardano` object containing contract-facing `proof_hex` and `public_input_digest_hex`. The backend-bound artifact must not include `path` or `paths` by default. Tampering target credential, destination address, public input, proof bytes, or `vk_hash` must fail verification.

For the first accepted proof smoke, the input must be the preflight golden vector: the `compromised_user` test mnemonic, target credential `ebb6872afedbadc5ce334f36060562d36258aed3b5e436a3a5489786`, the deterministic destination fixture beginning with `012a2a`, and the staged preprod proof-assets key bundle with `vk_hash` `blake2b256:6057da91b15dea8f8e93997f1b1944c35bc2c86faf9a9de17b814f6a172d430a`.

The failure outcome is also acceptable for this experiment if it is precise and reproducible. Examples of acceptable blockers are: the destination proving key format cannot be indexed safely, wasm memory grows past the browser limit, the Go wasm runtime cannot run the necessary gnark code, proof time is too long for realistic use, or browser security headers required for sharded proving conflict with the intended hosting model. A blocker is not acceptable unless this ExecPlan records the exact command, exact error, what was already verified, and the next command to resume after the blocker is resolved.

The browser harness is accepted only if the visible page or automation output shows:

- `crossOriginIsolated` state.
- selected engine, such as `sharded` or `cpu`.
- proof stage progress.
- wall seconds.
- proving milliseconds if available separately.
- peak heap GiB or the closest available memory measure.
- `verified: true` for a valid proof, or a precise blocker.

The security acceptance criteria are:

- Seed phrase, master XPrv, and private witness values do not appear in URLs, localStorage, sessionStorage, server logs, browser console logs, analytics, output artifacts, or network requests except as intentionally supplied to the local experiment wasm boundary.
- The wasm code does not create fresh proving keys when keys are missing.
- The proof artifact format is the existing repo format, not a new proof schema.
- The Cardano proof bytes come from the existing serializer path or a proven equivalent.

## Idempotence and Recovery

All experiment files must be additive under `experiments/wasm-prover/` except this plan document. Re-running build commands should overwrite generated wasm and output files under `experiments/wasm-prover/web/` and `experiments/wasm-prover/output/` without touching production app files.

Do not clean the repository or revert unrelated dirty files. This worktree already had many unrelated modifications before this ExecPlan was written. If a generated proof, key index, browser metric file, or wasm artifact is too large for git, add an experiment-local `.gitignore` entry and document where to regenerate it.

If a command fails halfway, do not delete key bundles or production artifacts. Capture the exact error in `Surprises & Discoveries`, update `Progress`, and rerun only the failed experiment command after fixing the cause.

If browser proving is too slow or crashes the browser tab, lower ambition before changing production code. First try Node wasm, then browser CPU, then browser sharded mode with cross-origin isolation. If all fail, record the blocker and keep the desktop helper as the production path.

## Artifacts and Notes

Initial compile probe evidence from 2026-07-07:

    cd /home/gumbo/playground/proof-zk-recovery/proof-tool
    GOOS=js GOARCH=wasm go test -c ./internal/prover -o /tmp/proof-tool-prover.test.wasm
    ls -lh /tmp/proof-tool-prover.test.wasm
    -rwxr-xr-x 1 gumbo gumbo 20M Jul  7 14:45 /tmp/proof-tool-prover.test.wasm

Plain `go test` with `GOOS=js GOARCH=wasm` is expected to fail in this shell unless a wasm-aware runner is configured:

    GOOS=js GOARCH=wasm go test ./internal/prover
    fork/exec /tmp/go-build.../prover.test: exec format error
    FAIL proof-tool/internal/prover 0.001s

Sibling browser-prover metric evidence:

    {
      "engine": "sharded",
      "verified": true,
      "peakHeapGiB": 2.621337890625,
      "wallSeconds": 821.986,
      "crossOriginIsolated": true,
      "hardwareConcurrency": 24,
      "runtime": "headless-chromium-puppeteer",
      "timestamp": "2026-06-30T15:32:04.932Z"
    }

Proof-assets preflight evidence from 2026-07-07:

    go run ./cmd/proof-tool verify-key-bundle --keys-dir output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3 --key-version ownership-destination-v1 --require-proving-key=true
    warning: using bundled manifest-public-key.hex; this checks integrity but does not establish signer trust
    verified key bundle: output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3
    signature_key_id: preprod-local-destination-d2c944dd753c-r3
    vk_hash: blake2b256:6057da91b15dea8f8e93997f1b1944c35bc2c86faf9a9de17b814f6a172d430a

Keep future successful or failed transcripts short and append them here. Do not paste secret-bearing input values.

## Interfaces and Dependencies

The experiment should use the existing Go packages rather than reimplementing proof semantics.

Use `internal/circuit/ownership.FindPath(masterXPrv, targetCredential, opts)` to find the CIP-1852 account, role, and index that derive the target credential.

Use `internal/circuit/ownershipdest.PublicInputForCredentialDestination(targetCredential, destination)` and `internal/circuit/ownershipdest.Assignment(masterXPrv, path, destination, publicInput)` to build the destination-bound circuit assignment.

Use `internal/prover.CompileOwnershipDestination()` to compile the destination circuit unless the milestone produces a precompiled constraint-system artifact for browser loading. If a precompiled constraint system is introduced, document its generation command and hash.

Use `internal/prover.Prove(ccs, provingKey, assignment)` for the first stock path. If stock proving cannot fit in wasm memory, introduce an experiment-local streaming prover adapter modeled on the sibling `ProveStreaming` path. The adapter must be verified against stock gnark verification on the same public input.

Use `internal/prover.MarshalProof(proof)` for backend verification and `internal/prover.CardanoProofArtifactWithDigest(proof, publicInputDigest)` for contract-facing proof bytes.

Use `internal/artifact.ProofArtifact` as the output schema. The wasm path must emit the same fields as the native destination helper:

    artifact.ProofArtifact{
      Schema:                     artifact.ProofSchema,
      CircuitID:                  ownershipdest.CircuitID,
      VKHash:                     bundle.Manifest.VKHash,
      TargetCredential:           hex.EncodeToString(targetCredential),
      DestinationAddressEncoding: ownershipdest.DestinationAddressEncoding,
      DestinationAddress:         hex.EncodeToString(destinationAddress),
      PublicInputEncoding:        ownershipdest.PublicInputEncoding,
      PublicInput:                ownershipdest.PublicInputHex(publicInput),
      Proof:                      encodedProof,
      Cardano:                    cardanoProof,
      Path:                       nil,
    }

The JavaScript-facing wasm function should have a stable shape:

    proveDestination(requestJson, progressCallback) -> Promise<object>

The request JSON should have this shape unless implementation evidence requires a change:

    {
      "master_xprv_hex": "...",
      "target_credential_hex": "...",
      "destination_address_hex": "...",
      "search": {
        "account": 0,
        "role": 0,
        "index": 0,
        "max_account": 9,
        "max_index": 999
      },
      "artifacts": {
        "manifest_url": "manifest.json",
        "ccs_url": "ownership-destination.ccs",
        "vk_url": "ownership-destination.vk",
        "pk_url": "ownership-destination.pk",
        "pk_index_url": "ownership-destination.idx.json"
      }
    }

For the first golden smoke, instantiate that request with:

    {
      "master_xprv_hex": "d890a94bf288d0ba559e7fd0e6052c4fea547286b72a40785542e3c83522c15a2d2c4fd23336a6525704951c484b92e1e49e749610531804fea7984bdd6dc96617520a156888c87d198bb685d2bf4c8b77a2d61ecd139b9f58b339962d3d116f",
      "target_credential_hex": "ebb6872afedbadc5ce334f36060562d36258aed3b5e436a3a5489786",
      "destination_address_hex": "012a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a0000000000000000000000000000000000000000000000000000000000",
      "search": {
        "account": 0,
        "role": 0,
        "index": 0,
        "max_account": 9,
        "max_index": 999
      },
      "artifacts": {
        "key_bundle_dir": "output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3"
      }
    }

The result object should have this shape:

    {
      "artifact": { "...": "existing ProofArtifact JSON" },
      "engine": "cpu or sharded",
      "ms": 12345,
      "wall_seconds": 12.345,
      "peak_heap_gib": 2.5,
      "verified_locally": true
    }

The progress callback should receive plain public stage data only:

    { "stage": "fetch-vk", "frac": 0.10 }
    { "stage": "open-pk", "frac": 0.15 }
    { "stage": "witness", "frac": 0.20 }
    { "stage": "prove", "frac": 0.30 }
    { "stage": "verify", "frac": 0.92 }
    { "stage": "done", "frac": 1.0 }

Do not include seed phrase, master XPrv, witness scalars, derivation path, or full request JSON in progress messages or errors.

## Revision Notes

2026-07-07 / Codex: Converted the previous lightweight browser-wasm prover plan into a self-contained ExecPlan. The rewrite adds required living-document sections, plain-language context, concrete commands, validation criteria, idempotence guidance, interface shapes, and explicit evidence from the current repo and sibling browser prover. The change was made because the user requested that the plan be made into an ExecPlan.

2026-07-07 / Codex: Added the current proof-assets path and golden vector preflight after the user identified the compromised-user mnemonic and credential file. This revision records the staged preprod release key bundle, expected hashes, local verification command, first payment credential, deterministic destination fixture, and first request JSON so implementation can start without searching for canonical proof inputs.
