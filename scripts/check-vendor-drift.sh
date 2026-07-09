#!/usr/bin/env bash
# Verifies that vendor/ is exactly `go mod vendor` output plus
# experiments/wasm-prover/patches/prove-stream.patch. The vendored gnark
# groth16/bls12-381 prover is hand-patched (ProveStream + streaming MSM seam);
# regenerating vendor/ without this check in place silently deletes the prover.
#
# Fails (exit 1) on any drift in either direction: an unmirrored vendor edit,
# or a patch that no longer applies to the pinned module versions.
set -euo pipefail

cd "$(dirname "$0")/.."
PATCH=experiments/wasm-prover/patches/prove-stream.patch

if [[ ! -s "$PATCH" ]]; then
  echo "FAIL: $PATCH is missing or empty" >&2
  exit 1
fi

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Re-vendor into a scratch dir; never touches ./vendor.
go mod vendor -o "$SCRATCH/vendor"

(cd "$SCRATCH" && git apply -p0 "$OLDPWD/$PATCH")

if ! diff -r "$SCRATCH/vendor" vendor; then
  echo "FAIL: vendor/ does not equal 'go mod vendor' + $PATCH." >&2
  echo "Either mirror your vendor edits into the patch or fix the patch." >&2
  exit 1
fi

echo "OK: vendor/ == go mod vendor + prove-stream.patch"
