#!/usr/bin/env bash
# Runs a staged, exact ownership-destination-v2 K=21 ceremony through the
# participant-facing CLI using same-host rehearsal identities.
#
# This is resource/coherence evidence, not participant-independence evidence.
# It never fetches a beacon. The operator must close each phase on a future
# round, publicly witness the closure, wait for that round, obtain the exact
# raw response independently, and resume with the next stage.
set -euo pipefail
umask 077
export LC_ALL=C

usage() {
  cat >&2 <<'EOF'
usage:
  run-mpc-k21-local-rehearsal.sh prepare FRESH_ROOT MPC_BINARY [PARTICIPANTS]
  run-mpc-k21-local-rehearsal.sh phase1-contribute ROOT MPC_BINARY
  run-mpc-k21-local-rehearsal.sh phase1-close ROOT MPC_BINARY FUTURE_QUICKNET_ROUND
  run-mpc-k21-local-rehearsal.sh phase1-beacon ROOT MPC_BINARY RAW_RESPONSE PUBLISHED_AT_UTC
  run-mpc-k21-local-rehearsal.sh phase2-contribute ROOT MPC_BINARY
  run-mpc-k21-local-rehearsal.sh phase2-close ROOT MPC_BINARY FUTURE_QUICKNET_ROUND
  run-mpc-k21-local-rehearsal.sh finish ROOT MPC_BINARY RAW_RESPONSE PUBLISHED_AT_UTC PHASE1_RELAY_DIR PHASE2_RELAY_DIR
  run-mpc-k21-local-rehearsal.sh inspect ROOT MPC_BINARY
  run-mpc-k21-local-rehearsal.sh self-test-state
  run-mpc-k21-local-rehearsal.sh self-test-close-recovery

This local harness requires 3-20 identities and a qualified work volume. It
does not create production enrollment, fetch network data, or prove that
same-host identities are independent participants or auditors.
EOF
  exit 2
}

[[ $# -ge 1 ]] || usage
STAGE=$1
shift

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
QUICKNET_GENESIS=1692803367
QUICKNET_PERIOD=3
DEFAULT_REHEARSAL_BEACON_LEAD_SECONDS=300
HARD_MIN_REHEARSAL_BEACON_LEAD_SECONDS=60

timestamp() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
}

max_epoch() {
  local left=$1
  local right=$2
  if (( left > right )); then
    echo "$left"
  else
    echo "$right"
  fi
}

round_epoch() {
  local round=$1
  if [[ ! "$round" =~ ^[1-9][0-9]*$ ]]; then
    echo "FAIL: Quicknet round must be a positive integer" >&2
    exit 1
  fi
  echo $((QUICKNET_GENESIS + (round - 1) * QUICKNET_PERIOD))
}

closure_epoch() {
  local path=$1
  local expected_round=$2
  local expected_round_epoch=$3
  local minimum_lead=$4
  node - "$path" "$expected_round" "$expected_round_epoch" "$minimum_lead" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const expectedRound = Number(process.argv[3]);
const expectedRoundEpoch = Number(process.argv[4]);
const minimumLead = Number(process.argv[5]);
let close;
try {
  close = JSON.parse(fs.readFileSync(path, "utf8"));
} catch (error) {
  process.stderr.write(`FAIL: cannot parse published closure: ${error.message}\n`);
  process.exit(1);
}
const closedMillis = Date.parse(close.closed_at);
const notBeforeMillis = Date.parse(close.beacon_not_before);
if (!Number.isSafeInteger(expectedRound) ||
    !Number.isSafeInteger(expectedRoundEpoch) ||
    !Number.isSafeInteger(minimumLead) ||
    close.beacon_round !== expectedRound ||
    !Number.isFinite(closedMillis) ||
    notBeforeMillis !== expectedRoundEpoch * 1000 ||
    expectedRoundEpoch * 1000 - closedMillis < (minimumLead + 2) * 1000) {
  process.stderr.write("FAIL: published closure does not bind the requested future round and lead\n");
  process.exit(1);
}
process.stdout.write(`${Math.floor(closedMillis / 1000)}\n`);
NODE
}

finalization_evidence_source_hash() {
  (
    cd "$REPO_ROOT/scripts/mpc-finalization-evidence"
    find . -maxdepth 1 -type f -print0 |
      LC_ALL=C sort -z |
      xargs -0 sha256sum |
      sha256sum |
      cut -d ' ' -f 1
  )
}

default_finalization_evidence_binary() {
  local candidate
  candidate="$(dirname "$MPC_BIN")/mpc-finalization-evidence"
  if [[ -f "$candidate" && ! -L "$candidate" && -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
  fi
}

record_finalization_evidence_generator() {
  local generator=${MPC_FINALIZATION_EVIDENCE_BIN:-}
  if [[ -z "$generator" ]]; then
    generator=$(default_finalization_evidence_binary)
  fi
  if [[ -n "$generator" ]]; then
    if [[ ! -f "$generator" ||
      -L "$generator" ||
      ! -x "$generator" ]]; then
      echo "FAIL: MPC_FINALIZATION_EVIDENCE_BIN must be an executable regular file, not a symlink" >&2
      exit 1
    fi
    write_state "$STATE_DIR/finalization-evidence-generator-mode.txt" "prebuilt-binary"
    write_state \
      "$STATE_DIR/finalization-evidence-generator.sha256" \
      "$(sha256sum "$generator" | cut -d ' ' -f 1)"
  else
    write_state "$STATE_DIR/finalization-evidence-generator-mode.txt" "go-run-source"
    write_state \
      "$STATE_DIR/finalization-evidence-generator.sha256" \
      "$(finalization_evidence_source_hash)"
  fi
}

resolve_finalization_evidence_generator() {
  local mode
  local expected_hash
  local actual_hash
  local generator
  for state_path in \
    "$STATE_DIR/finalization-evidence-generator-mode.txt" \
    "$STATE_DIR/finalization-evidence-generator.sha256"; do
    if [[ ! -f "$state_path" || -L "$state_path" ]]; then
      echo "FAIL: finalization evidence generator binding is absent or unsafe" >&2
      exit 1
    fi
  done
  mode=$(tr -d '\n' <"$STATE_DIR/finalization-evidence-generator-mode.txt")
  expected_hash=$(tr -d '\n' <"$STATE_DIR/finalization-evidence-generator.sha256")
  case "$mode" in
    prebuilt-binary)
      generator=${MPC_FINALIZATION_EVIDENCE_BIN:-}
      if [[ -z "$generator" ]]; then
        generator=$(default_finalization_evidence_binary)
      fi
      if [[ -z "$generator" ||
        ! -f "$generator" ||
        -L "$generator" ||
        ! -x "$generator" ]]; then
        echo "FAIL: prepared rehearsal requires the bound MPC_FINALIZATION_EVIDENCE_BIN" >&2
        exit 1
      fi
      actual_hash=$(sha256sum "$generator" | cut -d ' ' -f 1)
      if [[ "$actual_hash" != "$expected_hash" ]]; then
        echo "FAIL: finalization evidence generator changed after prepare" >&2
        exit 1
      fi
      FINALIZATION_EVIDENCE_COMMAND=("$generator")
      FINALIZATION_GOCACHE=
      ;;
    go-run-source)
      if [[ -n "${MPC_FINALIZATION_EVIDENCE_BIN:-}" ]]; then
        echo "FAIL: rehearsal prepared for source generator but a prebuilt helper was supplied" >&2
        exit 1
      fi
      actual_hash=$(finalization_evidence_source_hash)
      if [[ "$actual_hash" != "$expected_hash" ]]; then
        echo "FAIL: finalization evidence generator source changed after prepare" >&2
        exit 1
      fi
      FINALIZATION_GOCACHE="$ROOT/.mpc-finalization-evidence-go-cache"
      FINALIZATION_EVIDENCE_COMMAND=(
        env
        "GOCACHE=$FINALIZATION_GOCACHE"
        GOWORK=off
        GOFLAGS=-mod=vendor
        go run "$REPO_ROOT/scripts/mpc-finalization-evidence"
      )
      ;;
    *)
      echo "FAIL: unknown finalization evidence generator mode: $mode" >&2
      exit 1
      ;;
  esac
}

record_operational_evidence_generator() {
  local tools_dir="$CONTROL/tools"
  local generator="$tools_dir/mpc-rehearsal-operational-evidence"
  if [[ -e "$tools_dir" || -L "$tools_dir" ]]; then
    if [[ ! -d "$tools_dir" || -L "$tools_dir" ]]; then
      echo "FAIL: rehearsal helper directory is unsafe" >&2
      exit 1
    fi
  else
    mkdir -m 0700 "$tools_dir"
  fi
  if [[ -e "$generator" || -L "$generator" ]]; then
    echo "FAIL: rehearsal operational-evidence helper path must be fresh" >&2
    exit 1
  fi
  if [[ -n "${MPC_REHEARSAL_OPERATIONAL_EVIDENCE_BIN:-}" ]]; then
    if [[ ! -f "$MPC_REHEARSAL_OPERATIONAL_EVIDENCE_BIN" ||
      -L "$MPC_REHEARSAL_OPERATIONAL_EVIDENCE_BIN" ||
      ! -x "$MPC_REHEARSAL_OPERATIONAL_EVIDENCE_BIN" ]]; then
      echo "FAIL: MPC_REHEARSAL_OPERATIONAL_EVIDENCE_BIN must be an executable regular file, not a symlink" >&2
      exit 1
    fi
    cp -- "$MPC_REHEARSAL_OPERATIONAL_EVIDENCE_BIN" "$generator"
    write_state "$STATE_DIR/operational-evidence-generator-mode.txt" "provided-binary-copy"
  else
    local cache="$ROOT/.mpc-rehearsal-operational-evidence-go-cache"
    (
      cd "$REPO_ROOT"
      env \
        GOCACHE="$cache" \
        GOWORK=off \
        GOFLAGS=-mod=vendor \
        go build -buildvcs=false -trimpath \
        -o "$generator" \
        ./scripts/mpc-rehearsal-operational-evidence
    )
    rm -rf -- "$cache"
    write_state "$STATE_DIR/operational-evidence-generator-mode.txt" "prepare-built-binary"
  fi
  chmod 0500 "$generator"
  sync -f "$generator"
  write_state \
    "$STATE_DIR/operational-evidence-generator.sha256" \
    "$(sha256sum "$generator" | cut -d ' ' -f 1)"
}

resolve_operational_evidence_generator() {
  local generator="$CONTROL/tools/mpc-rehearsal-operational-evidence"
  local expected_hash
  local actual_hash
  for state_path in \
    "$STATE_DIR/operational-evidence-generator-mode.txt" \
    "$STATE_DIR/operational-evidence-generator.sha256"; do
    if [[ ! -f "$state_path" || -L "$state_path" ]]; then
      echo "FAIL: operational evidence generator binding is absent or unsafe" >&2
      exit 1
    fi
  done
  if [[ ! -f "$generator" || -L "$generator" || ! -x "$generator" ]]; then
    echo "FAIL: bound operational evidence generator is absent or unsafe" >&2
    exit 1
  fi
  expected_hash=$(tr -d '\n' <"$STATE_DIR/operational-evidence-generator.sha256")
  actual_hash=$(sha256sum "$generator" | cut -d ' ' -f 1)
  if [[ ! "$expected_hash" =~ ^[0-9a-f]{64}$ || "$actual_hash" != "$expected_hash" ]]; then
    echo "FAIL: operational evidence generator changed after prepare" >&2
    exit 1
  fi
  OPERATIONAL_EVIDENCE_COMMAND=("$generator")
}

write_state() {
  local path=$1
  local value=$2
  if [[ -e "$path" || -L "$path" ]]; then
    if [[ -L "$path" || ! -f "$path" ]]; then
      echo "FAIL: state path is not a regular file: $path" >&2
      exit 1
    fi
    local existing
    existing=$(tr -d '\n' <"$path")
    if [[ "$existing" != "$value" ]]; then
      echo "FAIL: existing state differs from exact retry value: $path" >&2
      exit 1
    fi
    return
  fi
  printf '%s\n' "$value" >"$path"
  sync -f "$path"
}

step_epoch() {
  local label=$1
  local minimum=$2
  local path="$STATE_DIR/steps/$label.epoch"
  if [[ -f "$path" && ! -L "$path" ]]; then
    local existing
    existing=$(tr -d '\n' <"$path")
    if [[ ! "$existing" =~ ^[0-9]+$ || "$existing" -lt "$minimum" ]]; then
      echo "FAIL: invalid persisted timestamp for $label" >&2
      exit 1
    fi
    echo "$existing"
    return
  fi
  local selected
  selected=$(max_epoch "$(date +%s)" "$minimum")
  write_state "$path" "$selected"
  echo "$selected"
}

