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
| Cache Rule | `proof_assets_cache_eligible_v1` | `set_cache_settings` with `cache: true` |
| Response Header Transform Rule | `proof_assets_response_headers_v1` | Set `Cache-Control: public, max-age=31536000, immutable` and `Cross-Origin-Resource-Policy: cross-origin` |
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

1. Build the runtime (reproducible; two clean builds → identical hashes):

       scripts/build-wasm-prover.sh            # → dist/proof-runtime/{proof-destination.wasm,msmworker.wasm,wasm_exec.js,runtime-manifest.json}

2. Generate the signed chunk manifest, pinning the CCS, the built WASM, the MSM
   worker JS, and the MSM worker WASM. The `--worker-js-path` MUST be the
   production `apps/ownership-proof-web/public/proof-runtime/msm-worker.js` — its
   bytes are pinned under the chunk-manifest asset key `worker.js` even though
   the served filename is `msm-worker.js`.

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
