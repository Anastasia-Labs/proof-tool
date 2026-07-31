#!/usr/bin/env bash
# Verifies the exact public finalization vector with the dynamic Plutus
# destination-proof verifier. No wallet secret or derivation path is read.
set -euo pipefail
umask 077

usage() {
  echo "usage: verify-mpc-final-plutus-evidence.sh CANDIDATE_OR_RELEASE_DIR [VERIFY_DESTINATION_PROOF_BINARY]" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
ARTIFACT_DIR=$1

if [[ ! -d "$ARTIFACT_DIR" || -L "$ARTIFACT_DIR" ]]; then
  echo "FAIL: artifact directory must be an existing real directory" >&2
  exit 1
fi
ARTIFACT_DIR=$(cd "$ARTIFACT_DIR" && pwd)

for tool in b2sum node sha256sum stat; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: required tool is unavailable: $tool" >&2
    exit 1
  fi
done

if [[ $# -eq 2 ]]; then
  VERIFIER_BIN=$2
elif [[ -n "${MPC_PLUTUS_VERIFIER_BIN:-}" ]]; then
  VERIFIER_BIN=$MPC_PLUTUS_VERIFIER_BIN
else
  if ! command -v cabal >/dev/null 2>&1; then
    echo "FAIL: pass a prebuilt verify-destination-proof binary or install cabal" >&2
    exit 1
  fi
  VERIFIER_BIN=$(
    cd "$REPO_ROOT/contracts/ownership-verifier"
    cabal list-bin exe:verify-destination-proof
  )
fi
if [[ ! -f "$VERIFIER_BIN" || -L "$VERIFIER_BIN" || ! -x "$VERIFIER_BIN" ]]; then
  echo "FAIL: Plutus verifier must be an executable regular file, not a symlink" >&2
  exit 1
fi
VERIFIER_BIN=$(cd "$(dirname "$VERIFIER_BIN")" && pwd)/$(basename "$VERIFIER_BIN")

CANDIDATE="$ARTIFACT_DIR/candidate.json"
REPORT="$ARTIFACT_DIR/verification-report.json"
EVIDENCE="$ARTIFACT_DIR/public-finalization-evidence.json"
VK_RAW="$ARTIFACT_DIR/cardano-vk.bin"
VK_HEX="$ARTIFACT_DIR/cardano-vk.hex"
for path in "$CANDIDATE" "$REPORT" "$EVIDENCE" "$VK_RAW" "$VK_HEX"; do
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "FAIL: required artifact is not a regular file: $path" >&2
    exit 1
  fi
done

mapfile -d '' JSON_VALUES < <(
  node - "$CANDIDATE" "$REPORT" "$EVIDENCE" <<'NODE'
const fs = require("fs");

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}
function readJSON(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    fail(`invalid JSON in ${path}: ${error.message}`);
  }
}
function requireValue(actual, expected, label) {
  if (actual !== expected) fail(`${label} differs from ${JSON.stringify(expected)}`);
}
function requireHex(value, bytes, label) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    fail(`${label} is not exactly ${bytes} lowercase hexadecimal bytes`);
  }
}
function requireRef(ref, name, label) {
  if (!ref || ref.name !== name || !ref.digest) fail(`${label} has the wrong artifact name`);
  requireHex(ref.digest.sha256?.replace(/^sha256:/, ""), 32, `${label} SHA-256`);
  requireHex(ref.digest.blake2b256?.replace(/^blake2b256:/, ""), 32, `${label} BLAKE2b-256`);
  if (!Number.isSafeInteger(ref.digest.size) || ref.digest.size <= 0) fail(`${label} size is invalid`);
}
function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function emit(value) {
  process.stdout.write(String(value));
  process.stdout.write("\0");
}

