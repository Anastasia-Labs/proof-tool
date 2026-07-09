#!/usr/bin/env bash
# Stages browser-proving assets from a generate-chunk-manifest output directory
# into the webapp, following the Milestone 2 hosting split:
#
#   same-origin  (apps/ownership-proof-web/public/)
#     proof-runtime/   proof-destination.wasm, msmworker.wasm, wasm_exec.js
#                      (msm-worker.js and prover-worker.js are committed source)
#     proof-assets/    manifest.json(+.sig), ownership.vk, ownership.pk.idx.json,
#                      chunk-manifest.json(+.sig), reclaim-deployment.json,
#                      *-public-key.hex
#
#   ranged host  (NOT copied here — Milestone 7 hosting)
#     ownership.pk (~2.08 GB), ownership-destination.ccs (~187 MB)
#
# Everything the browser executes or trusts as an integrity root is same-origin
# and hash-pinned; only bulk, hash-verified data streams from the ranged host.
#
# Usage: scripts/stage-proof-assets.sh <chunk-manifest-out-dir> [webapp-dir]
set -euo pipefail

SRC="${1:?usage: stage-proof-assets.sh <chunk-manifest-out-dir> [webapp-dir]}"
WEBAPP="${2:-apps/ownership-proof-web}"
cd "$(dirname "$0")/.."

RUNTIME_DST="$WEBAPP/public/proof-runtime"
ASSETS_DST="$WEBAPP/public/proof-assets"
DIST_RUNTIME="dist/proof-runtime"

if [[ ! -f "$SRC/chunk-manifest.json" ]]; then
  echo "FAIL: $SRC does not look like a generate-chunk-manifest output dir" >&2
  exit 1
fi
if [[ ! -f "$DIST_RUNTIME/wasm_exec.js" ]]; then
  echo "FAIL: run scripts/build-wasm-prover.sh first ($DIST_RUNTIME missing)" >&2
  exit 1
fi

mkdir -p "$RUNTIME_DST" "$ASSETS_DST"

# Runtime files come from the reproducible build (dist/), not the staging dir,
# so the same-origin bytes match runtime-manifest.json exactly.
install -m 0644 "$DIST_RUNTIME/proof-destination.wasm" "$RUNTIME_DST/proof-destination.wasm"
install -m 0644 "$DIST_RUNTIME/msmworker.wasm" "$RUNTIME_DST/msmworker.wasm"
install -m 0644 "$DIST_RUNTIME/wasm_exec.js" "$RUNTIME_DST/wasm_exec.js"

# Small integrity-root assets (world-readable; the staging dir is 0600).
for f in manifest.json manifest.sig manifest-public-key.hex ownership.vk \
         ownership.pk.idx.json chunk-manifest.json chunk-manifest.sig \
         chunk-manifest-public-key.hex reclaim-deployment.json; do
  install -m 0644 "$SRC/$f" "$ASSETS_DST/$f"
done

echo "staged runtime  -> $RUNTIME_DST"
echo "staged assets   -> $ASSETS_DST"
echo "NOT staged (ranged host / Milestone 7): ownership.pk, ownership-destination.ccs"
