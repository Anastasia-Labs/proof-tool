# Deploy the claim webapp to Vercel (Cardano preprod) with "Prove in this browser"

A complete, self-contained runbook to take the ownership-recovery claim webapp
from its **current working-tree state** to a public Vercel deployment on Cardano
**preprod**, with the browser WASM prover (`Prove in this browser`) enabled and
proving end-to-end.

This document is grounded in the actual repo state (verified 2026-07-09), not an
aspirational one. It first inventories exactly **what is already implemented** and
**what is not**, then gives the ordered, detailed steps to close the gap.

Status: open. The Cloudflare R2 ranged host is live. The Vercel environment,
deployed Lace/COEP check, and hosted end-to-end browser proof remain go/no-go
gates.

---

## Part 1 — Current state (verified)

### 1.1 What is implemented and working

The browser-proving feature is **code-complete and locally verified**. Concretely:

- **Go prover, extracted to production packages.** `internal/msmengine`,
  `internal/streampk`, `internal/streamprove`, `cmd/wasm-prover`, `cmd/msmworker`.
  `go build ./...`, `go vet ./...`, and the package tests pass. Both
  `GOOS=js GOARCH=wasm` binaries build.
- **Reproducible WASM build pipeline.** `scripts/build-wasm-prover.sh` emits
  `proof-destination.wasm`, `msmworker.wasm`, `wasm_exec.js`, and a
  `runtime-manifest.json` of hashes; two clean builds produce byte-identical
  output.
- **gnark streaming-prover dependency captured.** The hand-patched vendored gnark
  (`ProveStream`) is reconstructed into
  `experiments/wasm-prover/patches/prove-stream.patch`;
  `scripts/bootstrap-vendor.sh` recreates `vendor/` from `go.mod` + patch;
  `scripts/check-vendor-drift.sh` and `.github/workflows/vendor-drift.yml` guard it.
- **Provider layer.** `apps/ownership-proof-web/lib/proving/` — `types.ts`,
  `desktop-helper.ts` (behavior-preserving), `browser-wasm.ts`, `capability.ts`.
- **Runtime worker files.**
  `apps/ownership-proof-web/public/proof-runtime/prover-worker.js` and
  `msm-worker.js` (committed source; the latter sets GOGC/GOMEMLIMIT, keeps chunk
  hash verification and buffer zeroing).
- **Deployment descriptor.** `ReclaimDeployment.proof.browser_proving` is defined
  in `lib/reclaim/types.ts` and validated in `lib/reclaim-server/manifest.ts`
  (same-origin runtime URLs enforced, tuning validated), surfaced via
  `/claim-api/deployment` `capabilities.browserProving`.
- **Cross-origin isolation.** `next.config.mjs` sends COOP `same-origin` + COEP
  `require-corp` site-wide and CORP + immutable caching on `/proof-runtime/*` and
  `/proof-assets/*`. Verified `crossOriginIsolated === true` on `/claim` in
  headless Chromium.
- **ClaimFlow wiring.** `Prove in this browser` gated on live preflight; branched
  `generateClaimProofs`; N-of-M + stage/percent progress; Cancel + beforeunload
  guard.
- **Tests.** 234 webapp tests pass (incl. `lib/proving` unit tests and browser-
  method ClaimFlow tests); 98 e2e tests pass with the `RECLAIM_E2E_PROOF_PROVIDER`
  parameterization.
- **Local end-to-end acceptance.** A full browser proof through the production
  worker stack produced a `streampk-sharded-groth16` proof in **122 s / 2.31 GiB,
  verified locally**; the artifact passed `verify-destination` and the five-class
  tamper gate.
- **Cloudflare R2 ranged host.** Bucket `proof-assets` is live at
  `proof-assets.reclaim-proof.com`; the release prefix, CORS, immutable headers,
  compression disable rule, cache eligibility, and Smart Tiered Cache were
  verified against real PK chunks and the CCS on 2026-07-09. The enabled public
  descriptor and signed chunk manifest use the custom domain.

### 1.2 What is NOT done (the actual deployment gap)

