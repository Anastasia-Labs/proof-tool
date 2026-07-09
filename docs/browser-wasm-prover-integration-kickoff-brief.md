# Kickoff Brief: Implement the Browser WASM Prover Webapp Integration

Audience: a Claude Code session running inside WSL at `/home/gumbo/playground/proof-zk-recovery/proof-tool`, with full shell access (go, node, pnpm, git, playwright).

Suggested kickoff prompt:

    Read docs/browser-wasm-prover-integration-kickoff-brief.md and docs/browser-wasm-prover-webapp-integration-plan.md,
    then implement the plan milestone by milestone. The brief has repo anchors and hard constraints — follow them.
    Orchestrate subagents for the mechanical milestones; keep ClaimFlow.tsx edits in the main session.

## 1. Source of truth and division of labor

`docs/browser-wasm-prover-webapp-integration-plan.md` is the ExecPlan — the authoritative statement of milestones, decisions, interfaces, and acceptance. It is a living document: update its `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` sections after every milestone. This brief adds execution mechanics and verified repo anchors (surveyed 2026-07-08) so you can start without re-surveying.

Related context docs (read if needed, do not treat as current where they conflict with the plan):

- `docs/browser-wasm-prover-experiment-plan.md` — one generation stale on performance and gates (its "tamper outstanding" note is wrong; the gate passed).
- `docs/browser-wasm-prover-proving-time-optimization-plan.md` — current performance story (O1/O2/O4 done; O3/O5/O6/O7 open).
- `experiments/wasm-prover/README.md` — build commands (pre-extraction paths).

## 2. Hard constraints — read before touching anything

1. **The vendored gnark tree is hand-patched and load-bearing.** `go.mod` pins `gnark v0.15.0` with no replace directive; `groth16/bls12-381.ProveStream` plus the O1/O2/O4 kernel changes exist only as edits inside `vendor/`, nominally mirrored in `experiments/wasm-prover/patches/prove-stream.patch`. **Never run `go mod vendor`, `go mod tidy`, or anything that regenerates `vendor/` without first confirming the patch fully captures the current vendor diff** (`git diff --stat vendor/` on a clean baseline, or diff vendor against a scratch re-vendor). If the patch is stale relative to `vendor/`, regenerating loses unmirrored optimization work permanently. Milestone 1 replaces this workflow with a reviewed fork — until that lands, treat `vendor/` as source code.
2. **The tree may be dirty with unrelated work.** `git status --short` first; never revert, clean, or commit files you did not change. `experiments/wasm-prover/output/` and large assets in `experiments/wasm-prover/web/` are gitignored — do not delete them; the 2 GB PK and staged key bundle under `output/release/.../key-bundle/...` cannot be regenerated quickly.
3. **Desktop-helper flow must stay green after every milestone.** Run the ClaimFlow unit tests after each webapp change.
4. **Secrets policy is absolute** (plan: Milestone 4 + Security acceptance): seed phrase, master XPrv (any encoding), witness values, `path`/`paths`, and full prove-request JSON never appear in progress events, thrown errors, console logs, resume snapshots, analytics, e2e artifacts, or any network request beyond the loopback helper POST / descriptor asset fetches.
5. **Do not "improve" tuning.** Production defaults are the local7 config: workers 8, shards 32, range_fetch_concurrency 2, pinned_decode true, GOGC 50, GOMEMLIMIT 3000MiB. The w16/s64 configs measured 3x slower. Benchmarking is contamination-sensitive; if you must benchmark, use `experiments/wasm-prover/scripts/guarded-browser-benchmark.mjs` on an idle machine and discard `contaminated: true` runs.
6. **Go wasm runtime:** `wasm_exec.js` must come from the pinned Go toolchain (`$(go env GOROOT)/lib/wasm/wasm_exec.js`) and be vendored as a build product — version skew between it and the wasm binaries breaks at runtime.

## 3. Verified repo anchors (2026-07-08)

### Go / experiment side

