# Integrate Browser WASM Proving Into the Webapp Claim Flow

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

No `PLANS.md` file exists in this repository or its parent directories. This document follows the same self-contained ExecPlan format as `docs/browser-wasm-prover-experiment-plan.md` and `docs/browser-wasm-prover-proving-time-optimization-plan.md`.

2026-07-08: Rewritten from scratch. The original version of this plan predated the O1/O2/O4 proving-time optimizations and the expanded WASM entrypoint. The prover is now at ~115.9 s wall / ~2.32 GiB peak heap for a verified destination-bound proof (`o4-o2-section-commitment-w8-s32-rf2-local7`), the tamper-rejection gate has passed, and the entrypoint already ships `preflightProofAssets` with full manifest/signature/chunk pinning. This rewrite reflects that reality and adds the extraction plan (what leaves `experiments/`, and where it lands).

## Purpose / Big Picture

Today the claim webapp requires Proof Helper Desktop before it can create destination-bound ownership proofs. The website keeps the recovery phrase out of hosted services, derives the master XPrv in a browser worker (`packages/client-ts` worker, PBKDF2-HMAC-SHA512), sends that master key only to a loopback helper, and validates the helper's returned proof artifacts against the current claim draft.

The browser WASM experiment has now produced a real, locally verified, destination-bound proof in-browser at practical cost: **115.9 s wall, 2.32 GiB peak heap** with the current pinned preprod proof assets (engine `streampk-sharded-groth16`, 8 workers, 32 shards, range-fetch concurrency 2, pinned decode, GOGC=50, GOMEMLIMIT=3000MiB). Deliberate tamper variants are rejected by `verify-tamper.mjs`. This plan promotes that capability into the claim funds page as a second proof provider.

After this plan is implemented, the webapp has one proof-generation contract and two providers:

- `desktop-helper`: the current loopback Proof Helper Desktop route (`POST ${helperUrl}/prove-destination`), unchanged and remaining the default.
- `browser-wasm`: a browser route that loads the Go WASM prover, streams pinned proof assets over HTTP range requests, and emits the same backend-bound proof artifact shape.

Both providers must return artifacts that pass the existing client gate (`validateDestinationProofResponse` in `ClaimFlow.tsx`) and the existing server gate (`assertProofArtifacts` in `lib/claim-server/build-submit.ts`, including blake2b public-input digest recomputation) before claim transactions can be built or submitted. This plan does not broaden the proof claim. The proof remains a destination-bound derivability proof for a Cardano payment key credential at a CIP-1852 path.

## Progress

Carried forward (already done before this rewrite):

- [x] (2026-07-08) Step 5 UI shell exists in `ClaimFlow.tsx`: `Local proof method` summary tile, `LocalProofMethodDialog` ("Choose how to create proofs") with `Proof Helper Desktop` and `Prove in this browser` options, desktop routing into `ProofHelperInstallDialog`, and browser selection hard-blocked via `proofBlocked` with copy "Browser proving is not enabled for this build yet."
- [x] (2026-07-08) Tamper-rejection gate passed: `node experiments/wasm-prover/scripts/verify-tamper.mjs` rejected flipped target credential, flipped destination address, mutated public input, mutated proof bytes, and wrong `vk_hash` against both the O1 and O4/O2 artifacts, and accepted the valid artifacts.
- [x] (2026-07-08) Performance target reached: `o4-o2-section-commitment-w8-s32-rf2-local7.summary.json` records `prove_ms: 111461`, `wall_seconds: 115.900`, `peak_heap_gib: 2.3156`, `verified_locally: true`, `contaminated: false`.
- [x] (2026-07-08) WASM entrypoint hardened: `main_js.go` registers `proveDestination`, `preflightProofAssets`, and `__wasmProverReady`; URL-mode asset opening enforces manifest schema/key-version/circuit checks, VK hash/size pinning, PK index size pinning, optional detached signatures, chunk-manifest + reclaim-deployment cross-validation, and hash pinning of `proof-destination.wasm`, `worker.js`, and `msmworker.wasm`.

Remaining (this plan):

- [x] (2026-07-08) Milestone 1: Extract the prover Go packages and JS runtime out of `experiments/` into production locations; decide and execute the gnark `ProveStream` dependency strategy; add a reproducible build pipeline for `proof-destination.wasm` and `msmworker.wasm` with recorded hashes. Done: packages moved to `internal/msmengine`, `internal/streampk`, `internal/streamprove`, `cmd/wasm-prover`, `cmd/msmworker`; `scripts/build-wasm-prover.sh` builds reproducibly (two clean builds, identical hashes; manifest in `dist/proof-runtime/runtime-manifest.json`); the real vendor diff was captured into `experiments/wasm-prover/patches/prove-stream.patch` (it had been EMPTY — see Surprises) and guarded by `scripts/check-vendor-drift.sh`, `scripts/bootstrap-vendor.sh`, and `.github/workflows/vendor-drift.yml`. Gnark fork creation itself is deferred to the Milestone 7 provenance review (needs a repo Philip controls).
- [x] (2026-07-08) Milestone 2: `BrowserProvingDescriptor` in `lib/reclaim/types.ts`, validated in `lib/reclaim-server/manifest.ts` (`proof.browser_proving`, same-origin enforcement for runtime URLs, tuning validation), surfaced via `capabilities.browserProving` (tests in `manifest.test.ts`). Chunk manifest regenerated against the M4 runtime files (`generate-chunk-manifest`, 124 chunks, `worker.js` pin == staged `msm-worker.js`); assets staged via `scripts/stage-proof-assets.sh` into `public/proof-runtime` + `public/proof-assets` (small, same-origin) with the PK/CCS held back for the ranged host. Acceptance PASSED: `preflightProofAssets` through the production `prover-worker.js` against the staged assets returned `ok:true` with the expected `vk_hash`/`chunk_manifest`/`deployment_id`, and a ranged PK fetch was byte-identical to the bundle (see `docs/browser-proving-asset-hosting.md`). Remaining for M7/Philip: the real ranged asset host for `ownership.pk`/`ownership-destination.ccs` (descriptor `pk_url`/`ccs_url` currently point at a placeholder host).
- [x] (2026-07-08) Milestone 3: COOP `same-origin` + COEP `require-corp` applied site-wide in `next.config.mjs` `headers()` (audit found zero cross-origin subresources; site-wide scope avoids the SPA-navigation isolation pitfall), CORP `same-origin` + immutable caching on `/proof-runtime/*` and `/proof-assets/*`. Verified in headless Chromium: `crossOriginIsolated === true` and `SharedArrayBuffer` constructible on `/claim` and `/`. Lace/CIP-30 signing regression still to be exercised via the e2e stage (Milestone 6).
- [x] (2026-07-08) Milestone 4: Provider layer in `lib/proving/` — `types.ts` (provider contract, worker protocol), `desktop-helper.ts` (behavior-preserving POST extraction), `capability.ts` (WASM/worker/isolation/SAB/nested-worker/hardware checks + device-memory warning), `browser-wasm.ts` (worker lifecycle, sequential prove loop, asset preflight + vk_hash gate, AbortSignal → terminate, error/hex redaction). Runtime files `public/proof-runtime/prover-worker.js` (orchestrator) and `msm-worker.js` (MSM kernel, GOGC/GOMEMLIMIT via URL query string, chunk verification + zeroing preserved). Nested-worker orchestration confirmed working in headless Chromium (crossOriginIsolated + SharedArrayBuffer across the nested boundary) — no main-thread fallback needed.
- [x] (2026-07-08) Milestone 5: `ClaimFlow` wired — `proofMethod`/`browserProvingStatus` lifted to the flow, `LocalProofMethodDialog` shows live preflight results and blocks Continue until ready, `proofBlocked` now `browserSelected && status !== "ready"`, `generateClaimProofs` branches to `proveDestinationInBrowser` with an `AbortController`, `CreateProofsGenerating` shows engine label + N-of-M + stage/percent + Cancel + keep-tab-open warning, beforeunload guard while a browser proof runs, `masterBytes.fill(0)` in `finally`. Resume snapshot shape unchanged. Verified: 31 ClaimFlow unit tests green; fixture UI drives the browser-method dialog in headless Chromium with zero page errors.
- [x] (2026-07-08) Milestone 6: unit coverage — `lib/proving/browser-wasm.test.ts` (10 tests: sequential prove, progress redaction against a serialized event stream, verified-locally/vk-hash gates, abort→terminate, hex sanitization), `lib/proving/capability.test.ts` (8 tests: isolation/SAB/cores/nested-worker/descriptor), extended `manifest.test.ts` (browser_proving validation), and `ClaimFlow.test.tsx` (browser-method blocked-until-ready + tile). E2e: `RECLAIM_E2E_PROOF_PROVIDER` parameterization in `e2e/preprod/` (default `desktop-helper` unchanged; `browser-wasm` routes to the UI stage and fails closed with a named error when no hosted descriptor is present — 98 e2e tests pass). Full webapp suite: 234 tests green.
- [x] (2026-07-08) Milestone 7 (local acceptance + provenance; hosted run pending Philip): a full browser proof through the production `prover-worker.js` + nested `msm-worker.js` orchestration produced a **`streampk-sharded-groth16` proof in 122.3 s / 2.313 GiB, `verified_locally: true`, no CPU demotion** — at the target envelope. The browser artifact passed `verify-destination` (CLI: `verified`) and the tamper gate (`verify-tamper.mjs`: valid accepted, all five tamper classes rejected). Reproducible build confirmed (two clean `build-wasm-prover.sh` runs → identical sha256 for both wasm binaries and wasm_exec.js). gnark patch reviewed: purely additive (`ProveStream`, `VectorSource`, section-MSM helpers, wasm GC-suspension; existing `Prove` untouched). Secrets audit: no xprv/seed/path in the artifact, no console logging or xprv in the worker files, progress-redaction asserted in tests. **Remaining for Philip:** stand up the reviewed gnark fork repo + `replace` directive (interim drift-check CI is live); host the ~2.08 GB PK + 187 MB CCS on the real ranged host and flip `browser_proving.enabled`; run hosted e2e on one modest (≤8 GB/4-core) and one fast profile.