require_marker() {
  local name=$1
  if [[ ! -f "$STATE_DIR/$name.complete" || -L "$STATE_DIR/$name.complete" ]]; then
    echo "FAIL: required completed stage is missing: $name" >&2
    exit 1
  fi
  verify_stage_manifest "$name"
}

complete_stage() {
  local name=$1
  write_state "$STATE_DIR/$name.complete" "$(timestamp "$(date +%s)")"
  write_stage_manifest "$name"
  sync -f "$STATE_DIR"
}

load_common() {
  if [[ $# -lt 2 || $# -gt 3 ]]; then
    usage
  fi
  ROOT=$1
  MPC_BIN=$2
  LOAD_MODE=${3:-mutable}
  if [[ ! -d "$ROOT" || -L "$ROOT" ]]; then
    echo "FAIL: rehearsal root must be an existing real directory: $ROOT" >&2
    exit 1
  fi
  if [[ ! -f "$MPC_BIN" || -L "$MPC_BIN" || ! -x "$MPC_BIN" ]]; then
    echo "FAIL: MPC binary must be an executable regular file, not a symlink" >&2
    exit 1
  fi
  ROOT=$(cd "$ROOT" && pwd)
  MPC_BIN=$(cd "$(dirname "$MPC_BIN")" && pwd)/$(basename "$MPC_BIN")
  CONTROL="$ROOT/control"
  CONFIG="$CONTROL/config"
  KEYS="$CONTROL/keys"
  TRANSCRIPT="$ROOT/transcript"
  CANDIDATES="$ROOT/candidates"
  MEASUREMENTS="$ROOT/measurements"
  STATE_DIR="$ROOT/state"
  AUDITS="$ROOT/audits"
  PRELIMINARY_KEYS="$ROOT/preliminary-final-keys"
  FINAL_CANDIDATE="$ROOT/candidate"
  RELEASE_DIR="$ROOT/release"
  PUBLIC_FINALIZATION_EVIDENCE="$CONTROL/public-finalization-evidence.json"
  for dir in "$CONTROL" "$CONFIG" "$KEYS" "$TRANSCRIPT" "$MEASUREMENTS" "$STATE_DIR" "$STATE_DIR/steps"; do
    if [[ ! -d "$dir" || -L "$dir" ]]; then
      echo "FAIL: expected rehearsal directory is absent or unsafe: $dir" >&2
      exit 1
    fi
  done
  local unsafe_entry
  unsafe_entry=$(find "$ROOT" ! -type d ! -type f -print -quit)
  if [[ -n "$unsafe_entry" ]]; then
    echo "FAIL: rehearsal tree contains a symlink or special file: $unsafe_entry" >&2
    exit 1
  fi
  if [[ "$LOAD_MODE" != "read-only" ]]; then
    "$SCRIPT_DIR/check-mpc-k21-capacity.sh" "$ROOT"
  fi
  if [[ ! -f "$STATE_DIR/binary.sha256" || -L "$STATE_DIR/binary.sha256" ]]; then
    echo "FAIL: prepared binary hash is absent or unsafe" >&2
    exit 1
  fi
  local expected_binary_hash
  expected_binary_hash=$(tr -d '\n' <"$STATE_DIR/binary.sha256")
  local actual_binary_hash
  actual_binary_hash=$(sha256sum "$MPC_BIN" | cut -d ' ' -f 1)
  if [[ "$actual_binary_hash" != "$expected_binary_hash" ]]; then
    echo "FAIL: ceremony binary changed after prepare" >&2
    exit 1
  fi
  PARTICIPANT_COUNT=$(tr -d '\n' <"$CONTROL/participant-count.txt")
  if [[ ! "$PARTICIPANT_COUNT" =~ ^([3-9]|1[0-9]|20)$ ]]; then
    echo "FAIL: invalid rehearsal participant count" >&2
    exit 1
  fi
  if [[ ! -f "$STATE_DIR/beacon-lead-seconds.txt" ||
    -L "$STATE_DIR/beacon-lead-seconds.txt" ]]; then
    echo "FAIL: prepared rehearsal beacon lead is absent or unsafe" >&2
    exit 1
  fi
  MIN_BEACON_LEAD_SECONDS=$(tr -d '\n' <"$STATE_DIR/beacon-lead-seconds.txt")
  if [[ ! "$MIN_BEACON_LEAD_SECONDS" =~ ^[0-9]+$ ||
    "$MIN_BEACON_LEAD_SECONDS" -lt "$HARD_MIN_REHEARSAL_BEACON_LEAD_SECONDS" ]]; then
    echo "FAIL: invalid prepared rehearsal beacon lead" >&2
    exit 1
  fi
  CEREMONY="$TRANSCRIPT/ceremony.json"
  CEREMONY_SIGNATURE="$TRANSCRIPT/ceremony.sig"
  COORDINATOR_PUBLIC_KEY="$KEYS/coordinator.ed25519.public.hex"
  COORDINATOR_PRIVATE_KEY="$KEYS/coordinator.ed25519.private.hex"
  PHASE1_SEAL="$TRANSCRIPT/phase1/sealed/seal.json"
  PHASE1_SEAL_SIGNATURE="$TRANSCRIPT/phase1/sealed/seal.sig"
  resolve_finalization_evidence_generator
  resolve_operational_evidence_generator
  if [[ "$LOAD_MODE" == "read-only" ]]; then
    revalidate_completed_steps no
    revalidate_stage_markers no
  else
    revalidate_completed_steps yes
    revalidate_stage_markers yes
  fi
}

relay_ids() {
  local phase=$1
  local path="$STATE_DIR/$phase-relay-ids.txt"
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "FAIL: bound relay identifiers are absent or unsafe for $phase" >&2
    return 1
  fi
  local value
  value=$(tr -d '\n' <"$path")
  if [[ ! "$value" =~ ^[a-z0-9._:-]+(,[a-z0-9._:-]+){2,15}$ ||
    "$value" == *..* ]]; then
    echo "FAIL: bound relay identifiers are malformed for $phase" >&2
    return 1
  fi
  tr ',' '\n' <<<"$value"
}

record_relay_inputs() {
  local phase=$1
  local directory=$2
  if [[ ! -d "$directory" || -L "$directory" ]]; then
    echo "FAIL: $phase relay input must be a real directory" >&2
    return 1
  fi
  directory=$(cd "$directory" && pwd)
  local manifest="$directory/relays.tsv"
  if [[ ! -f "$manifest" || -L "$manifest" ]]; then
    echo "FAIL: $phase relay input lacks a regular relays.tsv" >&2
    return 1
  fi
  local ids
  ids=$(
    node - "$manifest" <<'NODE'
const fs = require("node:fs");
const rows = fs.readFileSync(process.argv[2], "utf8").split("\n");
if (rows.at(-1) === "") rows.pop();
const header = "relay_id\toperator_id\tendpoint_sha256\tretrieved_at\tfilename";
if (rows.length < 4 || rows.length > 17 || rows[0] !== header) {
  throw new Error("relays.tsv must have the exact header and 3-16 observations");
}
const idPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const filenamePattern = /^[a-z0-9][a-z0-9._-]*\.json$/;
const ids = [];
for (const row of rows.slice(1)) {
  const fields = row.split("\t");
  if (fields.length !== 5 || !idPattern.test(fields[0]) ||
      fields[0].includes("..") ||
      !filenamePattern.test(fields[4])) {
    throw new Error("relays.tsv contains an unsafe row");
  }
  ids.push(fields[0]);
}
ids.sort();
if (new Set(ids).size !== ids.length) {
  throw new Error("relays.tsv contains duplicate relay identifiers");
}
process.stdout.write(ids.join(","));
NODE
  )
  local latest_epoch=0
  local row=0
  local relay_id
  local operator_id
  local endpoint_sha256
  local retrieved_at
  local filename
  local retrieved_epoch
  while IFS=$'\t' read -r relay_id operator_id endpoint_sha256 retrieved_at filename; do
    ((row += 1))
    if (( row == 1 )); then
      continue
    fi
    if ! retrieved_epoch=$(date -u -d "$retrieved_at" +%s); then
      echo "FAIL: $phase relays.tsv contains an invalid retrieved_at" >&2
      return 1
    fi
    if (( retrieved_epoch > latest_epoch )); then
      latest_epoch=$retrieved_epoch
    fi
  done <"$manifest"
  write_state "$STATE_DIR/$phase-relay-ids.txt" "$ids"
  write_state \
    "$STATE_DIR/$phase-relays.sha256" \
    "$(sha256sum "$manifest" | cut -d ' ' -f 1)"
  printf -v "${phase^^}_RELAY_LATEST_EPOCH" '%s' "$latest_epoch"
}

operational_generated_paths() {
  local prefix=$1
  local phase
  local index
  local sequence
  local identity
  local relay
  local relay_values
  printf '%s\0' \
    "$prefix/operational/evidence-bundle.json" \
    "$prefix/operational/evidence-bundle.sig"
  for identity in \
    coordinator release-signer auditor-01 auditor-02 \
    witness-01 witness-02 mirror-01 mirror-02; do
    printf '%s\0' \
      "$prefix/operational/disclosures/$identity.json" \
      "$prefix/operational/enrollments/$identity.json" \
      "$prefix/operational/enrollments/$identity.sig"
  done
  for index in $(seq 1 "$PARTICIPANT_COUNT"); do
    printf -v identity 'participant-%02d' "$index"
    printf '%s\0' \
      "$prefix/operational/disclosures/$identity.json" \
      "$prefix/operational/enrollments/$identity.json" \
      "$prefix/operational/enrollments/$identity.sig"
  done
  for phase in phase1 phase2; do
    for index in $(seq 1 "$PARTICIPANT_COUNT"); do
      printf -v sequence '%04d' "$index"
      printf '%s\0' \
        "$prefix/operational/$phase/heads/$sequence/outbound-handoff.json" \
        "$prefix/operational/$phase/heads/$sequence/outbound-handoff.sig" \
        "$prefix/operational/$phase/heads/$sequence/outbound-receipt.json" \
        "$prefix/operational/$phase/heads/$sequence/outbound-receipt.sig" \
        "$prefix/operational/$phase/heads/$sequence/return-handoff.json" \
        "$prefix/operational/$phase/heads/$sequence/return-handoff.sig" \
        "$prefix/operational/$phase/heads/$sequence/return-receipt.json" \
        "$prefix/operational/$phase/heads/$sequence/return-receipt.sig" \
        "$prefix/operational/$phase/heads/$sequence/mirrors/mirror-01.json" \
        "$prefix/operational/$phase/heads/$sequence/mirrors/mirror-01.sig" \
        "$prefix/operational/$phase/heads/$sequence/mirrors/mirror-02.json" \
        "$prefix/operational/$phase/heads/$sequence/mirrors/mirror-02.sig"
    done
    printf '%s\0' \
      "$prefix/operational/$phase/witnesses/witness-01.json" \
      "$prefix/operational/$phase/witnesses/witness-01.sig" \
      "$prefix/operational/$phase/witnesses/witness-02.json" \
      "$prefix/operational/$phase/witnesses/witness-02.sig" \
      "$prefix/operational/$phase/beacon/evidence.json" \
      "$prefix/operational/$phase/beacon/evidence.sig"
    if ! relay_values=$(relay_ids "$phase"); then
      return 1
    fi
    while IFS= read -r relay; do
      printf '%s\0' "$prefix/operational/$phase/beacon/raw/$relay.json"
    done <<<"$relay_values"
  done
}

operational_release_transcript_paths() {
  local phase
  local index
  local sequence
  for phase in phase1 phase2; do
    printf '%s\0' \
      "$RELEASE_DIR/$phase/closure/record.json" \
      "$RELEASE_DIR/$phase/closure/record.sig" \
      "$RELEASE_DIR/$phase/genesis.bin"
    for index in $(seq 1 "$PARTICIPANT_COUNT"); do
      printf -v sequence '%04d' "$index"
      printf '%s\0' \
        "$RELEASE_DIR/$phase/chain-$sequence.json" \
        "$RELEASE_DIR/$phase/chain-$sequence.sig" \
        "$RELEASE_DIR/$phase/contributions/$sequence/contribution.bin" \
        "$RELEASE_DIR/$phase/contributions/$sequence/attestation.json" \
        "$RELEASE_DIR/$phase/contributions/$sequence/attestation.sig" \
        "$RELEASE_DIR/$phase/contributions/$sequence/erasure.json" \
        "$RELEASE_DIR/$phase/contributions/$sequence/erasure.sig" \
        "$RELEASE_DIR/$phase/contributions/$sequence/verification.json"
    done
  done
}

artifact_paths() {
  local label=$1
  local phase
  local sequence
  local index
  local participant_id
  local candidate
  local contribution
  case "$label" in
    init)
      printf '%s\0' \
        "$TRANSCRIPT/ceremony.json" \
        "$TRANSCRIPT/ceremony.sig" \
        "$TRANSCRIPT/coordinator-public-key.hex" \
        "$TRANSCRIPT/ownership-destination.ccs" \
        "$TRANSCRIPT/phase1/genesis.bin" \
        "$TRANSCRIPT/phase1/chain-0000.json" \
        "$TRANSCRIPT/phase1/chain-0000.sig"
      ;;
    phase1-[0-9][0-9][0-9][0-9]-contribute | phase2-[0-9][0-9][0-9][0-9]-contribute)
      phase=${label%%-*}
      sequence=${label#"$phase-"}
      sequence=${sequence%%-*}
      index=$((10#$sequence))
      printf -v participant_id 'participant-%02d' "$index"
      candidate="$CANDIDATES/$phase-$participant_id"
      printf '%s\0' \
        "$candidate/contribution.bin" \
        "$candidate/attestation.json" \
        "$candidate/attestation.sig"
      ;;
    phase1-[0-9][0-9][0-9][0-9]-erasure | phase2-[0-9][0-9][0-9][0-9]-erasure)
      phase=${label%%-*}
      sequence=${label#"$phase-"}
      sequence=${sequence%%-*}
      index=$((10#$sequence))
      printf -v participant_id 'participant-%02d' "$index"
      candidate="$CANDIDATES/$phase-$participant_id"
      printf '%s\0' "$candidate/erasure.json" "$candidate/erasure.sig"
      ;;
    phase1-[0-9][0-9][0-9][0-9]-verify | phase2-[0-9][0-9][0-9][0-9]-verify)
      phase=${label%%-*}
      sequence=${label#"$phase-"}
      sequence=${sequence%%-*}
      contribution="$TRANSCRIPT/$phase/contributions/$sequence"
      printf '%s\0' \
        "$contribution/contribution.bin" \
        "$contribution/attestation.json" \
        "$contribution/attestation.sig" \
        "$contribution/erasure.json" \
        "$contribution/erasure.sig" \
        "$contribution/verification.json" \
        "$TRANSCRIPT/$phase/chain-$sequence.json" \
        "$TRANSCRIPT/$phase/chain-$sequence.sig"
      ;;
    phase1-close | phase2-close)
      phase=${label%-close}
      printf '%s\0' "$TRANSCRIPT/$phase/closure/record.json" "$TRANSCRIPT/$phase/closure/record.sig"
      ;;
    phase1-beacon | phase2-beacon)
      phase=${label%-beacon}
      printf '%s\0' \
        "$TRANSCRIPT/$phase/beacon/raw-response.bin" \
        "$TRANSCRIPT/$phase/beacon/record.json" \
        "$TRANSCRIPT/$phase/beacon/record.sig"
      ;;
    phase1-seal)
      printf '%s\0' \
        "$TRANSCRIPT/phase1/sealed/commons.bin" \
        "$TRANSCRIPT/phase1/sealed/seal.json" \
        "$TRANSCRIPT/phase1/sealed/seal.sig"
      ;;
    phase2-init)
      printf '%s\0' \
        "$TRANSCRIPT/phase2/genesis.bin" \
        "$TRANSCRIPT/phase2/chain-0000.json" \
        "$TRANSCRIPT/phase2/chain-0000.sig"
      ;;
    finalize-prepare)
      printf '%s\0' \
        "$PRELIMINARY_KEYS/ownership-destination.ccs" \
        "$PRELIMINARY_KEYS/ownership.pk" \
        "$PRELIMINARY_KEYS/ownership.vk" \
        "$PRELIMINARY_KEYS/cardano-vk.bin" \
        "$PRELIMINARY_KEYS/cardano-vk.hex" \
        "$PRELIMINARY_KEYS/cardano-vk-format.txt" \
        "$PRELIMINARY_KEYS/preliminary-final-keys.json" \
        "$PRELIMINARY_KEYS/preliminary-final-keys.sig.json" \
        "$PRELIMINARY_KEYS/preliminary-checksums.sha256"
      ;;
    public-evidence-generate)
      printf '%s\0' "$PUBLIC_FINALIZATION_EVIDENCE"
      ;;
    operational-evidence-generate)
      operational_generated_paths "$TRANSCRIPT"
      ;;
    finalize-complete)
      printf '%s\0' \
        "$FINAL_CANDIDATE/candidate.json" \
        "$FINAL_CANDIDATE/candidate.sig.json" \
        "$FINAL_CANDIDATE/verification-report.json" \
        "$FINAL_CANDIDATE/public-finalization-evidence.json" \
        "$FINAL_CANDIDATE/ownership.pk" \
        "$FINAL_CANDIDATE/ownership.vk" \
        "$FINAL_CANDIDATE/ownership-destination.ccs" \
        "$FINAL_CANDIDATE/cardano-vk.bin" \
        "$FINAL_CANDIDATE/cardano-vk.hex" \
        "$FINAL_CANDIDATE/cardano-vk-format.txt" \
        "$FINAL_CANDIDATE/candidate-checksums.sha256" \
        "$FINAL_CANDIDATE/phase2-seal.json" \
        "$FINAL_CANDIDATE/phase2-seal.sig.json"
      ;;
    audit-01 | audit-02)
      printf '%s\0' \
        "$AUDITS/${label/audit-/auditor-}.json" \
        "$AUDITS/${label/audit-/auditor-}.sig"
      ;;
    release-sign)
      printf '%s\0' \
        "$RELEASE_DIR/ownership-destination.ccs" \
        "$RELEASE_DIR/ownership.pk" \
        "$RELEASE_DIR/ownership.vk" \
        "$RELEASE_DIR/cardano-vk.bin" \
        "$RELEASE_DIR/cardano-vk.hex" \
        "$RELEASE_DIR/cardano-vk-format.txt" \
        "$RELEASE_DIR/verification-report.json" \
        "$RELEASE_DIR/public-finalization-evidence.json" \
        "$RELEASE_DIR/phase2-seal.json" \
        "$RELEASE_DIR/phase2-seal.sig.json" \
        "$RELEASE_DIR/candidate.json" \
        "$RELEASE_DIR/candidate.sig.json" \
        "$RELEASE_DIR/candidate-checksums.sha256" \
        "$RELEASE_DIR/setup-transcript.json" \
        "$RELEASE_DIR/manifest.json" \
        "$RELEASE_DIR/manifest.sig" \
        "$RELEASE_DIR/manifest-public-key.hex" \
        "$RELEASE_DIR/audits/0001.json" \
        "$RELEASE_DIR/audits/0001.sig" \
        "$RELEASE_DIR/audits/0002.json" \
        "$RELEASE_DIR/audits/0002.sig" \
        "$RELEASE_DIR/checksums.sha256"
      operational_generated_paths "$RELEASE_DIR"
      operational_release_transcript_paths
      ;;
    final-plutus-evidence | operational-evidence-verify | release-verify)
      ;;
    *)
      echo "FAIL: no artifact allowlist exists for step $label" >&2
      return 1
      ;;
  esac
}

