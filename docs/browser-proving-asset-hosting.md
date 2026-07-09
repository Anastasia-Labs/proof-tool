# Browser-proving asset hosting (Milestone 2)

How the browser WASM prover's assets are produced, split between same-origin and
a ranged host, and gated by the deployment descriptor. See
`docs/browser-wasm-prover-webapp-integration-plan.md` for the full plan.

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
         --base-url https://<ranged-asset-host>/proof-assets \
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

Ranged asset host (NOT same-origin — Milestone 7 hosting): the ~2.08 GB
`ownership.pk` and ~187 MB `ownership-destination.ccs`. Required behavior,
mirroring `experiments/wasm-prover/web/server.mjs`:

- `Accept-Ranges: bytes` with correct 206/416 semantics on `ownership.pk`.
- `Cross-Origin-Resource-Policy: cross-origin` (or CORS with the explicit app origin).
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

Always pass `--base-url https://<ranged-host>/proof-assets/` **with a trailing
slash** (or a bare host root). Symptom of getting it wrong: proofs still succeed
and verify, but the result engine is `streampk-cpu-groth16` at ~500 s instead of
`streampk-sharded-groth16` at ~120 s.

## Verified (2026-07-08, local staging)

- `preflightProofAssets` via the production `prover-worker.js`, against the
  staged same-origin assets + locally ranged PK/CCS, returned `ok: true`,
  `vk_hash blake2b256:6057da91…d430a` (matches the deployment), 2,885,268
  constraints, 124 chunks, `deployment_id preprod:2fa284c0…:71c22462`,
  `signature_key_id preprod-local-destination-d2c944dd753c-r3`.
- A ranged fetch of `ownership.pk` bytes 1000000–1000063 is byte-identical
  (sha256 `d7fa486a…`) to the local key bundle.
- The `worker.js` chunk-manifest pin matches the staged `msm-worker.js`
  byte-for-byte (sha256 `d0443d00…`, 10,555 B).
