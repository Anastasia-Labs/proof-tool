#!/usr/bin/env bash
# Regenerates vendor/ from go.mod and applies the streaming-prover patch
# (gnark groth16/bls12-381 ProveStream + msmengine seam). vendor/ is
# gitignored; this script is the ONLY supported way to (re)create it.
# A plain `go mod vendor` produces a tree WITHOUT the streaming prover and
# the build will fail — run this instead.
#
# Refuses to clobber a drifted tree: if vendor/ exists and does not match
# `go mod vendor` + patch, it aborts so unmirrored optimization work is not
# lost. Use scripts/check-vendor-drift.sh to inspect.
set -euo pipefail

cd "$(dirname "$0")/.."
PATCH=experiments/wasm-prover/patches/prove-stream.patch

if [[ ! -s "$PATCH" ]]; then
  echo "FAIL: $PATCH is missing or empty" >&2
  exit 1
fi

if [[ -d vendor ]]; then
  if bash scripts/check-vendor-drift.sh >/dev/null 2>&1; then
    echo "vendor/ already matches go mod vendor + patch; nothing to do"
    exit 0
  fi
  echo "FAIL: existing vendor/ has drifted from go mod vendor + $PATCH." >&2
  echo "It may contain unmirrored hand edits. Refusing to overwrite." >&2
  echo "Run scripts/check-vendor-drift.sh to see the drift." >&2
  exit 1
fi

go mod vendor
git apply -p0 "$PATCH"
echo "OK: vendor/ created and prove-stream.patch applied"