load_expected_artifacts() {
  local label=$1
  local temporary
  temporary=$(mktemp)
  if ! artifact_paths "$label" >"$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  EXPECTED_ARTIFACTS=()
  mapfile -d '' EXPECTED_ARTIFACTS <"$temporary"
  rm -f -- "$temporary"
}

validate_artifact_path() {
  local path=$1
  if [[ "$path" != "$ROOT/"* || ! -f "$path" || -L "$path" ]]; then
    echo "FAIL: generated artifact is absent, outside the root, or unsafe: $path" >&2
    return 1
  fi
}

validate_exact_artifact_tree() {
  local label=$1
  local tree
  case "$label" in
    operational-evidence-generate)
      tree="$TRANSCRIPT/operational"
      ;;
    release-sign)
      tree="$RELEASE_DIR"
      ;;
    *)
      return
      ;;
  esac
  if [[ ! -d "$tree" || -L "$tree" ]]; then
    echo "FAIL: generated artifact tree is absent or unsafe for $label" >&2
    return 1
  fi
  local expected_file
  local actual_file
  expected_file=$(mktemp "$STATE_DIR/steps/.$label.expected.XXXXXXXX")
  actual_file=$(mktemp "$STATE_DIR/steps/.$label.actual.XXXXXXXX")
  local artifact
  for artifact in "${EXPECTED_ARTIFACTS[@]}"; do
    printf '%s\n' "${artifact#"$tree/"}"
  done | LC_ALL=C sort >"$expected_file"
  find "$tree" -type f -printf '%P\n' | LC_ALL=C sort >"$actual_file"
  if ! cmp -s "$expected_file" "$actual_file"; then
    rm -f -- "$expected_file" "$actual_file"
    echo "FAIL: $label generated a file set outside its exact allowlist" >&2
    return 1
  fi
  rm -f -- "$expected_file" "$actual_file"
}

