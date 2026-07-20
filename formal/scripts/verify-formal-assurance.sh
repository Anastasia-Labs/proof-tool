#!/usr/bin/env bash
set -uo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
formal_dir="${repo_dir}/formal"
catalog="${formal_dir}/assurance/theorem-catalog.json"
failures=0
require_complete=0

case "${1:-}" in
  "") ;;
  --require-complete) require_complete=1 ;;
  --help|-h)
    printf 'usage: %s [--require-complete]\n' "$0"
    printf '  default: verify reproducibility and honest catalog classification\n'
    printf '  --require-complete: additionally reject every Pending obligation\n'
    exit 0
    ;;
  *)
    printf 'unknown argument: %s\n' "$1" >&2
    printf 'usage: %s [--require-complete]\n' "$0" >&2
    exit 2
    ;;
esac

if [[ "$#" -gt 1 ]]; then
  printf 'usage: %s [--require-complete]\n' "$0" >&2
  exit 2
fi

pass() {
  printf 'PASS  %s\n' "$1"
}

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}

cd "${repo_dir}" || exit 1

cabal_source_config="$(cabal path 2>/dev/null | sed -n 's/^config-file: //p' | head -n 1)"
cabal_gate_config="/tmp/proof-tool-formal-cabal.config"
if [[ -n "${cabal_source_config}" && -f "${cabal_source_config}" ]]; then
  sed 's|^build-summary:.*|build-summary: /tmp/proof-tool-formal-cabal-summary.log|' \
    "${cabal_source_config}" >"${cabal_gate_config}"
  export CABAL_CONFIG="${cabal_gate_config}"
fi

branch="$(git branch --show-current 2>/dev/null || true)"
if [[ "${branch}" == "formal-methods" ]]; then
  pass "branch is formal-methods"
else
  fail "branch is ${branch:-unknown}, expected formal-methods"
fi

contract_baseline="$(git log -1 --format=%H -- \
  contracts/ownership-verifier/src \
  contracts/ownership-verifier/export \
  contracts/ownership-verifier/ownership-verifier.cabal)"
if jq -e --arg baseline "${contract_baseline}" '
    .workspace.contract_baseline_commit == $baseline
  ' "${formal_dir}/assurance/provenance-lock.json" >/dev/null; then
  pass "provenance lock names the current contract baseline commit"
else
  fail "provenance lock contract baseline is stale"
fi

