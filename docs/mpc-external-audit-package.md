# MPC Ceremony External Audit Package

This document is the handoff manifest for an independent review of the
production `cmd/mpc-ceremony` path. It defines the minimum audit scope and
evidence; it does not claim that an audit has occurred. The production
go/no-go record remains `NO-GO` until named independent reviewers sign their
reports for the same frozen commit and binary used by the ceremony.

## Security Claim Under Review

For the exact signed `ownership-destination-v2` BLS12-381 R1CS, the CLI:

1. admits only the complete ordered production roster in both phases;
2. verifies every native gnark Phase 1 and Phase 2 transition;
3. binds each accepted state, identity, predecessor, environment statement,
   erasure statement, software build, and timestamp into signed canonical
   records;
4. commits each closed phase to a distinct future Quicknet round and derives
   the seal challenge only from a verified archived response;
5. deterministically replays the full transcript into native gnark PK/VK and
   exact Cardano verifier bytes, then consumes only a separately generated,
   secret-free public proof vector and verifies it against the replayed VK;
6. requires two distinct enrolled replay auditors and a distinct release
   signer before publishing an exact, checksummed, signed release tree.

The claim does **not** prove participant independence, honest entropy,
ephemeral-memory erasure, coordinator publication time, public availability,
or host integrity. Those are separately witnessed operational gates.

## Frozen Inputs

The audit package must identify one clean signed Git tag and contain:

- the tag, commit, tag signature, source archive, `go.mod`, `go.sum`, and exact
  vendor tree;
- both independently reproduced release packages from
  `scripts/build-mpc-ceremony-release.sh --mode production` with the exact
  approved signed-tag fingerprint and build-signing trust anchor;
- executable SHA-256/BLAKE2b-256 values, Go build information,
  `sbom.cdx.json`, `source-checksums.sha256`, and
  `vendor-checksums.sha256`;
- the frozen circuit binding and serialized
  `ownership-destination.ccs`;
- an exact K=21 rehearsal transcript, measurements, candidate, two signed
  audits, final release, dynamic Plutus public-evidence verification (positive
  plus every mutation negative), and `release verify` output;
- the capacity probe, incident log, witness records, and numeric resource
  summary for every successfully completed command.

No private signing key, wallet material, seed phrase, master XPrv, recovery
secret, hostname, IP address, or unredacted host identifier belongs in the
public audit package. In particular, raw command-result JSON, GNU `time`
reports, retained-directory reports, and filesystem-capacity reports stay in
the separately controlled private audit channel: they can reveal
private-signing-key arguments or absolute host paths. The public packager
derives `measurements/command-resources.tsv` from completed-step markers,
retains only numeric resource fields, and rejects command/private-key markers
and Unix, Windows, UNC, or `file://` absolute paths in allowlisted text.

## Mandatory Code Scope

Review all lines at the frozen commit in:

```text
cmd/mpc-ceremony/
internal/mpcceremony/
internal/keybundle/
internal/keyprofile/
internal/prover/
cmd/proof-tool/ceremony.go
scripts/build-mpc-ceremony-release.sh
scripts/verify-mpc-ceremony-reproducible.sh
scripts/check-mpc-k21-capacity.sh
scripts/mpc-rehearsal-config/
scripts/mpc-rehearsal-operational-evidence/
scripts/mpc-finalization-evidence/
scripts/package-mpc-public-evidence.sh
scripts/run-mpc-k21-local-rehearsal.sh
scripts/verify-mpc-final-plutus-evidence.sh
contracts/ownership-verifier/export/VerifyDestinationProof.hs
go.mod
go.sum
vendor/github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup/
```

Follow downstream bindings through `internal/artifact`,
`internal/proofassets`, the web proof-release coherence verifier, and
`contracts/ownership-verifier`. Review the exact vendored BLS12-381 point,
pairing, FFT, transcript serialization, CSPRNG, update-verification, and seal
paths reached from `mpcsetup`; reviewing only the adapter is insufficient.

## Required Review Questions

Each report must answer, with file/line references:

- Can a malformed native state trigger unbounded allocation, panic, partial
  acceptance, non-canonical decoding, or parser disagreement?
- Can any symlink, path race, existing destination, crash, retry, or
  concurrent publisher replace or ambiguously publish an accepted artifact?
- Can a participant be skipped, duplicated, reordered, replayed, forked, or
  accepted without its exact predecessor and signed erasure record?
- Does every Phase 2 secret-sampling and release boundary independently
  validate the complete Phase 1 chain, closure, raw beacon evidence, seal, and
  locally derived commons? Is coordinator-only incremental acceptance unable
  to influence participant entropy or bypass later full replay?
