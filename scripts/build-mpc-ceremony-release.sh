#!/usr/bin/env -S -u SHELLOPTS -u BASHOPTS BASH_ENV=/dev/null ENV=/dev/null /bin/bash
# Builds the participant-facing MPC ceremony binary from an exact clean Git
# state and records the inputs needed for independent byte-for-byte rebuilds.
#
# Production usage requires a verified signed tag:
#   scripts/build-mpc-ceremony-release.sh \
#     --mode production \
#     --signed-tag vX.Y.Z \
#     --tag-signer-fingerprint "$APPROVED_GPG_FINGERPRINT" \
#     --build-signing-key /offline/build-signing-key \
#     --out-dir /fresh/output
#
# Rehearsals deliberately record that no signed-tag gate was applied:
#   scripts/build-mpc-ceremony-release.sh \
#     --mode rehearsal --out-dir /fresh/output
set -euo pipefail

# Release builds use a closed, non-hooked command/config environment. The Go
# build invocations below additionally set every build-affecting Go variable.
unset CDPATH GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_COUNT
export BASH_ENV=/dev/null
export ENV=/dev/null
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

usage() {
  echo "usage: $0 --mode production|rehearsal --out-dir DIR [--signed-tag TAG --tag-signer-fingerprint HEX] [--build-signing-key KEY]" >&2
  exit 2
}