write_artifact_manifest() {
  local label=$1
  local manifest="$STATE_DIR/steps/$label.artifacts.sha256"
  if [[ -e "$manifest" || -L "$manifest" ]]; then
    echo "FAIL: artifact marker already exists for $label" >&2
    return 1
  fi
  local artifact
  local relative
  local digest
  for artifact in "${EXPECTED_ARTIFACTS[@]}"; do
    validate_artifact_path "$artifact"
  done
  validate_exact_artifact_tree "$label"
  local temporary
  temporary=$(mktemp "$STATE_DIR/steps/.$label.artifacts.XXXXXXXX")
  for artifact in "${EXPECTED_ARTIFACTS[@]}"; do
    relative=${artifact#"$ROOT/"}
    if [[ "$relative" == *$'\t'* || "$relative" == *$'\n'* ]]; then
      echo "FAIL: generated artifact path contains a control character" >&2
      rm -f -- "$temporary"
      return 1
    fi
    digest=$(sha256sum "$artifact" | cut -d ' ' -f 1)
    printf '%s\t%s\n' "$digest" "$relative" >>"$temporary"
  done
  chmod 0600 "$temporary"
  sync -f "$temporary"
  if ! ln "$temporary" "$manifest"; then
    rm -f -- "$temporary"
    echo "FAIL: artifact marker publication collided for $label" >&2
    return 1
  fi
  rm -f -- "$temporary"
  sync -f "$STATE_DIR/steps"
}

verify_artifact_manifest() {
  local label=$1
  local manifest="$STATE_DIR/steps/$label.artifacts.sha256"
  if [[ ! -f "$manifest" || -L "$manifest" ]]; then
    echo "FAIL: completed step lacks an artifact hash marker: $label" >&2
    return 1
  fi
  local position=0
  local digest
  local relative
  local expected
  local actual
  while IFS=$'\t' read -r digest relative; do
    if (( position >= ${#EXPECTED_ARTIFACTS[@]} )); then
      echo "FAIL: artifact marker has unexpected entries for $label" >&2
      return 1
    fi
    expected=${EXPECTED_ARTIFACTS[$position]#"$ROOT/"}
    if [[ ! "$digest" =~ ^[0-9a-f]{64}$ || "$relative" != "$expected" ]]; then
      echo "FAIL: artifact marker is malformed or names an unexpected path for $label" >&2
      return 1
    fi
    validate_artifact_path "$ROOT/$relative"
    actual=$(sha256sum "$ROOT/$relative" | cut -d ' ' -f 1)
    if [[ "$actual" != "$digest" ]]; then
      echo "FAIL: completed-step artifact changed for $label: $relative" >&2
      return 1
    fi
    ((position += 1))
  done <"$manifest"
  if (( position != ${#EXPECTED_ARTIFACTS[@]} )); then
    echo "FAIL: artifact marker is incomplete for $label" >&2
    return 1
  fi
  validate_exact_artifact_tree "$label"
}

validate_output_marker() {
  local label=$1
  local marker="$STATE_DIR/steps/$label.complete"
  if [[ ! -f "$marker" || -L "$marker" ]]; then
    echo "FAIL: completed-step output marker is absent or unsafe: $label" >&2
    return 1
  fi
  local line
  local digest
  local output_relative
  local output
  local actual
  line=$(tr -d '\n' <"$marker")
  digest=${line%%  *}
  output_relative=${line#*  }
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ||
    "$output_relative" != "measurements/$label.attempt-"[0-9][0-9][0-9][0-9]".output.json" ]]; then
    echo "FAIL: completed-step output marker is malformed for $label" >&2
    return 1
  fi
  output="$ROOT/$output_relative"
  if [[ ! -f "$output" || -L "$output" ]]; then
    echo "FAIL: completed-step output marker is malformed for $label" >&2
    return 1
  fi
  actual=$(sha256sum "$output" | cut -d ' ' -f 1)
  if [[ "$actual" != "$digest" ]]; then
    echo "FAIL: completed-step output changed for $label" >&2
    return 1
  fi
  validate_success_json "$label" "$output"
}

validate_success_json() {
  local label=$1
  local output=$2
  node - "$label" "$output" "$CEREMONY" <<'NODE'
const fs = require("node:fs");
const label = process.argv[2];
const path = process.argv[3];
const ceremonyPath = process.argv[4];
let value;
try {
  value = JSON.parse(fs.readFileSync(path, "utf8"));
} catch (error) {
  process.stderr.write(`FAIL: invalid JSON result for ${label}: ${error.message}\n`);
  process.exit(1);
}
let expectedCeremonyID = "";
if (fs.existsSync(ceremonyPath)) {
  const ceremony = JSON.parse(fs.readFileSync(ceremonyPath, "utf8"));
  if (!/^sha256:[0-9a-f]{64}$/.test(ceremony.ceremony_id)) {
    process.stderr.write("FAIL: ceremony result trust anchor has an invalid ceremony_id\n");
    process.exit(1);
  }
  expectedCeremonyID = ceremony.ceremony_id;
}
if (label === "final-plutus-evidence") {
  if (value.schema !== "proof-tool-mpc-plutus-finalization-verification-v1" ||
      value.positive_verified !== true ||
      !Array.isArray(value.rejected_negatives) ||
      value.rejected_negatives.length !== 9) {
    process.stderr.write(`FAIL: unsuccessful Plutus evidence result for ${label}\n`);
    process.exit(1);
  }
} else if (label === "public-evidence-generate") {
  if (value.schema !== "proof-tool-mpc-public-evidence-generation-result-v1" ||
      !/^sha256:[0-9a-f]{64}$/.test(value.ceremony_id) ||
      value.ceremony_id !== expectedCeremonyID ||
      typeof value.public_evidence_digest !== "object" ||
      value.public_evidence_digest === null ||
      !/^sha256:[0-9a-f]{64}$/.test(value.public_evidence_digest.sha256) ||
      !/^blake2b256:[0-9a-f]{64}$/.test(value.public_evidence_digest.blake2b256) ||
      !Number.isSafeInteger(value.public_evidence_digest.size) ||
      value.public_evidence_digest.size < 1) {
    process.stderr.write(`FAIL: unsuccessful public-evidence generator result for ${label}\n`);
    process.exit(1);
  }
} else if (label === "operational-evidence-generate") {
  if (value.schema !== "proof-tool-mpc-rehearsal-operational-evidence-result-v1" ||
      value.ok !== true ||
      !/^sha256:[0-9a-f]{64}$/.test(value.ceremony_id) ||
      value.ceremony_id !== expectedCeremonyID ||
      !/^sha256:[0-9a-f]{64}$/.test(value.bundle_sha256) ||
      !Number.isSafeInteger(value.referenced_artifacts) ||
      value.referenced_artifacts < 1) {
    process.stderr.write(`FAIL: unsuccessful operational-evidence generator result for ${label}\n`);
    process.exit(1);
  }
} else if (value.schema !== "proof-tool-mpc-command-result-v1" || value.ok !== true) {
  process.stderr.write(`FAIL: unsuccessful ceremony command result for ${label}\n`);
  process.exit(1);
} else {
  let expected;
  if (label === "init") expected = "init";
  else if (/^phase[12]-[0-9]{4}-contribute$/.test(label)) {
    expected = `${label.slice(0, 6)} contribute`;
  } else if (/^phase[12]-[0-9]{4}-erasure$/.test(label)) {
    expected = `${label.slice(0, 6)} attest-erasure`;
  } else if (/^phase[12]-[0-9]{4}-verify$/.test(label)) {
    expected = `${label.slice(0, 6)} verify`;
  } else if (/^phase[12]-close$/.test(label)) expected = `${label.slice(0, 6)} close`;
  else if (/^phase[12]-beacon$/.test(label)) expected = `${label.slice(0, 6)} beacon`;
  else if (label === "phase1-seal") expected = "phase1 seal";
  else if (label === "phase2-init") expected = "phase2 init";
  else if (label === "finalize-prepare") expected = "finalize prepare";
  else if (label === "finalize-complete") expected = "finalize complete";
  else if (label === "operational-evidence-verify") expected = "ops verify";
  else if (/^audit-[0-9]{2}$/.test(label)) expected = "audit";
  else if (label === "release-sign") expected = "release sign";
  else if (label === "release-verify") expected = "release verify";
  if (!expected || value.command !== expected) {
    process.stderr.write(`FAIL: command result for ${label} names ${JSON.stringify(value.command)}, expected ${JSON.stringify(expected)}\n`);
    process.exit(1);
  }
}
NODE
}

revalidate_completed_steps() {
  local allow_upgrade=$1
  local marker
  local label
  while IFS= read -r -d '' marker; do
    label=$(basename "$marker" .complete)
    load_expected_artifacts "$label"
    validate_output_marker "$label"
    if [[ ! -e "$STATE_DIR/steps/$label.artifacts.sha256" ]]; then
      if [[ "$allow_upgrade" != "yes" ]]; then
        echo "FAIL: completed step $label predates artifact-bound resume markers" >&2
        return 1
      fi
      write_artifact_manifest "$label"
      echo "UPGRADE: bound completed step $label to its generated artifacts"
    fi
    verify_artifact_manifest "$label"
    if step_requires_runner_epoch "$label"; then
      local epoch_path="$STATE_DIR/steps/$label.epoch"
      local epoch_value
      if [[ ! -f "$epoch_path" || -L "$epoch_path" ]]; then
        echo "FAIL: completed step lacks its persisted runner epoch: $label" >&2
        return 1
      fi
      epoch_value=$(tr -d '\n' <"$epoch_path")
      if [[ ! "$epoch_value" =~ ^[0-9]+$ ]]; then
        echo "FAIL: completed step has a malformed runner epoch: $label" >&2
        return 1
      fi
    fi
  done < <(
    find "$STATE_DIR/steps" -maxdepth 1 -type f -name '*.complete' -print0 |
      LC_ALL=C sort -z
  )
}

step_requires_runner_epoch() {
  local label=$1
  [[ "$label" =~ ^phase[12]-[0-9]{4}-(contribute|erasure|verify)$ ||
    "$label" =~ ^finalize-(prepare|complete)$ ||
    "$label" == operational-evidence-generate ||
    "$label" =~ ^audit-[0-9]{2}$ ||
    "$label" == release-sign ]]
}

verify_stage_manifest() {
  local name=$1
  local manifest="$STATE_DIR/$name.steps.sha256"
  if [[ ! -f "$manifest" || -L "$manifest" ]]; then
    echo "FAIL: completed stage lacks a step-set manifest: $name" >&2
    return 1
  fi
  local digest
  local relative
  local previous=
  local actual
  local saw_stage_complete=0
  local step_complete_count=0
  local step_artifact_count=0
  local invariant_count=0
  declare -A completed_steps=()
  declare -A epoch_steps=()
  while IFS=$'\t' read -r digest relative; do
    if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ||
      ( "$relative" != "state/$name.complete" &&
      ! "$relative" =~ ^state/steps/[a-z0-9-]+\.(complete|epoch|artifacts\.sha256)$ &&
      ( "$name" != prepare ||
      ! "$relative" =~ ^(state/(binary\.sha256|created-epoch\.txt|config-generator-mode\.txt|config-generator\.sha256|finalization-evidence-generator-mode\.txt|finalization-evidence-generator\.sha256|operational-evidence-generator-mode\.txt|operational-evidence-generator\.sha256|beacon-lead-seconds\.txt)|control/(participant-count\.txt|config/(participants|policy)\.json)|measurements/prepare-capacity\.txt)$ ) &&
      ( "$name" != phase1 ||
      ! "$relative" =~ ^state/phase1-(round|round-epoch|closed-epoch)\.txt$ ) &&
      ( "$name" != phase1-beacon ||
      ! "$relative" =~ ^state/phase1-(published-at|published-epoch)\.txt$ ) &&
      ( "$name" != phase2 ||
      ! "$relative" =~ ^state/phase2-(round|round-epoch|closed-epoch)\.txt$ ) &&
      ( "$name" != finish ||
      ! "$relative" =~ ^(measurements/(artifact-sizes\.tsv|retained-directory-sizes\.txt|final-filesystem-capacity\.txt)|state/phase[12]-relay-ids\.txt|state/phase[12]-relays\.sha256|state/phase2-(published-at|published-epoch)\.txt)$ ) ) ||
      "$relative" == "$previous" ||
      ( -n "$previous" && "$relative" < "$previous" ) ]]; then
      echo "FAIL: stage step-set manifest is malformed: $name" >&2
      return 1
    fi
    if [[ ! -f "$ROOT/$relative" || -L "$ROOT/$relative" ]]; then
      echo "FAIL: stage $name lost a completed-step marker: $relative" >&2
      return 1
    fi
    actual=$(sha256sum "$ROOT/$relative" | cut -d ' ' -f 1)
    if [[ "$actual" != "$digest" ]]; then
      echo "FAIL: stage $name completed-step marker changed: $relative" >&2
      return 1
    fi
    if [[ "$relative" == "state/$name.complete" ]]; then
      saw_stage_complete=1
    elif [[ "$relative" == state/steps/*.complete ]]; then
      ((step_complete_count += 1))
      completed_steps["${relative#state/steps/}"]=1
    elif [[ "$relative" == state/steps/*.artifacts.sha256 ]]; then
      ((step_artifact_count += 1))
    elif [[ "$relative" == state/steps/*.epoch ]]; then
      local epoch
      epoch=$(tr -d '\n' <"$ROOT/$relative")
      if [[ ! "$epoch" =~ ^[0-9]+$ ]]; then
        echo "FAIL: stage $name contains a malformed runner epoch: $relative" >&2
        return 1
      fi
      epoch_steps["${relative#state/steps/}"]=1
    else
      ((invariant_count += 1))
    fi
    previous=$relative
  done <"$manifest"
  local epoch_name
  for epoch_name in "${!epoch_steps[@]}"; do
    if [[ -z "${completed_steps[${epoch_name%.epoch}.complete]:-}" ]]; then
      echo "FAIL: stage $name binds an epoch without its completed step: $epoch_name" >&2
      return 1
    fi
  done
  local complete_name
  local complete_label
  for complete_name in "${!completed_steps[@]}"; do
    complete_label=${complete_name%.complete}
    if step_requires_runner_epoch "$complete_label" &&
      [[ -z "${epoch_steps[$complete_label.epoch]:-}" ]]; then
      echo "FAIL: stage $name omits the required runner epoch for $complete_label" >&2
      return 1
    fi
  done
  if (( saw_stage_complete != 1 || step_complete_count == 0 ||
    step_complete_count != step_artifact_count )) ||
    { [[ "$name" == prepare ]] && (( invariant_count != 13 )); } ||
    { [[ "$name" == phase1 ]] && (( invariant_count != 3 )); } ||
    { [[ "$name" == phase1-beacon ]] && (( invariant_count != 2 )); } ||
    { [[ "$name" == phase2 ]] && (( invariant_count != 3 )); } ||
    { [[ "$name" == finish ]] && (( invariant_count != 9 )); } ||
    { [[ "$name" != prepare && "$name" != phase1 &&
      "$name" != phase1-beacon && "$name" != phase2 &&
      "$name" != finish ]] && (( invariant_count != 0 )); }; then
    echo "FAIL: stage $name step-set manifest is incomplete or unpaired" >&2
    return 1
  fi
}

write_stage_manifest() {
  local name=$1
  local manifest="$STATE_DIR/$name.steps.sha256"
  if [[ -e "$manifest" || -L "$manifest" ]]; then
    verify_stage_manifest "$name"
    return
  fi
  local temporary
  temporary=$(mktemp "$STATE_DIR/.$name.steps.XXXXXXXX")
  (
    cd "$ROOT"
    {
      printf 'state/%s.complete\n' "$name"
      if [[ "$name" == prepare ]]; then
        printf '%s\n' \
          state/binary.sha256 \
          state/created-epoch.txt \
          state/config-generator-mode.txt \
          state/config-generator.sha256 \
          state/finalization-evidence-generator-mode.txt \
          state/finalization-evidence-generator.sha256 \
          state/operational-evidence-generator-mode.txt \
          state/operational-evidence-generator.sha256 \
          state/beacon-lead-seconds.txt \
          control/participant-count.txt \
          control/config/participants.json \
          control/config/policy.json \
          measurements/prepare-capacity.txt
      elif [[ "$name" == phase1 ]]; then
        printf '%s\n' \
          state/phase1-round.txt \
          state/phase1-round-epoch.txt \
          state/phase1-closed-epoch.txt
      elif [[ "$name" == phase1-beacon ]]; then
        printf '%s\n' \
          state/phase1-published-at.txt \
          state/phase1-published-epoch.txt
      elif [[ "$name" == phase2 ]]; then
        printf '%s\n' \
          state/phase2-round.txt \
          state/phase2-round-epoch.txt \
          state/phase2-closed-epoch.txt
      elif [[ "$name" == finish ]]; then
        printf '%s\n' \
          measurements/artifact-sizes.tsv \
          measurements/retained-directory-sizes.txt \
          measurements/final-filesystem-capacity.txt \
          state/phase1-relay-ids.txt \
          state/phase1-relays.sha256 \
          state/phase2-relay-ids.txt \
          state/phase2-relays.sha256 \
          state/phase2-published-at.txt \
          state/phase2-published-epoch.txt
      fi
      find state/steps -maxdepth 1 -type f \
        \( -name '*.complete' -o -name '*.epoch' -o -name '*.artifacts.sha256' \) \
        -printf '%p\n'
    } |
      LC_ALL=C sort |
      while IFS= read -r relative; do
        printf '%s\t%s\n' "$(sha256sum "$relative" | cut -d ' ' -f 1)" "$relative"
      done
  ) >"$temporary"
  chmod 0600 "$temporary"
  sync -f "$temporary"
  if ! ln "$temporary" "$manifest"; then
    rm -f -- "$temporary"
    echo "FAIL: stage step-set marker publication collided for $name" >&2
    return 1
  fi
  rm -f -- "$temporary"
  sync -f "$STATE_DIR"
  verify_stage_manifest "$name"
}

revalidate_stage_markers() {
  local allow_upgrade=$1
  local marker
  local name
  for name in prepare phase1-contributions phase1 phase1-beacon phase2-contributions phase2 finish; do
    marker="$STATE_DIR/$name.complete"
    if [[ ! -e "$marker" && ! -L "$marker" ]]; then
      continue
    fi
    if [[ ! -f "$marker" || -L "$marker" ]]; then
      echo "FAIL: completed-stage marker is unsafe: $name" >&2
      return 1
    fi
    if [[ ! -e "$STATE_DIR/$name.steps.sha256" ]]; then
      if [[ "$allow_upgrade" != yes ]]; then
        echo "FAIL: completed stage $name predates step-set manifests" >&2
        return 1
      fi
      write_stage_manifest "$name"
      echo "UPGRADE: bound completed stage $name to its command markers"
    fi
    verify_stage_manifest "$name"
  done
}

recover_orphaned_success_marker() {
  local label=$1
  local artifact_marker="$STATE_DIR/steps/$label.artifacts.sha256"
  local step_marker="$STATE_DIR/steps/$label.complete"
  if [[ ! -f "$artifact_marker" || -L "$artifact_marker" || -e "$step_marker" || -L "$step_marker" ]]; then
    return
  fi
  verify_artifact_manifest "$label"
  local outputs=()
  mapfile -d '' outputs < <(
    find "$MEASUREMENTS" -maxdepth 1 -type f \
      -name "$label.attempt-????.output.json" -print0 |
      LC_ALL=C sort -z
  )
  if (( ${#outputs[@]} == 0 )); then
    echo "FAIL: artifact marker without a captured result for $label" >&2
    return 1
  fi
  local output=${outputs[-1]}
  if [[ ! -s "$output" || -L "$output" ]]; then
    echo "FAIL: orphaned successful result is empty or unsafe for $label" >&2
    return 1
  fi
  local output_hash
  output_hash=$(sha256sum "$output" | cut -d ' ' -f 1)
  write_state "$step_marker" "$output_hash  ${output#"$ROOT/"}"
  validate_output_marker "$label"
  echo "RECOVER: published the success marker for already-hashed artifacts from $label"
}

recover_unmarked_success() {
  local label=$1
  local step_marker="$STATE_DIR/steps/$label.complete"
  local artifact_marker="$STATE_DIR/steps/$label.artifacts.sha256"
  if [[ -e "$step_marker" || -L "$step_marker" || -e "$artifact_marker" || -L "$artifact_marker" ]]; then
    return
  fi
  local outputs=()
  mapfile -d '' outputs < <(
    find "$MEASUREMENTS" -maxdepth 1 -type f \
      -name "$label.attempt-????.output.json" -print0 |
      LC_ALL=C sort -z
  )
  if (( ${#outputs[@]} == 0 )); then
    return
  fi
  local output=${outputs[-1]}
  if [[ ! -s "$output" || -L "$output" ]] ||
    ! validate_success_json "$label" "$output" >/dev/null 2>&1; then
    return
  fi
  local artifact
  for artifact in "${EXPECTED_ARTIFACTS[@]}"; do
    validate_artifact_path "$artifact"
  done
  write_artifact_manifest "$label"
  local output_hash
  output_hash=$(sha256sum "$output" | cut -d ' ' -f 1)
  write_state "$step_marker" "$output_hash  ${output#"$ROOT/"}"
  validate_output_marker "$label"
  echo "RECOVER: adopted complete signed artifacts and a successful captured result from $label"
}

run_measured_json_step() {
  local label=$1
  shift
  load_expected_artifacts "$label"
  local step_marker="$STATE_DIR/steps/$label.complete"
  recover_unmarked_success "$label"
  recover_orphaned_success_marker "$label"
  if [[ -f "$step_marker" && ! -L "$step_marker" ]]; then
    validate_output_marker "$label"
    verify_artifact_manifest "$label"
    echo "SKIP: verified completed step $label"
    return
  fi
  local attempt=1
  local attempt_label
  local timing
  local output
  while true; do
    printf -v attempt_label '%s.attempt-%04d' "$label" "$attempt"
    timing="$MEASUREMENTS/$attempt_label.time.txt"
    output="$MEASUREMENTS/$attempt_label.output.json"
    if [[ ! -e "$timing" && ! -L "$timing" && ! -e "$output" && ! -L "$output" ]]; then
      break
    fi
    ((attempt += 1))
  done
  env LC_ALL=C TZ=UTC \
    /usr/bin/time -v -o "$timing" \
    "$@" >"$output"
  sync -f "$timing"
  sync -f "$output"
  validate_success_json "$label" "$output"
  write_artifact_manifest "$label"
  local output_hash
  output_hash=$(sha256sum "$output" | cut -d ' ' -f 1)
  write_state "$step_marker" "$output_hash  ${output#"$ROOT/"}"
}

run_step() {
  local label=$1
  shift
  run_measured_json_step "$label" "$MPC_BIN" --format json "$@"
}

common_trust_flags() {
  COMMON_TRUST_FLAGS=(
    --ceremony "$CEREMONY"
    --ceremony-signature "$CEREMONY_SIGNATURE"
    --coordinator-public-key-file "$COORDINATOR_PUBLIC_KEY"
  )
}

replay_flags() {
  local count=$PARTICIPANT_COUNT
  printf -v final_chain 'chain-%04d' "$count"
  REPLAY_FLAGS=(
    --transcript-root "$TRANSCRIPT"
    --phase1-chain "$TRANSCRIPT/phase1/$final_chain.json"
    --phase1-chain-signature "$TRANSCRIPT/phase1/$final_chain.sig"
    --phase1-close "$TRANSCRIPT/phase1/closure/record.json"
    --phase1-close-signature "$TRANSCRIPT/phase1/closure/record.sig"
    --phase1-beacon "$TRANSCRIPT/phase1/beacon/record.json"
    --phase1-beacon-signature "$TRANSCRIPT/phase1/beacon/record.sig"
    --phase1-seal "$PHASE1_SEAL"
    --phase1-seal-signature "$PHASE1_SEAL_SIGNATURE"
    --phase2-chain "$TRANSCRIPT/phase2/$final_chain.json"
    --phase2-chain-signature "$TRANSCRIPT/phase2/$final_chain.sig"
    --phase2-close "$TRANSCRIPT/phase2/closure/record.json"
    --phase2-close-signature "$TRANSCRIPT/phase2/closure/record.sig"
    --phase2-beacon "$TRANSCRIPT/phase2/beacon/record.json"
    --phase2-beacon-signature "$TRANSCRIPT/phase2/beacon/record.sig"
  )
}

run_close_stage() {
  local phase=$1
  local round=$2
  local phase_title
  local round_epoch_value
  local closed_epoch
  local sequence
  local chain
  local chain_signature
  local phase_flags=()

  case "$phase" in
    phase1)
      phase_title="Phase 1"
      ;;
    phase2)
      phase_title="Phase 2"
      phase_flags=(
        --phase1-seal "$PHASE1_SEAL"
        --phase1-seal-signature "$PHASE1_SEAL_SIGNATURE"
      )
      ;;
    *)
      echo "FAIL: unsupported close phase: $phase" >&2
      return 1
      ;;
  esac

  require_marker "$phase-contributions" || return 1
  if [[ -e "$STATE_DIR/$phase.complete" ]]; then
    echo "FAIL: $phase_title close stage is already complete" >&2
    return 1
  fi
  if [[ "$phase" == phase2 ]]; then
    if [[ ! -f "$STATE_DIR/phase1-round.txt" ||
      -L "$STATE_DIR/phase1-round.txt" ]]; then
      echo "FAIL: Phase 1 beacon round state is absent or unsafe" >&2
      return 1
    fi
    local phase1_round
    phase1_round=$(tr -d '\n' <"$STATE_DIR/phase1-round.txt")
    if [[ "$round" == "$phase1_round" ]]; then
      echo "FAIL: Phase 2 must use a distinct beacon round" >&2
      return 1
    fi
  fi
  common_trust_flags
  round_epoch_value=$(round_epoch "$round") || return 1
  if [[ ! -e "$TRANSCRIPT/$phase/closure" &&
    ! -L "$TRANSCRIPT/$phase/closure" ]] &&
    (( round_epoch_value < $(date +%s) + MIN_BEACON_LEAD_SECONDS + 2 )); then
    echo "FAIL: select a $phase_title beacon round leaving the signed lead plus publication margin after the close replay" >&2
    return 1
  fi
  printf -v sequence '%04d' "$PARTICIPANT_COUNT"
  chain="$TRANSCRIPT/$phase/chain-$sequence.json"
  chain_signature="$TRANSCRIPT/$phase/chain-$sequence.sig"
  run_step "$phase-close" \
    "$phase" close \
    "${COMMON_TRUST_FLAGS[@]}" \
    "${phase_flags[@]}" \
    --transcript-dir "$TRANSCRIPT" \
    --chain "$chain" \
    --chain-signature "$chain_signature" \
    --coordinator-signing-key "$COORDINATOR_PRIVATE_KEY" \
    --beacon-round "$round" ||
    return 1
  if ! closed_epoch=$(
    closure_epoch \
      "$TRANSCRIPT/$phase/closure/record.json" \
      "$round" \
      "$round_epoch_value" \
      "$MIN_BEACON_LEAD_SECONDS"
  ); then
    return 1
  fi
  write_state "$STATE_DIR/$phase-round.txt" "$round" || return 1
  write_state "$STATE_DIR/$phase-round-epoch.txt" "$round_epoch_value" ||
    return 1
  write_state "$STATE_DIR/$phase-closed-epoch.txt" "$closed_epoch" ||
    return 1
  complete_stage "$phase" || return 1
  if [[ "$phase" == phase2 ]]; then
    echo "OK: $phase_title closed on distinct future Quicknet round $round"
  else
    echo "OK: $phase_title closed on future Quicknet round $round"
  fi
  echo "Publish and independently timestamp the closure before waiting for the round."
}

case "$STAGE" in
  self-test-close-recovery)
    if [[ $# -ne 0 ]]; then
      usage
    fi
    SELF_TEST_ROOT=$(mktemp -d)
    cleanup_close_recovery_self_test() {
      rm -rf -- "$SELF_TEST_ROOT"
    }
    trap cleanup_close_recovery_self_test EXIT

    initialize_close_recovery_fixture() {
      local name=$1
      local phase=$2
      local round=$3
      local record_mode=$4
      local round_epoch_value
      local closed_epoch
      ROOT="$SELF_TEST_ROOT/$name"
      STATE_DIR="$ROOT/state"
      MEASUREMENTS="$ROOT/measurements"
      TRANSCRIPT="$ROOT/transcript"
      KEYS="$ROOT/control/keys"
      MPC_BIN=/bin/false
      PARTICIPANT_COUNT=3
      MIN_BEACON_LEAD_SECONDS=60
      CEREMONY="$TRANSCRIPT/ceremony.json"
      CEREMONY_SIGNATURE="$TRANSCRIPT/ceremony.sig"
      COORDINATOR_PUBLIC_KEY="$KEYS/coordinator.ed25519.public.hex"
      COORDINATOR_PRIVATE_KEY="$KEYS/coordinator.ed25519.private.hex"
      PHASE1_SEAL="$TRANSCRIPT/phase1/sealed/seal.json"
      PHASE1_SEAL_SIGNATURE="$TRANSCRIPT/phase1/sealed/seal.sig"
      mkdir -p \
        "$STATE_DIR/steps" \
        "$MEASUREMENTS" \
        "$TRANSCRIPT/$phase/closure" \
        "$KEYS"
      printf 'fixture\n' >"$STATE_DIR/steps/fixture.complete"
      printf 'fixture\n' >"$STATE_DIR/steps/fixture.artifacts.sha256"
      complete_stage "$phase-contributions"
      round_epoch_value=$(round_epoch "$round")
      closed_epoch=$((round_epoch_value - MIN_BEACON_LEAD_SECONDS - 2))
      if [[ "$record_mode" == valid ]]; then
        printf \
          '{"beacon_round":%s,"beacon_not_before":"%s","closed_at":"%s"}\n' \
          "$round" \
          "$(timestamp "$round_epoch_value")" \
          "$(timestamp "$closed_epoch")" \
          >"$TRANSCRIPT/$phase/closure/record.json"
      else
        printf '{malformed closure\n' \
          >"$TRANSCRIPT/$phase/closure/record.json"
      fi
      printf 'fixture signature\n' \
        >"$TRANSCRIPT/$phase/closure/record.sig"
      printf \
        '{"schema":"proof-tool-mpc-command-result-v1","ok":true,"command":"%s close"}\n' \
        "$phase" \
        >"$MEASUREMENTS/$phase-close.attempt-0001.output.json"
    }

    initialize_close_recovery_fixture exact phase1 2 valid
    run_close_stage phase1 2 >"$SELF_TEST_ROOT/exact.out"
    [[ -f "$STATE_DIR/steps/phase1-close.complete" ]]
    [[ -f "$STATE_DIR/steps/phase1-close.artifacts.sha256" ]]
    [[ -f "$STATE_DIR/phase1.complete" ]]
    [[ "$(tr -d '\n' <"$STATE_DIR/phase1-round.txt")" == 2 ]]
    grep -F "RECOVER: adopted complete signed artifacts" \
      "$SELF_TEST_ROOT/exact.out" >/dev/null
    verify_stage_manifest phase1

    initialize_close_recovery_fixture different-round phase1 2 valid
    if run_close_stage phase1 3 \
      >"$SELF_TEST_ROOT/different-round.out" \
      2>"$SELF_TEST_ROOT/different-round.err"; then
      echo "FAIL: close recovery accepted a different requested round" >&2
      exit 1
    fi
    grep -F "published closure does not bind the requested future round and lead" \
      "$SELF_TEST_ROOT/different-round.err" >/dev/null
    [[ ! -e "$STATE_DIR/phase1.complete" ]]
    [[ ! -e "$STATE_DIR/phase1-round.txt" ]]

    initialize_close_recovery_fixture malformed phase1 2 malformed
    if run_close_stage phase1 2 \
      >"$SELF_TEST_ROOT/malformed.out" \
      2>"$SELF_TEST_ROOT/malformed.err"; then
      echo "FAIL: close recovery accepted a malformed closure" >&2
      exit 1
    fi
    grep -F "cannot parse published closure" \
      "$SELF_TEST_ROOT/malformed.err" >/dev/null
    [[ ! -e "$STATE_DIR/phase1.complete" ]]
    [[ ! -e "$STATE_DIR/phase1-round.txt" ]]

    initialize_close_recovery_fixture reused phase2 2 valid
    write_state "$STATE_DIR/phase1-round.txt" 2
    if run_close_stage phase2 2 \
      >"$SELF_TEST_ROOT/reused.out" \
      2>"$SELF_TEST_ROOT/reused.err"; then
      echo "FAIL: Phase 2 close recovery accepted the Phase 1 round" >&2
      exit 1
    fi
    grep -F "Phase 2 must use a distinct beacon round" \
      "$SELF_TEST_ROOT/reused.err" >/dev/null
    [[ ! -e "$STATE_DIR/phase2.complete" ]]
    [[ ! -e "$STATE_DIR/steps/phase2-close.complete" ]]
    echo "OK: rehearsal close-stage recovery self-test passed"
    ;;

  self-test-state)
    if [[ $# -ne 0 ]]; then
      usage
    fi
    SELF_TEST_ROOT=$(mktemp -d)
    cleanup_self_test() {
      rm -rf -- "$SELF_TEST_ROOT"
    }
    trap cleanup_self_test EXIT
    ROOT="$SELF_TEST_ROOT"
    STATE_DIR="$ROOT/state"
    mkdir -p "$STATE_DIR/steps"
    printf '2026-07-24T00:00:00Z\n' >"$STATE_DIR/phase1.complete"
    printf '123\n' >"$STATE_DIR/phase1-round.txt"
    printf '1692803733\n' >"$STATE_DIR/phase1-round-epoch.txt"
    printf '1692803600\n' >"$STATE_DIR/phase1-closed-epoch.txt"
    printf '%064d  measurements/phase1-0001-contribute.attempt-0001.output.json\n' 0 \
      >"$STATE_DIR/steps/phase1-0001-contribute.complete"
    printf '%064d\ttranscript/demo.json\n' 0 \
      >"$STATE_DIR/steps/phase1-0001-contribute.artifacts.sha256"
    printf '1692803500\n' \
      >"$STATE_DIR/steps/phase1-0001-contribute.epoch"
    write_stage_manifest phase1
    verify_stage_manifest phase1
    grep -F $'\tstate/steps/phase1-0001-contribute.epoch' \
      "$STATE_DIR/phase1.steps.sha256" >/dev/null
    grep -F $'\tstate/phase1-round.txt' \
      "$STATE_DIR/phase1.steps.sha256" >/dev/null
    printf '1692803501\n' >"$STATE_DIR/steps/phase1-0001-contribute.epoch"
    if verify_stage_manifest phase1 >/dev/null 2>&1; then
      echo "FAIL: state self-test accepted a changed runner epoch" >&2
      exit 1
    fi
    printf '1692803500\n' >"$STATE_DIR/steps/phase1-0001-contribute.epoch"
    printf '124\n' >"$STATE_DIR/phase1-round.txt"
    if verify_stage_manifest phase1 >/dev/null 2>&1; then
      echo "FAIL: state self-test accepted a changed beacon round" >&2
      exit 1
    fi
    echo "OK: rehearsal stage-state binding self-test passed"
    ;;

  inspect)
    if [[ $# -ne 2 ]]; then
      usage
    fi
    ROOT_ARG=$1
    MPC_ARG=$2
    load_common "$ROOT_ARG" "$MPC_ARG" read-only
    orphan_marker=$(
      find "$STATE_DIR/steps" -maxdepth 1 -type f -name '*.artifacts.sha256' \
        -print |
        while IFS= read -r artifact_marker; do
          label=$(basename "$artifact_marker" .artifacts.sha256)
          if [[ ! -f "$STATE_DIR/steps/$label.complete" ]]; then
            printf '%s\n' "$artifact_marker"
            break
          fi
        done
    )
    if [[ -n "$orphan_marker" ]]; then
      echo "FAIL: read-only inspection found an unpublished success marker: $orphan_marker" >&2
      exit 1
    fi
    unmarked_result=$(
      find "$MEASUREMENTS" -maxdepth 1 -type f \
        -name '*.attempt-????.output.json' -print |
        LC_ALL=C sort |
        while IFS= read -r result_path; do
          result_name=$(basename "$result_path")
          result_label=${result_name%.attempt-????.output.json}
          if [[ ! -f "$STATE_DIR/steps/$result_label.complete" ]] &&
            validate_success_json "$result_label" "$result_path" >/dev/null 2>&1; then
            printf '%s\n' "$result_path"
            break
          fi
        done
    )
    if [[ -n "$unmarked_result" ]]; then
      echo "FAIL: read-only inspection found a successful result awaiting exact recovery: $unmarked_result" >&2
      exit 1
    fi
    echo "OK: all completed command outputs and generated artifacts match their resume markers"
    echo "root=$ROOT participant_count=$PARTICIPANT_COUNT binary_sha256=$(tr -d '\n' <"$STATE_DIR/binary.sha256")"
    for stage_name in prepare phase1-contributions phase1 phase1-beacon phase2-contributions phase2 finish; do
      if [[ -f "$STATE_DIR/$stage_name.complete" && ! -L "$STATE_DIR/$stage_name.complete" ]]; then
        echo "stage=$stage_name status=complete completed_at=$(tr -d '\n' <"$STATE_DIR/$stage_name.complete")"
      else
        echo "stage=$stage_name status=pending"
      fi
    done
    echo "NOTE: inspect is read-only; it does not run the capacity probe or any ceremony command."
    ;;

  prepare)
    if [[ $# -lt 2 || $# -gt 3 ]]; then
      usage
    fi
    ROOT=$1
    MPC_BIN=$2
    PARTICIPANT_COUNT=${3:-3}
    if [[ -e "$ROOT" || -L "$ROOT" ]]; then
      echo "FAIL: prepare requires a fresh root: $ROOT" >&2
      exit 1
    fi
    if [[ ! -f "$MPC_BIN" || -L "$MPC_BIN" || ! -x "$MPC_BIN" ]]; then
      echo "FAIL: MPC binary must be an executable regular file, not a symlink" >&2
      exit 1
    fi
    PARENT=$(dirname "$ROOT")
    CAPACITY_TEMP=$(mktemp "$PARENT/.mpc-k21-capacity.XXXXXXXX")
    if ! "$SCRIPT_DIR/check-mpc-k21-capacity.sh" "$PARENT" >"$CAPACITY_TEMP"; then
      rm -f -- "$CAPACITY_TEMP"
      exit 1
    fi
    sed -n '1,200p' "$CAPACITY_TEMP"
    mkdir -m 0700 "$ROOT"
    ROOT=$(cd "$ROOT" && pwd)
    MPC_BIN=$(cd "$(dirname "$MPC_BIN")" && pwd)/$(basename "$MPC_BIN")
    CONTROL="$ROOT/control"
    TRANSCRIPT="$ROOT/transcript"
    MEASUREMENTS="$ROOT/measurements"
    STATE_DIR="$ROOT/state"
    mkdir -m 0700 "$MEASUREMENTS" "$STATE_DIR"
    mkdir -m 0700 "$STATE_DIR/steps"
    chmod 0600 "$CAPACITY_TEMP"
    mv -T "$CAPACITY_TEMP" "$MEASUREMENTS/prepare-capacity.txt"
    sync -f "$MEASUREMENTS/prepare-capacity.txt"
    REHEARSAL_BEACON_LEAD_SECONDS=${MPC_REHEARSAL_BEACON_LEAD_SECONDS:-$DEFAULT_REHEARSAL_BEACON_LEAD_SECONDS}
    if [[ ! "$REHEARSAL_BEACON_LEAD_SECONDS" =~ ^[0-9]+$ ||
      "$REHEARSAL_BEACON_LEAD_SECONDS" -lt "$HARD_MIN_REHEARSAL_BEACON_LEAD_SECONDS" ]]; then
      echo "FAIL: MPC_REHEARSAL_BEACON_LEAD_SECONDS must be an integer of at least $HARD_MIN_REHEARSAL_BEACON_LEAD_SECONDS" >&2
      exit 1
    fi
    if [[ -n "${MPC_REHEARSAL_CONFIG_BIN:-}" ]]; then
      if [[ ! -f "$MPC_REHEARSAL_CONFIG_BIN" ||
        -L "$MPC_REHEARSAL_CONFIG_BIN" ||
        ! -x "$MPC_REHEARSAL_CONFIG_BIN" ]]; then
        echo "FAIL: MPC_REHEARSAL_CONFIG_BIN must be an executable regular file, not a symlink" >&2
        exit 1
      fi
      "$MPC_REHEARSAL_CONFIG_BIN" \
        --out-dir "$CONTROL" \
        --participants "$PARTICIPANT_COUNT" \
        --beacon-witness-lead-seconds "$REHEARSAL_BEACON_LEAD_SECONDS"
      write_state "$STATE_DIR/config-generator-mode.txt" "prebuilt-binary"
      write_state \
        "$STATE_DIR/config-generator.sha256" \
        "$(sha256sum "$MPC_REHEARSAL_CONFIG_BIN" | cut -d ' ' -f 1)"
    else
      CONFIG_GOCACHE="$ROOT/.mpc-rehearsal-config-go-cache"
      (
        cd "$REPO_ROOT"
        env \
          GOCACHE="$CONFIG_GOCACHE" \
          GOWORK=off \
          GOFLAGS=-mod=vendor \
          go run ./scripts/mpc-rehearsal-config \
          --out-dir "$CONTROL" \
          --participants "$PARTICIPANT_COUNT" \
          --beacon-witness-lead-seconds "$REHEARSAL_BEACON_LEAD_SECONDS"
      )
      rm -rf -- "$CONFIG_GOCACHE"
      CONFIG_SOURCE_HASH=$(
        cd "$REPO_ROOT/scripts/mpc-rehearsal-config"
        find . -maxdepth 1 -type f -print0 |
          LC_ALL=C sort -z |
          xargs -0 sha256sum |
          sha256sum |
          cut -d ' ' -f 1
      )
      write_state "$STATE_DIR/config-generator-mode.txt" "go-run-source"
      write_state "$STATE_DIR/config-generator.sha256" "$CONFIG_SOURCE_HASH"
    fi
    CONFIG="$CONTROL/config"
    KEYS="$CONTROL/keys"
    MPC_HASH=$(sha256sum "$MPC_BIN" | cut -d ' ' -f 1)
    CREATED_EPOCH=$(date +%s)
    write_state "$STATE_DIR/binary.sha256" "$MPC_HASH"
    write_state "$STATE_DIR/created-epoch.txt" "$CREATED_EPOCH"
    write_state "$STATE_DIR/beacon-lead-seconds.txt" "$REHEARSAL_BEACON_LEAD_SECONDS"
    record_finalization_evidence_generator
    record_operational_evidence_generator
    CEREMONY="$TRANSCRIPT/ceremony.json"
    CEREMONY_SIGNATURE="$TRANSCRIPT/ceremony.sig"
    COORDINATOR_PUBLIC_KEY="$KEYS/coordinator.ed25519.public.hex"
    COORDINATOR_PRIVATE_KEY="$KEYS/coordinator.ed25519.private.hex"
    run_step init \
      init \
      --mode rehearsal \
      --created-at "$(timestamp "$CREATED_EPOCH")" \
      --key-version ownership-destination-v2 \
      --participants "$CONFIG/participants.json" \
      --policy "$CONFIG/policy.json" \
      --coordinator-key-id coordinator-key \
      --coordinator-signing-key "$COORDINATOR_PRIVATE_KEY" \
      --out-dir "$TRANSCRIPT"
    complete_stage prepare
    echo "OK: prepared exact K=21 local rehearsal at $ROOT"
    echo "WARNING: same-host identities are not independent ceremony participants."
    ;;

  phase1-contribute)
    if [[ $# -ne 2 ]]; then
      usage
    fi
    ROOT_ARG=$1
    MPC_ARG=$2
    load_common "$ROOT_ARG" "$MPC_ARG"
    require_marker prepare
    if [[ -e "$STATE_DIR/phase1-contributions.complete" ]]; then
      echo "FAIL: Phase 1 contribution stage is already complete" >&2
      exit 1
    fi
    common_trust_flags
    CREATED_EPOCH=$(tr -d '\n' <"$STATE_DIR/created-epoch.txt")
    LAST_EPOCH=$CREATED_EPOCH
    if [[ ! -e "$CANDIDATES" && ! -L "$CANDIDATES" ]]; then
      mkdir -m 0700 "$CANDIDATES"
    elif [[ ! -d "$CANDIDATES" || -L "$CANDIDATES" ]]; then
      echo "FAIL: candidate root is unsafe" >&2
      exit 1
    fi
    CHAIN="$TRANSCRIPT/phase1/chain-0000.json"
    CHAIN_SIGNATURE="$TRANSCRIPT/phase1/chain-0000.sig"
    for index in $(seq 1 "$PARTICIPANT_COUNT"); do
      printf -v participant_id 'participant-%02d' "$index"
      printf -v sequence '%04d' "$index"
      candidate="$CANDIDATES/phase1-$participant_id"
      contributed_epoch=$(step_epoch "phase1-$sequence-contribute" "$((LAST_EPOCH + 10))")
      run_step "phase1-$sequence-contribute" \
        phase1 contribute \
        "${COMMON_TRUST_FLAGS[@]}" \
        --transcript-dir "$TRANSCRIPT" \
        --chain "$CHAIN" \
        --chain-signature "$CHAIN_SIGNATURE" \
        --participant-id "$participant_id" \
        --participant-signing-key "$KEYS/$participant_id.ed25519.private.hex" \
        --environment "$CONFIG/environment.json" \
        --contributed-at "$(timestamp "$contributed_epoch")" \
        --out-dir "$candidate"
      LAST_EPOCH=$contributed_epoch
      destroyed_epoch=$(step_epoch "phase1-$sequence-erasure" "$((LAST_EPOCH + 10))")
      run_step "phase1-$sequence-erasure" \
        phase1 attest-erasure \
        "${COMMON_TRUST_FLAGS[@]}" \
        --participant-id "$participant_id" \
        --participant-signing-key "$KEYS/$participant_id.ed25519.private.hex" \
        --candidate-dir "$candidate" \
        --destroyed-at "$(timestamp "$destroyed_epoch")"
      LAST_EPOCH=$destroyed_epoch
      accepted_epoch=$(step_epoch "phase1-$sequence-verify" "$((LAST_EPOCH + 10))")
      run_step "phase1-$sequence-verify" \
        phase1 verify \
        "${COMMON_TRUST_FLAGS[@]}" \
        --transcript-dir "$TRANSCRIPT" \
        --chain "$CHAIN" \
        --chain-signature "$CHAIN_SIGNATURE" \
        --candidate-dir "$candidate" \
        --coordinator-signing-key "$COORDINATOR_PRIVATE_KEY" \
        --accepted-at "$(timestamp "$accepted_epoch")"
      LAST_EPOCH=$accepted_epoch
      CHAIN="$TRANSCRIPT/phase1/chain-$sequence.json"
      CHAIN_SIGNATURE="$TRANSCRIPT/phase1/chain-$sequence.sig"
    done
    complete_stage phase1-contributions
    echo "OK: completed all Phase 1 contributions; select the future beacon round now."
    ;;

  phase1-close)
    if [[ $# -ne 3 ]]; then
      usage
    fi
    ROOT_ARG=$1
    MPC_ARG=$2
    ROUND=$3
    load_common "$ROOT_ARG" "$MPC_ARG"
    run_close_stage phase1 "$ROUND"
    ;;

  phase1-beacon)
    if [[ $# -ne 4 ]]; then
      usage
    fi
    ROOT_ARG=$1
    MPC_ARG=$2
    RAW_RESPONSE=$3
    PUBLISHED_AT=$4
    load_common "$ROOT_ARG" "$MPC_ARG"
    require_marker phase1
    if [[ -e "$STATE_DIR/phase1-beacon.complete" ]]; then
      echo "FAIL: Phase 1 beacon stage is already complete" >&2
      exit 1
    fi
    if [[ ! -f "$RAW_RESPONSE" || -L "$RAW_RESPONSE" ]]; then
      echo "FAIL: raw response must be a regular file, not a symlink" >&2
      exit 1
    fi
    PUBLISHED_EPOCH=$(date -u -d "$PUBLISHED_AT" +%s)
    if (( PUBLISHED_EPOCH > $(date +%s) + 5 )); then
      echo "FAIL: Phase 1 published-at is more than five seconds in the future" >&2
      exit 1
    fi
    ROUND_EPOCH=$(tr -d '\n' <"$STATE_DIR/phase1-round-epoch.txt")
    if (( PUBLISHED_EPOCH < ROUND_EPOCH )); then
      echo "FAIL: Phase 1 publication time predates the committed round" >&2
      exit 1
    fi
    write_state "$STATE_DIR/phase1-published-at.txt" "$PUBLISHED_AT"
    common_trust_flags
    run_step phase1-beacon \
      phase1 beacon \
      "${COMMON_TRUST_FLAGS[@]}" \
      --closure "$TRANSCRIPT/phase1/closure/record.json" \
      --closure-signature "$TRANSCRIPT/phase1/closure/record.sig" \
      --raw-response "$RAW_RESPONSE" \
      --published-at "$PUBLISHED_AT" \
      --coordinator-signing-key "$COORDINATOR_PRIVATE_KEY" \
      --transcript-dir "$TRANSCRIPT"
    run_step phase1-seal \
      phase1 seal \
      "${COMMON_TRUST_FLAGS[@]}" \
      --transcript-dir "$TRANSCRIPT" \
      --closure "$TRANSCRIPT/phase1/closure/record.json" \
      --closure-signature "$TRANSCRIPT/phase1/closure/record.sig" \
      --beacon "$TRANSCRIPT/phase1/beacon/record.json" \
      --beacon-signature "$TRANSCRIPT/phase1/beacon/record.sig" \
      --coordinator-signing-key "$COORDINATOR_PRIVATE_KEY" \
      --out-dir "$TRANSCRIPT/phase1/sealed"
    run_step phase2-init \
      phase2 init \
      "${COMMON_TRUST_FLAGS[@]}" \
      --phase1-transcript-dir "$TRANSCRIPT" \
      --phase1-seal "$PHASE1_SEAL" \
      --phase1-seal-signature "$PHASE1_SEAL_SIGNATURE" \
      --coordinator-signing-key "$COORDINATOR_PRIVATE_KEY" \
      --out-dir "$TRANSCRIPT/phase2"
    write_state "$STATE_DIR/phase1-published-epoch.txt" "$PUBLISHED_EPOCH"
    complete_stage phase1-beacon
    echo "OK: verified Phase 1 beacon, sealed Phase 1, and initialized Phase 2"
    ;;

  phase2-contribute)
    if [[ $# -ne 2 ]]; then
      usage
    fi
    ROOT_ARG=$1
    MPC_ARG=$2
    load_common "$ROOT_ARG" "$MPC_ARG"
    require_marker phase1-beacon
    if [[ -e "$STATE_DIR/phase2-contributions.complete" ]]; then
      echo "FAIL: Phase 2 contribution stage is already complete" >&2
      exit 1
    fi
    common_trust_flags
    PUBLISHED_EPOCH=$(tr -d '\n' <"$STATE_DIR/phase1-published-epoch.txt")
    LAST_EPOCH=$PUBLISHED_EPOCH
    CHAIN="$TRANSCRIPT/phase2/chain-0000.json"
    CHAIN_SIGNATURE="$TRANSCRIPT/phase2/chain-0000.sig"
    for index in $(seq 1 "$PARTICIPANT_COUNT"); do
      printf -v participant_id 'participant-%02d' "$index"
      printf -v sequence '%04d' "$index"
      candidate="$CANDIDATES/phase2-$participant_id"
      contributed_epoch=$(step_epoch "phase2-$sequence-contribute" "$((LAST_EPOCH + 10))")
      run_step "phase2-$sequence-contribute" \
        phase2 contribute \
        "${COMMON_TRUST_FLAGS[@]}" \
        --phase1-seal "$PHASE1_SEAL" \
        --phase1-seal-signature "$PHASE1_SEAL_SIGNATURE" \
        --transcript-dir "$TRANSCRIPT" \
        --chain "$CHAIN" \
        --chain-signature "$CHAIN_SIGNATURE" \
        --participant-id "$participant_id" \
        --participant-signing-key "$KEYS/$participant_id.ed25519.private.hex" \
        --environment "$CONFIG/environment.json" \
        --contributed-at "$(timestamp "$contributed_epoch")" \
        --out-dir "$candidate"
      LAST_EPOCH=$contributed_epoch
      destroyed_epoch=$(step_epoch "phase2-$sequence-erasure" "$((LAST_EPOCH + 10))")
      run_step "phase2-$sequence-erasure" \
        phase2 attest-erasure \
        "${COMMON_TRUST_FLAGS[@]}" \
        --participant-id "$participant_id" \
        --participant-signing-key "$KEYS/$participant_id.ed25519.private.hex" \
        --candidate-dir "$candidate" \
        --destroyed-at "$(timestamp "$destroyed_epoch")"
      LAST_EPOCH=$destroyed_epoch
      accepted_epoch=$(step_epoch "phase2-$sequence-verify" "$((LAST_EPOCH + 10))")
      run_step "phase2-$sequence-verify" \
        phase2 verify \
        "${COMMON_TRUST_FLAGS[@]}" \
        --phase1-seal "$PHASE1_SEAL" \
        --phase1-seal-signature "$PHASE1_SEAL_SIGNATURE" \
        --transcript-dir "$TRANSCRIPT" \
        --chain "$CHAIN" \
        --chain-signature "$CHAIN_SIGNATURE" \
        --candidate-dir "$candidate" \
        --coordinator-signing-key "$COORDINATOR_PRIVATE_KEY" \
        --accepted-at "$(timestamp "$accepted_epoch")"
      LAST_EPOCH=$accepted_epoch
      CHAIN="$TRANSCRIPT/phase2/chain-$sequence.json"
      CHAIN_SIGNATURE="$TRANSCRIPT/phase2/chain-$sequence.sig"
    done
    complete_stage phase2-contributions
    echo "OK: completed all Phase 2 contributions; select the distinct future beacon round now."
    ;;

  phase2-close)
    if [[ $# -ne 3 ]]; then
      usage
    fi
    ROOT_ARG=$1
    MPC_ARG=$2
    ROUND=$3
    load_common "$ROOT_ARG" "$MPC_ARG"
    run_close_stage phase2 "$ROUND"
    ;;

  finish)
    if [[ $# -ne 6 ]]; then
      usage
    fi
    ROOT_ARG=$1
    MPC_ARG=$2
    RAW_RESPONSE=$3
    PUBLISHED_AT=$4
    PHASE1_RELAY_DIR=$5
    PHASE2_RELAY_DIR=$6
    load_common "$ROOT_ARG" "$MPC_ARG"
    require_marker phase2
    if [[ -e "$STATE_DIR/finish.complete" ]]; then
      echo "FAIL: finish stage is already complete" >&2
      exit 1
    fi
    if [[ ! -f "$RAW_RESPONSE" || -L "$RAW_RESPONSE" ]]; then
      echo "FAIL: raw response must be a regular file, not a symlink" >&2
      exit 1
    fi
    record_relay_inputs phase1 "$PHASE1_RELAY_DIR"
    record_relay_inputs phase2 "$PHASE2_RELAY_DIR"
    PHASE1_RELAY_DIR=$(cd "$PHASE1_RELAY_DIR" && pwd)
    PHASE2_RELAY_DIR=$(cd "$PHASE2_RELAY_DIR" && pwd)
    PUBLISHED_EPOCH=$(date -u -d "$PUBLISHED_AT" +%s)
    if (( PUBLISHED_EPOCH > $(date +%s) + 5 )); then
      echo "FAIL: Phase 2 published-at is more than five seconds in the future" >&2
      exit 1
    fi
    ROUND_EPOCH=$(tr -d '\n' <"$STATE_DIR/phase2-round-epoch.txt")
    if (( PUBLISHED_EPOCH < ROUND_EPOCH )); then
      echo "FAIL: Phase 2 publication time predates the committed round" >&2
      exit 1
    fi
    write_state "$STATE_DIR/phase2-published-at.txt" "$PUBLISHED_AT"
    common_trust_flags
    replay_flags
    run_step phase2-beacon \
      phase2 beacon \
      "${COMMON_TRUST_FLAGS[@]}" \
      --closure "$TRANSCRIPT/phase2/closure/record.json" \
      --closure-signature "$TRANSCRIPT/phase2/closure/record.sig" \
      --raw-response "$RAW_RESPONSE" \
      --published-at "$PUBLISHED_AT" \
      --coordinator-signing-key "$COORDINATOR_PRIVATE_KEY" \
      --transcript-dir "$TRANSCRIPT"
    write_state "$STATE_DIR/phase2-published-epoch.txt" "$PUBLISHED_EPOCH"
    PREPARED_EPOCH=$(step_epoch finalize-prepare "$((PUBLISHED_EPOCH + 1))")
    run_step finalize-prepare \
      finalize prepare \
      "${COMMON_TRUST_FLAGS[@]}" \
      "${REPLAY_FLAGS[@]}" \
      --coordinator-signing-key "$COORDINATOR_PRIVATE_KEY" \
      --prepared-at "$(timestamp "$PREPARED_EPOCH")" \
      --out-dir "$PRELIMINARY_KEYS"
    CEREMONY_ID=$(
      node - "$CEREMONY" <<'NODE'
const fs = require("node:fs");
const definition = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (typeof definition.ceremony_id !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(definition.ceremony_id)) {
  throw new Error("ceremony.json has an invalid ceremony_id");
}
process.stdout.write(definition.ceremony_id);
NODE
    )
    resolve_finalization_evidence_generator
    run_measured_json_step public-evidence-generate \
      "${FINALIZATION_EVIDENCE_COMMAND[@]}" \
      --keys-dir "$PRELIMINARY_KEYS" \
      --ceremony-id "$CEREMONY_ID" \
      --coordinator-public-key-file "$COORDINATOR_PUBLIC_KEY" \
      --out "$PUBLIC_FINALIZATION_EVIDENCE"
    if [[ -n "$FINALIZATION_GOCACHE" && -d "$FINALIZATION_GOCACHE" ]]; then
      rm -rf -- "$FINALIZATION_GOCACHE"
    fi
    FINALIZED_EPOCH=$(step_epoch finalize-complete "$((PREPARED_EPOCH + 1))")
    run_step finalize-complete \
      finalize complete \
      "${COMMON_TRUST_FLAGS[@]}" \
      "${REPLAY_FLAGS[@]}" \
      --coordinator-signing-key "$COORDINATOR_PRIVATE_KEY" \
      --public-evidence "$PUBLIC_FINALIZATION_EVIDENCE" \
      --finalized-at "$(timestamp "$FINALIZED_EPOCH")" \
      --out-dir "$FINAL_CANDIDATE"
    PLUTUS_EVIDENCE_ARGS=("$FINAL_CANDIDATE")
    if [[ -n "${MPC_PLUTUS_VERIFIER_BIN:-}" ]]; then
      if [[ ! -f "$MPC_PLUTUS_VERIFIER_BIN" ||
        -L "$MPC_PLUTUS_VERIFIER_BIN" ||
        ! -x "$MPC_PLUTUS_VERIFIER_BIN" ]]; then
        echo "FAIL: MPC_PLUTUS_VERIFIER_BIN must be an executable regular file, not a symlink" >&2
        exit 1
      fi
      PLUTUS_EVIDENCE_ARGS+=("$MPC_PLUTUS_VERIFIER_BIN")
    fi
    run_measured_json_step final-plutus-evidence \
      "$SCRIPT_DIR/verify-mpc-final-plutus-evidence.sh" \
      "${PLUTUS_EVIDENCE_ARGS[@]}"
    LATEST_RELAY_EPOCH=$(max_epoch "$PHASE1_RELAY_LATEST_EPOCH" "$PHASE2_RELAY_LATEST_EPOCH")
    OPERATIONAL_EVIDENCE_MINIMUM=$(max_epoch \
      "$((FINALIZED_EPOCH + 1))" \
      "$((LATEST_RELAY_EPOCH + 2))")
    OPERATIONAL_EVIDENCE_EPOCH=$(
      step_epoch operational-evidence-generate "$OPERATIONAL_EVIDENCE_MINIMUM"
    )
    run_measured_json_step operational-evidence-generate \
      "${OPERATIONAL_EVIDENCE_COMMAND[@]}" \
      --transcript-root "$TRANSCRIPT" \
      --keys-dir "$KEYS" \
      --coordinator-public-key-file "$COORDINATOR_PUBLIC_KEY" \
      --phase1-relays "$PHASE1_RELAY_DIR" \
      --phase2-relays "$PHASE2_RELAY_DIR" \
      --assembled-at "$(timestamp "$OPERATIONAL_EVIDENCE_EPOCH")" \
      --out-dir "$TRANSCRIPT/operational"
    run_step operational-evidence-verify \
      ops verify \
      --record-type evidence-bundle \
      --record "$TRANSCRIPT/operational/evidence-bundle.json" \
      --signature "$TRANSCRIPT/operational/evidence-bundle.sig" \
      "${COMMON_TRUST_FLAGS[@]}" \
      --signer-public-key-file "$COORDINATOR_PUBLIC_KEY" \
      --evidence-root "$TRANSCRIPT"
    if [[ ! -e "$AUDITS" && ! -L "$AUDITS" ]]; then
      mkdir -m 0700 "$AUDITS"
    elif [[ ! -d "$AUDITS" || -L "$AUDITS" ]]; then
      echo "FAIL: audit root is unsafe" >&2
      exit 1
    fi
    AUDIT1_EPOCH=$(step_epoch audit-01 "$((OPERATIONAL_EVIDENCE_EPOCH + 1))")
    run_step audit-01 \
      audit \
      "${COMMON_TRUST_FLAGS[@]}" \
      "${REPLAY_FLAGS[@]}" \
      --candidate-bundle "$FINAL_CANDIDATE" \
      --auditor-id auditor-01 \
      --auditor-signing-key "$KEYS/auditor-01.ed25519.private.hex" \
      --audited-at "$(timestamp "$AUDIT1_EPOCH")" \
      --out "$AUDITS/auditor-01.json" \
      --audit-signature "$AUDITS/auditor-01.sig"
    AUDIT2_EPOCH=$(step_epoch audit-02 "$((AUDIT1_EPOCH + 1))")
    run_step audit-02 \
      audit \
      "${COMMON_TRUST_FLAGS[@]}" \
      "${REPLAY_FLAGS[@]}" \
      --candidate-bundle "$FINAL_CANDIDATE" \
      --auditor-id auditor-02 \
      --auditor-signing-key "$KEYS/auditor-02.ed25519.private.hex" \
      --audited-at "$(timestamp "$AUDIT2_EPOCH")" \
      --out "$AUDITS/auditor-02.json" \
      --audit-signature "$AUDITS/auditor-02.sig"
    RELEASED_EPOCH=$(step_epoch release-sign "$((AUDIT2_EPOCH + 1))")
    run_step release-sign \
      release sign \
      "${COMMON_TRUST_FLAGS[@]}" \
      --candidate-bundle "$FINAL_CANDIDATE" \
      --audit-report "$AUDITS/auditor-01.json" \
      --audit-signature "$AUDITS/auditor-01.sig" \
      --audit-report "$AUDITS/auditor-02.json" \
      --audit-signature "$AUDITS/auditor-02.sig" \
      --operational-evidence-root "$TRANSCRIPT" \
      --operational-bundle "$TRANSCRIPT/operational/evidence-bundle.json" \
      --operational-bundle-signature "$TRANSCRIPT/operational/evidence-bundle.sig" \
      --release-signing-key "$KEYS/release-signer.ed25519.private.hex" \
      --signature-key-id release-signer-key \
      --released-at "$(timestamp "$RELEASED_EPOCH")" \
      --release-dir "$RELEASE_DIR"
    run_step release-verify \
      release verify \
      "${COMMON_TRUST_FLAGS[@]}" \
      --keys-dir "$RELEASE_DIR" \
      --manifest-public-key-file "$KEYS/release-signer.ed25519.public.hex" \
      --signature-key-id release-signer-key
    (
      cd "$ROOT"
      find . -type f \
        ! -path './control/keys/*.private.hex' \
        -printf '%s\t%P\n' |
        LC_ALL=C sort -k2,2 >"$MEASUREMENTS/artifact-sizes.tsv"
    )
    du -sb \
      "$CONTROL" \
      "$TRANSCRIPT" \
      "$CANDIDATES" \
      "$PRELIMINARY_KEYS" \
      "$FINAL_CANDIDATE" \
      "$AUDITS" \
      "$RELEASE_DIR" \
      >"$MEASUREMENTS/retained-directory-sizes.txt"
    df -B1 "$ROOT" >"$MEASUREMENTS/final-filesystem-capacity.txt"
    sync -f "$MEASUREMENTS/artifact-sizes.tsv"
    sync -f "$MEASUREMENTS/retained-directory-sizes.txt"
    sync -f "$MEASUREMENTS/final-filesystem-capacity.txt"
    complete_stage finish
    echo "OK: exact K=21 local rehearsal finalized, audited twice, signed, and verified"
    echo "WARNING: this same-host run does not satisfy independent participant, auditor, or witness gates."
    ;;

  *)
    usage
    ;;
esac
