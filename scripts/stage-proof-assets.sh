#!/usr/bin/env bash
# Stages a write-once browser-proving release from a
# generate-chunk-manifest output directory into the webapp:
#
#   same-origin  (apps/ownership-proof-web/public/proof-releases/<release>/)
#     runtime/   proof-destination.wasm, msmworker.wasm, wasm_exec.js,
#                runtime-manifest.json, msm-worker.js, prover-worker.js
#     assets/    manifest.json(+.sig), ownership.vk, ownership.pk.idx.json,
#                chunk-manifest.json(+.sig), reclaim-deployment.json,
#                *-public-key.hex
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

DIST_RUNTIME="dist/proof-runtime"
LEGACY_RUNTIME="$WEBAPP/public/proof-runtime"
STABLE_ASSETS="$WEBAPP/public/proof-assets"

if [[ ! -f "$SRC/chunk-manifest.json" ]]; then
  echo "FAIL: $SRC does not look like a generate-chunk-manifest output dir" >&2
  exit 1
fi
if [[ ! -f "$DIST_RUNTIME/wasm_exec.js" || ! -f "$DIST_RUNTIME/runtime-manifest.json" ]]; then
  echo "FAIL: run scripts/build-wasm-prover.sh first ($DIST_RUNTIME missing)" >&2
  exit 1
fi

release="$(jq -er '.release | select(type == "string" and length > 0)' "$SRC/chunk-manifest.json")"
if [[ ! "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$ ]]; then
  echo "FAIL: unsafe chunk-manifest release id: $release" >&2
  exit 1
fi

RELEASE_DST="$WEBAPP/public/proof-releases/$release"
RUNTIME_DST="$RELEASE_DST/runtime"
ASSETS_DST="$RELEASE_DST/assets"

runtime_files=(
  proof-destination.wasm
  msmworker.wasm
  wasm_exec.js
)
runtime_source_files=(msm-worker.js prover-worker.js)
asset_files=(
  manifest.json manifest.sig manifest-public-key.hex ownership.vk
  ownership.pk.idx.json chunk-manifest.json chunk-manifest.sig
  chunk-manifest-public-key.hex reclaim-deployment.json
)

# Extend the reproducible Go runtime manifest with the committed JavaScript
# bootstraps. This release manifest therefore pins every executable byte, while
# preserving the toolchain/build metadata emitted by build-wasm-prover.sh.
RELEASE_RUNTIME_MANIFEST="$(mktemp)"
runtime_source_entries="$({
  for f in "${runtime_source_files[@]}"; do
    jq -n \
      --arg filename "$f" \
      --argjson size_bytes "$(wc -c < "$LEGACY_RUNTIME/$f")" \
      --arg sha256 "$(sha256sum "$LEGACY_RUNTIME/$f" | cut -d' ' -f1)" \
      --arg blake2b256 "$(b2sum -l 256 "$LEGACY_RUNTIME/$f" | cut -d' ' -f1)" \
      '{filename:$filename,size_bytes:$size_bytes,sha256:$sha256,blake2b256:$blake2b256}'
  done
} | jq -s .)"
jq --argjson source_files "$runtime_source_entries" \
  '.files += $source_files' \
  "$DIST_RUNTIME/runtime-manifest.json" > "$RELEASE_RUNTIME_MANIFEST"
trap 'rm -f "$RELEASE_RUNTIME_MANIFEST"' EXIT

if [[ -e "$RELEASE_DST" ]]; then
  # A release ID is write-once. A repeat invocation is accepted only when every
  # source byte is already present unchanged; it never overwrites the release.
  for f in "${runtime_files[@]}"; do
    cmp -s "$DIST_RUNTIME/$f" "$RUNTIME_DST/$f" || {
      echo "FAIL: write-once release $release already has different runtime/$f" >&2
      exit 1
    }
  done
  for f in "${runtime_source_files[@]}"; do
    cmp -s "$LEGACY_RUNTIME/$f" "$RUNTIME_DST/$f" || {
      echo "FAIL: write-once release $release already has different runtime/$f" >&2
      exit 1
    }
  done
  cmp -s "$RELEASE_RUNTIME_MANIFEST" "$RUNTIME_DST/runtime-manifest.json" || {
    echo "FAIL: write-once release $release already has different runtime/runtime-manifest.json" >&2
    exit 1
  }
  for f in "${asset_files[@]}"; do
    cmp -s "$SRC/$f" "$ASSETS_DST/$f" || {
      echo "FAIL: write-once release $release already has different assets/$f" >&2
      exit 1
    }
  done
  node "$WEBAPP/scripts/verify-proof-release.mjs" \
    --web-root "$WEBAPP/public" \
    --deployment "$ASSETS_DST/reclaim-deployment.json"
  install -m 0644 "$ASSETS_DST/reclaim-deployment.json" "$STABLE_ASSETS/reclaim-deployment.json"
  node "$WEBAPP/scripts/verify-proof-release.mjs" \
    --web-root "$WEBAPP/public" \
    --deployment "$STABLE_ASSETS/reclaim-deployment.json"
  echo "release already staged unchanged -> $RELEASE_DST"
  echo "updated stable pointer          -> $STABLE_ASSETS/reclaim-deployment.json"
  exit 0
fi

STAGING_DST="$WEBAPP/public/proof-releases/.${release}.staging.$$"
trap 'rm -rf "$STAGING_DST"; rm -f "$RELEASE_RUNTIME_MANIFEST"' EXIT
mkdir -p "$STAGING_DST/runtime" "$STAGING_DST/assets"

# Runtime files come from the reproducible build (dist/), not the staging dir,
# so the same-origin bytes match runtime-manifest.json exactly. The two worker
# bootstraps are committed source and become immutable members of the release.
for f in "${runtime_files[@]}"; do
  install -m 0644 "$DIST_RUNTIME/$f" "$STAGING_DST/runtime/$f"
done
for f in "${runtime_source_files[@]}"; do
  install -m 0644 "$LEGACY_RUNTIME/$f" "$STAGING_DST/runtime/$f"
done
install -m 0644 "$RELEASE_RUNTIME_MANIFEST" "$STAGING_DST/runtime/runtime-manifest.json"

# Small integrity-root assets (world-readable; the staging dir is 0600).
for f in "${asset_files[@]}"; do
  install -m 0644 "$SRC/$f" "$STAGING_DST/assets/$f"
done

mkdir -p "$(dirname "$RELEASE_DST")"
mv "$STAGING_DST" "$RELEASE_DST"
trap - EXIT
rm -f "$RELEASE_RUNTIME_MANIFEST"

node "$WEBAPP/scripts/verify-proof-release.mjs" \
  --web-root "$WEBAPP/public" \
  --deployment "$ASSETS_DST/reclaim-deployment.json"

# Promote the mutable pointer only after the release itself verifies. The
# Next.js cache policy forces this stable path to revalidate.
install -m 0644 "$ASSETS_DST/reclaim-deployment.json" "$STABLE_ASSETS/reclaim-deployment.json"
node "$WEBAPP/scripts/verify-proof-release.mjs" \
  --web-root "$WEBAPP/public" \
  --deployment "$STABLE_ASSETS/reclaim-deployment.json"

echo "staged write-once release -> $RELEASE_DST"
echo "updated stable pointer    -> $STABLE_ASSETS/reclaim-deployment.json"
echo "NOT staged (ranged host / Milestone 7): ownership.pk, ownership-destination.ccs"