## Surprises & Discoveries

- Observation: The prover is ~5x faster than when this plan was first written, at lower memory.
  Evidence: The first sharded browser proof was 587.6 s / 2.64 GiB (w8/s8/rf4). After M1/O1/O2/O4 (pinned decode of hash-pinned PK points, worker-owned section fetch for commitment `Basis`/`BasisExpSigma`, computeH overlap, GC suspension around `r1cs.Solve`), the clean local7 run is 115.9 s / 2.32 GiB at w8/s32/rf2, GOGC=50, GOMEMLIMIT=3000MiB. Note: the w16/s64 "worker-owned" configs are *slower* (346–360 s); the winning config is w8/s32/rf2 with pinned decode. Do not assume more workers/shards is better.

- Observation: The tamper gate the old plan listed as outstanding has passed.
  Evidence: `docs/browser-wasm-prover-proving-time-optimization-plan.md` Outcomes records `verify-tamper.mjs` passing (valid accepted; five tamper classes rejected) against the O1 and O4/O2 artifacts. The experiment plan's "outstanding" note on tamper evidence is stale.

- Observation: The WASM entrypoint already implements most of the asset preflight this plan needs.
  Evidence: `experiments/wasm-prover/cmd/wasm-prover/main_js.go` exposes `preflightProofAssets(requestJson)` returning `{ok, vk_hash, constraints, chunk_manifest, chunks, chunk_size, deployment_id, signature_key_id}`, and its URL mode verifies manifest signatures, chunk manifests, deployment manifest cross-checks, and runtime-file hash pins before any proving.

- Observation: The webapp has two independent artifact gates, and both recompute semantics rather than trusting the provider.
  Evidence: Client: `validateDestinationProofResponse` (ClaimFlow.tsx ~4036) checks profile, artifact count, out_ref order, `vk_hash`, target credential, destination encoding/bytes, and recursively rejects any `path`/`paths` key. Server: `assertProofArtifacts` (lib/claim-server/build-submit.ts ~342) additionally pins `schema`, `circuit_id`, `public_input_encoding`, `cardano.format`, and recomputes `destinationPublicInputDigest` (blake2b) and requires a match. The browser provider does not need new validation logic — it needs to produce artifacts that already pass these gates. The Go side already emits backend shape via `artifact.BackendProofArtifact()`.

- Observation: The webapp currently has no COOP/COEP headers anywhere.
  Evidence: `apps/ownership-proof-web/next.config.mjs` has no `headers()` and there is no `middleware.*`. The sharded engine requires `crossOriginIsolated === true` (SharedArrayBuffer). This is a real integration workstream, not a config one-liner: COEP `require-corp` constrains every cross-origin subresource on affected pages.

- Observation: The experiment runs the Go runtime on the page main thread; production should not.
  Evidence: `experiments/wasm-prover/web/browser-prover.js` calls `go.run(instance)` on the main thread and the MSM shards run in `worker.js` workers. For the claim page, the orchestrator wasm should run in a dedicated module worker (nested workers spawn the MSM workers) so a ~2-minute proof cannot jank React or be tied to component lifecycle. Nested `Worker` construction and `fetch` are available in worker scopes in current Chrome/Firefox/Safari; verify during Milestone 4 that `msmengine/sharded_js.go`'s `newWorker` path works from inside a worker.

- Observation: The MSM worker kernel runs with default Go GC settings.
  Evidence: `web/worker.js` creates `new Go()` without setting `GOGC`/`GOMEMLIMIT` (flagged as the O5 concern). Per-worker heap is currently untracked; on low-RAM user machines this is the most likely OOM source. Production worker bootstrap should set explicit limits and the preflight should record `navigator.deviceMemory`.

- Observation: `ProveStream` exists only via a dirty vendored gnark tree.
  Evidence: `go.mod` pins `gnark v0.15.0` with **no replace directive**; the streaming prover comes from `go mod vendor` + `git apply -p0 experiments/wasm-prover/patches/prove-stream.patch`, and O1/O2/O4 further mutated the vendored `prove.go`. Any teammate running `go mod vendor` silently loses the prover. This is the single biggest promotion blocker.

- Observation: Most of the experiment's Go code is already production-shaped and lightly coupled.
  Evidence: `msmengine` imports no `proof-tool/internal` packages at all; `internal/streampk` imports only `proof-tool/internal/proofassets` (index types/constants); `internal/streamprove` imports only gnark + streampk. Extraction is mostly a move + import-path rewrite, not a rewrite.