- Can the coordinator choose or change beacon entropy after observing the
  future round, reuse a round, substitute a relay response, or falsify the
  signed challenge derivation?
- Can different R1CS, curve, backend, commitment shape, binary, source commit,
  dependency, key, or Cardano serialization survive finalization or release
  verification?
- Do finalization and both audits replay all accepted contributions rather
  than trusting coordinator summaries?
- Does the signed candidate hash-bind a secret-free credential, destination,
  public-input digest, exact Cardano proof, and exact final Cardano VK, and
  does the dynamic Plutus executable accept that vector while rejecting
  destination, credential/digest, proof/VK, truncation, and append mutations?
- Can one identity/key satisfy multiple participant, auditor, coordinator, or
  release-signer roles?
- Do timestamps impose the intended strict phase, audit, and release order,
  and which time assertions still require independent witnesses?
- Is closure time sampled only after expensive replay, then checked again
  immediately before one atomic no-replace record/signature commit? Do slow
  replay, round rollover, clock rollback, process suspension, crash, and exact
  retry fail closed without leaving an ambiguous closure?
- Are the measured K21 transition counts, initialization counts, artifact
  passes, per-participant prefix transfers, close duration, and worst-case
  recovery window operationally feasible for the signed scheduled count—five
  independent contributor hosts for the current Mainnet profile? Which
  correctness and resource claims remain valid at the supported ceiling of 20,
  and which require count-specific requalification before a larger ceremony?
- Does any participant-facing path accept, log, transmit, or request wallet
  secrets?

## Independent Test Work

Run tests from clean, offline-capable vendor-backed checkouts. At minimum:

```sh
env GOWORK=off GOFLAGS=-mod=vendor go test -race \
  ./cmd/mpc-ceremony ./internal/mpcceremony ./internal/keybundle

env GOWORK=off GOFLAGS=-mod=vendor go vet \
  ./cmd/mpc-ceremony ./internal/mpcceremony ./internal/keybundle

env GOWORK=off GOFLAGS=-mod=vendor go test ./...
pnpm test:all
scripts/check-vendor-drift.sh
scripts/verify-mpc-ceremony-reproducible.sh \
  --mode production \
  --expected-commit "$SOURCE_COMMIT" \
  --expected-tag "$SIGNED_TAG" \
  --tag-signer-fingerprint "$TAG_SIGNER_FINGERPRINT" \
  --trusted-build-public-key-file "$TRUSTED_BUILD_PUBLIC_KEY_FILE" \
  BUILD_A BUILD_B
scripts/verify-mpc-final-plutus-evidence.sh \
  REHEARSAL_RELEASE /independently-built/verify-destination-proof
```

Run the committed fuzz targets for a reviewer-chosen duration and retain the
corpus and crash artifacts:

```sh
go test ./internal/mpcceremony -run '^$' \
  -fuzz 'FuzzCanonicalJSONParser' -fuzztime 1h
go test ./internal/mpcceremony -run '^$' \
  -fuzz 'FuzzPhase1Preflight' -fuzztime 1h
go test ./internal/mpcceremony -run '^$' \
  -fuzz 'FuzzDrandResponseParser' -fuzztime 1h
```

Independently scan the frozen executable/SBOM against current vulnerability
databases. Record scanner versions, database timestamps, complete output, and
dispositions. A network-backed scan performed before freezing the commit does
not satisfy this gate.

The audit team should add its own malformed-length, invalid-point, SIGKILL,
disk-full, read-only-volume, concurrent-publication, rollback, fork,
equivocation, beacon-substitution, wrong-key, wrong-circuit, and release-tree
tests. Passing the repository's own tests is necessary but is not independent
assurance.

## Deliverables And Acceptance

Require exactly two named reviewer sign-offs in the canonical production
decision. The reviewers must not have authored this implementation and must
use distinct identities and Ed25519 keys that are also distinct from the
ceremony coordinator, release signer, and enrolled replay auditors. Each
detached sign-off authenticates the exact bytes of its independently pinned
report. Reports must include scope, methodology, environment, frozen hashes,
findings, severity, exploitability, reproducer, remediation verification,
residual risk, and an explicit accept/reject conclusion.

Every finding must be fixed and retested, or explicitly risk-accepted by
mainnet governance with rationale and an accountable signer. Any code,
dependency, toolchain, circuit, build recipe, or protocol change after review
invalidates the sign-off unless the reviewers document the exact reviewed
delta.

Place signed reports and their checksums under `reviews/` in the immutable
production evidence package, then reference them from the final go/no-go
record.
