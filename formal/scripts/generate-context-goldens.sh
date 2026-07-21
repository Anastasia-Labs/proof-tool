#!/usr/bin/env bash
set -euo pipefail

formal_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "${formal_dir}/.." && pwd)"
haskell_dir="${formal_dir}/haskell"
mkdir -p "${formal_dir}/artifacts/helpers"

candidate_base_hash="$(jq -r '.current_source_candidate.script_hash' \
  "${formal_dir}/assurance/reclaim-base-evidence.json")"
candidate_global_hash="$(jq -r '.script_hash' \
  "${formal_dir}/assurance/reclaim-global-v2-candidate-evidence.json")"

(
  cd "${haskell_dir}"
  cabal build \
    --build-summary="${haskell_dir}/dist-newstyle/formal-fixtures-build-summary.log" \
    --build-log="${haskell_dir}/dist-newstyle/formal-fixtures-build.log" \
    exe:generate-context-goldens
)

generator="$(cd "${haskell_dir}" && cabal list-bin exe:generate-context-goldens)"
"${generator}" \
  "${formal_dir}/assurance/context-goldens.json" \
  "${formal_dir}/ProofToolFormal/ContextGoldensGenerated.lean" \
  "${repo_dir}/contracts/ownership-verifier/testdata/ownership-destination-vk.hex" \
  "${repo_dir}/contracts/ownership-verifier/testdata/ownership-destination-proof.hex" \
  "${formal_dir}/artifacts/active-preprod/one-shot-params-nft.cbor.hex" \
  "${formal_dir}/artifacts/active-preprod/reclaim-base.cbor.hex" \
  "${formal_dir}/artifacts/active-preprod/reclaim-global-v2.cbor.hex" \
  "${formal_dir}/artifacts/candidate/reclaim-base.cbor.hex" \
  "${formal_dir}/artifacts/candidate/reclaim-global-v2.cbor.hex" \
  "${candidate_base_hash}" \
  "${candidate_global_hash}" \
  "${formal_dir}/artifacts/helpers/reclaim-base-parameterized.cbor.hex" \
  "${formal_dir}/artifacts/helpers/one-shot-parameterized.cbor.hex" \
  "${formal_dir}/artifacts/helpers/find-reference-input-equals.cbor.hex" \
  "${formal_dir}/artifacts/helpers/has-exact-param-token.cbor.hex" \
  "${formal_dir}/artifacts/helpers/value-covers.cbor.hex" \
  "${formal_dir}/artifacts/helpers/statement-digest-equals.cbor.hex" \
  "${formal_dir}/artifacts/helpers/batch-transcript-v2-equals.cbor.hex"

(
  cd "${formal_dir}"
  # `#import_uplc` reads external artifact files during elaboration, but Lake
  # does not track those files as module dependencies. Invalidate the import
  # module explicitly so changed locked bytes cannot reuse a stale olean.
  rm -f \
    .lake/build/lib/lean/ProofToolFormal/Artifacts.olean \
    .lake/build/lib/lean/ProofToolFormal/Artifacts.ilean \
    .lake/build/ir/ProofToolFormal/Artifacts.c \
    .lake/build/ir/ProofToolFormal/Artifacts.c.o
  lake build ProofToolFormal.ConcreteReplay
)