- Observation: Proof assets are far too large for Next.js `public/`.
  Evidence: PK is 2,079,485,517 bytes (range-fetched, ~2.08 GB), CCS is 187,120,157 bytes, PK index sections A/B/Basis/BasisExpSigma/G2B/K/Z with G2B alone at 487 MB. Only the runtime files (`proof-destination.wasm`, `msmworker.wasm`, worker JS, `wasm_exec.js`, manifests, VK at 784 bytes, `ownership.pk.idx.json`) are plausibly same-origin. The PK and CCS need a dedicated ranged asset host.

- Observation: Batch size multiplies proof time; the UI must plan for ~2–10 minutes.
  Evidence: `CLAIM_DEFAULT_BATCH_CAP=4`, `CLAIM_HARD_BATCH_CAP=5` (`lib/claim/types.ts`); `proveDestination` proves one request. Five proofs at ~116 s each is roughly 10 minutes sequential (per-proof asset state is reused after first load, but MSM work dominates). `CreateProofsGenerating` currently shows an indeterminate spinner with hardcoded `0 of N`; browser mode needs real `current/total` + stage/fraction progress.

- Observation (2026-07-08, M1): `experiments/wasm-prover/patches/prove-stream.patch` was EMPTY (0 bytes) and `vendor/` is entirely gitignored — the streaming prover existed only as bytes on one disk, invisible to git and to any fresh clone.
  Evidence: `wc -l` on the patch returned 0; `git ls-files vendor/` returned nothing; `.gitignore` line 22 ignores `vendor/`. Resolution: re-vendored to a scratch dir (`go mod vendor -o`), diffed — exactly one file differs (`backend/groth16/bls12-381/prove.go`, +360 lines: `ProveStream`, `VectorSource`, msmengine seam) — and wrote that diff back into the patch (verified: pristine + patch round-trips byte-identically). `scripts/check-vendor-drift.sh` fails on any future divergence, `scripts/bootstrap-vendor.sh` is the only supported way to (re)create `vendor/`, and `.github/workflows/vendor-drift.yml` proves the bootstrap builds on every push.

- Observation (2026-07-08, M1): the hand-patched vendored `prove.go` imports `proof-tool/experiments/wasm-prover/msmengine` — the OLD package path — so the extraction could not simply delete that path.
  Evidence: import block of `vendor/github.com/consensys/gnark/backend/groth16/bls12-381/prove.go`. Resolution: `experiments/wasm-prover/msmengine/shim.go` forwards the four identifiers the vendored code uses (type aliases preserve type identity). Delete the shim when the gnark fork lands and imports `proof-tool/internal/msmengine` directly.

- Observation (2026-07-08, M3): the webapp has zero cross-origin subresources anywhere (one same-origin `<img>`, no external fonts/scripts/CDNs), and COOP/COEP isolation is fixed per-document at load time.
  Evidence: repo-wide grep for external `src=`/`href=`/`url()`; Playwright check `crossOriginIsolated === true` on `/claim` and `/`. Consequence: headers are applied site-wide rather than scoped — a client-side (SPA) navigation from a non-isolated landing document onto `/claim` would otherwise leave the claim page non-isolated even with correct per-route headers.

- Observation (2026-07-08, M4/M7): nested-worker orchestration from a dedicated worker works, and the dedicated worker inherits cross-origin isolation.
  Evidence: a headless probe showed `crossOriginIsolated === true` on the page, in the dedicated worker, and in a nested worker; SharedArrayBuffer constructs and transfers across the nested boundary; the real `msm-worker.js` spawned as a child from a dedicated worker replied `ready`. No main-thread-orchestration fallback needed.

- Observation (2026-07-08, M7): the chunk-manifest `base_url` MUST carry a trailing slash, or the sharded engine silently degrades to CPU.
  Evidence: `internal/msmengine/sharded_js.go` `resolveChunkURL` uses `base.ResolveReference`; against `https://host/proof-assets` (no trailing slash) a relative chunk path resolves to `https://host/<chunk>` (segment dropped) → 404 → `WithFallback` logs `demoting from "sharded" to cpu` and streams the whole PK via `pk_url` instead. Symptom: proofs still succeed and verify, but engine is `streampk-cpu-groth16` at ~500 s instead of `streampk-sharded-groth16` at ~120 s. Documented in `docs/browser-proving-asset-hosting.md`; always pass `--base-url https://host/proof-assets/`.

- Observation (2026-07-08, M7): the extracted production runtime reproduces the experiment's performance envelope.
  Evidence: a full proof through the production `prover-worker.js` + `msm-worker.js` (staged assets, w8/s32/rf2, GOGC 50, GOMEMLIMIT 3000MiB) measured 122.3 s wall / 2.313 GiB peak heap / `verified_locally: true`, against the experiment's 115.9 s / 2.32 GiB. The browser artifact verified via `verify-destination` and survived the five-class tamper gate.

## Decision Log

Carried forward (still valid):

- Decision: Integrate WASM proving as a proof provider, not as a separate page or artifact format.
  Rationale: The claim flow already has draft ordering, destination binding, backend build, signing, and submit semantics. A second flow risks accepting artifacts not tied to the selected safe wallet and draft.
  Date/Author: 2026-07-08 / Codex

- Decision: Proof Helper Desktop remains the default and the always-available fallback.
  Rationale: Browser proving still depends on cross-origin isolation, ~2 GB ranged asset streaming, ~2.3 GiB heap headroom, and a long runtime. Desktop is faster and works on browsers/machines that fail the preflight.
  Date/Author: 2026-07-08 / Codex

- Decision: The browser provider must consume signed and pinned proof assets; it must never generate keys.
  Rationale: A fresh proving key would not match the hosted/on-chain verifier; the entrypoint's URL mode already enforces this.
  Date/Author: 2026-07-08 / Codex

- Decision: Provider choice happens on the Create proofs step, before the recovery phrase is read; capability preflight runs before phrase entry is accepted for the browser path.
  Rationale: If the browser cannot prove, fail or fall back before any seed material exists in page memory. The dialog footer copy already promises this: "Seed phrase stays local and is read only after you choose a method."
  Date/Author: 2026-07-08 / Codex

- Decision: User-facing labels are `Proof Helper Desktop` and `Prove in this browser`; `desktop-helper`/`browser-wasm` are internal IDs only. The desktop option keeps routing into the existing `ProofHelperInstallDialog`.
  Date/Author: 2026-07-08 / Codex

New decisions (this rewrite):

- Decision: Extract the Go prover into first-class packages: `experiments/wasm-prover/msmengine` → `internal/msmengine`; `experiments/wasm-prover/internal/streampk` → `internal/streampk`; `experiments/wasm-prover/internal/streamprove` → `internal/streamprove`; `experiments/wasm-prover/cmd/wasm-prover` → `cmd/wasm-prover`; `experiments/wasm-prover/cmd/msmworker` → `cmd/msmworker`; keep `cmd/pkindex` and `cmd/ccsgen` logic with the existing release/asset tooling (fold into `internal/proofassets` tooling if a natural home exists).
  Rationale: The packages are already decoupled (see Surprises). `internal/` placement keeps them out of the public module surface while making the webapp's prover a supported build product. `experiments/wasm-prover/` retains only benchmark harnesses, traces, and the optimization backlog until O3–O7 conclude.
  Date/Author: 2026-07-08 / Claude

