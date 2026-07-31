#!/usr/bin/env bash
# Builds or verifies a fail-closed, content-hashed public MPC evidence tree.
# Private control keys and files outside the explicit allowlist are never copied.
set -euo pipefail
umask 077
export LC_ALL=C

usage() {
  cat >&2 <<'EOF'
usage:
  package-mpc-public-evidence.sh create REHEARSAL_ROOT FRESH_PACKAGE_DIR
  package-mpc-public-evidence.sh verify PACKAGE_DIR
  package-mpc-public-evidence.sh self-test

The package is a directory. SHA256SUMS covers every other regular file in it;
the SHA-256 of SHA256SUMS is printed separately for external witnessing.
EOF
  exit 2
}

[[ $# -ge 1 ]] || usage
MODE=$1
shift

is_allowed_source_path() {
  local path=$1
  case "$path" in
    control/participant-count.txt | control/config/participants.json \
      | control/config/policy.json \
      | control/public-finalization-evidence.json)
      return 0
      ;;
    transcript/ceremony.json | transcript/ceremony.sig \
      | transcript/coordinator-public-key.hex \
      | transcript/ownership-destination.ccs)
      return 0
      ;;
    candidate/candidate.json | candidate/candidate.sig.json \
      | candidate/verification-report.json \
      | candidate/ownership.pk | candidate/ownership.vk \
      | candidate/ownership-destination.ccs \
      | candidate/public-finalization-evidence.json \
      | candidate/cardano-vk.bin | candidate/cardano-vk.hex \
      | candidate/cardano-vk-format.txt \
      | candidate/candidate-checksums.sha256 \
      | candidate/phase2-seal.json | candidate/phase2-seal.sig.json)
      return 0
      ;;
    preliminary-final-keys/ownership-destination.ccs \
      | preliminary-final-keys/ownership.pk \
      | preliminary-final-keys/ownership.vk \
      | preliminary-final-keys/cardano-vk.bin \
      | preliminary-final-keys/cardano-vk.hex \
      | preliminary-final-keys/cardano-vk-format.txt \
      | preliminary-final-keys/preliminary-final-keys.json \
      | preliminary-final-keys/preliminary-final-keys.sig.json \
      | preliminary-final-keys/preliminary-checksums.sha256)
      return 0
      ;;
    release/ownership-destination.ccs | release/ownership.pk \
      | release/ownership.vk | release/cardano-vk.bin \
      | release/cardano-vk.hex | release/cardano-vk-format.txt \
      | release/verification-report.json \
      | release/public-finalization-evidence.json \
      | release/phase2-seal.json \
      | release/phase2-seal.sig.json | release/candidate.json \
      | release/candidate.sig.json | release/candidate-checksums.sha256 \
      | release/setup-transcript.json | release/manifest.json \
      | release/manifest.sig | release/manifest-public-key.hex \
      | release/checksums.sha256)
      return 0
      ;;
    measurements/artifact-sizes.tsv \
      | measurements/command-resources.tsv)
      return 0
      ;;
    state/binary.sha256 | state/config-generator-mode.txt \
      | state/config-generator.sha256 | state/created-epoch.txt \
      | state/beacon-lead-seconds.txt \
      | state/finalization-evidence-generator-mode.txt \
      | state/finalization-evidence-generator.sha256 \
      | state/operational-evidence-generator-mode.txt \
      | state/operational-evidence-generator.sha256 \
      | state/phase1-relay-ids.txt | state/phase1-relays.sha256 \
      | state/phase2-relay-ids.txt | state/phase2-relays.sha256)
      return 0
      ;;
  esac

  if [[ "$path" =~ ^transcript/phase[12]/(genesis\.bin|chain-[0-9]{4}\.(json|sig)|closure/record\.(json|sig))$ ||
    "$path" =~ ^transcript/phase[12]/contributions/[0-9]{4}/(contribution\.bin|attestation\.(json|sig)|erasure\.(json|sig)|verification\.json)$ ||
    "$path" =~ ^transcript/phase[12]/beacon/(raw-response\.bin|record\.(json|sig))$ ||
    "$path" =~ ^transcript/phase1/sealed/(commons\.bin|seal\.(json|sig))$ ||
    "$path" =~ ^(transcript|release)/operational/evidence-bundle\.(json|sig)$ ||
    "$path" =~ ^(transcript|release)/operational/(disclosures/[a-z0-9._:-]+\.json|enrollments/[a-z0-9._:-]+\.(json|sig))$ ||
    "$path" =~ ^(transcript|release)/operational/phase[12]/heads/[0-9]{4}/(outbound-handoff|outbound-receipt|return-handoff|return-receipt)\.(json|sig)$ ||
    "$path" =~ ^(transcript|release)/operational/phase[12]/heads/[0-9]{4}/mirrors/[a-z0-9._:-]+\.(json|sig)$ ||
    "$path" =~ ^(transcript|release)/operational/phase[12]/witnesses/[a-z0-9._:-]+\.(json|sig)$ ||
    "$path" =~ ^(transcript|release)/operational/phase[12]/beacon/(evidence\.(json|sig)|raw/[a-z0-9._:-]+\.json)$ ||
    "$path" =~ ^release/phase[12]/(genesis\.bin|chain-[0-9]{4}\.(json|sig)|closure/record\.(json|sig))$ ||
    "$path" =~ ^release/phase[12]/contributions/[0-9]{4}/(contribution\.bin|attestation\.(json|sig)|erasure\.(json|sig)|verification\.json)$ ||
    "$path" =~ ^audits/auditor-[0-9]{2}\.(json|sig)$ ||
    "$path" =~ ^release/audits/[0-9]{4}\.(json|sig)$ ||
    "$path" =~ ^state/(prepare|phase1-contributions|phase1|phase1-beacon|phase2-contributions|phase2|finish)\.(complete|steps\.sha256)$ ||
    "$path" =~ ^state/phase[12]-(round|round-epoch|closed-epoch|published-at|published-epoch)\.txt$ ||
    "$path" =~ ^state/steps/[a-z0-9-]+\.(epoch|complete|artifacts\.sha256)$ ]]; then
    return 0
  fi
  return 1
}

