# Browser-Proving Asset Hosting

How the browser WASM prover's assets are produced, split between same-origin and
a ranged host, and gated by the deployment descriptor. See
`docs/browser-proving.md` for runtime architecture and developer checks.

## Live Preprod R2 deployment

Verified 2026-07-09. The browser prover's bulk Preprod assets are public through
a Cloudflare R2 custom domain. The custom domain is required for Cloudflare Cache
and Rules; do not replace it with the non-production `r2.dev` endpoint.

| Item | Live value |
| --- | --- |
| Cloudflare zone | `reclaim-proof.com` |
| R2 bucket | `proof-assets` (`WNAM`) |
| Stored footprint | 126 objects, approximately 4.35 GB |
| Custom domain | `proof-assets.reclaim-proof.com` |
| Object-key prefix | `proof-assets/preprod-d2c944d-r3/` |
| Browser chunk base URL | `https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3/` |
| Release | `proof-assets-ownership-destination-v1-preprod-d2c944d-r3` |

The repeated `proof-assets` in the URL is intentional: the custom domain maps to
the bucket root, and the uploaded object keys retain their `proof-assets/`
prefix. The signed chunk manifest and reclaim deployment descriptor must use the
exact URL above, including its trailing slash where it is a base URL.

The prefix contains 124 `ownership.pk.part####` chunks of 16 MiB each, the
187,120,157-byte `ownership-destination.ccs`, and the 2,079,485,517-byte
`ownership.pk` CPU-fallback object. The small signed manifests, verifier key, PK
index, workers, and WASM remain same-origin with the Vercel webapp; R2 is only a
transport for bulk, hash-pinned bytes.

### CORS policy

The public bucket has this CORS policy:

```json
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
```

Wildcard origin access is intentional because these are public, immutable,
content-verified artifacts and requests carry no credentials. If this is later
tightened, include every deployed Vercel origin that must prove in-browser and
purge cached responses after changing the bucket policy. Cloudflare only adds
the CORS response headers when the request includes an `Origin` header.

### Cloudflare Rules and cache settings

The three Ruleset Engine rules match only:

```text
(http.host eq "proof-assets.reclaim-proof.com")
```