- Decision: The JS runtime is rewritten in TypeScript inside the webapp, not copied. `web/browser-prover.js` becomes `apps/ownership-proof-web/lib/proving/` modules plus a dedicated prover worker; `web/worker.js` becomes a built, hash-pinned MSM worker script. Golden-vector defaults, `__defaultProofRequest`, benchmark globals, and the GOROOT-served `wasm_exec.js` do not cross over; a pinned copy of `wasm_exec.js` matching the Go toolchain version is vendored into the build.
  Rationale: The experiment harness contains test-only globals and a hardcoded golden master XPrv that must never ship. The MSM worker's hash is pinned by the manifest, so it must be a deterministic build artifact, not a dev-served file.
  Date/Author: 2026-07-08 / Claude

- Decision: Run the Go orchestrator wasm in a dedicated module worker (which spawns the MSM workers), not on the main thread.
  Rationale: Keeps the page responsive for the full proof duration, survives React re-renders, and lets termination be a clean `worker.terminate()`. Contingency: if nested-worker spawning from `sharded_js.go` fails anywhere we support, fall back to main-thread orchestration as the experiment does today and record the decision.
  Date/Author: 2026-07-08 / Claude

- Decision: Gate the feature on a deployment-level descriptor, not a client env flag alone. `ReclaimDeployment.proof` gains an optional `browser_proving` block (asset URLs + pins + enablement); `/claim-api/deployment` surfaces it in capabilities. No descriptor ⇒ the browser option renders exactly as today (visible, guarded, "not enabled for this build").
  Rationale: Asset identity is deployment-specific (vk_hash, key bundle, signature key). Tying enablement to the deployment config keeps one source of truth and makes rollback a config change.
  Date/Author: 2026-07-08 / Claude

- Decision: Asset hosting is split: small runtime files (`proof-destination.wasm`, `msmworker.wasm`, prover worker JS, `wasm_exec.js`, `manifest.json` + sig, `ownership.vk`, `ownership.pk.idx.json`, `chunk-manifest.json` + sig, `reclaim-deployment.json`) are served same-origin under `public/proof-runtime/` and `public/proof-assets/`; the PK (~2.08 GB) and CCS (~187 MB) live on a dedicated ranged asset host with `Accept-Ranges: bytes`, correct `Cross-Origin-Resource-Policy`/CORS, and no content-encoding transforms (the worker rejects non-`identity` encodings).
  Rationale: Everything the browser executes or trusts as an integrity root is same-origin and hash-pinned; only bulk, hash-verified data streams cross-origin. Next.js `public/` cannot reasonably carry 2 GB.
  Date/Author: 2026-07-08 / Claude

- Decision: Prove sequentially within a batch, reusing the loaded runtime and asset state across `draft.proofRequests`.
  Rationale: Peak heap of 2.32 GiB per proof leaves no headroom for parallel proofs; sequential keeps the memory envelope flat and progress reporting simple (`current`/`total`).
  Date/Author: 2026-07-08 / Claude

- Decision: gnark strategy — maintain a reviewed fork (`Anastasia-Labs/gnark` or equivalent) carrying the `ProveStream` + msmengine-seam commits, referenced via a `replace` directive, replacing the dirty-vendor + patch workflow. Interim acceptance for the experimental flag phase only: keep the vendored tree but make CI verify `vendor/` matches `go mod vendor + prove-stream.patch` exactly, so drift is impossible to miss.
  Rationale: A patch applied by hand to `vendor/` is invisible to `go.mod`, silently lost by re-vendoring, and unauditable. A pinned fork commit is reviewable and reproducible. Upstreaming remains the long-term goal.
  Date/Author: 2026-07-08 / Claude

- Decision: Execute the gnark strategy's interim path now (patch captured + drift check + bootstrap script + CI workflow); the reviewed fork is deferred to Milestone 7 and needs Philip (creating `Anastasia-Labs/gnark` or equivalent is an org-level action). Until then `vendor/` is reproducible from `go.mod` + `prove-stream.patch` and drift is CI-visible.
  Date/Author: 2026-07-08 / Claude

- Decision: Apply COOP/COEP site-wide, not scoped to `/claim`. Isolation is per-document at load; scoping would break browser proving after a client-side navigation from a non-isolated page. The zero-cross-origin-subresource audit makes blanket `require-corp` safe.
  Date/Author: 2026-07-08 / Claude

- Decision: Regenerate the chunk manifest (`proof-tool generate-chunk-manifest`) only after the production runtime files exist, since it pins `proof-destination.wasm`, the MSM worker JS, and `msmworker.wasm` by hash; the signing key `output/signing-keys/preprod-local-destination-d2c944dd753c-r3.ed25519.private.hex` is present locally for the preprod bundle.
  Date/Author: 2026-07-08 / Claude

- Decision: Ship behind an explicit experimental posture at first release: descriptor-gated, `Experimental` pill retained in the chooser, desktop remains "Recommended for speed".
  Rationale: Hosted-behavior evidence and dependency provenance review (Milestone 7) are not yet done; 115 s local ≠ 115 s on user hardware over real networks.
  Date/Author: 2026-07-08 / Claude

## Outcomes & Retrospective

Milestones 1–6 implemented; Milestone 7 has local acceptance + provenance, with the hosted run and gnark-fork repo handed to Philip. The claim page now offers `Prove in this browser` alongside `Proof Helper Desktop`; the app preflights capability + pinned assets before accepting the phrase, a dedicated worker runs the Go prover per request with stage/percent/N-of-M progress and a Cancel/beforeunload guard, and the resulting artifacts pass the same client and server gates as desktop-helper artifacts. The deployment descriptor remains the sole enablement switch — with no `browser_proving` descriptor the UI is today's guarded shell, bit-for-bit.

### Recorded evidence (2026-07-08, local staging acceptance)

- **Provider / engine:** `browser-wasm` → `streampk-sharded-groth16` (no CPU demotion), via the production `prover-worker.js` orchestrator spawning nested `msm-worker.js` MSM workers.
- **Per-proof runtime / heap:** 122.3 s wall, 2.313 GiB peak heap (target envelope 115.9 s / 2.32 GiB), `verified_locally: true`. (An earlier run degraded to `streampk-cpu-groth16` at ~500 s — root cause was a chunk `base_url` missing its trailing slash, now documented.)
- **Artifact validation:** browser artifact passed `verify-destination` (CLI: `verified`) and the five-class `verify-tamper.mjs` gate (valid accepted; tampered credential / destination / public input / proof bytes / vk_hash all rejected). Artifact carries no `path`/`paths` metadata.
- **Backend build acceptance:** artifact shape is `artifact.BackendProofArtifact()` (schema `root-ownership-proof-artifact-v1`), identical to the desktop-helper output that `assertProofArtifacts` already accepts; the two providers normalize to the same `DestinationProofResponse` (asserted in `browser-wasm.test.ts`).
- **Capability state:** `crossOriginIsolated === true` (page + dedicated worker + nested worker), SharedArrayBuffer constructible and transferable across the nested boundary, 32 hardware threads, `msm-worker.js` child boots to `ready`.
- **Asset identity:** vk_hash `blake2b256:6057da91…d430a`; ccs `blake2b256:54da79a3…b577e`; deployment_id `preprod:2fa284c0…:71c22462`; signature_key_id `preprod-local-destination-d2c944dd753c-r3`; 124 chunks @ 16 MiB; PK 2,079,485,517 B. Reproducible wasm build (two clean builds → identical sha256).
- **Secrets audit:** no master XPrv, seed phrase, derivation path, or request JSON in the artifact, resume snapshot, worker files (zero `console` logging), or progress events (redaction asserted against a serialized event stream). Prover-worker network egress is exactly the descriptor URLs.

