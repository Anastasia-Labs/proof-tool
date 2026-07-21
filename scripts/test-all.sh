#!/usr/bin/env bash
# Aggregate quality gate for the whole repo.
#
#   scripts/test-all.sh          # everything available on this machine
#   scripts/test-all.sh --fast   # skip the slow circuit/full-proof suites
#
# A green full run means: Go engine (including real Groth16 ownership proofs),
# WASM prover builds, TS client, web app (unit + claim API + tx-build tests +
# published proof-asset coherence), desktop app, and — when cabal is
# installed — the Plutus validators against real proof fixtures. Sections that
# need tools not installed locally are reported as SKIPPED and do not fail the
# run; CI runs them all.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAST=0
if [[ "${1:-}" == "--fast" ]]; then
  FAST=1
fi

FAILURES=()
SKIPPED=()
PASSED=()

section() {
  printf '\n\033[1m== %s ==\033[0m\n' "$1"
}

run_step() {
  local name="$1"
  shift
  section "$name"
  if "$@"; then
    PASSED+=("$name")
  else
    FAILURES+=("$name")
  fi
}

skip_step() {
  local name="$1" reason="$2"
  section "$name"
  echo "SKIPPED: $reason"
  SKIPPED+=("$name ($reason)")
}

# --- Go engine ---------------------------------------------------------------
if [[ ! -d vendor ]]; then
  run_step "vendor bootstrap (patched gnark)" bash scripts/bootstrap-vendor.sh
fi

run_step "go build" go build ./...
run_step "go vet" go vet ./...

if command -v golangci-lint >/dev/null 2>&1; then
  run_step "golangci-lint" golangci-lint run ./...
else
  skip_step "golangci-lint" "golangci-lint not installed"
fi

if [[ "$FAST" == "1" ]]; then
  run_step "go test (fast: skips circuit compile suites)" \
    go test ./cmd/... ./internal/prover/... ./internal/verifier/... ./internal/helper/... \
    ./internal/msmengine/... ./internal/streampk/... ./internal/streamprove/... \
    ./internal/proofassets/... ./internal/batchtranscript/...
else
  # PROOF_TOOL_RUN_FULL_PROOF=1 un-gates the real Groth16 ownership /
  # multi / destination round-trip integration tests (positive + tamper
  # cases). This is the strongest local evidence that proof generation works.
  run_step "go test (full, incl. real ownership Groth16 round-trips)" \
    env PROOF_TOOL_RUN_FULL_PROOF=1 go test ./...
fi

run_step "wasm prover builds" env GOOS=js GOARCH=wasm go build -o /dev/null ./cmd/wasm-prover
run_step "wasm msm worker builds" env GOOS=js GOARCH=wasm go build -o /dev/null ./cmd/msmworker

# --- TypeScript / web --------------------------------------------------------
if command -v pnpm >/dev/null 2>&1; then
  run_step "biome lint+format" pnpm exec biome ci .

  run_step "client-ts build" pnpm --dir packages/client-ts build
  run_step "client-ts test" pnpm --dir packages/client-ts test

  run_step "web typecheck" pnpm --dir apps/ownership-proof-web typecheck
  run_step "web test (unit + claim API + tx build + e2e-harness)" pnpm --dir apps/ownership-proof-web test
  # Verifies the published proof assets in public/ stay a coherent, signed
  # set: manifests, signatures, vk/pk digests, wasm digests, deployment pins.
  run_step "web proof-release coherence" pnpm --dir apps/ownership-proof-web verify:proof-release

  run_step "desktop typecheck" pnpm --dir apps/proof-helper-desktop typecheck
  run_step "desktop test" pnpm --dir apps/proof-helper-desktop test
else
  skip_step "TypeScript suites" "pnpm not installed"
fi

# --- Desktop native (Rust) ---------------------------------------------------
if command -v cargo >/dev/null 2>&1; then
  run_step "tauri key-bundle-core tests" cargo test --quiet --manifest-path apps/proof-helper-desktop/src-tauri/key-bundle-core/Cargo.toml
  run_step "tauri sidecar-core tests" cargo test --quiet --manifest-path apps/proof-helper-desktop/src-tauri/sidecar-core/Cargo.toml
  # The app crate links webkit2gtk and its build script bundles the Go
  # sidecar binary; only run it where the system prereqs exist, and stage a
  # sidecar build first (matches release-proof-helper.yml).
  if bash apps/proof-helper-desktop/scripts/check-tauri-linux-prereqs.sh >/dev/null 2>&1; then
    build_sidecar_and_test_app_crate() {
      local sidecar="apps/proof-helper-desktop/src-tauri/binaries/proof-tool-x86_64-unknown-linux-gnu"
      mkdir -p "$(dirname "$sidecar")" &&
        go build -trimpath -ldflags="-s -w" -o "$sidecar" ./cmd/proof-tool &&
        cargo test --quiet --manifest-path apps/proof-helper-desktop/src-tauri/Cargo.toml
    }
    run_step "tauri app crate tests" build_sidecar_and_test_app_crate
  else
    skip_step "tauri app crate tests" "Tauri Linux system prerequisites missing"
  fi
else
  skip_step "Rust (tauri) suites" "cargo not installed"
fi

# --- Plutus contracts ---------------------------------------------------------
if command -v cabal >/dev/null 2>&1; then
  if [[ "$FAST" == "1" ]]; then
    skip_step "contracts (Plutus validators, real proof fixtures)" "--fast"
  else
    run_step "contracts (Plutus validators, real proof fixtures)" \
      cabal test ownership-verifier-test --project-dir contracts/ownership-verifier
  fi
else
  skip_step "contracts (Plutus validators)" "cabal not installed"
fi

# --- Summary ------------------------------------------------------------------
# ${ARR[@]+"${ARR[@]}"} keeps empty-array expansion safe under `set -u` on
# bash 3.2 (macOS system bash).
section "summary"
for name in ${PASSED[@]+"${PASSED[@]}"}; do
  echo "PASS  $name"
done
for name in ${SKIPPED[@]+"${SKIPPED[@]}"}; do
  echo "SKIP  $name"
done
for name in ${FAILURES[@]+"${FAILURES[@]}"}; do
  echo "FAIL  $name"
done

if ((${#FAILURES[@]} > 0)); then
  echo
  echo "${#FAILURES[@]} section(s) failed."
  exit 1
fi
echo
echo "All run sections passed (${#PASSED[@]} passed, ${#SKIPPED[@]} skipped)."
