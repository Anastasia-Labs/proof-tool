#!/usr/bin/env bash
# build-wasm-prover.sh — deterministic GOOS=js GOARCH=wasm build of the browser
# prover runtime.
#
# Outputs (into $1, default dist/proof-runtime/):
#   proof-destination.wasm   — main prover entrypoint (./cmd/wasm-prover)
#   msmworker.wasm           — per-worker MSM kernel  (./cmd/msmworker)
#   wasm_exec.js             — Go runtime JS shim, copied from the toolchain
#   runtime-manifest.json    — go version, build flags, and per-file
#                              size / sha256 / blake2b256 digests
#
# Builds use -trimpath, disable repository-dependent VCS stamping, and clear the
# build ID so two clean builds of the same tree with the same toolchain produce
# byte-identical wasm (identical hashes), including from linked worktrees.
#
# After each module is built, wasm-opt (Binaryen) runs a deterministic -O3
# post-pass: single-digit-percent size and speed gains on Go wasm output, no
# source changes. wasm-opt is deterministic for a fixed version+flags+input, so
# the reproducible-build contract still holds; its version is recorded in the
# manifest alongside the toolchain. Override the binary with WASM_OPT= (path)
# and the flags with WASM_OPT_FLAGS=; set WASM_OPT=none to skip the pass.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${1:-${repo_root}/dist/proof-runtime}"
mkdir -p "${out_dir}"
out_dir="$(cd "${out_dir}" && pwd)"

cd "${repo_root}"

go_version="$(go version)"
build_flags="-trimpath -buildvcs=false -mod=vendor -ldflags -buildid="
echo "toolchain: ${go_version}"
echo "build flags: ${build_flags}"
echo "output dir: ${out_dir}"

wasm_opt="${WASM_OPT:-wasm-opt}"
# -all enables every wasm feature so wasm-opt accepts Go's output (bulk memory,
# sign-extension, etc.) instead of rejecting it on a feature-mismatch.
wasm_opt_flags="${WASM_OPT_FLAGS:--O3 -all}"
wasm_opt_manifest=""
if [[ "${wasm_opt}" == "none" ]]; then
  echo "wasm-opt: skipped (WASM_OPT=none)"
elif ! command -v "${wasm_opt}" >/dev/null 2>&1; then
  echo "wasm-opt not found (looked for '${wasm_opt}')." >&2
  echo "Install Binaryen (apt install binaryen | brew install binaryen | npm i -g binaryen)," >&2
  echo "point WASM_OPT= at the binary, or set WASM_OPT=none to skip the post-pass." >&2
  exit 1
else
  wasm_opt_version="$("${wasm_opt}" --version)"
  # Reproducibility now depends on the Binaryen version as well as the Go
  # toolchain. Release/verification builds should pin it:
  #   WASM_OPT_EXPECT_VERSION="wasm-opt version 118" scripts/build-wasm-prover.sh
  if [[ -n "${WASM_OPT_EXPECT_VERSION:-}" && "${wasm_opt_version}" != "${WASM_OPT_EXPECT_VERSION}"* ]]; then
    echo "wasm-opt version mismatch: have '${wasm_opt_version}', expected prefix '${WASM_OPT_EXPECT_VERSION}'" >&2
    exit 1
  fi
  wasm_opt_manifest="${wasm_opt_version} ${wasm_opt_flags}"
  echo "wasm-opt: ${wasm_opt_manifest}"
fi

# optimize_wasm runs the deterministic wasm-opt post-pass in place (via a temp
# file so a partial run can never leave a truncated module behind).
optimize_wasm() {
  local target="$1"
  [[ "${wasm_opt}" == "none" ]] && return 0
  local before after
  before="$(wc -c <"${target}")"
  "${wasm_opt}" ${wasm_opt_flags} "${target}" -o "${target}.opt"
  mv "${target}.opt" "${target}"
  after="$(wc -c <"${target}")"
  echo "optimized $(basename "${target}"): ${before} -> ${after} bytes"
}

GOOS=js GOARCH=wasm go build ${build_flags} \
  -o "${out_dir}/proof-destination.wasm" ./cmd/wasm-prover
echo "built proof-destination.wasm"
optimize_wasm "${out_dir}/proof-destination.wasm"

GOOS=js GOARCH=wasm go build ${build_flags} \
  -o "${out_dir}/msmworker.wasm" ./cmd/msmworker
echo "built msmworker.wasm"
optimize_wasm "${out_dir}/msmworker.wasm"

wasm_exec="$(go env GOROOT)/lib/wasm/wasm_exec.js"
if [[ ! -f "${wasm_exec}" ]]; then
  echo "wasm_exec.js not found at ${wasm_exec}" >&2
  exit 1
fi
cp "${wasm_exec}" "${out_dir}/wasm_exec.js"
echo "copied wasm_exec.js"

go run ./scripts/hash-blake2b \
  -go-version "${go_version}" \
  -build-flags "${build_flags}" \
  -wasm-opt "${wasm_opt_manifest}" \
  "${out_dir}/proof-destination.wasm" \
  "${out_dir}/msmworker.wasm" \
  "${out_dir}/wasm_exec.js" \
  > "${out_dir}/runtime-manifest.json"
echo "wrote ${out_dir}/runtime-manifest.json"