MODE=
OUT_DIR=
SIGNED_TAG=
TAG_SIGNER_FINGERPRINT=
BUILD_SIGNING_KEY=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || usage
      MODE=$2
      shift 2
      ;;
    --out-dir)
      [[ $# -ge 2 ]] || usage
      OUT_DIR=$2
      shift 2
      ;;
    --signed-tag)
      [[ $# -ge 2 ]] || usage
      SIGNED_TAG=$2
      shift 2
      ;;
    --tag-signer-fingerprint)
      [[ $# -ge 2 ]] || usage
      TAG_SIGNER_FINGERPRINT=$2
      shift 2
      ;;
    --build-signing-key)
      [[ $# -ge 2 ]] || usage
      BUILD_SIGNING_KEY=$2
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

if [[ "$MODE" != "production" && "$MODE" != "rehearsal" ]]; then
  usage
fi
if [[ -z "$OUT_DIR" ]]; then
  usage
fi
if [[ "$MODE" == "production" &&
  ( -z "$SIGNED_TAG" || -z "$TAG_SIGNER_FINGERPRINT" || -z "$BUILD_SIGNING_KEY" ) ]]; then
  echo "FAIL: production builds require --signed-tag, --tag-signer-fingerprint, and --build-signing-key" >&2
  exit 1
fi
if [[ "$MODE" == "rehearsal" &&
  ( -n "$SIGNED_TAG" || -n "$TAG_SIGNER_FINGERPRINT" || -n "$BUILD_SIGNING_KEY" ) ]]; then
  echo "FAIL: rehearsal builds must not supply production tag or build-signing identity" >&2
  exit 1
fi
if [[ -n "$SIGNED_TAG" && -z "$TAG_SIGNER_FINGERPRINT" ]] ||
  [[ -z "$SIGNED_TAG" && -n "$TAG_SIGNER_FINGERPRINT" ]]; then
  echo "FAIL: --signed-tag and --tag-signer-fingerprint must be supplied together" >&2
  exit 1
fi
if [[ -n "$TAG_SIGNER_FINGERPRINT" ]]; then
  TAG_SIGNER_FINGERPRINT=${TAG_SIGNER_FINGERPRINT^^}
  if [[ ! "$TAG_SIGNER_FINGERPRINT" =~ ^([0-9A-F]{40}|[0-9A-F]{64})$ ]]; then
    echo "FAIL: tag signer fingerprint must be exactly 40 or 64 hexadecimal characters" >&2
    exit 1
  fi
fi

if [[ -n "$BUILD_SIGNING_KEY" ]]; then
  BUILD_SIGNING_KEY_DIR=$(realpath -e -- "$(dirname -- "$BUILD_SIGNING_KEY")")
  BUILD_SIGNING_KEY="$BUILD_SIGNING_KEY_DIR/$(basename -- "$BUILD_SIGNING_KEY")"
  if [[ ! -f "$BUILD_SIGNING_KEY" || -L "$BUILD_SIGNING_KEY" ]]; then
    echo "FAIL: build signing key must be a non-symlink regular file" >&2
    exit 1
  fi
fi
OUT_PARENT=$(realpath -e -- "$(dirname -- "$OUT_DIR")")
OUT_DIR="$OUT_PARENT/$(basename -- "$OUT_DIR")"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)
cd "$REPO_ROOT"

if ! git diff --quiet --ignore-submodules -- ||
  ! git diff --cached --quiet --ignore-submodules -- ||
  [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "FAIL: release builds require a clean Git checkout with no untracked source files" >&2
  exit 1
fi

SOURCE_COMMIT=$(git rev-parse --verify HEAD)
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: HEAD is not an exact 40-character Git commit" >&2
  exit 1
fi

TAG_STATUS=not-required-for-rehearsal
TAG_OBJECT=none
if [[ -n "$SIGNED_TAG" ]]; then
  if [[ "$SIGNED_TAG" == -* ]] || ! git check-ref-format "refs/tags/$SIGNED_TAG"; then
    echo "FAIL: invalid signed tag name: $SIGNED_TAG" >&2
    exit 1
  fi
  TAG_COMMIT=$(git rev-parse --verify "$SIGNED_TAG^{commit}")
  if [[ "$TAG_COMMIT" != "$SOURCE_COMMIT" ]]; then
    echo "FAIL: signed tag $SIGNED_TAG resolves to $TAG_COMMIT, not HEAD $SOURCE_COMMIT" >&2
    exit 1
  fi
  TAG_OBJECT=$(git rev-parse --verify "$SIGNED_TAG^{tag}")
  VERIFY_TAG_OUTPUT=
  if ! VERIFY_TAG_OUTPUT=$(git verify-tag --raw "$SIGNED_TAG" 2>&1); then
    printf '%s\n' "$VERIFY_TAG_OUTPUT" >&2
    echo "FAIL: signed tag verification failed: $SIGNED_TAG" >&2
    exit 1
  fi
  mapfile -t VALID_TAG_FINGERPRINTS < <(
    printf '%s\n' "$VERIFY_TAG_OUTPUT" |
      sed -n 's/^\[GNUPG:\] VALIDSIG \([0-9A-Fa-f]*\) .*/\U\1/p'
  )
  if [[ "${#VALID_TAG_FINGERPRINTS[@]}" -ne 1 ||
    "${VALID_TAG_FINGERPRINTS[0]}" != "$TAG_SIGNER_FINGERPRINT" ]]; then
    echo "FAIL: signed tag fingerprint does not match the approved fingerprint" >&2
    exit 1
  fi
  TAG_STATUS=verified
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
if [[ ! -x "$GO_BIN" || -L "$GO_BIN" ]]; then
  echo "FAIL: resolved Go executable must be a non-symlink executable file: $GO_BIN" >&2
  exit 1
fi
GO_VERSION=$(env -u GOROOT CGO_ENABLED=0 GOARCH=amd64 GOENV=off GOEXPERIMENT= GOFIPS140=off GOOS=linux GOAMD64=v1 GOTOOLCHAIN=local "$GO_BIN" env GOVERSION)
if [[ "$GO_VERSION" != "go1.26.5" ]]; then
  echo "FAIL: release build requires go1.26.5, found $GO_VERSION" >&2
  exit 1
fi
GO_HOST_OS=$(env -u GOROOT CGO_ENABLED=0 GOARCH=amd64 GOENV=off GOEXPERIMENT= GOFIPS140=off GOOS=linux GOAMD64=v1 GOTOOLCHAIN=local "$GO_BIN" env GOHOSTOS)
GO_HOST_ARCH=$(env -u GOROOT CGO_ENABLED=0 GOARCH=amd64 GOENV=off GOEXPERIMENT= GOFIPS140=off GOOS=linux GOAMD64=v1 GOTOOLCHAIN=local "$GO_BIN" env GOHOSTARCH)
if [[ "$GO_HOST_OS" != "linux" || "$GO_HOST_ARCH" != "amd64" ]]; then
  echo "FAIL: release build host toolchain must be linux/amd64, found $GO_HOST_OS/$GO_HOST_ARCH" >&2
  exit 1
fi
if [[ -n "$(env -u GOROOT CGO_ENABLED=0 GOARCH=amd64 GOENV=off GOEXPERIMENT= GOFIPS140=off GOOS=linux GOAMD64=v1 GOTOOLCHAIN=local "$GO_BIN" env GOEXPERIMENT)" ]]; then
  echo "FAIL: release build requires an empty GOEXPERIMENT" >&2
  exit 1
fi
EXPECTED_GO_SHA256=8da5fd321795754b994c64e3eb8a5a14ff47bd285559a7e876f3c79abafc67f9
EXPECTED_COMPILE_SHA256=10c67b9de41c1e546b9bf416ceef410e5e3dd87a76d129b08b74a9570db9c463
EXPECTED_LINK_SHA256=e58a36e6550a32ed7175cd6e2a1824dc66c034d1e3539ebeac8af719a9150d5d
EXPECTED_ASM_SHA256=0c9a07447aba3ed1df7a0a3e85f6e003d9bf312d2936dfc4b79e3d81e8ca7636
GO_TOOL_DIR=$(env -u GOROOT CGO_ENABLED=0 GOARCH=amd64 GOENV=off GOEXPERIMENT= GOFIPS140=off GOOS=linux GOAMD64=v1 GOTOOLCHAIN=local "$GO_BIN" env GOTOOLDIR)
verify_tool_hash() {
  local path=$1
  local expected=$2
  local actual
  actual=$(sha256sum "$path")
  actual=${actual%% *}
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: toolchain digest mismatch for $path: $actual, want $expected" >&2
    exit 1
  fi
}
verify_tool_hash "$GO_BIN" "$EXPECTED_GO_SHA256"
verify_tool_hash "$GO_TOOL_DIR/compile" "$EXPECTED_COMPILE_SHA256"
verify_tool_hash "$GO_TOOL_DIR/link" "$EXPECTED_LINK_SHA256"
verify_tool_hash "$GO_TOOL_DIR/asm" "$EXPECTED_ASM_SHA256"
if rg -n '^[[:space:]]*replace([[:space:]]|$)' go.mod >/dev/null; then
  echo "FAIL: release build forbids Go module replace directives" >&2
  exit 1
fi
if [[ ! -d vendor ]]; then
  echo "FAIL: vendor/ is absent; create it only with scripts/bootstrap-vendor.sh" >&2
  exit 1
fi
if [[ -n "$(find vendor -type l -print -quit)" ]]; then
  echo "FAIL: release build forbids symbolic links in vendor/" >&2
  exit 1
fi

if [[ -e "$OUT_DIR" || -L "$OUT_DIR" ]]; then
  echo "FAIL: output directory already exists: $OUT_DIR" >&2
  exit 1
fi
if [[ ! -d "$OUT_PARENT" || -L "$OUT_PARENT" ]]; then
  echo "FAIL: output parent must be an existing real directory: $OUT_PARENT" >&2
  exit 1
fi

umask 077
CANONICAL_ROOT="/tmp/proof-tool-mpc-release-build-$SOURCE_COMMIT"
CANONICAL_SOURCE="$CANONICAL_ROOT/source"
if [[ -e "$CANONICAL_ROOT" || -L "$CANONICAL_ROOT" ]]; then
  echo "FAIL: canonical clean-build path already exists: $CANONICAL_ROOT" >&2
  exit 1
fi
mkdir -m 0700 "$CANONICAL_ROOT"
STAGING=
cleanup() {
  if [[ -n "$STAGING" ]]; then
    rm -rf -- "$STAGING"
  fi
  rm -rf -- "$CANONICAL_ROOT"
}
trap cleanup EXIT

git clone --quiet --no-hardlinks --no-checkout "$REPO_ROOT" "$CANONICAL_SOURCE"
git -C "$CANONICAL_SOURCE" checkout --quiet --detach "$SOURCE_COMMIT"
cp -a "$REPO_ROOT/vendor" "$CANONICAL_SOURCE/vendor"

STAGING=$(mktemp -d "$OUT_PARENT/.mpc-ceremony-release.partial.XXXXXXXX")
cd "$CANONICAL_SOURCE"

env \
  -u GOROOT \
  CGO_ENABLED=0 \
  GOCACHE="$CANONICAL_ROOT/go-cache" \
  GOENV=off \
  GOEXPERIMENT= \
  GOFIPS140=off \
  GOTOOLCHAIN=local \
  GOWORK=off \
  GOOS=linux \
  GOARCH=amd64 \
  GOAMD64=v1 \
  GOFLAGS=-mod=vendor \
  PATH="$(dirname "$GO_BIN"):$PATH" \
  bash scripts/check-vendor-drift.sh

SOURCE_DATE_EPOCH=$(git show -s --format=%ct "$SOURCE_COMMIT")
BUILD_FLAGS="-mod=vendor -trimpath -buildvcs=true -ldflags=-buildid="

env \
  -u GOROOT \
  CGO_ENABLED=0 \
  GOCACHE="$CANONICAL_ROOT/go-cache" \
  GOENV=off \
  GOEXPERIMENT= \
  GOFIPS140=off \
  GOOS=linux \
  GOARCH=amd64 \
  GOAMD64=v1 \
  GOTOOLCHAIN=local \
  GOWORK=off \
  GOFLAGS= \
  SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  TZ=UTC \
  LC_ALL=C \
  "$GO_BIN" build \
    -mod=vendor \
    -trimpath \
    -buildvcs=true \
    -ldflags=-buildid= \
    -o "$STAGING/mpc-ceremony" \
    ./cmd/mpc-ceremony

env \
  -u GOROOT \
  CGO_ENABLED=0 \
  GOCACHE="$CANONICAL_ROOT/go-cache" \
  GOENV=off \
  GOEXPERIMENT= \
  GOFIPS140=off \
  GOOS=linux \
  GOARCH=amd64 \
  GOAMD64=v1 \
  GOTOOLCHAIN=local \
  GOWORK=off \
  GOFLAGS= \
  SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  TZ=UTC \
  LC_ALL=C \
  "$GO_BIN" build \
    -mod=vendor \
    -trimpath \
    -buildvcs=true \
    -ldflags=-buildid= \
    -o "$STAGING/mpc-finalization-evidence" \
    ./scripts/mpc-finalization-evidence

env \
  -u GOROOT \
  CGO_ENABLED=0 \
  GOCACHE="$CANONICAL_ROOT/go-cache" \
  GOENV=off \
  GOEXPERIMENT= \
  GOFIPS140=off \
  GOTOOLCHAIN=local \
  GOWORK=off \
  GOOS=linux \
  GOARCH=amd64 \
  GOAMD64=v1 \
  GOFLAGS=-mod=vendor \
  "$GO_BIN" run ./scripts/hash-blake2b \
    -go-version "$GO_VERSION" \
    -build-flags "$BUILD_FLAGS" \
    "$STAGING/mpc-ceremony" >"$STAGING/binary-manifest.json"

env \
  -u GOROOT \
  CGO_ENABLED=0 \
  GOCACHE="$CANONICAL_ROOT/go-cache" \
  GOENV=off \
  GOEXPERIMENT= \
  GOFIPS140=off \
  GOTOOLCHAIN=local \
  GOWORK=off \
  GOOS=linux \
  GOARCH=amd64 \
  GOAMD64=v1 \
  GOFLAGS=-mod=vendor \
  "$GO_BIN" run ./scripts/hash-blake2b \
    -go-version "$GO_VERSION" \
    -build-flags "$BUILD_FLAGS" \
    "$STAGING/mpc-finalization-evidence" >"$STAGING/finalization-evidence-binary-manifest.json"

env \
  -u GOROOT \
  CGO_ENABLED=0 \
  GOCACHE="$CANONICAL_ROOT/go-cache" \
  GOENV=off \
  GOEXPERIMENT= \
  GOFIPS140=off \
  GOTOOLCHAIN=local \
  GOWORK=off \
  GOOS=linux \
  GOARCH=amd64 \
  GOAMD64=v1 \
  GOFLAGS=-mod=vendor \
  "$GO_BIN" run ./scripts/generate-go-sbom \
    --binary "$STAGING/mpc-ceremony" \
    --name mpc-ceremony \
    --source-root "$CANONICAL_SOURCE" >"$STAGING/sbom.cdx.json"

env \
  -u GOROOT \
  CGO_ENABLED=0 \
  GOCACHE="$CANONICAL_ROOT/go-cache" \
  GOENV=off \
  GOEXPERIMENT= \
  GOFIPS140=off \
  GOTOOLCHAIN=local \
  GOWORK=off \
  GOOS=linux \
  GOARCH=amd64 \
  GOAMD64=v1 \
  GOFLAGS=-mod=vendor \
  "$GO_BIN" run ./scripts/generate-go-sbom \
    --binary "$STAGING/mpc-finalization-evidence" \
    --name mpc-finalization-evidence \
    --source-root "$CANONICAL_SOURCE" >"$STAGING/finalization-evidence-sbom.cdx.json"

(
  cd "$CANONICAL_SOURCE"
  git ls-files -z |
    LC_ALL=C sort -z |
    xargs -0 sha256sum >"$STAGING/source-checksums.sha256"
  find vendor -type f -print0 |
    LC_ALL=C sort -z |
    xargs -0 sha256sum >"$STAGING/vendor-checksums.sha256"
)

(
  cd "$STAGING"
  sha256sum mpc-ceremony mpc-finalization-evidence >checksums.sha256
  b2sum -l 256 mpc-ceremony mpc-finalization-evidence >checksums.blake2b256
  env -u GOROOT \
    CGO_ENABLED=0 \
    GOARCH=amd64 \
    GOENV=off \
    GOEXPERIMENT= \
    GOFIPS140=off \
    GOOS=linux \
    GOTOOLCHAIN=local \
    GOAMD64=v1 \
    "$GO_BIN" version -m ./mpc-ceremony >go-build-info.txt
  env -u GOROOT \
    CGO_ENABLED=0 \
    GOARCH=amd64 \
    GOENV=off \
    GOEXPERIMENT= \
    GOFIPS140=off \
    GOOS=linux \
    GOTOOLCHAIN=local \
    GOAMD64=v1 \
    "$GO_BIN" version -m ./mpc-finalization-evidence >finalization-evidence-go-build-info.txt
)
printf '%s\n' "$SOURCE_COMMIT" >"$STAGING/source-commit.txt"
printf '%s\n' "$SOURCE_DATE_EPOCH" >"$STAGING/source-date-epoch.txt"
printf '%s\n' "$MODE" >"$STAGING/build-mode.txt"
printf '%s\n' "${SIGNED_TAG:-none}" >"$STAGING/signed-tag.txt"
printf '%s\n' "$TAG_STATUS" >"$STAGING/signed-tag-status.txt"
printf '%s\n' "$TAG_OBJECT" >"$STAGING/signed-tag-object.txt"
printf '%s\n' "${TAG_SIGNER_FINGERPRINT:-none}" >"$STAGING/signed-tag-signer-fingerprint.txt"
cat >"$STAGING/toolchain-checksums.sha256" <<EOF
$EXPECTED_GO_SHA256  go
$EXPECTED_COMPILE_SHA256  compile
$EXPECTED_LINK_SHA256  link
$EXPECTED_ASM_SHA256  asm
EOF

ROOT_INPUTS=(
  "$STAGING/binary-manifest.json"
  "$STAGING/build-mode.txt"
  "$STAGING/checksums.blake2b256"
  "$STAGING/checksums.sha256"
  "$STAGING/go-build-info.txt"
  "$STAGING/finalization-evidence-binary-manifest.json"
  "$STAGING/finalization-evidence-go-build-info.txt"
  "$STAGING/finalization-evidence-sbom.cdx.json"
  "$STAGING/mpc-finalization-evidence"
  "$STAGING/mpc-ceremony"
  "$STAGING/sbom.cdx.json"
  "$STAGING/signed-tag-object.txt"
  "$STAGING/signed-tag-signer-fingerprint.txt"
  "$STAGING/signed-tag-status.txt"
  "$STAGING/signed-tag.txt"
  "$STAGING/source-checksums.sha256"
  "$STAGING/source-commit.txt"
  "$STAGING/source-date-epoch.txt"
  "$STAGING/toolchain-checksums.sha256"
  "$STAGING/vendor-checksums.sha256"
)
env \
  -u GOROOT \
  CGO_ENABLED=0 \
  GOCACHE="$CANONICAL_ROOT/go-cache" \
  GOENV=off \
  GOEXPERIMENT= \
  GOFIPS140=off \
  GOTOOLCHAIN=local \
  GOWORK=off \
  GOOS=linux \
  GOARCH=amd64 \
  GOAMD64=v1 \
  GOFLAGS=-mod=vendor \
  "$GO_BIN" run ./scripts/hash-blake2b \
    -go-version "$GO_VERSION" \
    -build-flags "$BUILD_FLAGS" \
    "${ROOT_INPUTS[@]}" >"$STAGING/build-package-manifest.json"
(
  cd "$STAGING"
  sha256sum build-package-manifest.json >build-package-manifest.sha256
)
if [[ -n "$BUILD_SIGNING_KEY" ]]; then
  env \
    -u GOROOT \
    CGO_ENABLED=0 \
    GOCACHE="$CANONICAL_ROOT/go-cache" \
    GOENV=off \
    GOEXPERIMENT= \
    GOFIPS140=off \
    GOTOOLCHAIN=local \
    GOWORK=off \
    GOOS=linux \
    GOARCH=amd64 \
    GOAMD64=v1 \
    GOFLAGS=-mod=vendor \
    "$GO_BIN" run ./scripts/sign-ed25519-file \
      --input "$STAGING/build-package-manifest.json" \
      --private-key "$BUILD_SIGNING_KEY" \
      --signature-out "$STAGING/build-package-manifest.sig" \
      --public-key-out "$STAGING/build-package-manifest-public-key.hex"
fi

chmod 0555 "$STAGING/mpc-ceremony" "$STAGING/mpc-finalization-evidence"
chmod 0444 \
  "$STAGING"/*.txt \
  "$STAGING"/*.json \
  "$STAGING"/build-package-manifest.sha256 \
  "$STAGING"/checksums.* \
  "$STAGING"/*-checksums.sha256
if [[ -n "$BUILD_SIGNING_KEY" ]]; then
  chmod 0444 \
    "$STAGING"/build-package-manifest.sig \
    "$STAGING"/build-package-manifest-public-key.hex
fi
touch -d "@$SOURCE_DATE_EPOCH" "$STAGING"/*
env \
  -u GOROOT \
  CGO_ENABLED=0 \
  GOCACHE="$CANONICAL_ROOT/go-cache" \
  GOENV=off \
  GOEXPERIMENT= \
  GOFIPS140=off \
  GOTOOLCHAIN=local \
  GOWORK=off \
  GOOS=linux \
  GOARCH=amd64 \
  GOAMD64=v1 \
  GOFLAGS=-mod=vendor \
  "$GO_BIN" run ./scripts/rename-directory-noreplace "$STAGING" "$OUT_DIR"
STAGING=
rm -rf -- "$CANONICAL_ROOT"
CANONICAL_ROOT=
trap - EXIT

echo "OK: built $OUT_DIR/mpc-ceremony from $SOURCE_COMMIT ($MODE)"