const candidate = readJSON(process.argv[2]);
const report = readJSON(process.argv[3]);
const evidence = readJSON(process.argv[4]);
requireValue(candidate.schema, "proof-tool-mpc-release-candidate-v2", "candidate schema");
requireValue(report.schema, "proof-tool-mpc-verification-report-v2", "report schema");
requireValue(evidence.schema, "proof-tool-mpc-public-finalization-evidence-v1", "evidence schema");
requireValue(report.native_proof_verified, true, "native proof result");
requireValue(report.wrong_credential_rejected, true, "wrong-credential result");
requireValue(report.wrong_destination_rejected, true, "wrong-destination result");
requireValue(report.wrong_digest_rejected, true, "wrong-digest result");
requireValue(report.wrong_proof_rejected, true, "wrong-proof result");
requireValue(report.wrong_vk_rejected, true, "wrong-VK result");
requireValue(report.proof_truncation_rejected, true, "proof-truncation result");
requireValue(report.proof_append_rejected, true, "proof-append result");
requireValue(report.cardano_proof_format, "groth16-bls12-381-bsb22", "report proof format");
requireValue(report.cardano_proof_bytes, 336, "report proof length");
requireValue(report.cardano_vk_format, "groth16-bls12-381-bsb22", "report VK format");
requireValue(report.cardano_vk_bytes, 672, "report VK length");
requireValue(evidence.cardano_proof_format, "groth16-bls12-381-bsb22", "evidence proof format");
requireValue(report.cardano_proof_raw_digest.size, 336, "report proof digest size");
requireValue(evidence.cardano_proof_raw_digest.size, 336, "evidence proof digest size");
requireValue(report.cardano_vk_raw_digest.size, 672, "report VK digest size");
requireRef(candidate.verification_report, "verification-report.json", "candidate report reference");
requireRef(candidate.public_finalization_evidence, "public-finalization-evidence.json", "candidate evidence reference");
requireRef(candidate.cardano_verifying_key, "cardano-vk.bin", "candidate VK reference");
if (!same(candidate.public_finalization_evidence, report.public_evidence)) {
  fail("verification report does not hash-bind candidate public evidence");
}
if (!same(candidate.cardano_verifying_key, evidence.cardano_verifying_key)) {
  fail("public evidence does not bind candidate Cardano VK");
}
if (candidate.ceremony_id !== report.ceremony_id || candidate.ceremony_id !== evidence.ceremony_id) {
  fail("ceremony id differs across candidate, report, and evidence");
}
requireHex(evidence.credential_hex, 28, "credential");
requireHex(evidence.destination_hex, 58, "destination");
requireHex(evidence.public_input_digest_hex, 32, "public input digest");
requireHex(evidence.cardano_proof_hex, 336, "Cardano proof");
if (!same(report.cardano_proof_raw_digest, evidence.cardano_proof_raw_digest)) {
  fail("report and evidence proof digests differ");
}
if (!same(report.cardano_vk_raw_digest, candidate.cardano_verifying_key.digest)) {
  fail("report and candidate VK digests differ");
}