reject_private_name() {
  local path=$1
  local lowered=${path,,}
  case "$lowered" in
    *private* | *secret* | *wallet* | *mnemonic* | *seed* | *xprv*)
      echo "FAIL: private-material name is forbidden in a public package: $path" >&2
      return 1
      ;;
  esac
}

verify_public_text() {
  local package=$1
  local file
  local relative
  while IFS= read -r -d '' file; do
    relative=${file#"$package/"}
    case "$relative" in
      *.json | *.sig | *.hex | *.txt | *.tsv | *.sha256)
        ;;
      *)
        continue
        ;;
    esac
    if grep -E -i -n \
      '(Command being timed:|--(participant|coordinator|release)-signing-key|[a-z0-9._-]+\.private\.hex)' \
      "$file" >/dev/null 2>&1; then
      echo "FAIL: public package contains a command line or private-key path: $relative" >&2
      return 1
    fi
    if grep -E -i -n \
      '(^|[[:space:]"'"'"'=:(])/[a-z0-9._~-]|(^|[[:space:]"'"'"'=:(])[A-Za-z]:\\|file://|(^|[[:space:]"'"'"'=:(])\\\\[a-z0-9._~-]' \
      "$file" >/dev/null 2>&1; then
      echo "FAIL: public package contains an absolute host path: $relative" >&2
      return 1
    fi
  done < <(find "$package" -type f ! -name SHA256SUMS -print0)
}