| Layer | Stable rule reference | Action |
| --- | --- | --- |
| Cache Rule | `proof_assets_cache_eligible_v1` | `set_cache_settings` with `cache: true` and a 1-year `edge_ttl` override (objects are write-once and content-addressed, so maximal edge retention is safe; added 2026-07-15) |
| Response Header Transform Rule | `proof_assets_response_headers_v1` | Set `Cache-Control: public, max-age=31536000, immutable`, `Cross-Origin-Resource-Policy: cross-origin`, and `Timing-Allow-Origin: *` (exposes Resource Timing `transferSize` cross-origin so the prover's `range_bytes_network/disk_cache` telemetry gets full attribution; added 2026-07-15) |
| Compression Rule | `proof_assets_disable_compression_v1` | `compress_response` with `algorithms: [{"name":"none"}]` |

Tiered Cache and Smart Tiered Cache are both enabled. Those are zone settings,
not hostname-scoped Ruleset Engine rules. Smart Tiered Cache reduces direct R2
reads by routing lower-tier misses through an upper tier selected for the R2
origin.

Observed cache behavior on 2026-07-09:

- A complete 16 MiB PK chunk returned `CF-Cache-Status: HIT` with
  `Content-Encoding: identity`.
- The complete 187,120,157-byte CCS returned `CF-Cache-Status: HIT` with
  `Content-Encoding: identity`.
- The 2,079,485,517-byte monolithic fallback PK returned
  `CF-Cache-Status: BYPASS`. It exceeds Cloudflare's 512 MB cacheable-object
  limit on Free, Pro, and Business plans, so requests go to R2.
- Chunk and CCS range requests returned `206` with a correct `Content-Range`.
  The monolithic `ownership.pk` returned `200` to a Range request during this
  check and sent the whole object. The sharded prover does not use that object;
  treat CPU fallback as a whole-object download until ranged behavior is fixed
  and re-verified.

Range requests do not by themselves prove that a complete object is edge-cached.
Use a complete chunk or CCS request when checking for `HIT`; never use a GET
Range probe against the current monolithic fallback.

Cloudflare references: [R2 custom domains], [R2 caching], [R2 CORS],
[R2 pricing], [Compression Rules], and [Tiered Cache].

[R2 custom domains]: https://developers.cloudflare.com/r2/buckets/public-buckets/
[R2 caching]: https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/
[R2 CORS]: https://developers.cloudflare.com/r2/buckets/cors/
[R2 pricing]: https://developers.cloudflare.com/r2/pricing/
[Compression Rules]: https://developers.cloudflare.com/rules/compression-rules/settings/
[Tiered Cache]: https://developers.cloudflare.com/cache/how-to/tiered-cache/

### Operations and verification

Treat every release prefix as write-once. Publish changed bytes under a new
release prefix, regenerate and sign `chunk-manifest.json`, and update the reclaim
deployment descriptor as one coherence set. Overwriting an existing key can
leave stale bytes at the edge for the one-year TTL; purge the hostname if an
emergency overwrite, delete, or CORS/header change is unavoidable.

Manage bucket CORS and custom-domain attachment with Wrangler. Zone Cache Rules,
Transform Rules, Compression Rules, and tiered-cache settings are managed in the
Cloudflare dashboard or Rulesets/settings APIs. A maintenance API token should be
restricted to the `reclaim-proof.com` zone and only these permissions:

- Cache Rules: Edit
- Transform Rules: Edit
- Response Compression: Edit
- Zone Settings: Edit

Never commit that token or leave it in a repo `.env` file.

Use these checks after a release or Cloudflare configuration change:

```sh
BASE='https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3'

# Cross-origin byte range: expect 206, Content-Range, ACAO *, immutable cache,
# CORP cross-origin, and absent/identity Content-Encoding.
curl -si -r 0-63 \
  -H 'Origin: https://example.vercel.app' \
  -H 'Accept-Encoding: gzip, br, zstd' \
  "$BASE/ownership.pk.part0000" | head -40

# Range preflight: expect 204, ACAO *, GET/HEAD, Range, max-age 86400.
curl -si -X OPTIONS \
  -H 'Origin: https://example.vercel.app' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: Range' \
  "$BASE/ownership-destination.ccs" | head -40

# Cache check. Run twice; a complete chunk should settle on HIT.
curl -sS -o /dev/null -D - "$BASE/ownership.pk.part0000" \
  | tr -d '\r' | grep -iE '^(HTTP/|cf-cache-status:|age:|content-encoding:)'

# The oversized fallback must remain directly accessible. HEAD avoids accidentally
# downloading 2.08 GB; HEAD may report DYNAMIC even though the full GET bypasses.
curl -sSI "$BASE/ownership.pk" \
  | tr -d '\r' | grep -iE '^(HTTP/|cf-cache-status:|content-length:)'
```

## Producing the assets

1. Build the runtime (reproducible; two clean builds → identical hashes).
   Requires Binaryen's `wasm-opt` on PATH (`apt install binaryen`,
   `brew install binaryen`, or `npm i -g binaryen`): the build runs a
   deterministic `wasm-opt -O3 -all` post-pass (~9% smaller modules) and
   records the wasm-opt version in `runtime-manifest.json`. Override with
   `WASM_OPT=<path>`, `WASM_OPT_FLAGS=...`, or skip with `WASM_OPT=none`
   (changes the output hashes):

       scripts/build-wasm-prover.sh            # → dist/proof-runtime/{proof-destination.wasm,msmworker.wasm,wasm_exec.js,runtime-manifest.json}

2. Generate the signed chunk manifest, pinning the CCS, the built WASM, the MSM
   worker JS, and the MSM worker WASM. The `--worker-js-path` MUST be the
   production `apps/ownership-proof-web/public/proof-runtime/msm-worker.js` — its
   bytes are pinned under the chunk-manifest asset key `worker.js` even though
   the served filename is `msm-worker.js`.

   Pass `--compress-ccs` to also emit and pin `ownership-destination.ccs.zst`
   (~30% of the identity size); clients that understand the pin fetch the
   compressed object, verify both pinned digest layers, and fall back to the
   identity CCS if the `.zst` object is unavailable. Upload the `.zst` next to
   the identity CCS under the same release prefix.

       go run ./cmd/proof-tool generate-chunk-manifest \
         --keys-dir <signed key bundle dir> \
         --deployment-manifest deployments/reclaim/preprod/live.local.json \
         --out-dir output/proof-assets-stage-<release> \
         --signing-key output/signing-keys/<key-id>.ed25519.private.hex \
         --manifest-public-key <trusted key-manifest ed25519 public hex> \
         --ccs-path <ownership-destination.ccs> \
         --proof-wasm-path dist/proof-runtime/proof-destination.wasm \
         --worker-js-path apps/ownership-proof-web/public/proof-runtime/msm-worker.js \
         --msm-worker-wasm-path dist/proof-runtime/msmworker.wasm \
         --base-url https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3/ \
         --release <release-id> --profile preprod-single-destination