### Handoff to Philip (Milestone 7 remainder)

1. Reviewed gnark fork repo + `replace` directive (interim: `scripts/check-vendor-drift.sh` + `.github/workflows/vendor-drift.yml` keep the vendored patch honest).
2. Real ranged asset host for `ownership.pk` / `ownership-destination.ccs` (identity/CORS/range/`identity` encoding), then set `proof.browser_proving.pk_url`/`ccs_url` and flip `enabled: true`.
3. Hosted e2e (`RECLAIM_E2E_PROOF_PROVIDER=browser-wasm`) on one modest (≤8 GB RAM / 4 cores) and one fast profile; record wall/heap/range-bytes here.

## Context and Orientation

Working repository: `/home/gumbo/playground/proof-zk-recovery/proof-tool`. All paths below are relative to it.

Webapp claim flow (Next.js 15 App Router, React 19):

    apps/ownership-proof-web/components/ClaimFlow.tsx     — 4,600-line flow; all proof handoff logic
    apps/ownership-proof-web/lib/claim/                   — DTOs (types.ts), validation.ts, addresses.ts, datum.ts
    apps/ownership-proof-web/lib/claim-server/            — draft.ts, build-submit.ts (server artifact gate)
    apps/ownership-proof-web/lib/reclaim/types.ts         — ReclaimDeployment (verifierVkHash, proof block)
    apps/ownership-proof-web/app/claim-api/               — deployment, reclaim-utxos, draft, progress, build, submit
    apps/ownership-proof-web/workers/ownership-proof-worker.ts — re-export of packages/client-ts worker (xprv derivation only)
    apps/ownership-proof-web/e2e/preprod/                 — staged e2e; proof-stage.mjs is helper-specific
    apps/ownership-proof-web/next.config.mjs              — no headers() today; no middleware exists
    packages/client-ts                                    — @proof-zk-recovery/proof-tool-client (seed→xprv worker)

Key ClaimFlow facts:

- `LocalProofMethod = "desktop" | "browser"`; state `proofMethod`, `proofMethodDialogOpen`, `installDialogOpen`; `browserSelected` currently feeds `proofBlocked`, hard-disabling generation.
- `generateClaimProofs` (~line 1063): reads+clears phrase from DOM inputs (`readAndClearRecoveryPhrase`), derives xprv in a terminated-after-use worker (`deriveMasterXPrv`), POSTs `{master_xprv_base64, profile, requests, search:{max_account:9,max_index:999}, include_debug_path:false}` to the helper, validates, stores `proofArtifacts`, transitions `create-proofs-generating` → `create-proofs-complete` / `proof-failed`. `masterBytes.fill(0)` in `finally`.
- `checkHelper` (~707) gates the desktop path: helper `/status` must report `single-destination`, `key_ready`, and `key_hash === deployment.deployment.verifierVkHash`.
- `proofArtifacts` feeds `/claim-api/build` and is persisted in the localStorage resume snapshot (`proof-tool.claim-flow.resume.v1`, 2 h TTL). Artifacts are non-secret; this is acceptable, but browser-provider metadata must not add secrets to it.

Experiment (source of the extraction):

    experiments/wasm-prover/cmd/wasm-prover/main_js.go    — proveDestination / preflightProofAssets / __wasmProverReady
    experiments/wasm-prover/cmd/msmworker/                — MSM worker kernel wasm
    experiments/wasm-prover/msmengine/                    — engine seam, sharded transport (sharded_js.go), partition/serialize kernels
    experiments/wasm-prover/internal/streampk/            — PK index + HTTP-range KeySource (imports internal/proofassets)
    experiments/wasm-prover/internal/streamprove/         — PK-shell adapter calling vendored groth16_bls12381.ProveStream
    experiments/wasm-prover/web/                          — harness: browser-prover.js, worker.js, index.html, server.mjs (COOP/COEP/CORP + Range)
    experiments/wasm-prover/scripts/verify-tamper.mjs     — tamper acceptance script (passed 2026-07-08)
    experiments/wasm-prover/patches/prove-stream.patch    — the vendored gnark modification

`proveDestination` request fields: `master_xprv_hex`, `target_credential_hex`, `destination_address_hex`, `search{account?,role?,index?,max_account=9,max_index=999}`, `artifacts{manifest_url, manifest_sig_url, manifest_public_key_hex, vk_url, pk_url, pk_index_url, ccs_url, ccs_blake2b256, chunk_manifest_url, chunk_manifest_sig_url, chunk_manifest_public_key_hex, deployment_manifest_url, proof_wasm_url, worker_js_url, msm_worker_wasm_url}`, `tuning{force_cpu, worker_count, shard_count, shard_multiplier, range_fetch_concurrency, pinned_decode}`, `include_debug_path`. Progress events are `{stage, frac}` with stages `parse, decode-inputs, open-keys, open-ccs, find-path, probe, prove, "prove NN.N%", verify, done` — no secret fields. Response: `{artifact, engine, ms, wall_seconds, peak_heap_gib, verified_locally, trace?}`.

Current proof-asset identity (preprod, pinned):

    key_version: ownership-destination-v1
    circuit_id: root-ownership-destination-v1/bls12-381/groth16
    vk_hash: blake2b256:6057da91b15dea8f8e93997f1b1944c35bc2c86faf9a9de17b814f6a172d430a
    ccs_blake2b256: blake2b256:54da79a38f83d47447cd613bb41d16ef0a19e3c29b0b1a3267d0a1c16aeb577e (187,120,157 bytes; 2,885,268 constraints)
    proving_key: 2,079,485,517 bytes; sha256:9222859a…df550; blake2b256:853b407f…b1ef
    signature_key_id: preprod-local-destination-d2c944dd753c-r3
    key bundle: output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/…

Best verified browser run (target envelope for production):

    case: o4-o2-section-commitment-w8-s32-rf2-local7
    engine: streampk-sharded-groth16   verified_locally: true   contaminated: false
    prove_ms: 111461   wall_seconds: 115.900   peak_heap_gib: 2.3156
    tuning: workers 8, shards 32, range_fetch_concurrency 2, pinned_decode true, GOGC 50, GOMEMLIMIT 3000MiB
    (Note: w16/s64 configs measured slower, 346–360 s. Default production tuning = the local7 config.)

## Plan of Work

Seven milestones. Each must update `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` before stopping. Milestones 1–3 are parallelizable; 4 depends on 1–2; 5 depends on 4 (and 3 for the sharded engine); 6–7 close it out. The desktop-helper flow must remain green after every milestone.

### Milestone 1 — Extract the prover from `experiments/` and fix the dependency story

Move Go packages per the Decision Log mapping (`internal/msmengine`, `internal/streampk`, `internal/streamprove`, `cmd/wasm-prover`, `cmd/msmworker`), rewriting import paths. Keep the experiment directory building against the new locations (thin re-export or direct import) so benchmark harnesses keep working for O3–O7.

Scrub experiment-isms during the move: the golden default request and test globals stay behind in the harness; `include_debug_path` remains supported but defaults false; `key_bundle_dir` local mode stays for CLI/testing but the webapp only ever uses URL mode.