[
  candidate.ceremony_id,
  evidence.credential_hex,
  evidence.destination_hex,
  evidence.public_input_digest_hex,
  evidence.cardano_proof_hex,
  candidate.verification_report.digest.sha256,
  candidate.verification_report.digest.blake2b256,
  candidate.verification_report.digest.size,
  candidate.public_finalization_evidence.digest.sha256,
  candidate.public_finalization_evidence.digest.blake2b256,
  candidate.public_finalization_evidence.digest.size,
  candidate.cardano_verifying_key.digest.sha256,
  candidate.cardano_verifying_key.digest.blake2b256,
  candidate.cardano_verifying_key.digest.size,
  report.cardano_proof_raw_digest.sha256,
  report.cardano_proof_raw_digest.blake2b256,
].forEach(emit);
NODE
)
if [[ ${#JSON_VALUES[@]} -ne 16 ]]; then
  echo "FAIL: JSON validator returned incomplete evidence" >&2
  exit 1
fi

CEREMONY_ID=${JSON_VALUES[0]}
CREDENTIAL_HEX=${JSON_VALUES[1]}
DESTINATION_HEX=${JSON_VALUES[2]}
PUBLIC_INPUT_DIGEST_HEX=${JSON_VALUES[3]}
PROOF_HEX=${JSON_VALUES[4]}

verify_ref() {
  local path=$1
  local expected_sha=$2
  local expected_blake=$3
  local expected_size=$4
  local label=$5
  local actual_sha actual_blake actual_size
  actual_sha="sha256:$(sha256sum "$path" | cut -d ' ' -f 1)"
  actual_blake="blake2b256:$(b2sum -l 256 "$path" | cut -d ' ' -f 1)"
  actual_size=$(stat -c %s "$path")
  if [[ "$actual_sha" != "$expected_sha" ||
    "$actual_blake" != "$expected_blake" ||
    "$actual_size" != "$expected_size" ]]; then
    echo "FAIL: artifact digest mismatch for $label" >&2
    exit 1
  fi
}

verify_ref "$REPORT" "${JSON_VALUES[5]}" "${JSON_VALUES[6]}" "${JSON_VALUES[7]}" "verification report"
verify_ref "$EVIDENCE" "${JSON_VALUES[8]}" "${JSON_VALUES[9]}" "${JSON_VALUES[10]}" "public evidence"
verify_ref "$VK_RAW" "${JSON_VALUES[11]}" "${JSON_VALUES[12]}" "${JSON_VALUES[13]}" "Cardano VK"

hex_to_binary() {
  node -e 'process.stdout.write(Buffer.from(process.argv[1], "hex"))' "$1"
}

PROOF_SHA="sha256:$(hex_to_binary "$PROOF_HEX" | sha256sum | cut -d ' ' -f 1)"
PROOF_BLAKE="blake2b256:$(hex_to_binary "$PROOF_HEX" | b2sum -l 256 | cut -d ' ' -f 1)"
if [[ "$PROOF_SHA" != "${JSON_VALUES[14]}" || "$PROOF_BLAKE" != "${JSON_VALUES[15]}" ]]; then
  echo "FAIL: report/evidence proof hashes do not bind the exact Cardano proof" >&2
  exit 1
fi

VK_SHA="sha256:$(sha256sum "$VK_RAW" | cut -d ' ' -f 1)"
VK_BLAKE="blake2b256:$(b2sum -l 256 "$VK_RAW" | cut -d ' ' -f 1)"
VK_FULL_HEX=$(node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]).toString("hex"))' "$VK_RAW")
if [[ "$VK_FULL_HEX" != "$(tr -d '[:space:]' <"$VK_HEX")" ]]; then
  echo "FAIL: Cardano VK hex differs from exact final raw VK" >&2
  exit 1
fi

COMPUTED_PUBLIC_INPUT_DIGEST=$(
  {
    printf '%s' 'ROOT-OWNERSHIP-DESTINATION-v1'
    hex_to_binary "$CREDENTIAL_HEX"
    hex_to_binary "$DESTINATION_HEX"
  } | b2sum -l 256 | cut -d ' ' -f 1
)
if [[ "$COMPUTED_PUBLIC_INPUT_DIGEST" != "$PUBLIC_INPUT_DIGEST_HEX" ]]; then
  echo "FAIL: public input digest does not bind the credential and destination" >&2
  exit 1
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/proof-tool-plutus-evidence.XXXXXXXX")
trap 'rm -rf -- "$TMP_DIR"' EXIT

flip_first_byte() {
  local value=$1
  local byte
  printf -v byte '%02x' "$((16#${value:0:2} ^ 1))"
  printf '%s%s' "$byte" "${value:2}"
}

expect_reject() {
  local label=$1
  local vk_path=$2
  local proof=$3
  local credential=$4
  local destination=$5
  local digest=$6
  if "$VERIFIER_BIN" "$vk_path" "$proof" "$credential" "$destination" "$digest" \
    >"$TMP_DIR/$label.stdout" 2>"$TMP_DIR/$label.stderr"; then
    echo "FAIL: dynamic Plutus verifier accepted negative case: $label" >&2
    exit 1
  fi
}

POSITIVE_OUTPUT=$(
  "$VERIFIER_BIN" \
    "$VK_HEX" \
    "$PROOF_HEX" \
    "$CREDENTIAL_HEX" \
    "$DESTINATION_HEX" \
    "$PUBLIC_INPUT_DIGEST_HEX"
)
if [[ "$POSITIVE_OUTPUT" != "ok" ]]; then
  echo "FAIL: dynamic Plutus verifier did not return the exact positive result" >&2
  exit 1
fi

MUTATED_VK_HEX=$(flip_first_byte "$VK_FULL_HEX")
printf '%s\n' "$MUTATED_VK_HEX" >"$TMP_DIR/vk-mutated.hex"
printf '%s\n' "${VK_FULL_HEX:0:${#VK_FULL_HEX}-2}" >"$TMP_DIR/vk-truncated.hex"
printf '%s00\n' "$VK_FULL_HEX" >"$TMP_DIR/vk-appended.hex"

expect_reject destination-mutated "$VK_HEX" "$PROOF_HEX" "$CREDENTIAL_HEX" "$(flip_first_byte "$DESTINATION_HEX")" "$PUBLIC_INPUT_DIGEST_HEX"
expect_reject credential-mutated "$VK_HEX" "$PROOF_HEX" "$(flip_first_byte "$CREDENTIAL_HEX")" "$DESTINATION_HEX" "$PUBLIC_INPUT_DIGEST_HEX"
expect_reject digest-mutated "$VK_HEX" "$PROOF_HEX" "$CREDENTIAL_HEX" "$DESTINATION_HEX" "$(flip_first_byte "$PUBLIC_INPUT_DIGEST_HEX")"
expect_reject proof-mutated "$VK_HEX" "$(flip_first_byte "$PROOF_HEX")" "$CREDENTIAL_HEX" "$DESTINATION_HEX" "$PUBLIC_INPUT_DIGEST_HEX"
expect_reject vk-mutated "$TMP_DIR/vk-mutated.hex" "$PROOF_HEX" "$CREDENTIAL_HEX" "$DESTINATION_HEX" "$PUBLIC_INPUT_DIGEST_HEX"
expect_reject proof-truncated "$VK_HEX" "${PROOF_HEX:0:${#PROOF_HEX}-2}" "$CREDENTIAL_HEX" "$DESTINATION_HEX" "$PUBLIC_INPUT_DIGEST_HEX"
expect_reject proof-appended "$VK_HEX" "${PROOF_HEX}00" "$CREDENTIAL_HEX" "$DESTINATION_HEX" "$PUBLIC_INPUT_DIGEST_HEX"
expect_reject vk-truncated "$TMP_DIR/vk-truncated.hex" "$PROOF_HEX" "$CREDENTIAL_HEX" "$DESTINATION_HEX" "$PUBLIC_INPUT_DIGEST_HEX"
expect_reject vk-appended "$TMP_DIR/vk-appended.hex" "$PROOF_HEX" "$CREDENTIAL_HEX" "$DESTINATION_HEX" "$PUBLIC_INPUT_DIGEST_HEX"

node - \
  "$CEREMONY_ID" \
  "sha256:$(sha256sum "$VERIFIER_BIN" | cut -d ' ' -f 1)" \
  "sha256:$(sha256sum "$REPORT" | cut -d ' ' -f 1)" \
  "sha256:$(sha256sum "$EVIDENCE" | cut -d ' ' -f 1)" \
  "$VK_SHA" \
  "$PROOF_SHA" <<'NODE'
const values = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  schema: "proof-tool-mpc-plutus-finalization-verification-v1",
  ceremony_id: values[0],
  verifier_sha256: values[1],
  verification_report_sha256: values[2],
  public_evidence_sha256: values[3],
  cardano_vk_sha256: values[4],
  cardano_proof_sha256: values[5],
  positive_verified: true,
  rejected_negatives: [
    "destination-mutated",
    "credential-mutated",
    "digest-mutated",
    "proof-mutated",
    "vk-mutated",
    "proof-truncated",
    "proof-appended",
    "vk-truncated",
    "vk-appended",
  ],
}));
process.stdout.write("\n");
NODE