3. Stage into the webapp (same-origin split):

       scripts/stage-proof-assets.sh output/proof-assets-stage-<release>

## Hosting split

Same-origin, under `apps/ownership-proof-web/public/` (COOP/COEP set site-wide;
CORP `same-origin` + immutable caching on both dirs via `next.config.mjs`):

    proof-runtime/  proof-destination.wasm, msmworker.wasm, wasm_exec.js,
                    msm-worker.js (committed source), prover-worker.js (committed source)
    proof-assets/   manifest.json(+.sig, +-public-key.hex), ownership.vk,
                    ownership.pk.idx.json, chunk-manifest.json(+.sig, +-public-key.hex),
                    reclaim-deployment.json

Everything the browser executes or trusts as an integrity root is same-origin
and hash-pinned. The `.wasm` files are gitignored build products; regenerate
with the two scripts above at deploy time.

Ranged asset host (NOT same-origin): the ~2.08 GB `ownership.pk` (as chunks) and
~187 MB `ownership-destination.ccs`, served by the live R2 deployment documented
above. Required behavior:

- `Accept-Ranges: bytes` with correct 206/416 semantics on the chunks and CCS.
- **CORS** — the prover fetches these cross-origin from a worker and *reads the
  body*, so the response must send `Access-Control-Allow-Origin` for the app
  (the current public bucket intentionally sends `*`), plus
  `Access-Control-Allow-Headers: range` and a handled `OPTIONS` preflight for
  range-fetched chunks/CCS. Under COEP a body-reading cross-origin `fetch()` is a
  CORS request; `Cross-Origin-Resource-Policy: cross-origin` alone is **not**
  sufficient (CORP only covers no-cors embeds like `<img>`/`<script>`). Setting
  CORP additionally is harmless. NOTE: `experiments/wasm-prover/web/server.mjs`
  sets `CORP: same-origin` because the experiment served assets same-origin — do
  not copy that for a real cross-origin host.
- `Content-Encoding: identity` — the MSM worker rejects any transformed encoding.
- Long-lived immutable cache headers (content-addressed by the chunk manifest).

## Descriptor gate (master kill switch)

`ReclaimDeployment.proof.browser_proving` enables the feature. With no descriptor
(or `enabled: false`) the claim UI shows today's guarded shell, bit-for-bit. The
descriptor's runtime URLs must be same-origin paths (validated); `pk_url`/`ccs_url`
may be absolute ranged-host URLs. A disabled example lives in
`deployments/reclaim/preprod/disabled.sample.json`.

The client refuses browser proving unless the preflight-reported `vk_hash`
equals `deployment.verifierVkHash`.

## Gotcha: chunk-manifest `base_url` needs a trailing slash

`--base-url` passed to `generate-chunk-manifest` becomes the chunk manifest's
`transport.base_url`, and the sharded MSM engine resolves each chunk with
`base.ResolveReference(relPath)` (`internal/msmengine/sharded_js.go`
`resolveChunkURL`). URL resolution against a base with no trailing slash drops
the last path segment: `ResolveReference("ownership.pk.part0100")` against
`https://host/proof-assets` yields `https://host/ownership.pk.part0100`, a 404.
When that fetch 404s the engine logs `demoting from "sharded" to cpu` and
silently falls back to the (working but ~4x slower) CPU path via `pk_url`.

For this release, always pass
`--base-url https://proof-assets.reclaim-proof.com/proof-assets/preprod-d2c944d-r3/`
**with the trailing slash**. Symptom of getting it wrong: proofs still succeed and
verify, but the result engine is `streampk-cpu-groth16` at ~500 s instead of
`streampk-sharded-groth16` at ~120 s.

## Verification record

Gate G1 signed runtime promotion, 2026-07-11:

- Final stage:
  `output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/chunk-assets-16m-runtime-g1-r8`, release
  `proof-assets-ownership-destination-v1-preprod-d2c944d-r3-runtime-g1-r8`.
  Its 124-part/16-MiB manifest reuses the immutable preprod PK/CCS objects and
  pins the reviewed r8 proof WASM, Worker JS/WASM, v1 VK, key manifest, and
  active adaptive descriptor under the existing r3 signing key.
- Public same-origin runtime and proof-assets hashes match the detached signed
  manifest. Active tuning has no explicit worker count, base shard count 8,
  rf2, pinned decode, W1/W2/W3/W5/W6/W7 enabled, GOGC50, and 3000MiB. New
  clients use `shards=max(8,resolved workers)` with an 8..16 worker cap; older
  clients retain their worker8 default.