if jq empty \
    "${formal_dir}"/assurance/*.json \
    "${formal_dir}"/assurance/counterexamples/*.json >/dev/null; then
  pass "assurance JSON is syntactically valid"
else
  fail "assurance JSON is invalid"
fi

lean_version="$(cd "${formal_dir}" && lake env lean --version 2>/dev/null || true)"
z3_version="$(z3 --version 2>/dev/null || true)"
if [[ "${lean_version}" == *"version 4.24.0"* ]] &&
   [[ "${z3_version}" == "Z3 version 4.15.2 - 64 bit" ]] &&
   jq -e '
      (.packages | map(select(.name == "Blaster" and .rev == "402f6d22c1fc42e6e26255faac77e15b2450e4ab")) | length) == 1 and
      (.packages | map(select(.name == "PlutusCore" and .rev == "4ef48606303c45225d3ed2e2a87fc50280a763b7")) | length) == 1 and
      (.packages | map(select(.name == "CardanoLedgerApi" and .rev == "577e3eb03b5be09354cfdb1c0d0c12e9e16541a0")) | length) == 1
    ' "${formal_dir}/lake-manifest.json" >/dev/null; then
  pass "Lean, Z3, and formal dependencies are pinned"
else
  fail "formal toolchain differs from the provenance lock"
fi

artifact_lock_ok=0
if node "${formal_dir}/scripts/lock-active-artifacts.mjs" \
    >/tmp/proof-tool-formal-artifact-lock.json; then
  if jq -e '.all_identities_match == true' \
      "${formal_dir}/assurance/artifact-regeneration.json" >/dev/null; then
    pass "active exporter bytes and Cardano identities regenerate exactly"
    artifact_lock_ok=1
  else
    fail "artifact regeneration report contains an identity mismatch"
  fi
else
  fail "active artifact regeneration failed"
fi

if node "${formal_dir}/scripts/verify-current-candidates.mjs" \
    >/tmp/proof-tool-formal-current-candidates.json; then
  pass "coherent current-source GlobalV2/Base candidate pair regenerates"
else
  fail "current-source GlobalV2/Base candidate regeneration failed"
fi

if [[ "${artifact_lock_ok}" -eq 1 ]]; then
  if "${formal_dir}/scripts/generate-context-goldens.sh" \
      >/tmp/proof-tool-formal-golden-generation.log 2>&1; then
    pass "V3 contexts and production helper artifacts regenerate"
  else
    fail "V3 context/helper regeneration failed"
  fi
else
  fail "V3 context/helper regeneration skipped to preserve deployed evidence after active artifact lock failure"
fi

helper_hash_failure=0
while IFS=$'\t' read -r helper_file expected_hash; do
  actual_hash="$(sha256sum "${repo_dir}/${helper_file}" | cut -d' ' -f1)"
  if [[ "${actual_hash}" != "${expected_hash}" ]]; then
    printf '      %s: got %s, expected %s\n' \
      "${helper_file}" "${actual_hash}" "${expected_hash}" >&2
    helper_hash_failure=1
  fi
done < <(jq -r '.helpers[] | [.file, .hex_file_sha256] | @tsv' \
  "${formal_dir}/assurance/helper-artifacts.json")
if [[ "${helper_hash_failure}" -eq 0 ]]; then
  pass "production helper artifacts match the locked helper catalog"
else
  fail "one or more production helper artifacts changed"
fi

import_hash_failure=0
while IFS=$'\t' read -r artifact_file expected_hash; do
  actual_hash="$(xxd -r -p "${repo_dir}/${artifact_file}" | sha256sum | cut -d' ' -f1)"
  if [[ "${actual_hash}" != "${expected_hash}" ]]; then
    printf '      %s: got %s, expected %s\n' \
      "${artifact_file}" "${actual_hash}" "${expected_hash}" >&2
    import_hash_failure=1
  fi
done < <(jq -r '.artifacts[] | [.file, .decoded_cbor_sha256] | @tsv' \
  "${formal_dir}/assurance/import-fidelity.json")
if [[ "${import_hash_failure}" -eq 0 ]]; then
  pass "Lean import files are the locked exporter bytes"
else
  fail "one or more Lean import files changed"
fi

if rg -n \
    '(^|[^[:alnum:]_])(sorry|admit)([^[:alnum:]_]|$)|^[[:space:]]*axiom[[:space:]]' \
    "${formal_dir}/ProofToolFormal" "${formal_dir}/ProofToolFormal.lean" \
    -g '*.lean' >/tmp/proof-tool-formal-authored-admissions.log; then
  fail "project-authored formal modules contain sorry, admit, or axiom"
else
  pass "project-authored formal modules are admission-free"
fi

if (cd "${formal_dir}" && lake build ProofToolFormal) \
    >/tmp/proof-tool-formal-lake-build.log 2>&1; then
  if rg -q "Build completed successfully" /tmp/proof-tool-formal-lake-build.log &&
     rg -q "blasterProven" /tmp/proof-tool-formal-lake-build.log &&
     rg -q "declaration uses 'sorry'" /tmp/proof-tool-formal-lake-build.log; then
    pass "Lean theorem suite builds and emits the disclosed trust boundary"
  else
    fail "Lean build omitted expected build or trust-boundary diagnostics"
  fi
else
  fail "Lean theorem suite failed; see /tmp/proof-tool-formal-lake-build.log"
fi

if jq -e --slurpfile goldens "${formal_dir}/assurance/context-goldens.json" '
    .all_replays_agree == true and
    (.replays | length >= 19) and
    (.replays | length) == ($goldens[0].fixtures | length) and
    all(.replays[];
      . as $replay |
        any($goldens[0].fixtures[];
          .name == $replay.fixture and
          (if $replay.haskell_compiled_decision == "success"
           then .haskell_compiled_decision == true
           else .haskell_compiled_decision == false
           end)
        )
    )
  ' "${formal_dir}/assurance/cross-evaluator-decisions.json" >/dev/null; then
  pass "all exact Haskell/Lean replay decisions agree"
else
  fail "cross-evaluator decisions are incomplete or disagree"
fi

catalog_pending_ids="$(jq -r '[.entries[] | select(.status == "Pending") | .catalog_id] | join(", ")' "${catalog}")"
catalog_pending_count="$(jq -r '[.entries[] | select(.status == "Pending")] | length' "${catalog}")"
if jq -e '
    all(.entries[];
      (.status == "Valid" or .status == "Falsified" or .status == "Pass" or .status == "Pending") and
      (if .status == "Pending"
       then ((.evidence_required // []) | length) > 0
       else ((.evidence_observed // []) | length) > 0
       end) and
      (if .expected_result == "Pass"
       then (.status == "Pass" or .status == "Pending")
       elif .expected_result == "Falsified"
       then (.status == "Falsified" or .status == "Pending")
       elif .expected_result == "Valid"
       then (.status == "Valid" or .status == "Falsified" or .status == "Pending")
       else false
       end)
    )
  ' "${catalog}" >/dev/null; then
  pass "theorem catalog uses consistent classifications and evidence"
else
  fail "theorem catalog contains an unsupported status, evidence gap, or result mismatch"
fi

if [[ "${catalog_pending_count}" -eq 0 ]]; then
  pass "theorem catalog has no pending obligations"
elif [[ "${require_complete}" -eq 1 ]]; then
  fail "strict completeness gate has ${catalog_pending_count} pending obligations: ${catalog_pending_ids}"
else
  printf 'INFO  theorem catalog honestly retains %s pending obligations: %s\n' \
    "${catalog_pending_count}" "${catalog_pending_ids}"
fi

context_goldens_hash="$(sha256sum "${formal_dir}/assurance/context-goldens.json" | cut -d' ' -f1)"
expected_context_goldens_hash="$(jq -r '.context_goldens_sha256' \
  "${formal_dir}/assurance/cross-evaluator-decisions.json")"
if [[ "${context_goldens_hash}" == "${expected_context_goldens_hash}" ]] &&
   jq -e '(.fixtures | length >= 19)' \
      "${formal_dir}/assurance/context-goldens.json" >/dev/null; then
  pass "source-backed V3 golden contexts are present"
else
  fail "V3 golden-context evidence is missing"
fi

if env GOCACHE=/tmp/proof-tool-formal-go-cache \
    go test -mod=mod ./internal/batchtranscript ./internal/proofassets \
    >/tmp/proof-tool-formal-go-tests.log 2>&1; then
  pass "Go transcript and proof-asset regressions pass"
else
  fail "Go transcript/proof-asset regressions failed"
fi

contract_dir="${repo_dir}/contracts/ownership-verifier"
if (cd "${contract_dir}" && cabal build \
      --build-summary=/tmp/proof-tool-formal-contract-build-summary.log \
      --build-log=/tmp/proof-tool-formal-contract-build.log \
      exe:reclaim-scripts-export test:ownership-verifier-test) \
      >/tmp/proof-tool-formal-contract-build.stdout 2>&1; then
  test_bin="$(cd "${contract_dir}" && cabal list-bin test:ownership-verifier-test)"
  exporter_bin="$(cd "${contract_dir}" && cabal list-bin exe:reclaim-scripts-export)"
  if (cd "${contract_dir}" && \
      env PATH="$(dirname "${exporter_bin}"):${PATH}" "${test_bin}") \
      >/tmp/proof-tool-formal-haskell-tests.log 2>&1; then
    pass "complete Haskell ownership-verifier suite passes"
  else
    fail "Haskell ownership-verifier suite failed"
  fi
else
  fail "Haskell ownership-verifier build failed"
fi

web_dir="${repo_dir}/apps/ownership-proof-web"
if (cd "${web_dir}" && env TMPDIR=/tmp TEMP=/tmp TMP=/tmp npm test -- \
      --maxWorkers=1 --minWorkers=1 \
      lib/reclaim/batch-transcript.test.ts \
      lib/claim/claim.test.ts \
      lib/reclaim-server/manifest.test.ts) \
      >/tmp/proof-tool-formal-web-tests.log 2>&1; then
  pass "focused transcript/address/manifest web regressions pass"
else
  fail "focused transcript/address/manifest web regressions failed"
fi

if (cd "${repo_dir}" && node \
      apps/ownership-proof-web/scripts/verify-reclaim-manifest.mjs \
      apps/ownership-proof-web/public/proof-assets/reclaim-deployment.json) \
      >/tmp/proof-tool-formal-manifest-verifier.json 2>&1 &&
   jq -e '.ok == true and .proof_slot_encoding == "full-proof-plus-public-input-digest-v2"' \
      /tmp/proof-tool-formal-manifest-verifier.json >/dev/null; then
  pass "active deployment manifest coherence verifier passes"
else
  fail "active deployment manifest coherence verifier failed"
fi

if [[ -z "${CODEX_PERMISSION_PROFILE:-}" ]]; then
  if (cd "${web_dir}" && env TMPDIR=/tmp TEMP=/tmp TMP=/tmp npm test -- \
      --maxWorkers=1 --minWorkers=1 scripts/verify-reclaim-manifest.test.mjs) \
      >/tmp/proof-tool-formal-manifest-wrapper-tests.log 2>&1; then
    pass "manifest verifier child-process wrapper regressions pass"
  else
    fail "manifest verifier child-process wrapper regressions failed"
  fi
else
  printf 'SKIP  nested child-process capture is unavailable in the managed Codex sandbox; direct and in-process checks ran\n'
fi

for required_report in \
  provenance-lock.json theorem-catalog.json coverage-matrix.md trust-report.md \
  report.md import-fidelity.json model-findings.md reclaim-base-evidence.json \
  reclaim-global-v2-candidate-evidence.json cross-evaluator-decisions.json; do
  if [[ ! -s "${formal_dir}/assurance/${required_report}" ]]; then
    fail "required report ${required_report} is missing or empty"
  fi
done
if [[ "${failures}" -eq 0 ]]; then
  pass "all required assurance reports are present"
fi

if [[ "${failures}" -ne 0 ]]; then
  printf '\nFormal assurance gate failed with %d failing check(s).\n' "${failures}" >&2
  exit 1
fi

if [[ "${catalog_pending_count}" -eq 0 ]]; then
  printf '\nFormal assurance workspace and completeness gates passed.\n'
else
  printf '\nFormal assurance workspace gate passed with %s explicitly pending obligations.\n' \
    "${catalog_pending_count}"
  printf 'The contracts are not fully formally verified; run with --require-complete for the promotion gate.\n'
fi