write_public_resource_summary() {
  local source=$1
  local output=$2
  mkdir -p "$(dirname "$output")"
  node - "$source" "$output" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const source = process.argv[2];
const output = process.argv[3];
const measurements = path.join(source, "measurements");
const steps = path.join(source, "state", "steps");
const suffix = ".time.txt";
const namePattern = /^([a-z0-9-]+)\.attempt-([0-9]{4})\.time\.txt$/;
const fields = [
  ["user_seconds", "User time (seconds)", /^[0-9]+(?:\.[0-9]+)?$/],
  ["system_seconds", "System time (seconds)", /^[0-9]+(?:\.[0-9]+)?$/],
  ["elapsed_wall", "Elapsed (wall clock) time (h:mm:ss or m:ss)", /^(?:[0-9]+:){1,2}[0-9]+(?:\.[0-9]+)?$/],
  ["max_rss_kib", "Maximum resident set size (kbytes)", /^[0-9]+$/],
  ["filesystem_inputs", "File system inputs", /^[0-9]+$/],
  ["filesystem_outputs", "File system outputs", /^[0-9]+$/],
  ["exit_status", "Exit status", /^[0-9]+$/],
];
const names = [];
if (fs.existsSync(steps)) {
  for (const markerName of fs.readdirSync(steps).filter((name) => name.endsWith(".complete")).sort()) {
    const label = markerName.slice(0, -".complete".length);
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error(`unexpected step marker: ${markerName}`);
    const marker = fs.readFileSync(path.join(steps, markerName), "utf8").trimEnd();
    const match = marker.match(/^([0-9a-f]{64})  measurements\/([a-z0-9-]+\.attempt-[0-9]{4})\.output\.json$/);
    if (!match || !match[2].startsWith(`${label}.attempt-`)) {
      throw new Error(`malformed completed-step marker: ${markerName}`);
    }
    const resultPath = path.join(measurements, `${match[2]}.output.json`);
    const actualResultHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(resultPath))
      .digest("hex");
    if (actualResultHash !== match[1]) {
      throw new Error(`completed-step result digest mismatch: ${markerName}`);
    }
    names.push(`${match[2]}${suffix}`);
  }
}
const rows = [];
for (const name of names) {
  const match = name.match(namePattern);
  if (!match) {
    throw new Error(`unexpected timing filename: ${name}`);
  }
  const values = new Map();
  for (const line of fs.readFileSync(path.join(measurements, name), "utf8").split(/\r?\n/)) {
    for (const [, label] of fields) {
      const prefix = `\t${label}: `;
      if (line.startsWith(prefix)) {
        if (values.has(label)) throw new Error(`duplicate ${label} in ${name}`);
        values.set(label, line.slice(prefix.length));
      }
    }
  }
  const row = [match[1], match[2]];
  for (const [, label, pattern] of fields) {
    const value = values.get(label);
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new Error(`missing or malformed ${label} in ${name}`);
    }
    row.push(value);
  }
  rows.push(row.join("\t"));
}
const header = ["label", "attempt", ...fields.map(([key]) => key)].join("\t");
fs.writeFileSync(output, `${header}\n${rows.length ? `${rows.join("\n")}\n` : ""}`, {
  encoding: "utf8",
  mode: 0o400,
  flag: "wx",
});
NODE
  chmod 0444 "$output"
}

verify_public_resource_summary() {
  local summary=$1
  node - "$summary" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const lines = fs.readFileSync(path, "utf8").split("\n");
if (lines.pop() !== "") throw new Error("resource summary lacks a final newline");
const expectedHeader =
  "label\tattempt\tuser_seconds\tsystem_seconds\telapsed_wall\tmax_rss_kib\tfilesystem_inputs\tfilesystem_outputs\texit_status";
if (lines.shift() !== expectedHeader) throw new Error("resource summary header is invalid");
const rowPattern =
  /^[a-z0-9-]+\t[0-9]{4}\t[0-9]+(?:\.[0-9]+)?\t[0-9]+(?:\.[0-9]+)?\t(?:[0-9]+:){1,2}[0-9]+(?:\.[0-9]+)?\t[0-9]+\t[0-9]+\t[0-9]+\t[0-9]+$/;
let previous = "";
for (const row of lines) {
  if (!rowPattern.test(row) || (previous && row <= previous)) {
    throw new Error("resource summary row is malformed, duplicated, or unsorted");
  }
  previous = row;
}
NODE
}

