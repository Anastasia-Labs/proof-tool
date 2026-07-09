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
# Builds use -trimpath and -ldflags "-buildid=" so two clean builds of the same
# tree with the same toolchain produce byte-identical wasm (identical hashes).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${1:-${repo_root}/dist/proof-runtime}"
mkdir -p "${out_dir}"
out_dir="$(cd "${out_dir}" && pwd)"

cd "${repo_root}"

go_version="$(go version)"
build_flags="-trimpath -mod=vendor -ldflags -buildid="
echo "toolchain: ${go_version}"
echo "build flags: ${build_flags}"
echo "output dir: ${out_dir}"

GOOS=js GOARCH=wasm go build ${build_flags} \
  -o "${out_dir}/proof-destination.wasm" ./cmd/wasm-prover
echo "built proof-destination.wasm"

GOOS=js GOARCH=wasm go build ${build_flags} \
  -o "${out_dir}/msmworker.wasm" ./cmd/msmworker
echo "built msmworker.wasm"

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
  "${out_dir}/proof-destination.wasm" \
  "${out_dir}/msmworker.wasm" \
  "${out_dir}/wasm_exec.js" \
  > "${out_dir}/runtime-manifest.json"
echo "wrote ${out_dir}/runtime-manifest.json"
