#!/usr/bin/env bash
# Verifies that vendor/ is exactly `go mod vendor` output plus the reviewed
# browser-runtime patches. The vendored gnark prover contains the streaming
# seam and W1/W2/W3/W6 scheduling/lifetime changes;
# regenerating vendor/ without this check in place silently deletes the prover.
#
# Fails (exit 1) on any drift in either direction: an unmirrored vendor edit,
# or a patch that no longer applies to the pinned module versions.
set -euo pipefail

cd "$(dirname "$0")/.."
PATCHES=(
  experiments/wasm-prover/patches/prove-stream.patch
  experiments/wasm-prover/patches/domain-read-no-precompute.patch
  experiments/wasm-prover/patches/release-ccs-after-solve.patch
  experiments/wasm-prover/patches/dispatch-before-fft.patch
  experiments/wasm-prover/patches/computeh-scoped-coset-tables.patch
)

for patch in "${PATCHES[@]}"; do
  if [[ ! -s "$patch" ]]; then
    echo "FAIL: $patch is missing or empty" >&2
    exit 1
  fi
done

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Re-vendor into a scratch dir; never touches ./vendor.
go mod vendor -o "$SCRATCH/vendor"

for patch in "${PATCHES[@]}"; do
  (cd "$SCRATCH" && git apply -p0 "$OLDPWD/$patch")
done

if ! diff -r "$SCRATCH/vendor" vendor; then
  echo "FAIL: vendor/ does not equal 'go mod vendor' + reviewed runtime patches." >&2
  echo "Either mirror your vendor edits into the patch or fix the patch." >&2
  exit 1
fi

echo "OK: vendor/ == go mod vendor + reviewed runtime patches"