verify_package() {
  local package=$1
  if [[ ! -d "$package" || -L "$package" ]]; then
    echo "FAIL: package must be an existing real directory: $package" >&2
    return 1
  fi
  package=$(cd "$package" && pwd)
  local unsafe
  unsafe=$(find "$package" ! -type d ! -type f -print -quit)
  if [[ -n "$unsafe" ]]; then
    echo "FAIL: package contains a symlink or special file: $unsafe" >&2
    return 1
  fi
  if [[ ! -f "$package/SHA256SUMS" || -L "$package/SHA256SUMS" ]]; then
    echo "FAIL: package SHA256SUMS is absent or unsafe" >&2
    return 1
  fi
  if [[ ! -f "$package/PUBLIC-PACKAGE-FORMAT.txt" ||
    -L "$package/PUBLIC-PACKAGE-FORMAT.txt" ]]; then
    echo "FAIL: public package format marker is absent, unsafe, or unsupported" >&2
    return 1
  fi
  local format_value
  format_value=$(tr '\n' ' ' <"$package/PUBLIC-PACKAGE-FORMAT.txt")
  if [[ "$format_value" != "proof-tools MPC public evidence package format 2 SHA256SUMS covers every other regular file in this directory. " ]]; then
    echo "FAIL: public package format marker is absent, unsafe, or unsupported" >&2
    return 1
  fi
  if [[ ! -f "$package/measurements/command-resources.tsv" ||
    -L "$package/measurements/command-resources.tsv" ]]; then
    echo "FAIL: numeric command resource summary is absent or unsafe" >&2
    return 1
  fi
  if ! verify_public_resource_summary \
    "$package/measurements/command-resources.tsv"; then
    echo "FAIL: numeric command resource summary is malformed" >&2
    return 1
  fi

  local listed
  local digest
  local path
  local previous=
  local count=0
  while IFS=$'\t' read -r digest path; do
    if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ||
      -z "$path" || "$path" == /* || "$path" == *'..'* ||
      "$path" == *$'\t'* || "$path" == *$'\n'* ]]; then
      echo "FAIL: malformed or unsafe SHA256SUMS entry" >&2
      return 1
    fi
    if [[ "$path" != PUBLIC-PACKAGE-FORMAT.txt ]] &&
      ! is_allowed_source_path "$path"; then
      echo "FAIL: package path is outside the explicit public allowlist: $path" >&2
      return 1
    fi
    if [[ -n "$previous" && "$path" < "$previous" ]]; then
      echo "FAIL: SHA256SUMS is not bytewise path-sorted" >&2
      return 1
    fi
    if [[ "$path" == "$previous" ]]; then
      echo "FAIL: duplicate SHA256SUMS path: $path" >&2
      return 1
    fi
    reject_private_name "$path"
    if [[ ! -f "$package/$path" || -L "$package/$path" ]]; then
      echo "FAIL: listed package file is absent or unsafe: $path" >&2
      return 1
    fi
    listed=$(sha256sum "$package/$path" | cut -d ' ' -f 1)
    if [[ "$listed" != "$digest" ]]; then
      echo "FAIL: package digest mismatch: $path" >&2
      return 1
    fi
    previous=$path
    ((count += 1))
  done <"$package/SHA256SUMS"

  local actual_list
  actual_list=$(mktemp)
  local manifest_list
  manifest_list=$(mktemp)
  find "$package" -type f ! -name SHA256SUMS -printf '%P\n' |
    LC_ALL=C sort >"$actual_list"
  cut -f 2 "$package/SHA256SUMS" >"$manifest_list"
  if ! cmp -s "$actual_list" "$manifest_list"; then
    rm -f -- "$actual_list" "$manifest_list"
    echo "FAIL: SHA256SUMS does not cover the exact package file set" >&2
    return 1
  fi
  rm -f -- "$actual_list" "$manifest_list"
  if (( count == 0 )); then
    echo "FAIL: public evidence package is empty" >&2
    return 1
  fi
  if grep -I -R -E -i -n \
    --exclude=SHA256SUMS \
    '(BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY|master xprv|mnemonic phrase|seed phrase)' \
    "$package" >/dev/null; then
    echo "FAIL: public package contains a private-material marker" >&2
    return 1
  fi
  verify_public_text "$package"
  local package_file
  while IFS= read -r -d '' package_file; do
    local package_relative=${package_file#"$package/"}
    if [[ "$package_relative" != release/manifest.sig ]] &&
      grep -E -x '[0-9a-f]{128}' "$package_file" >/dev/null 2>&1; then
      echo "FAIL: public package contains an Ed25519 private-key-shaped value: $package_relative" >&2
      return 1
    fi
  done < <(find "$package" -type f ! -name SHA256SUMS -print0)
  echo "OK: public evidence package verified"
  echo "package=$package files=$count manifest_sha256=$(sha256sum "$package/SHA256SUMS" | cut -d ' ' -f 1)"
}

case "$MODE" in
  create)
    [[ $# -eq 2 ]] || usage
    SOURCE=$1
    DESTINATION=$2
    if [[ ! -d "$SOURCE" || -L "$SOURCE" ]]; then
      echo "FAIL: rehearsal root must be an existing real directory: $SOURCE" >&2
      exit 1
    fi
    if [[ -e "$DESTINATION" || -L "$DESTINATION" ]]; then
      echo "FAIL: destination must be fresh: $DESTINATION" >&2
      exit 1
    fi
    DESTINATION_PARENT=$(dirname "$DESTINATION")
    if [[ ! -d "$DESTINATION_PARENT" || -L "$DESTINATION_PARENT" ]]; then
      echo "FAIL: destination parent must be an existing real directory" >&2
      exit 1
    fi
    SOURCE=$(cd "$SOURCE" && pwd)
    DESTINATION_PARENT=$(cd "$DESTINATION_PARENT" && pwd)
    DESTINATION="$DESTINATION_PARENT/$(basename "$DESTINATION")"
    if [[ "$DESTINATION_PARENT" == "$SOURCE" || "$DESTINATION_PARENT" == "$SOURCE/"* ]]; then
      echo "FAIL: public package destination must be outside the rehearsal root" >&2
      exit 1
    fi
    unsafe_entry=$(find "$SOURCE" ! -type d ! -type f -print -quit)
    if [[ -n "$unsafe_entry" ]]; then
      echo "FAIL: source tree contains a symlink or special file: $unsafe_entry" >&2
      exit 1
    fi
    for required in \
      transcript/ceremony.json \
      transcript/ceremony.sig \
      transcript/coordinator-public-key.hex \
      transcript/ownership-destination.ccs; do
      if [[ ! -f "$SOURCE/$required" ]]; then
        echo "FAIL: required public ceremony artifact is absent: $required" >&2
        exit 1
      fi
    done

    PACKAGE_TMP=$(mktemp -d "$DESTINATION_PARENT/.mpc-public-evidence.XXXXXXXX")
    cleanup() {
      if [[ -n "${PACKAGE_TMP:-}" && -d "$PACKAGE_TMP" ]]; then
        rm -rf -- "$PACKAGE_TMP"
      fi
    }
    trap cleanup EXIT
    COPIED=0
    while IFS= read -r -d '' source_path; do
      relative=${source_path#"$SOURCE/"}
      if ! is_allowed_source_path "$relative"; then
        continue
      fi
      reject_private_name "$relative"
      if [[ ! -f "$source_path" || -L "$source_path" ]]; then
        echo "FAIL: selected source is not a safe regular file: $relative" >&2
        exit 1
      fi
      install -D -m 0444 "$source_path" "$PACKAGE_TMP/$relative"
      ((COPIED += 1))
    done < <(find "$SOURCE" -type f -print0 | LC_ALL=C sort -z)
    write_public_resource_summary \
      "$SOURCE" \
      "$PACKAGE_TMP/measurements/command-resources.tsv"
    ((COPIED += 1))
    if (( COPIED == 0 )); then
      echo "FAIL: allowlist selected no public evidence" >&2
      exit 1
    fi
    printf '%s\n' \
      'proof-tools MPC public evidence package format 2' \
      'SHA256SUMS covers every other regular file in this directory.' \
      >"$PACKAGE_TMP/PUBLIC-PACKAGE-FORMAT.txt"
    chmod 0444 "$PACKAGE_TMP/PUBLIC-PACKAGE-FORMAT.txt"
    (
      cd "$PACKAGE_TMP"
      find . -type f ! -name SHA256SUMS -printf '%P\n' |
        LC_ALL=C sort |
        while IFS= read -r path; do
          printf '%s\t%s\n' "$(sha256sum "$path" | cut -d ' ' -f 1)" "$path"
        done >SHA256SUMS
      chmod 0444 SHA256SUMS
      sync -f SHA256SUMS
      sync -f .
    )
    verify_package "$PACKAGE_TMP" >/dev/null
    if ! mv -Tn "$PACKAGE_TMP" "$DESTINATION" || [[ -d "$PACKAGE_TMP" ]]; then
      echo "FAIL: package publication collided with an existing path" >&2
      exit 1
    fi
    PACKAGE_TMP=
    sync -f "$DESTINATION_PARENT"
    verify_package "$DESTINATION"
    ;;
  verify)
    [[ $# -eq 1 ]] || usage
    verify_package "$1"
    ;;
  self-test)
    [[ $# -eq 0 ]] || usage
    SELF_TEST_ROOT=$(mktemp -d)
    cleanup_self_test() {
      rm -rf -- "$SELF_TEST_ROOT"
    }
    trap cleanup_self_test EXIT
    SOURCE="$SELF_TEST_ROOT/source"
    PACKAGE="$SELF_TEST_ROOT/package"
    mkdir -p "$SOURCE/transcript" "$SOURCE/measurements" "$SOURCE/state/steps"
    printf '{}\n' >"$SOURCE/transcript/ceremony.json"
    printf 'signature\n' >"$SOURCE/transcript/ceremony.sig"
    printf '00\n' >"$SOURCE/transcript/coordinator-public-key.hex"
    printf 'r1cs\n' >"$SOURCE/transcript/ownership-destination.ccs"
    cat >"$SOURCE/measurements/demo.attempt-0001.time.txt" <<'EOF'
	Command being timed: "/host/mpc phase1 contribute --participant-signing-key /home/operator/participant.private.hex"
	User time (seconds): 1.25
	System time (seconds): 0.50
	Elapsed (wall clock) time (h:mm:ss or m:ss): 0:02.00
	Maximum resident set size (kbytes): 12345
	File system inputs: 4
	File system outputs: 8
	Exit status: 0
EOF
    printf '{"outputs":{"candidate":"/home/operator/rehearsal/candidate"}}\n' \
      >"$SOURCE/measurements/demo.attempt-0001.output.json"
    SELF_RESULT_HASH=$(
      sha256sum "$SOURCE/measurements/demo.attempt-0001.output.json" |
        cut -d ' ' -f 1
    )
    printf '%s  measurements/demo.attempt-0001.output.json\n' "$SELF_RESULT_HASH" \
      >"$SOURCE/state/steps/demo.complete"
    "$0" create "$SOURCE" "$PACKAGE" >/dev/null
    "$0" verify "$PACKAGE" >/dev/null
    if find "$PACKAGE" -type f \
      \( -name '*.time.txt' -o -name '*.output.json' \) -print -quit |
      grep -q .; then
      echo "FAIL: self-test packaged a raw command measurement" >&2
      exit 1
    fi
    if grep -R -E \
      '(Command being timed:|participant-signing-key|private\.hex|/home/operator)' \
      "$PACKAGE" >/dev/null; then
      echo "FAIL: self-test package leaked private host context" >&2
      exit 1
    fi
    grep -F $'demo\t0001\t1.25\t0.50\t0:02.00\t12345\t4\t8\t0' \
      "$PACKAGE/measurements/command-resources.tsv" >/dev/null
    chmod 0644 "$PACKAGE/transcript/ceremony.json" "$PACKAGE/SHA256SUMS"
    printf '{"path":"/home/operator/rehearsal"}\n' \
      >"$PACKAGE/transcript/ceremony.json"
    (
      cd "$PACKAGE"
      find . -type f ! -name SHA256SUMS -printf '%P\n' |
        LC_ALL=C sort |
        while IFS= read -r path; do
          printf '%s\t%s\n' "$(sha256sum "$path" | cut -d ' ' -f 1)" "$path"
        done >SHA256SUMS
    )
    if "$0" verify "$PACKAGE" >/dev/null 2>&1; then
      echo "FAIL: self-test verifier accepted an absolute host path" >&2
      exit 1
    fi
    echo "OK: public evidence package self-test passed"
    ;;
  *)
    usage
    ;;
esac