1. **Almost none of the above is committed to git.** On branch `main` the working
   tree has 43 modified + 41 untracked entries. The entire prover subsystem
   (`internal/msmengine|streampk|streamprove`, `cmd/wasm-prover|msmworker`,
   `internal/proofassets`, `cmd/proof-tool/chunk_manifest.go`, `experiments/`,
   `scripts/`), the provider layer (`lib/proving/`), and the runtime workers are
   **untracked**. The WASM binaries and `ownership.vk` are **gitignored**. Only
   three browser-proving files are tracked-and-modified: `ClaimFlow.tsx`,
   `next.config.mjs`, `lib/reclaim-server/manifest.ts` — and `ClaimFlow.tsx`
   imports the untracked `lib/proving/*`, so committing it without the rest breaks
   the build. **Vercel deploys only committed files, so this is the first blocker.**
2. **The WASM binaries are not shippable yet.** They are gitignored build products,
   and Vercel's Next.js build image has no Go toolchain, so `next build` cannot
   produce them.
3. **No Vercel environment is configured** (deployment manifest, provider key,
   review-token secret).
4. **No hosted/wallet validation** (COOP/COEP + Lace signing on a real domain; a
   modest-hardware run).
5. **gnark fork provenance** (Milestone 7) is deferred — interim drift-check CI is
   the current control.

### 1.3 Architecture once deployed — what serves what

| Origin | Serves | Notes |
|---|---|---|
| **Vercel Next.js project** (Root Directory `apps/ownership-proof-web`) | The app; `/claim-api/*` and `/reclaim-api/*` Route Handlers; same-origin `/proof-runtime/*` (WASM + workers) and `/proof-assets/*` (manifests, VK, PK index) | Route Handlers deploy as Vercel Functions. COOP/COEP is in `next.config.mjs`; `public/` is served from Vercel's CDN. |
| **Cloudflare R2 custom domain** (`proof-assets.reclaim-proof.com`, not Vercel) | `ownership.pk` chunks (~2.08 GB), `ownership-destination.ccs` (~187 MB), and the monolithic CPU fallback | Live with CORS, identity encoding, immutable headers, edge caching for chunks/CCS, and Smart Tiered Cache. Exact configuration: `docs/browser-proving-asset-hosting.md`. |

The legacy `/dev/credential-proof` page and its Go `/api/verify` service are
local-only. Production deploys only the Next.js project;
`scripts/dev-credential-proof.sh` starts the verifier plus the developer-only
Next.js proxy locally.

**Trust model:** everything the browser executes or trusts as an integrity root
(WASM, workers, signed manifests, VK, PK index) is same-origin on Vercel and
hash-pinned; only bulk, hash-verified data (PK, CCS) streams from the ranged host.
The `browser_proving` descriptor is the master on/off switch — with none present,
the claim page is today's guarded shell, bit-for-bit.

---

## Part 2 — Prerequisites

Accounts / access:

- **Vercel** account + team connected to this repo and able to set environment
  variables for Preview and Production deployments.
- **Blockfrost** preprod project id (`preprod…`) — the preprod build/submit
  provider. (Koios works keyless as fallback but Blockfrost is better for submit.)
- The live **Cloudflare R2** bucket `proof-assets`, exposed through
  `proof-assets.reclaim-proof.com`. Its CORS, cache, response-header,
  no-compression, and Smart Tiered Cache configuration is recorded in
  `docs/browser-proving-asset-hosting.md`.
- The **preprod key bundle** already staged locally at
  `output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/…`
  (2 GB PK, VK, signed key manifest; `vk_hash` `blake2b256:6057da91…d430a`).
  If absent, regenerate from the setup ceremony first (out of scope).
- The **preprod reclaim contracts** deployed on-chain, captured in
  `deployments/reclaim/preprod/live.local.json` (gitignored). If not deployed, run
  `pnpm --dir apps/ownership-proof-web deploy:reclaim:preprod` first.

Local tools: `go 1.26.0` (pinned), `node`, `pnpm`, `git`, `playwright` (in webapp
dev deps), and your host's CLI (`wrangler`/`aws`/`b2`).

Absolute rule: **never run `go mod vendor`/`go mod tidy` directly** — the streaming
prover lives only in a gitignored, hand-patched `vendor/`. Use
`scripts/bootstrap-vendor.sh`.

---

## Part 3 — Step-by-step deployment

### Step 0 — Get the codebase into a committed, deployable state