Resolve gnark: create the reviewed fork branch with `ProveStream` + the msmengine seam + O1/O2/O4 kernel changes, add the `replace` directive, delete the hand-patched vendor workflow (or, if fork review can't land before the experimental release, add the CI vendor-drift check described in the Decision Log and record the deferral).

Add a reproducible build script (make target or `scripts/build-wasm-prover.sh`): builds `proof-destination.wasm` and `msmworker.wasm` with the pinned Go toolchain, copies the toolchain's `wasm_exec.js`, emits a `runtime-manifest.json` with sha256/blake2b256 of each output. These hashes feed the asset manifest that `main_js.go` already verifies (`proof_wasm_url`/`worker_js_url`/`msm_worker_wasm_url` pins).

Acceptance: `go build ./...`, `go test ./internal/msmengine/... ./internal/streampk/... ./internal/streamprove/...` pass on a clean checkout without manual patching; `GOOS=js GOARCH=wasm` builds succeed; the Node MSM bit-exactness check (`web/node-msm-check/run.mjs`, repointed) still passes; a browser proof via the experiment harness against the extracted code reproduces ≈116 s / ≈2.32 GiB.

### Milestone 2 — Proof-asset hosting and the deployment descriptor

Extend the reclaim deployment config (`lib/reclaim-server/config`, `ReclaimDeployment.proof`) with an optional `browser_proving` descriptor:

    browser_proving: {
      enabled: boolean,
      runtime_base_url: string,        // same-origin /proof-runtime/…
      manifest_url, manifest_sig_url, manifest_public_key_hex,
      chunk_manifest_url, chunk_manifest_sig_url, chunk_manifest_public_key_hex,
      deployment_manifest_url,
      vk_url, pk_url, pk_index_url, ccs_url, ccs_blake2b256,
      proof_wasm_url, worker_js_url, msm_worker_wasm_url,
      tuning?: { worker_count, shard_count, range_fetch_concurrency, pinned_decode, gogc, gomemlimit }
    }

Surface it (minus anything server-private) through `/claim-api/deployment` capabilities. The descriptor's `vk_hash` chain must terminate at `deployment.verifierVkHash` — the client refuses browser proving if the preflight-reported `vk_hash` differs.

Host the bulk assets: pick the ranged host (release CDN/bucket). Required behavior, mirroring `web/server.mjs`: `Accept-Ranges: bytes` with correct 206/416 semantics on `ownership.pk`, `Cross-Origin-Resource-Policy: cross-origin` (or CORS with explicit origin), `Content-Encoding: identity` (workers reject transformed encodings), long-lived immutable cache headers (assets are content-addressed by the manifest). Place small assets under `apps/ownership-proof-web/public/proof-assets/` and runtime files under `public/proof-runtime/`.

Acceptance: `preflightProofAssets` run from a browser against the hosted descriptor returns `ok: true` with the expected `vk_hash`, `chunk_manifest`, and `deployment_id`; a ranged fetch of an arbitrary PK section returns byte-identical data to the local bundle.

### Milestone 3 — Cross-origin isolation for the claim page

Add a `headers()` block to `next.config.mjs` applying `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` — scoped to the claim route(s) and the proof-runtime paths, not blanket, unless an audit shows the whole app is already compatible. Audit every cross-origin subresource on the claim page (images, fonts, wallet-extension interactions, the `/api` rewrite) under isolation; fix with CORP headers/`crossorigin` attributes, or fall back to `COEP: credentialless` if some resource cannot be fixed (record which, and verify Safari support status at implementation time — if credentialless is required but unsupported there, Safari users stay on desktop-helper via preflight).

CIP-30 wallet extensions must be regression-tested under COOP/COEP (Lace at minimum, via the existing e2e harness): extension-injected scripts are typically exempt from COEP, but the claim signing step is the one place this can bite.

Acceptance: on the claim page, `window.crossOriginIsolated === true`, `new SharedArrayBuffer(8)` succeeds, wallet connect + signing still work in e2e, and all other app pages are unaffected.

### Milestone 4 — Provider layer in the webapp

Create `apps/ownership-proof-web/lib/proving/`:

    types.ts            — provider kinds, progress events, provider interface, status types
    desktop-helper.ts   — the current generateClaimProofs POST logic, moved verbatim (behavior-preserving)
    browser-wasm.ts     — provider: worker lifecycle, per-request prove loop, response normalization
    capability.ts       — capability + asset preflight (see below)
    prover-worker.ts    — dedicated module worker: loads wasm_exec.js + proof-destination.wasm, sets go.env GOGC/GOMEMLIMIT from descriptor tuning, forwards prove/preflight calls and progress events over postMessage

Provider interface (target shape):

    export type ProofProviderKind = "desktop-helper" | "browser-wasm";

    export type ProofProgressEvent = {
      provider: ProofProviderKind;
      stage: string;          // wasm stage string, or "request" for helper
      frac?: number;          // 0..1 within current proof
      current?: number;       // 1-based proof index within batch
      total?: number;
      engine?: string;
    };

    export type GenerateDestinationProofsInput = {
      masterXPrv: Uint8Array;               // 96 bytes; provider converts to hex/base64 internally and zeroes copies
      draft: ClaimDraftResponse;            // proofProfile, proofRequests, ordering
      expectedVkHash: string;               // deployment.verifierVkHash
      browserProving?: BrowserProvingDescriptor;  // from /claim-api/deployment capabilities
      signal?: AbortSignal;
      onProgress?: (e: ProofProgressEvent) => void;
    };

    export interface DestinationProofProvider {
      kind: ProofProviderKind;
      check(): Promise<ProofProviderStatus>;   // helper /status vs capability+asset preflight
      prove(input: GenerateDestinationProofsInput): Promise<DestinationProofResponse>;
    }

Browser provider behavior: spawn `prover-worker` once per batch; run `preflightProofAssets` first (fail closed on any mismatch); for each `draft.proofRequests[i]` in draft order, call `proveDestination` with `master_xprv_hex`, request credential/destination, `search:{max_account:9,max_index:999}`, the descriptor's artifact URLs/pins, descriptor tuning (default: the local7 config), `include_debug_path:false`; map progress to `{current:i+1,total:N}` events; require `verified_locally === true` per result; assemble `{profile: draft.proofProfile, artifacts:[{out_ref, artifact}...]}`; terminate the worker and zero the hex string source buffer in `finally`. On `AbortSignal`, terminate the worker immediately (that is the kill switch — the Go runtime doesn't cancel mid-MSM).

Capability preflight (`capability.ts`), all checked before the browser option is enabled and re-checked before proving:

    WebAssembly + module Worker + fetch available
    crossOriginIsolated === true and SharedArrayBuffer constructible
    nested Worker creation works (probe from a scratch worker)
    hardwareConcurrency recorded (warn/deny below 4)
    navigator.deviceMemory recorded (warn below 8; the proof peaks ~2.32 GiB in one tab)
    browser_proving descriptor present and enabled
    preflightProofAssets ok, and its vk_hash === deployment.verifierVkHash

Secrets policy enforced at this boundary: `master_xprv_hex`, `master_xprv_base64`, seed phrase, `path`/`paths`, witness values, and full request JSON never leave the provider modules — not in progress events, thrown errors (wrap/sanitize), console logs, resume snapshots, or analytics. The prover worker communicates only with same-origin code; its network egress is exactly the descriptor URLs.

