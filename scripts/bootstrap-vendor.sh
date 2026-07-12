#!/usr/bin/env bash
# Regenerates vendor/ from go.mod and applies the reviewed browser-prover patches
# (gnark ProveStream/MSM seam, opt-W2 domain decoding, opt-W3 CCS release, and
# opt-W1 dispatch-before-FFT scheduling/yields, opt-W6 scoped computeH
# coset-table reuse and opt-C8 constant byte-operation folding).
# vendor/ is
# gitignored; this script is the ONLY supported way to (re)create it.
# A plain `go mod vendor` produces a tree WITHOUT the streaming prover and
# the build will fail — run this instead.
#
# Refuses to clobber a drifted tree: if vendor/ exists and does not match
# `go mod vendor` + patches, it aborts so unmirrored optimization work is not
# lost. Use scripts/check-vendor-drift.sh to inspect.
set -euo pipefail

cd "$(dirname "$0")/.."
PATCHES=(
  experiments/wasm-prover/patches/prove-stream.patch
  experiments/wasm-prover/patches/domain-read-no-precompute.patch
  experiments/wasm-prover/patches/release-ccs-after-solve.patch
  experiments/wasm-prover/patches/dispatch-before-fft.patch
	experiments/wasm-prover/patches/computeh-scoped-coset-tables.patch
	experiments/wasm-prover/patches/uints-constant-fold.patch
)

for patch in "${PATCHES[@]}"; do
  if [[ ! -s "$patch" ]]; then
    echo "FAIL: $patch is missing or empty" >&2
    exit 1
  fi
done

if [[ -d vendor ]]; then
  if bash scripts/check-vendor-drift.sh >/dev/null 2>&1; then
    echo "vendor/ already matches go mod vendor + reviewed patches; nothing to do"
    exit 0
  fi
  echo "FAIL: existing vendor/ has drifted from go mod vendor + reviewed patches." >&2
  echo "It may contain unmirrored hand edits. Refusing to overwrite." >&2
  echo "Run scripts/check-vendor-drift.sh to see the drift." >&2
  exit 1
fi

go mod vendor
for patch in "${PATCHES[@]}"; do
  git apply -p0 "$patch"
done
echo "OK: vendor/ created and reviewed patches applied"
