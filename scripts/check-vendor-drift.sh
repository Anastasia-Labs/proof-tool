#!/usr/bin/env bash
# Verifies that vendor/ is exactly `go mod vendor` output plus
# the reviewed patches under experiments/wasm-prover/patches. The vendored
# dependencies contain ProveStream/MSM plus opt-W2 domain-decoding, opt-W3
# CCS-release, opt-W1 scheduling/yield, opt-W6 computeH table-lifetime,
# opt-C8 constant byte-operation folding, and native MPC ceremony parallelism;
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
  experiments/wasm-prover/patches/uints-constant-fold.patch
  experiments/wasm-prover/patches/computeh-parallel-transforms.patch
  experiments/wasm-prover/patches/mpc-phase1-parallel-update.patch
  experiments/wasm-prover/patches/mpc-phase1-parallel-codec.patch
  experiments/wasm-prover/patches/mpc-phase2-parallel-initialize.patch
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
  # Same CRLF normalization as scripts/bootstrap-vendor.sh: Windows checkouts
  # can materialize the patch files with CRLF while vendor targets are LF.
  (cd "$SCRATCH" && tr -d '\r' < "$OLDPWD/$patch" | git apply -p0)
done

if ! diff -r "$SCRATCH/vendor" vendor; then
  echo "FAIL: vendor/ does not equal 'go mod vendor' + reviewed patches." >&2
  echo "Either mirror your vendor edits into the patch or fix the patch." >&2
  exit 1
fi

echo "OK: vendor/ == go mod vendor + reviewed patches"