- The production-host w16/s16 proof fetched the existing CDN chunks, qualified
  every Worker 0..15, and verified locally and through the compiled contract at
  115,770 ms / 1.4627 GiB. Heavy simultaneous Go and Midgard builds make that
  timing confirmation-only; the local signed-r8 G1 gate remains 70,400 ms /
  1.4593 GiB. Both tamper matrices and the final five-case r8 fault suite pass.
- The public proof WASM is deliberately the exact pre-C3 r8 snapshot. Do not
  rebuild only that file from the later circuit-working tree: T-CIRCUIT changes
  require the G3 ceremony plus a full PK/CCS/VK/manifest/runtime coherence
  refresh, not a partial runtime replacement.

Optimized V2 runtime measurements, 2026-07-14 (supersede the r8 G1 numbers as
best measured results):

- The v2-opt-r1 matrix (output/remote-browser-matrix-v2-opt-r1, deployment
  key id `preprod-local-destination-v2-9fac96b-g3a`, 2 MiB chunk tier,
  gogc=15/gomemlimit=3200MiB) measured best verified proofs of 41.46 s warm
  (`v2-2m-fresh-warm-w16-idle-pf4`) and 47.68 s cold
  (`v2-2m-hit-cold-w16-idle-pf2`) at w16/s16 with ~0.83 GiB peak heap —
  versus the signed-r8 G1 gate's 70,400 ms / 1.4593 GiB (~41% faster, ~43%
  lower peak heap). The 8-worker floor lands at 63-81 s. See
  docs/browser-proving-remote-chunk-matrix.md for full coverage status.
- The r8 G1 gate record above is retained as the acceptance evidence for the
  r8 runtime it measured; it is no longer the reference baseline. New
  optimization comparisons should be made against the r1 results.
- Active tuning as shipped now sets gogc=15/gomemlimit=3200MiB (measured 9-27%
  faster than GOGC50/3000MiB across cold/warm and 8/16-worker cases; see
  output/gogc50-comparison).

W7 verified-chunk reuse qualification, 2026-07-10:

- A fresh signed local candidate manifest used the existing immutable
  `proof-assets/preprod-d2c944d-r3/` 16-MiB PK chunks as its absolute ranged
  transport while the reviewed candidate WASM and Worker stayed local. No R2
  object was uploaded, replaced, or made a new trust root.
- On the cumulative W1/W2/W3/W6 w8/s32/rf2 profile, W7 reduced fetched and
  hashed bytes from 5,819,026,151 to 3,002,232,397 (48.41%). Its per-Worker
  verified LRU served 2,816,793,754 bytes from 168 hits; aggregate hash time
  fell about 48.6%.
- The guarded runs were contaminated by unrelated host work, but the candidate
  still improved prove time from 168,491 to 145,288 ms (13.77%) with peak main
  heap within 0.14%. Both arms passed local and compiled-contract verification,
  exact 336-byte Cardano export, coherence identity, and tamper rejection.
- Evidence prefix: `experiments/wasm-prover/output/w7-r6-hosted-2026-07-10-`
  (baseline/candidate JSON, summary, and telemetry files).

Hosted R2 path, 2026-07-09:

- The 16 MiB chunk and 187 MB CCS returned correct `206` ranges, wildcard CORS,
  immutable cache headers, `Cross-Origin-Resource-Policy: cross-origin`, and
  `Content-Encoding: identity` even when the client offered gzip, Brotli, and
  Zstandard.
- An `OPTIONS` request for cross-origin GET + Range returned `204`,
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, HEAD`,
  `Access-Control-Allow-Headers: Range`, and an 86,400-second preflight TTL.
- Complete chunk and CCS requests returned edge-cache `HIT`. The oversized
  monolithic PK remained directly accessible with `BYPASS`.

Local staging, 2026-07-08:

- `preflightProofAssets` via the production `prover-worker.js`, against the
  staged same-origin assets + locally ranged PK/CCS, returned `ok: true`,
  `vk_hash blake2b256:6057da91…d430a` (matches the deployment), 2,885,268
  constraints, 124 chunks, `deployment_id preprod:2fa284c0…:71c22462`,
  `signature_key_id preprod-local-destination-d2c944dd753c-r3`.
- A ranged fetch of `ownership.pk` bytes 1000000–1000063 is byte-identical
  (sha256 `d7fa486a…`) to the local key bundle.
- The `worker.js` chunk-manifest pin matches the staged `msm-worker.js`
  byte-for-byte (sha256 `d0443d00…`, 10,555 B).
