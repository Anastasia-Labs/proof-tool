#!/usr/bin/env -S -u SHELLOPTS -u BASHOPTS BASH_ENV=/dev/null ENV=/dev/null /bin/bash
# Semantically verifies and then compares release-build directories produced
# independently by build-mpc-ceremony-release.sh.
set -euo pipefail

unset CDPATH GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_COUNT
export BASH_ENV=/dev/null
export ENV=/dev/null
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

usage() {
  echo "usage: $0 --mode production|rehearsal --expected-commit COMMIT --expected-tag TAG|none --tag-signer-fingerprint HEX|none --trusted-build-public-key-file FILE|none BUILD_DIR_A BUILD_DIR_B" >&2
  exit 2
}

MODE=
EXPECTED_COMMIT=
EXPECTED_TAG=
TAG_SIGNER_FINGERPRINT=
TRUSTED_BUILD_PUBLIC_KEY_FILE=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || usage
      MODE=$2
      shift 2
      ;;
    --expected-commit)
      [[ $# -ge 2 ]] || usage
      EXPECTED_COMMIT=$2
      shift 2
      ;;
    --expected-tag)
      [[ $# -ge 2 ]] || usage
      EXPECTED_TAG=$2
      shift 2
      ;;
    --tag-signer-fingerprint)
      [[ $# -ge 2 ]] || usage
      TAG_SIGNER_FINGERPRINT=${2^^}
      shift 2
      ;;
    --trusted-build-public-key-file)
      [[ $# -ge 2 ]] || usage
      TRUSTED_BUILD_PUBLIC_KEY_FILE=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      usage
      ;;
    *)
      break
      ;;
  esac
done
if [[ $# -ne 2 || ( "$MODE" != "production" && "$MODE" != "rehearsal" ) ||
  ! "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ||
  -z "$EXPECTED_TAG" || -z "$TAG_SIGNER_FINGERPRINT" ||
  -z "$TRUSTED_BUILD_PUBLIC_KEY_FILE" ]]; then
  usage
fi
if [[ "$MODE" == "production" ]]; then
  if [[ "$EXPECTED_TAG" == "none" ||
    ! "$TAG_SIGNER_FINGERPRINT" =~ ^([0-9A-F]{40}|[0-9A-F]{64})$ ||
    "$TRUSTED_BUILD_PUBLIC_KEY_FILE" == "none" ]]; then
    usage
  fi
  TRUSTED_BUILD_PUBLIC_KEY_DIR=$(realpath -e -- "$(dirname -- "$TRUSTED_BUILD_PUBLIC_KEY_FILE")")
  TRUSTED_BUILD_PUBLIC_KEY_FILE="$TRUSTED_BUILD_PUBLIC_KEY_DIR/$(basename -- "$TRUSTED_BUILD_PUBLIC_KEY_FILE")"
  if [[ ! -f "$TRUSTED_BUILD_PUBLIC_KEY_FILE" || -L "$TRUSTED_BUILD_PUBLIC_KEY_FILE" ]]; then
    echo "FAIL: trusted build public key must be a non-symlink regular file" >&2
    exit 1
  fi
elif [[ "$EXPECTED_TAG" != "none" || "$TAG_SIGNER_FINGERPRINT" != "NONE" ||
  "$TRUSTED_BUILD_PUBLIC_KEY_FILE" != "none" ]]; then
  usage
else
  TAG_SIGNER_FINGERPRINT=none
fi

BUILD_A=$1
BUILD_B=$2
EXPECTED_FILES=(
  binary-manifest.json
  build-mode.txt
  build-package-manifest.json
  build-package-manifest.sha256
  checksums.blake2b256
  checksums.sha256
  finalization-evidence-binary-manifest.json
  finalization-evidence-go-build-info.txt
  finalization-evidence-sbom.cdx.json
  go-build-info.txt
  mpc-finalization-evidence
  mpc-ceremony
  sbom.cdx.json
  signed-tag-object.txt
  signed-tag-signer-fingerprint.txt
  signed-tag-status.txt
  signed-tag.txt
  source-checksums.sha256
  source-commit.txt
  source-date-epoch.txt
  toolchain-checksums.sha256
  vendor-checksums.sha256
)
if [[ "$MODE" == "production" ]]; then
  EXPECTED_FILES+=(
    build-package-manifest-public-key.hex
    build-package-manifest.sig
  )
fi
mapfile -t EXPECTED_FILES < <(printf '%s\n' "${EXPECTED_FILES[@]}" | LC_ALL=C sort)

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)
if [[ "$MODE" == "production" ]]; then
  if [[ "$EXPECTED_TAG" == -* ]] ||
    ! git -C "$REPO_ROOT" check-ref-format "refs/tags/$EXPECTED_TAG"; then
    echo "FAIL: invalid expected production tag: $EXPECTED_TAG" >&2
    exit 1
  fi
  VERIFIED_TAG_COMMIT=$(git -C "$REPO_ROOT" rev-parse --verify "$EXPECTED_TAG^{commit}")
  if [[ "$VERIFIED_TAG_COMMIT" != "$EXPECTED_COMMIT" ]]; then
    echo "FAIL: expected production tag does not resolve to the expected commit" >&2
    exit 1
  fi
  VERIFIED_TAG_OBJECT=$(git -C "$REPO_ROOT" rev-parse --verify "$EXPECTED_TAG^{tag}")
  VERIFY_TAG_OUTPUT=
  if ! VERIFY_TAG_OUTPUT=$(git -C "$REPO_ROOT" verify-tag --raw "$EXPECTED_TAG" 2>&1); then
    printf '%s\n' "$VERIFY_TAG_OUTPUT" >&2
    echo "FAIL: independent production tag verification failed" >&2
    exit 1
  fi
  mapfile -t VERIFIED_TAG_FINGERPRINTS < <(
    printf '%s\n' "$VERIFY_TAG_OUTPUT" |
      sed -n 's/^\[GNUPG:\] VALIDSIG \([0-9A-Fa-f]*\) .*/\U\1/p'
  )
  if [[ "${#VERIFIED_TAG_FINGERPRINTS[@]}" -ne 1 ||
    "${VERIFIED_TAG_FINGERPRINTS[0]}" != "$TAG_SIGNER_FINGERPRINT" ]]; then
    echo "FAIL: independent tag verification did not use the approved signer fingerprint" >&2
    exit 1
  fi
fi
ACTIVE_GOROOT=$(env -u GOROOT \
  CGO_ENABLED=0 \
  GOARCH=amd64 \
  GOENV=off \
  GOEXPERIMENT= \
  GOFIPS140=off \
  GOOS=linux \
  GOAMD64=v1 \
  GOTOOLCHAIN=auto \
  go env GOROOT)
GO_BIN="$ACTIVE_GOROOT/bin/go"
if [[ ! -x "$GO_BIN" || -L "$GO_BIN" ||
  "$(env -u GOROOT CGO_ENABLED=0 GOARCH=amd64 GOENV=off GOEXPERIMENT= GOFIPS140=off GOOS=linux GOAMD64=v1 GOTOOLCHAIN=local "$GO_BIN" env GOVERSION)" != "go1.26.5" ]]; then
  echo "FAIL: semantic verification requires the approved Go 1.26.5 toolchain" >&2
  exit 1
fi

for dir in "$BUILD_A" "$BUILD_B"; do
  if [[ ! -d "$dir" || -L "$dir" ]]; then
    echo "FAIL: build path must be a real directory: $dir" >&2
    exit 1
  fi
  if [[ -n "$(find "$dir" -type l -print -quit)" ]]; then
    echo "FAIL: build directory contains a symbolic link: $dir" >&2
    exit 1
  fi
  mapfile -t actual_entries < <(
    cd "$dir"
    find . -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort
  )
  if [[ "${actual_entries[*]}" != "${EXPECTED_FILES[*]}" ]]; then
    echo "FAIL: build directory has an unexpected entry set: $dir" >&2
    printf 'expected: %s\n' "${EXPECTED_FILES[*]}" >&2
    printf 'actual:   %s\n' "${actual_entries[*]}" >&2
    exit 1
  fi
  for name in "${EXPECTED_FILES[@]}"; do
    if [[ ! -f "$dir/$name" || -L "$dir/$name" ]]; then
      echo "FAIL: build entry must be a non-symlink regular file: $dir/$name" >&2
      exit 1
    fi
    expected_mode=444
    if [[ "$name" == "mpc-ceremony" || "$name" == "mpc-finalization-evidence" ]]; then
      expected_mode=555
    fi
    actual_mode=$(stat -c %a "$dir/$name")
    if [[ "$actual_mode" != "$expected_mode" ]]; then
      echo "FAIL: build entry mode is $actual_mode, want $expected_mode: $dir/$name" >&2
      exit 1
    fi
  done
  if [[ ! -x "$dir/mpc-ceremony" || ! -x "$dir/mpc-finalization-evidence" ]]; then
    echo "FAIL: both release binaries must be executable: $dir" >&2
    exit 1
  fi
  if [[ "$MODE" == "production" ]]; then
    RECORDED_TAG_OBJECT=$(<"$dir/signed-tag-object.txt")
    if [[ "$RECORDED_TAG_OBJECT" != "$VERIFIED_TAG_OBJECT" ]]; then
      echo "FAIL: recorded signed tag object does not equal independently verified tag object: $dir" >&2
      exit 1
    fi
  fi
  env \
    -u GOROOT \
    CGO_ENABLED=0 \
    GOCACHE="${TMPDIR:-/tmp}/proof-tool-mpc-verify-go-cache" \
    GOENV=off \
    GOEXPERIMENT= \
    GOFIPS140=off \
    GOTOOLCHAIN=local \
    GOWORK=off \
    GOOS=linux \
    GOARCH=amd64 \
    GOAMD64=v1 \
    GOFLAGS=-mod=vendor \
    "$GO_BIN" run "$REPO_ROOT/scripts/verify-mpc-build-metadata" \
      --dir "$dir" \
      --mode "$MODE" \
      --commit "$EXPECTED_COMMIT" \
      --tag "$EXPECTED_TAG" \
      --tag-signer-fingerprint "$TAG_SIGNER_FINGERPRINT" \
      --source-root "$REPO_ROOT" \
      --trusted-build-public-key-file "$TRUSTED_BUILD_PUBLIC_KEY_FILE"
  BUILD_INFO_TMP=$(mktemp "${TMPDIR:-/tmp}/mpc-build-info.XXXXXXXX")
  (
    cd "$dir"
    env -u GOROOT \
      CGO_ENABLED=0 \
      GOARCH=amd64 \
      GOENV=off \
      GOEXPERIMENT= \
      GOFIPS140=off \
      GOOS=linux \
      GOAMD64=v1 \
      GOTOOLCHAIN=local \
      "$GO_BIN" version -m ./mpc-ceremony >"$BUILD_INFO_TMP"
  )
  if ! cmp "$BUILD_INFO_TMP" "$dir/go-build-info.txt"; then
    rm -f -- "$BUILD_INFO_TMP"
    echo "FAIL: saved Go build information does not exactly describe the binary: $dir" >&2
    exit 1
  fi
  rm -f -- "$BUILD_INFO_TMP"
  EVIDENCE_BUILD_INFO_TMP=$(mktemp "${TMPDIR:-/tmp}/mpc-finalization-build-info.XXXXXXXX")
  (
    cd "$dir"
    env -u GOROOT \
      CGO_ENABLED=0 \
      GOARCH=amd64 \
      GOENV=off \
      GOEXPERIMENT= \
      GOFIPS140=off \
      GOOS=linux \
      GOAMD64=v1 \
      GOTOOLCHAIN=local \
      "$GO_BIN" version -m ./mpc-finalization-evidence >"$EVIDENCE_BUILD_INFO_TMP"
  )
  if ! cmp "$EVIDENCE_BUILD_INFO_TMP" "$dir/finalization-evidence-go-build-info.txt"; then
    rm -f -- "$EVIDENCE_BUILD_INFO_TMP"
    echo "FAIL: saved Go build information does not exactly describe the finalization evidence binary: $dir" >&2
    exit 1
  fi
  rm -f -- "$EVIDENCE_BUILD_INFO_TMP"
done

diff -r --no-dereference "$BUILD_A" "$BUILD_B"
cmp "$BUILD_A/mpc-ceremony" "$BUILD_B/mpc-ceremony"
cmp "$BUILD_A/mpc-finalization-evidence" "$BUILD_B/mpc-finalization-evidence"

if [[ "$MODE" == "production" ]]; then
  echo "OK: independent signed-tag production MPC ceremony release builds are semantically valid and byte-identical"
else
  echo "OK: independent MPC ceremony rehearsal builds are semantically valid and byte-identical (NOT PRODUCTION)"
fi
sha256sum "$BUILD_A/mpc-ceremony"
sha256sum "$BUILD_A/mpc-finalization-evidence"