Acceptance: unit tests pass with a mocked worker; a manual browser run through `browser-wasm.ts` (dev page or test harness) produces an artifact accepted by `validateDestinationProofResponse` and by a local `verify-destination` CLI check.

### Milestone 5 — ClaimFlow wiring and UX

Changes in `ClaimFlow.tsx` (building on the existing shell, no second chooser surface):

- Add `browserProvingStatus` state (`"unknown" | "checking" | "ready" | "unsupported" | "asset-error"`) driven by `capability.ts` when the dialog opens or browser is selected; keep it separate from `helperState`.
- `LocalProofMethodDialog`: the browser option's readiness section now renders live preflight results (supported/unsupported with the failing check named in plain language) instead of the static "not enabled in this build yet". Keep `No download` / `Experimental` pills; add expected duration copy ("about 2 minutes per proof on a fast machine"). If the descriptor is absent or preflight fails, the option stays selectable-but-blocked exactly as today, with the blocked reason updated to name the cause and point to desktop.
- `proofBlocked`: replace the unconditional `browserSelected` term with `browserSelected && browserProvingStatus !== "ready"`.
- `generateClaimProofs`: branch on `proofMethod`. Desktop path is byte-identical to today (via `desktop-helper.ts`). Browser path: re-run preflight, then read+clear phrase → derive xprv → call the browser provider with an `AbortController` wired to a Cancel affordance → `validateDestinationProofResponse` → same state transitions. Keep `masterBytes.fill(0)` in `finally`; on failure, land on `proof-failed` with a sanitized, provider-tagged error and desktop fallback prominently offered.
- `CreateProofsGenerating`: when provider is browser-wasm, show engine label ("Proving in this browser"), per-proof `current / total`, stage + percent from `ProofProgressEvent`, a persistent "Keep this tab open — refreshing will restart proof generation" warning, and the Cancel button. Never render request JSON, xprv, paths, or proof bytes. Helper mode keeps its current copy.
- Beforeunload guard while a browser proof is running.
- Resume snapshot: unchanged shape; browser proving adds no new persisted fields beyond the (non-secret) selected method.

Acceptance: with descriptor enabled and a capable browser, the full flow — choose browser method → phrase → generate (visible progress) → `create-proofs-complete` → build → sign → submit — succeeds on preprod; with descriptor disabled or preflight failing, behavior is indistinguishable from today's guarded shell; desktop path regression-free.

### Milestone 6 — Tests and e2e

Unit (ClaimFlow.test.tsx + new lib/proving tests):

- Browser option blocked when: descriptor absent; each capability check fails; asset preflight vk_hash mismatch.
- Browser option enabled ⇒ generation runs without helperUrl/helperToken; desktop still requires pairing.
- Both providers normalize to the same `DestinationProofResponse`; `validateDestinationProofResponse` rejects path metadata, wrong `vk_hash`, wrong destination, wrong credential, wrong count (existing tests, extended to browser-shaped responses).
- Progress events contain no secret-bearing fields (assert against a serialized event stream).
- Abort terminates the worker and zeroes buffers; failure paths land on `proof-failed` with desktop fallback.
- Continue-button and dialog copy states for each `browserProvingStatus`.

E2E (`e2e/preprod/`): parameterize the proof stage —

    RECLAIM_E2E_PROOF_PROVIDER=desktop-helper|browser-wasm

Desktop mode stays as-is (direct helper POST). Browser mode drives the real claim page UI (the `claim-ui-stage`/Playwright harness) through method selection, phrase entry, and proof generation, since the provider only exists in the browser. The stage artifact records provider, engine, capability state, asset identity (vk_hash/deployment id), per-proof runtime, and peak heap — and continues to exclude master XPrv, seed phrase, request bodies, derivation paths, and proof bytes.

Acceptance: both provider modes produce a proof bundle the downstream `claim-stage` builds and submits on preprod.

### Milestone 7 — Hosted behavior, provenance, release posture

Hosted-behavior evidence: run the browser e2e against a deployed (non-localhost) app + real asset host from at least one modest machine profile (≤8 GB RAM, 4 cores) and one fast profile. Record wall time, heap, range-request counts/bytes, and any CDN/range anomalies in this plan.

Dependency provenance: review the gnark fork diff (or vendor patch) line-by-line; record reviewer + commit; confirm `go.mod`/`go.sum` pin the fork; confirm the wasm build is reproducible (two clean builds, identical hashes).

Release posture: if fork review, hosted evidence, and provenance all pass → ship descriptor-enabled on preprod with the `Experimental` pill; document the trust distinction (hosted-JS trust vs local native helper trust) in release notes. If any gate fails → descriptor stays disabled in hosted configs; the code ships inert.

## Concrete Steps

Orientation and baseline (before Milestone 1):

    cd /home/gumbo/playground/proof-zk-recovery/proof-tool
    git status --short                      # preserve unrelated dirty-tree work
    go test ./experiments/wasm-prover/...
    node experiments/wasm-prover/scripts/verify-tamper.mjs   # re-confirm gate on current artifacts

Milestone 1 mechanics: `git mv` the packages per the mapping; `gofmt`-safe import rewrites (`proof-tool/experiments/wasm-prover/msmengine` → `proof-tool/internal/msmengine`, etc.); re-point `web/node-msm-check`, benchmark scripts, and the README build commands; then

    go build ./... && go vet ./...
    go test ./internal/msmengine/... ./internal/streampk/... ./internal/streamprove/...
    GOOS=js GOARCH=wasm go build -o /tmp/proof-destination.wasm ./cmd/wasm-prover
    GOOS=js GOARCH=wasm go build -o /tmp/msmworker.wasm ./cmd/msmworker
    GOROOT="$(go env GOROOT)" node experiments/wasm-prover/web/node-msm-check/run.mjs

For the gnark fork: branch from v0.15.0, apply `prove-stream.patch` + the O1/O2/O4 vendored-prove.go deltas as reviewed commits, add `replace github.com/consensys/gnark => github.com/<org>/gnark <pinned-commit>` — then delete the checked-in patched `vendor/` tree (or keep vendoring but regenerate from the fork so `go mod vendor` is idempotent).

Milestone 4 file skeleton (webapp):

    apps/ownership-proof-web/lib/proving/types.ts
    apps/ownership-proof-web/lib/proving/desktop-helper.ts
    apps/ownership-proof-web/lib/proving/browser-wasm.ts
    apps/ownership-proof-web/lib/proving/capability.ts
    apps/ownership-proof-web/lib/proving/prover-worker.ts
    apps/ownership-proof-web/public/proof-runtime/{proof-destination.wasm, msmworker.wasm, msm-worker.js, wasm_exec.js}
    apps/ownership-proof-web/public/proof-assets/{manifest.json, manifest.sig, ownership.vk, ownership.pk.idx.json, chunk-manifest.json, chunk-manifest.sig, reclaim-deployment.json}

Move `DestinationProofResponse` from its local declaration in `ClaimFlow.tsx` (~line 192) into `lib/proving/types.ts` (or `lib/claim/types.ts`) so both providers and tests share it.

Webapp test commands as work proceeds:

    pnpm --dir apps/ownership-proof-web test -- ClaimFlow
    pnpm --dir apps/ownership-proof-web test -- proving
    pnpm --dir packages/client-ts test