Because the feature is essentially uncommitted, nothing deploys until this is done.
This step is yours to review (you own which of the 43 modified files are ready),
but the browser-proving surface that **must** be committed together is:

1. **Un-gitignore the shippable build products.** Edit `.gitignore` and remove (or
   scope) the lines that currently exclude the Vercel-served WASM. Today it has:

       dist/
       apps/ownership-proof-web/public/proof-runtime/*.wasm

   Keep `dist/` ignored (that's scratch), but the two `public/proof-runtime/*.wasm`
   files and `ownership.vk` must ship. Either delete the `public/proof-runtime/*.wasm`
   ignore line, or plan to `git add -f` them (Step 3). `ownership.vk` is also caught
   by the repo-wide `*.vk` rule — it will need `git add -f` regardless.

2. **Commit the Go prover subsystem** (required if you build WASM in CI, and for the
   Go `verifier` service): `internal/msmengine/`, `internal/streampk/`,
   `internal/streamprove/`, `internal/proofassets/`, `cmd/wasm-prover/`,
   `cmd/msmworker/`, `cmd/proof-tool/chunk_manifest.go`,
   `experiments/wasm-prover/patches/prove-stream.patch`,
   `experiments/wasm-prover/msmengine/shim.go`, and `scripts/*.sh`.
   (`vendor/` stays gitignored — it is regenerated by `bootstrap-vendor.sh`.)

3. **Commit the webapp browser-proving surface:** `apps/ownership-proof-web/lib/proving/`,
   `apps/ownership-proof-web/public/proof-runtime/{prover-worker.js,msm-worker.js,wasm_exec.js}`,
   the modified `ClaimFlow.tsx`, `next.config.mjs`, `lib/reclaim/types.ts`,
   `lib/reclaim-server/manifest.ts`, and their tests. Commit `ClaimFlow.tsx`
   **together with** `lib/proving/*` — the former imports the latter.

4. **Verify a clean build off the commit** before pushing:

       bash scripts/check-vendor-drift.sh
       go build ./... && go vet ./...
       pnpm --dir apps/ownership-proof-web install
       pnpm --dir apps/ownership-proof-web typecheck
       pnpm --dir apps/ownership-proof-web test
       pnpm --dir apps/ownership-proof-web build     # next build, the Vercel command

5. **The webapp commit you deploy must be clean and pushed.** The manifest's
   `source_commit` identifies the contract deployment source, so an existing
   deployment normally keeps its original commit while the webapp advances. The
   release commit must contain that deployment commit in its Git history. Only a
   new contract deployment replaces `source_commit` and its bound
   `deployment_id`.

> Do a normal branch → PR → merge if that is your flow; just ensure the deployed
> commit contains everything above and is not dirty.

### Step 1 — Lock the preprod deployment identity

1. Validate the preprod manifest:

       node apps/ownership-proof-web/scripts/verify-reclaim-manifest.mjs deployments/reclaim/preprod/live.local.json

2. Record the identity values you will reuse: `deployment_id`, `network: Preprod`,
   `network_id: 0`, and `reclaim_global.verifier_vk_hash` == `proof.vk_hash` ==
   `blake2b256:6057da91…d430a`. Keep the existing `source_commit` for this
   on-chain deployment and verify it is an ancestor of the webapp release commit:

       git merge-base --is-ancestor "$(jq -r .source_commit deployments/reclaim/preprod/live.local.json)" HEAD

The descriptor's browser-proving `vk_hash` chain must terminate at this
`verifierVkHash` or the client refuses to prove.

### Step 2 — Verify and maintain the ranged asset host (PK + CCS) — complete

The ranged host was deployed and verified on 2026-07-09. Keep this step as the
release/revalidation procedure; the detailed live configuration and operations
record is `docs/browser-proving-asset-hosting.md`.

**2.1 Deployed host — Cloudflare R2.** The workload range-fetches ~2 GB of
proving key **per proof** (up to ~10 GB per batch session), so **egress, not
storage, is the entire cost story**. R2 was selected because it has **zero
egress fees**, native HTTP range, one service, and Cloudflare-native header
control. The 4.35 GB stored footprint is below R2 Standard's 10 GB-month monthly
free tier by itself; usage elsewhere in the account still counts toward that
allowance. Alternatives, for the record:

| Host | Egress at 2 GB/proof | Verdict |
|---|---|---|
| **Cloudflare R2** (custom domain) | **$0** | **Recommended.** Edge-cached; repeat users barely touch R2. |
| Backblaze B2 + Cloudflare (Bandwidth Alliance) | ~$0 | Fine if already on B2; two services instead of one. |
| AWS S3 + CloudFront | ~$0.085/GB → **~$0.17/proof** | Works, but 10k proofs ≈ $1,700 egress. Avoid for this workload. |
| Vercel Blob / Vercel itself | costly + weak range/header control | **Don't** — the point is to keep bulk off Vercel. |

The live bucket is `proof-assets` in `WNAM`, attached to the custom domain
`proof-assets.reclaim-proof.com`.

**Stable base path.** Content is content-addressed and immutable; use a
write-once, release-scoped path. The current release uses
`https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3/`.
The repeated `proof-assets` is the bucket object's key prefix, not a typo.
Serve it via a **custom domain**, not the `r2.dev` URL (rate-limited, not for
production, limited header control). Never overwrite a release path.

**2.2 Generate the chunk manifest + chunked PK against the production base URL.**
Run **after** the WASM is built (Step 3) so the pins match, or run now and rebuild
if the WASM changes:

    go run ./cmd/proof-tool generate-chunk-manifest \
      --keys-dir output/release/proof-assets-…/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3 \
      --deployment-manifest deployments/reclaim/preprod/live.local.json \
      --out-dir output/proof-assets-stage-preprod-d2c944d-r3 \
      --signing-key output/signing-keys/preprod-local-destination-d2c944dd753c-r3.ed25519.private.hex \
      --manifest-public-key e20b0fb38fb6dc0a66284a8f3a6e8d05bf55b8e966d86f53b77d284b524463d6 \
      --ccs-path experiments/wasm-prover/web/ownership-destination.ccs \
      --proof-wasm-path dist/proof-runtime/proof-destination.wasm \
      --worker-js-path apps/ownership-proof-web/public/proof-runtime/msm-worker.js \
      --msm-worker-wasm-path dist/proof-runtime/msmworker.wasm \
      --base-url 'https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3/' \
      --release proof-assets-preprod-d2c944d-r3 --profile preprod-single-destination

> **GOTCHA — trailing slash.** `--base-url` MUST end with `/`. The sharded engine
> resolves each chunk with `ResolveReference`; without the trailing slash the last
> path segment is dropped, chunks 404, and the engine silently degrades from
> `streampk-sharded-groth16` (~120 s) to `streampk-cpu-groth16` (~500 s). The proof
> still verifies, so this is easy to miss — check the `engine` field after a test
> proof. (See `docs/browser-proving-asset-hosting.md`.)

The out dir now has `ownership.pk.part0000…part0123` (124 × 16 MiB), the CCS, and
the signed `chunk-manifest.json`.

**2.3 Upload the bulk objects.** Upload under the release base path: the 124
`ownership.pk.part####` chunks and `ownership-destination.ccs`. **Also upload the
single `ownership.pk`** (the 2 GB file from the key bundle) if you want the
CPU-fallback proving path to work — it is fetched via `pk_url` when the sharded
engine can't run; it adds about 2.08 GB to the stored footprint and lets a proof
still complete (slowly) instead of failing to desktop. If you'd rather fail fast to
desktop-helper when sharding is unavailable, omit it. (The small integrity-root
files — manifests, VK, PK index — go to Vercel same-origin in Step 4, not here.)

The worker enforces these response requirements and rejects otherwise:

- **`Accept-Ranges: bytes`** with 206/416 semantics on every chunk and the CCS.
  The live monolithic PK returned `200` to a Range request on 2026-07-09; the
  sharded path is unaffected, but do not rely on a ranged CPU fallback until this
  is corrected and re-verified.
- **`Content-Encoding: identity`** — no gzip/brotli/transfer transforms on the
  body. Serve as `application/octet-stream` and disable Cloudflare
  Polish/Brotli/auto-minify for the route.
- **CORS is required (not just CORP).** The prover runs in a worker and reaches
  these objects with a cross-origin `fetch()` whose *body it must read*. Under COEP
  a body-reading cross-origin `fetch()` is a CORS request — so the response **must**
  carry `Access-Control-Allow-Origin` for the app. The current public bucket uses
  `Access-Control-Allow-Origin: *`, which is valid because the requests carry no
  credentials. Range fetches also need `Access-Control-Allow-Headers:
  range` and a handled `OPTIONS` preflight. `Cross-Origin-Resource-Policy:
  cross-origin` alone is **not** sufficient here — CORP covers no-cors embeds
  (`<img>`/`<script>`), not `fetch()` that reads bytes. (Add CORP too if you like;
  it does no harm.)

  > The live cross-origin CORS-under-COEP prerequisites were verified against a
  > PK chunk and the CCS on 2026-07-09. Repeat the checks in 2.4 after changing
  > the bucket CORS policy or the app origin.

- **`Cache-Control: public, max-age=31536000, immutable`.**

**Live R2 configuration:**

1. Set the bucket **CORS policy** (R2 dashboard → bucket → Settings → CORS, or via
   `wrangler`/S3 API). This produces the `Access-Control-*` headers, including
   preflight handling:

       [
         {
           "AllowedOrigins": ["*"],
           "AllowedMethods": ["GET", "HEAD"],
           "AllowedHeaders": ["Range"],
           "ExposeHeaders": [
             "Accept-Ranges",
             "Content-Length",
             "Content-Range",
             "Content-Encoding",
             "ETag",
             "Cache-Control"
           ],
           "MaxAgeSeconds": 86400
         }
       ]

2. Cache Rule `proof_assets_cache_eligible_v1` matches
   `(http.host eq "proof-assets.reclaim-proof.com")` and sets `cache: true`.
3. Response Header Transform Rule `proof_assets_response_headers_v1` uses the
   same hostname match and sets
   `Cache-Control: public, max-age=31536000, immutable` plus
   `Cross-Origin-Resource-Policy: cross-origin`.
4. Compression Rule `proof_assets_disable_compression_v1` uses the same hostname
   match and selects only the `none` algorithm. This is required even when a
   client advertises gzip, Brotli, or Zstandard.
5. Tiered Cache and Smart Tiered Cache are enabled for the zone. Unlike the three
   hostname rules, these are zone-level settings.

The 16 MiB chunks and 187 MB CCS are below Cloudflare's 512 MB cacheable-object
limit on Free, Pro, and Business plans and returned `CF-Cache-Status: HIT` during
live checks. The 2.08 GB monolithic fallback is accessible but returned `BYPASS`;
it is too large for that cache limit. See the hosting guide for Cloudflare source
links, safe token permissions, purge guidance, and exact verification commands.

Other hosts, briefly: **S3 + CloudFront** — bucket CORS + a response-headers policy
(cache; CORS is carried from the origin), `Content-Encoding` unset, CloudFront
compression **off** for these objects. **B2** — front with Cloudflare/Bunny to get
range + CORS + cache.

**2.4 Verify from outside Vercel, simulating the app origin** before wiring it in.
Check both the plain chunk GET and a CORS preflight for the ranged CCS:

    # Chunk GET (no Range header) — must be CORS-readable:
    curl -si -H 'Origin: https://<app-origin>' \
      'https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3/ownership.pk.part0000' | head
    # expect: 200, Accept-Ranges: bytes, no/identity Content-Encoding,
    #         Access-Control-Allow-Origin: *

    # Range request byte-identity on the CCS:
    curl -si -H 'Origin: https://<app-origin>' -r 1000000-1000063 \
      'https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3/ownership-destination.ccs' | head
    # expect: 206, Content-Range present, ACAO present

    # CORS preflight for a ranged fetch:
    curl -si -X OPTIONS \
      -H 'Origin: https://<app-origin>' \
      -H 'Access-Control-Request-Method: GET' \
      -H 'Access-Control-Request-Headers: range' \
      'https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3/ownership-destination.ccs' | head
    # expect: 2xx, Access-Control-Allow-Origin + Access-Control-Allow-Headers: range

If any of these lack `Access-Control-Allow-Origin`, the browser proof will fail the
moment it tries to read a chunk — fix CORS before proceeding.

### Step 3 — Build and ship the WASM runtime (the Go-on-Vercel problem)

The browser prover needs four same-origin runtime files in
`apps/ownership-proof-web/public/proof-runtime/` — `proof-destination.wasm`
(~24 MB), `msmworker.wasm` (~12 MB), `wasm_exec.js`, plus the committed
`prover-worker.js` + `msm-worker.js`. The first three are reproducible build
products, currently gitignored, and Vercel's Next.js build image has no Go. The
validator also requires these to be same-origin, so they cannot move to the ranged
host. Pick one strategy:

**Strategy 1 — build in CI, commit the artifacts (recommended).** Run the
reproducible build with Go 1.26.0 (locally or in a GitHub Action), then commit:

    bash scripts/build-wasm-prover.sh                 # → dist/proof-runtime/{*.wasm,wasm_exec.js,runtime-manifest.json}
    bash scripts/stage-proof-assets.sh output/proof-assets-stage-preprod-d2c944d-r3
    git add -f apps/ownership-proof-web/public/proof-runtime/proof-destination.wasm \
               apps/ownership-proof-web/public/proof-runtime/msmworker.wasm \
               apps/ownership-proof-web/public/proof-runtime/wasm_exec.js

  Because the build is byte-reproducible, the committed binaries match
  `runtime-manifest.json` and the chunk-manifest pins. Trade-off: ~36 MB in Git.

**Strategy 2 — build the WASM in the Vercel `web` build.** Only if you make Go
available there via a custom install command that fetches the pinned Go toolchain,
then runs `bash scripts/bootstrap-vendor.sh && scripts/build-wasm-prover.sh &&
scripts/stage-proof-assets.sh output/…`. Keeps Git clean; heavier build; needs
network to the Go toolchain and the committed `prove-stream.patch`.

After this step, `public/proof-runtime/` has all five files and their bytes match
the chunk-manifest pins (the `worker.js` pin must equal the served `msm-worker.js`
bytes — the stage script keeps them consistent; verify with a sha256 compare).
The 24 MB WASM is within Vercel's static-asset limits and is CDN-cached; do not
route it through a serverless function.

### Step 4 — Stage same-origin assets and enable the descriptor

**4.1 Stage the small same-origin assets.** `scripts/stage-proof-assets.sh` (run
in Step 3) copies into `apps/ownership-proof-web/public/proof-assets/`:
`manifest.json`(+`.sig`,+`-public-key.hex`), `ownership.vk`,
`ownership.pk.idx.json`, `chunk-manifest.json`(+`.sig`,+`-public-key.hex`),
`reclaim-deployment.json`. Commit these (tiny). **`ownership.vk` is matched by the
`*.vk` gitignore — `git add -f` it or it will be missing on Vercel.**

**4.2 Add the enabled `browser_proving` block** to the preprod manifest's `proof`
object. Runtime URLs are same-origin paths (validated); `pk_url`/`ccs_url` point at
the ranged host. Start from `deployments/reclaim/preprod/disabled.sample.json` and
set `enabled: true` and the real host URLs:

    "browser_proving": {
      "enabled": true,
      "runtime_base_url": "/proof-runtime",
      "manifest_url": "/proof-assets/manifest.json",
      "manifest_sig_url": "/proof-assets/manifest.sig",
      "manifest_public_key_hex": "e20b0fb38fb6dc0a66284a8f3a6e8d05bf55b8e966d86f53b77d284b524463d6",
      "chunk_manifest_url": "/proof-assets/chunk-manifest.json",
      "chunk_manifest_sig_url": "/proof-assets/chunk-manifest.sig",
      "chunk_manifest_public_key_hex": "e20b0fb38fb6dc0a66284a8f3a6e8d05bf55b8e966d86f53b77d284b524463d6",
      "deployment_manifest_url": "/proof-assets/reclaim-deployment.json",
      "vk_url": "/proof-assets/ownership.vk",
      "pk_url": "https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3/ownership.pk",
      "pk_index_url": "/proof-assets/ownership.pk.idx.json",
      "ccs_url": "https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3/ownership-destination.ccs",
      "ccs_blake2b256": "blake2b256:54da79a38f83d47447cd613bb41d16ef0a19e3c29b0b1a3267d0a1c16aeb577e",
      "proof_wasm_url": "/proof-runtime/proof-destination.wasm",
      "worker_js_url": "/proof-runtime/msm-worker.js",
      "msm_worker_wasm_url": "/proof-runtime/msmworker.wasm",
      "tuning": { "worker_count": 8, "shard_count": 32, "range_fetch_concurrency": 2, "pinned_decode": true, "gogc": 50, "gomemlimit": "3000MiB" }
    }

> The sharded engine fetches chunk parts via the **chunk-manifest** `base_url`
> (Step 2); `pk_url` is used by the CPU-fallback path. Simplest: keep the chunk
> parts, the CCS, and (optionally) a single `ownership.pk` under the same base
> path so both paths resolve.

**4.3 Validate the full manifest parses** (enforces same-origin runtime URLs,
hex/hash formats, and the `vk_hash` chain):

    node apps/ownership-proof-web/scripts/verify-reclaim-manifest.mjs <your-manifest.json>

### Step 5 — Vercel project + environment variables

**5.1 Project.** Import the repo as a standard Next.js project with Root
Directory `apps/ownership-proof-web`. Do not select the Services framework.
The app-local `vercel.json` pins `pnpm install --frozen-lockfile` and
`pnpm build`; leave the output directory at the Next.js default. Keep **Include
source files outside of the Root Directory** enabled so the
`file:../../packages/client-ts` dependency is available. The local-only
credential proof demo is intentionally absent, so `/dev/credential-proof` and
`/api/verify` must both return 404 on Preview and Production. For local
development with the Go verifier, run `scripts/dev-credential-proof.sh`.

**5.2 Environment variables (Production).** Inject the whole manifest as one JSON
var — cleanest, and avoids the 40+ flat `RECLAIM_*` fields:

| Variable | Value | Notes |
|---|---|---|
| `RECLAIM_DEPLOYMENT_MANIFEST_JSON` | full preprod manifest JSON (with the `browser_proving` block) | Single source of truth. |
| `RECLAIM_PROVIDER` | `blockfrost` | Preprod submit provider. |
| `RECLAIM_BLOCKFROST_PROJECT_ID` (or `BLOCKFROST_PROJECT_ID`) | your `preprod…` id | **Secret.** Required for build/submit. |
| `RECLAIM_REVIEW_TOKEN_SECRET` | `openssl rand -hex 32` | **Secret.** HMAC secret for build→submit review tokens. Required. |
| `RECLAIM_KOIOS_URL` / `RECLAIM_KOIOS_TOKEN` | optional | Fallback provider. |

Do **not** also set flat `RECLAIM_*` per-field vars unless they match the JSON
exactly — the loader runs an env/manifest coherence check and disables the
deployment on any mismatch. Browser-proving enablement is entirely
`browser_proving.enabled` in the JSON — there is no client env flag.

**5.3 Custom domain.** Assign it. The current public R2 CORS policy allows `*`, so
Preview and Production app origins are already accepted for credential-free
asset reads. If the policy is tightened later, add every deployed app origin and
purge cached asset responses after changing CORS.

### Step 6 — Cross-origin isolation & wallet (Lace) validation on the deployed site

COOP/COEP ship automatically from `next.config.mjs`. Verify on the live site:

1. **Isolation live.** On `/claim`: `crossOriginIsolated === true` and
   `new SharedArrayBuffer(8)` succeeds. If false, a cross-origin subresource is
   COEP-blocked — check the network tab for a resource lacking CORP/CORS.
2. **CIP-30 signing under COEP.** Connect **Lace** (preprod), run a claim to the
   signing step, confirm `signTx` succeeds. Extension scripts are usually
   COEP-exempt, but the signing handshake is where isolation can bite. If a wallet
   breaks and cannot be fixed with CORP, the fallback is `COEP: credentialless`
   (verify Safari support at that time) — record the change if you make it.

### Step 7 — Deploy and run acceptance

1. Deploy the clean webapp release commit (`vercel --prod` or via Git). Its Git
   history must contain the manifest's contract-deployment `source_commit`.
2. **Deployment health:** `/claim` shows preprod as available;
   `GET /claim-api/deployment` returns `available: true` with
   `capabilities.browserProving` non-null.
3. **Browser preflight (no phrase yet):** choose `Prove in this browser`; the
   readiness section must resolve to **ready**. An asset error means the preflight
   `vk_hash` mismatched or a signed manifest/chunk check failed — recheck Steps
   2/4. "Continue" stays blocked until ready.
4. **Full browser proof on preprod:** with an impacted preprod wallet that has
   matching reclaim UTxOs and a distinct safe wallet (Lace), run browser method →
   phrase → generate. Expect visible N-of-M + stage/percent progress, engine
   `streampk-sharded-groth16` at ~2 min/proof (a `streampk-cpu-groth16` ~8 min run
   means the chunk base_url trailing slash or a ranged-host 404/CORS issue demoted
   it — fix Step 2), then `create-proofs-complete` → build → sign (Lace) → submit
   on preprod.
5. **Desktop path regression check:** flip `browser_proving.enabled: false` in the
   manifest env var → the page is the guarded shell and Proof Helper Desktop still
   works. The kill switch is config-only.

---

## Part 4 — Go / no-go checklist

- [ ] Browser-proving code + workers + Go packages + scripts **committed**; WASM
  and `ownership.vk` force-added past `.gitignore`; `next build` green off the
  webapp release commit; manifest `source_commit` clean, pushed, and an ancestor
  of that release commit.
- [x] Ranged host (R2) serves PK chunks + CCS with range, `identity` encoding,
  wildcard read-only CORS, immutable cache headers, and preflight handling; full
  chunk and CCS requests were edge-cache `HIT` on 2026-07-09.
- [ ] Chunk manifest generated with a **trailing-slash** base URL; `worker.js` pin == served `msm-worker.js` bytes.
- [ ] `public/proof-runtime/*` (5 files) + `public/proof-assets/*` present in the deploy and byte-match the pins.
- [ ] Manifest `browser_proving.enabled: true`; `vk_hash` chain terminates at `verifierVkHash`; manifest passes `verify-reclaim-manifest.mjs`.
- [ ] Vercel env: `RECLAIM_DEPLOYMENT_MANIFEST_JSON`, `RECLAIM_PROVIDER=blockfrost`, `RECLAIM_BLOCKFROST_PROJECT_ID`, `RECLAIM_REVIEW_TOKEN_SECRET`.
- [ ] Preview and Production return 404 for both `/dev/credential-proof` and `/api/verify`; `scripts/dev-credential-proof.sh` still serves the local credential-proof demo.
- [ ] `crossOriginIsolated === true` on `/claim`; Lace connect + signTx works under COEP.
- [ ] End-to-end preprod browser proof: sharded engine, ~2 min/proof, verified, build+sign+submit succeeds.
- [ ] Secrets spot-check: no seed phrase / master XPrv / derivation path / request JSON in any network request (beyond descriptor asset fetches), console log, `localStorage` resume snapshot, or error surface.

## Part 5 — Rollback

- **Disable browser proving:** set `browser_proving.enabled: false` in the manifest
  JSON env var and redeploy. UI reverts to the guarded shell; desktop unaffected.
- **Disable the whole claim deployment:** set manifest `enabled: false` or remove
  `RECLAIM_DEPLOYMENT_MANIFEST_JSON`.
- **Bad asset host:** repoint `pk_url`/`ccs_url`/chunk `base_url` at a prior release
  path (assets are immutable/content-addressed, so old paths stay valid), or disable
  browser proving.

## Part 6 — Known limits & costs

- **Bandwidth:** each proof range-fetches ~2 GB of PK (plus 187 MB CCS on the first
  proof of a batch; asset state is reused across a batch). A 4–5 proof batch can be
  ~10 GB per session worst case. Prefer a zero-egress host (R2).
- **Client:** the proof peaks ~2.3 GiB heap in one tab and needs cross-origin
  isolation + SharedArrayBuffer + ≥4 cores. The preflight denies incapable browsers
  and points them at desktop; low-memory machines may still OOM.
- **Vercel functions:** `/claim-api/build` and `/claim-api/submit` use
  lucid-evolution + CML (`serverExternalPackages`). Watch function bundle size,
  memory, and submit duration against your plan limits; bump memory if it times out.
- **Experimental posture:** keep the `Experimental` pill and desktop as
  "Recommended for speed" until hosted evidence on a modest (≤8 GB / 4-core) and a
  fast profile is recorded and the gnark fork provenance review lands
  (see `docs/browser-proving.md` and `docs/browser-proving-asset-hosting.md`).