- `experiments/wasm-prover/cmd/wasm-prover/main_js.go` — registers `proveDestination(requestJson, progressCb) -> Promise`, `preflightProofAssets(requestJson) -> Promise`, `__wasmProverReady`. Request/response/progress schemas are reproduced in the plan (Context and Orientation). URL-mode asset opening (`openStreamingArtifactsFromURLs`, `openChunkManifestPreflight`) already enforces manifest sig, VK/CCS/PK-index pins, chunk-manifest + `reclaim-deployment.json` cross-checks, and hash pins for `proof_wasm_url` / `worker_js_url` / `msm_worker_wasm_url`.
- `experiments/wasm-prover/msmengine/` — no `proof-tool/internal` imports (leaf package; gnark-crypto + blake2b only). `sharded_js.go`: `defaultWorkerCap = 8` (~line 386); `newWorker` default worker URL is `worker.js` — check how it resolves relative to the spawning scope before relocating worker files. Kernel globals: `__msmengineShardG1/G2[Timed]`, `__msmengineShardSectionG1/G2`, `__msmengineVerifyChunkBytes`.
- `experiments/wasm-prover/internal/streampk/` — imports `proof-tool/internal/proofassets` (PKIndex types, `BuildPKIndex`/`ValidatePKIndex`, raw-size constants) and `.../msmengine` (PKSectionPlan). HTTP range reader `httpRangeAt` + `RangeStats`.
- `experiments/wasm-prover/internal/streamprove/streamprove.go` — builds a PK shell and calls vendored `groth16_bls12381.ProveStream`; imports only gnark + streampk.
- `experiments/wasm-prover/web/worker.js` — MSM worker bootstrap: `importScripts('wasm_exec.js')`, **no GOGC/GOMEMLIMIT set** (open O5 concern — production worker must set explicit limits); verifies each fetched chunk (`sha256`/`blake2b256` via `__msmengineVerifyChunkBytes`) before decode; rejects non-`identity` content-encoding; zeroes scalar buffers in `finally`.
- `experiments/wasm-prover/web/browser-prover.js` — main-thread harness. Contains a **golden master XPrv in `__defaultProofRequest` and benchmark globals; none of this may reach production code.** Sets `go.env.GOMEMLIMIT/GOGC` before `go.run`.
- `experiments/wasm-prover/web/server.mjs` — reference for required headers: COOP `same-origin`, COEP `require-corp`, CORP `same-origin`, `Accept-Ranges: bytes` with 206/416 semantics.
- `experiments/wasm-prover/scripts/verify-tamper.mjs` — `node ... [artifactJson] [keysDir]`; runs `go run ./cmd/proof-tool verify-destination` on valid + five tampered variants. Passed 2026-07-08.
- Best-run evidence: `experiments/wasm-prover/output/o4-o2-section-commitment-w8-s32-rf2-local7.summary.json` (115.9 s / 2.316 GiB / verified / clean).
- Asset identity: vk_hash `blake2b256:6057da91…d430a`, CCS `blake2b256:54da79a3…b577e` (187,120,157 B), PK 2,079,485,517 B, sig key `preprod-local-destination-d2c944dd753c-r3`, bundle at `output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/…`.

### Webapp side (`apps/ownership-proof-web`)

- `components/ClaimFlow.tsx` (~4,591 lines). Anchors (approximate lines, verify before editing): `LocalProofMethod` type ~157; local `DestinationProofResponse` type ~192 (move to shared location); `ClaimScreen` union 54–76; `checkHelper` ~707; `generateClaimProofs` ~1063 (phrase read `readAndClearRecoveryPhrase` ~1083, `masterBytes.fill(0)` in `finally` ~1118); `buildOrSubmitCurrentBatch` ~1215; `CreateProofs` ~2187 (state `proofMethod`/`proofMethodDialogOpen`/`installDialogOpen` ~2211–2213, desktop-default effect ~2258, `browserSelected` ~2317, `proofBlocked` ~2322 — currently includes `methodMissing || browserSelected`, blocked-reason strings ~2336–2352, summary tile ~2367); `CreateProofsGenerating` ~2474 (indeterminate spinner, hardcoded `0 of N`); `LocalProofMethodDialog` ~3050 (all chooser copy); `ProofHelperInstallDialog` ~3167; phrase input helpers ~3960–3999; `deriveMasterXPrv` ~4001; `validateDestinationProofResponse` ~4036 (recursive `findPathMetadata` ~4076). Resume snapshot key `proof-tool.claim-flow.resume.v1` (2 h TTL) — persists `proofArtifacts`; must gain no secret fields.
- Helper POST body (both webapp and e2e): `{ master_xprv_base64, profile, requests, search: { max_account: 9, max_index: 999 }, include_debug_path: false }` with `X-Proof-Tool-Token`.
- `lib/claim/types.ts` — `ClaimDraftResponse` (`proofProfile`, `proofRequests`, `orderedInputs`, `buildSupported`), `CLAIM_DEFAULT_BATCH_CAP=4`, `CLAIM_HARD_BATCH_CAP=5`, `DESTINATION_ADDRESS_V1_ENCODING`.
- `lib/reclaim/types.ts` — `ReclaimDeployment.verifierVkHash` (~line 13) + optional `proof` block: extend here for `browser_proving`.
- `lib/reclaim-server/config` — `getReclaimDeployment()`: server-side descriptor parsing goes here; surfaced via `app/claim-api/deployment/route.ts` capabilities.
- `lib/claim-server/build-submit.ts` — `assertProofArtifacts` (~342–412; called from `buildClaimTx` ~239): pins schema, `circuit_id`, vk_hash, credential, destination, `public_input_encoding`, `cardano.format`, and recomputes the blake2b `destinationPublicInputDigest`. **Do not modify — browser artifacts must pass it as-is.**
- `next.config.mjs` — no `headers()` today; no middleware exists. COOP/COEP work happens here (Milestone 3), scoped to claim + proof-runtime routes unless a full audit says otherwise.
- `workers/ownership-proof-worker.ts` — one-line re-export of `@proof-zk-recovery/proof-tool-client/worker` (`packages/client-ts`: seed→xprv via PBKDF2-HMAC-SHA512, zeroes after transfer). Pattern reference for worker creation: `defaultCreateWorker` ~509.
- `public/` — only `landing-recovery-hero.png`; proof runtime/assets directories do not exist yet.
- `e2e/preprod/` — `run.mjs` orchestrator; `proof-stage.mjs` (`generate-destination-bound-proofs`) is helper-specific and asserts the same artifact schema + digest recompute; `claim-ui-stage.mjs` + `cip30-harness.mjs`/Lace drivers exist for real-UI runs (browser-wasm e2e mode drives the UI, not a direct POST).