Local acceptance run (Milestone 5):

    source .env.local
    pnpm --dir apps/ownership-proof-web dev
    # Playwright/manual: claim page → Choose method → Prove in this browser → phrase → generate → build → sign → submit

Final regression sweep:

    go test ./...                                   # or narrowest set if dirty tree blocks full run — record blocker
    pnpm --dir apps/ownership-proof-web test
    pnpm --dir packages/client-ts test
    RECLAIM_E2E_PROOF_PROVIDER=desktop-helper node apps/ownership-proof-web/e2e/preprod/run.mjs …
    RECLAIM_E2E_PROOF_PROVIDER=browser-wasm  node apps/ownership-proof-web/e2e/preprod/run.mjs …

## Validation and Acceptance

The plan succeeds when a user can open the claim page, reach Create proofs, choose either `Proof Helper Desktop` or `Prove in this browser` in the existing modal, enter the impacted-wallet recovery phrase, and produce proof artifacts that pass the same client validation, `/claim-api/build`, signing, and `/claim-api/submit` path — with browser proving available only where the preflight passes and the deployment descriptor enables it.

Functional acceptance: browser option disabled/blocked (with named reason) unless descriptor + capability + asset preflight pass; desktop provider unchanged everywhere it worked before; Step 5 tile reflects the selected provider truthfully; provider selection precedes phrase read; both providers' artifacts pass `validateDestinationProofResponse` and `assertProofArtifacts`; artifacts cannot redirect the claim to any destination other than the selected safe wallet (destination bytes are pinned by the draft and re-checked server-side against backend state).

Security acceptance: seed phrase, master XPrv (hex or base64), witness values, derivation paths, and full request JSON never appear in URLs, localStorage/sessionStorage (including the resume snapshot), analytics, console logs, progress events, thrown-error surfaces, e2e artifacts, or any network request other than (desktop) the loopback helper POST; browser proving fetches only descriptor-listed, hash-pinned assets; `verified_locally` must be true per proof and the runtime files' hashes must match the chunk manifest before proving; no key generation in the browser, ever; backend build remains blocked if path metadata appears anywhere.

Performance and UX acceptance: capability state visible before proving; per-proof stage/percent and N-of-M progress during proving; Cancel works (worker terminated, buffers zeroed, user returned to `create-proofs-ready`); page remains responsive throughout (orchestrator off the main thread); refresh warning shown; desktop fallback visible whenever browser proving is unsupported or fails; hosted evidence recorded for at least one modest and one fast machine profile.

Release acceptance: browser proving ships descriptor-gated and labeled Experimental until the gnark fork review, provenance review, and hosted evidence are all recorded in this document; release notes distinguish hosted-JS trust from local native helper trust.

## Idempotence and Recovery

Every milestone is individually revertible and the desktop-helper flow must never be broken by a partial state. The deployment descriptor is the master kill switch: removing/disabling `browser_proving` returns the UI to today's guarded shell with no code rollback.

If browser proof generation fails mid-batch: terminate the prover worker, zero xprv buffers, keep completed artifacts out of `proofArtifacts` (the batch is all-or-nothing, matching helper semantics), land on `proof-failed` with desktop offered. If asset preflight fails: block before phrase entry; surface which asset/check failed without logging URLs' response bodies or any secret. If a browser artifact passes client validation but `/claim-api/build` rejects it: preserve redacted provider metadata (engine, timing, asset identity, error code) for debugging; never persist proof request bodies.

Do not clean `experiments/wasm-prover/output/`, release staging, or unrelated dirty-tree work during extraction. `git mv` history-preserving moves only.

## Artifacts and Notes

Evidence anchors (do not paste secrets, phrases, xprvs, witness values, request JSON, or proof bytes here):

    best run:      experiments/wasm-prover/output/o4-o2-section-commitment-w8-s32-rf2-local7.summary.json
                   (115.900 s wall / 111,461 prove_ms / 2.3156 GiB peak heap / verified / clean)
    prior best:    o1-pinned-decode-w8-s32-rf2.summary.json (118.84 s / 2.797 GiB)
    first proof:   587.62 s / 2.636 GiB (w8/s8/rf4) — superseded
    tamper gate:   verify-tamper.mjs pass recorded in docs/browser-wasm-prover-proving-time-optimization-plan.md (Outcomes)
    asset identity: see Context and Orientation (vk_hash 6057da91…, ccs 54da79a3…, pk 2,079,485,517 B, sig key preprod-local-destination-d2c944dd753c-r3)

Open items inherited from the optimization plan that affect production defaults: O3 (worker cap >8 exploration), O5 (worker-side GOGC/GOMEMLIMIT — production `msm-worker.js` should set explicit limits even though the optimization experiment is unfinished), O6 (cross-stage queue, conditional), O7 (re-sweep + new baseline lock). If O-series work changes the best tuning, update the descriptor's `tuning` defaults — not code.

## Interfaces and Dependencies

Provider contract: see Milestone 4 (`ProofProviderKind`, `ProofProgressEvent`, `GenerateDestinationProofsInput`, `DestinationProofProvider`). Both providers resolve to the helper-shaped response:

    { "profile": draft.proofProfile,
      "artifacts": [ { "out_ref": request.out_ref, "artifact": <ProofArtifact, backend shape, no path metadata> } ] }

Per-request browser prove call (inside the provider boundary only):

    { "master_xprv_hex": "…",
      "target_credential_hex": request.target_credential,
      "destination_address_hex": request.destination_address,
      "search": { "max_account": 9, "max_index": 999 },
      "artifacts": { …descriptor URLs and pins… },
      "tuning": { "worker_count": 8, "shard_count": 32, "range_fetch_concurrency": 2, "pinned_decode": true },
      "include_debug_path": false }

Never exposed or persisted outside the provider boundary: `master_xprv_hex`, `master_xprv_base64`, `seedPhrase`, `path`/`paths`, witness values, full request JSON.

Dependency chain after extraction: webapp → same-origin runtime files (hash-pinned) → `cmd/wasm-prover` → `internal/streamprove` → gnark fork `ProveStream` → `internal/msmengine` seam → MSM workers (`cmd/msmworker`) → ranged asset host (hash-verified chunks). `internal/streampk` → `internal/proofassets` (index format). No package under `internal/` may import from `experiments/`.

End-to-end invariant, unchanged:

    claim draft → selected proof provider → DestinationProofResponse → validateDestinationProofResponse
      → proofArtifacts state → /claim-api/build (assertProofArtifacts, digest recompute) → wallet signing → /claim-api/submit

## Revision Notes

2026-07-08 / Codex: Initial ExecPlan (pre-optimization state: 587 s / 2.64 GiB, tamper gate outstanding, no preflight entrypoint).

2026-07-08 / Claude: Full rewrite. Updated performance basis to the verified 115.9 s / 2.32 GiB local7 run and its w8/s32/rf2 tuning; marked the tamper gate passed; incorporated `preflightProofAssets` and runtime-hash pinning as existing capabilities; added the concrete extraction mapping out of `experiments/` (internal/msmengine, internal/streampk, internal/streamprove, cmd/wasm-prover, cmd/msmworker) and the gnark fork strategy replacing the dirty-vendor patch; added the deployment-descriptor feature gate, split asset-hosting design, scoped COOP/COEP milestone, dedicated-worker orchestration, sequential batch proving, per-proof progress UI, abort/cancel semantics, and provider-parameterized e2e.