## 4. Execution order and orchestration

Milestone order: 1 → (2, 3 in parallel) → 4 → 5 → 6 → 7. Suggested subagent split — delegate the mechanical, keep the judgment-heavy in the main session:

- **Subagent A (Milestone 1, mechanical):** `git mv` the five packages per the plan's mapping, rewrite import paths (`proof-tool/experiments/wasm-prover/msmengine` → `proof-tool/internal/msmengine`, etc.), re-point `experiments/wasm-prover` harness/scripts/README to the new locations, write `scripts/build-wasm-prover.sh` (builds both wasm binaries with the pinned toolchain, copies `wasm_exec.js`, emits `runtime-manifest.json` with sha256+blake2b256 of each output). Gate: `go build ./... && go vet ./...`, package tests, both `GOOS=js GOARCH=wasm` builds, `node experiments/wasm-prover/web/node-msm-check/run.mjs` (repointed). The gnark-fork decision execution (fork repo + replace directive vs. interim CI vendor-drift check) stays in the main session — it touches the load-bearing vendor tree (constraint 1).
- **Subagent B (Milestone 4 runtime files, mechanical given the spec):** production `public/proof-runtime/` worker files adapted from `web/worker.js` (add GOGC/GOMEMLIMIT init parameters, keep chunk verification and zeroing, strip nothing security-relevant) and the classic prover worker that loads `wasm_exec.js` + `proof-destination.wasm` and forwards `preflightProofAssets`/`proveDestination` + progress over `postMessage`. Must first verify in `sharded_js.go` how the MSM worker URL resolves when the orchestrator runs inside a worker (nested workers), and prove nested spawning works with a scratch page before committing to the design; fall back to main-thread orchestration (as the experiment does) if it doesn't, and record the decision in the plan.
- **Subagent C (Milestone 6, after 5 lands):** unit tests per the plan's test list (mock the worker; assert progress-event redaction by serializing the event stream) and the `RECLAIM_E2E_PROOF_PROVIDER` e2e parameterization.
- **Main session:** Milestones 2 (descriptor + config + deployment route), 3 (COOP/COEP + cross-origin subresource audit + Lace/CIP-30 regression via existing e2e), 4's provider layer (`lib/proving/types.ts`, `desktop-helper.ts` — behavior-preserving extraction from `generateClaimProofs`, `browser-wasm.ts`, `capability.ts`), 5 (all ClaimFlow.tsx edits), 7 (evidence + posture; hosted infra and modest-hardware runs may need Philip — flag rather than fake).

Review every subagent diff before proceeding; subagents must not touch `vendor/`, `ClaimFlow.tsx`, or `assertProofArtifacts`.

## 5. Verification cadence

After each milestone, and always before ClaimFlow edits are considered done:

    go build ./... && go vet ./...
    go test ./internal/msmengine/... ./internal/streampk/... ./internal/streamprove/...   # after M1
    pnpm --dir apps/ownership-proof-web test -- ClaimFlow
    pnpm --dir apps/ownership-proof-web test -- proving                                    # once lib/proving tests exist
    pnpm --dir packages/client-ts test

Milestone-specific gates are in the plan (each milestone's Acceptance paragraph). Full local acceptance (Milestone 5): `source .env.local && pnpm --dir apps/ownership-proof-web dev`, then the real claim page flow with the browser method — proof must reach `create-proofs-complete`, build, sign, submit on preprod; then re-run one tamper check via `verify-tamper.mjs` against a browser-produced artifact.

## 6. Definition of done

All plan milestones 1–6 implemented and their acceptance gates green; Milestone 7 evidence gathered or explicitly handed to Philip (hosted run, provenance review, fork landing); the ExecPlan's living sections updated throughout, with the final `Outcomes & Retrospective` recording provider, runtimes, heap, validation results, and the secrets audit. The desktop-helper path must be regression-free at every commit, and the deployment descriptor must remain the sole enablement switch (no descriptor ⇒ today's guarded UI, bit-for-bit).
