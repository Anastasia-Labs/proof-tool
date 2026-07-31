# MPC Production Ceremony Go/No-Go Record

Copy this template into the immutable evidence package. Replace every
placeholder; do not delete an inapplicable gate. The only valid final decision
is `GO` or `NO-GO`. Any unchecked, missing, mismatched, disputed, or
unverifiable item forces `NO-GO`.

This Markdown file is the human review checklist bound by the canonical
`formal_checklist` digest; it is not itself the machine-verifiable decision.
After the final release exists, construct
`proof-tool-mpc-production-decision-draft-v1`, run
`mpc-ceremony decision prepare`, obtain the exact detached role signatures,
and publish the verified `proof-tool-mpc-production-decision-v1` record as
described in `docs/mpc-ceremony-runbook.md`.

## Frozen Identity

| Field | Exact value / evidence URI |
| --- | --- |
| Decision | `NO-GO` |
| Decision time (UTC) | `<required>` |
| Ceremony ID | `<required>` |
| Signed production tag | `<required>` |
| 40-character source commit | `<required>` |
| Binary SHA-256 | `<required>` |
| Binary BLAKE2b-256 | `<required>` |
| Go / gnark / gnark-crypto / drand versions | `<required>` |
| R1CS SHA-256 / BLAKE2b-256 / bytes | `<required>` |
| Circuit / key version / curve / backend / domain | `<required>` |
| Final transcript ID | `<required>` |
| Manifest SHA-256 | `<required>` |
| PK SHA-256 / BLAKE2b-256 / bytes | `<required>` |
| VK SHA-256 / BLAKE2b-256 / bytes | `<required>` |
| Cardano VK BLAKE2b-256 / bytes / format | `<required>` |
| Public finalization evidence SHA-256 / BLAKE2b-256 | `<required>` |
| Cardano finalization proof SHA-256 / BLAKE2b-256 / bytes | `<required>` |
| Dynamic Plutus verifier executable SHA-256 | `<required>` |
| Deployment manifest digest | `<required>` |
| Contract/script hashes | `<required>` |
| Public evidence `SHA256SUMS` digest / mirrors | `<required>` |
| Operational evidence bundle/signature digest | `<required>` |
| Enrollment/PoP set digest | `<required>` |
| Accepted-head custody/prefix/mirror evidence root | `<required>` |
| Phase 1 / Phase 2 witness quorum and relay evidence digests | `<required>` |
| Phase 1 / Phase 2 derived final chain sequences | `<required>` |
| Phase 1 / Phase 2 scheduled participant counts | `5 / 5` |
| Tool-supported production count range | `2-20 per phase` |
| Capacity report digest / approved margin policy | `<required>` |
| Restore/failover drill report digest | `<required>` |

## Repository-Controlled Gates

- [ ] Two clean independent builds are byte-identical and their source,
  vendor, SBOM, build-info, and executable manifests verify.
- [ ] Current vulnerability scans of the frozen binary and complete SBOM have
  no unaccepted findings.
- [ ] Vendor drift, Go vet/static analysis, race tests, committed fuzz targets,
  `pnpm test:all`, real proof lanes, web proof-release coherence, and Plutus
  tests pass on the frozen commit with no required section skipped.
- [ ] The exact K=21 rehearsal completed on a qualified local filesystem with
  the currently planned five genuinely independent contributors, distinct
  future beacons, a passing dynamic Plutus public-evidence check, two
  independent auditors, release signing, and `release verify`.
- [ ] Each close selected its beacon only after all participant work, sampled
  `closed_at` after full replay, atomically committed record plus signature
  while the signed lead plus publication margin still held, and was observed
  by the required independent witnesses before the round. Close start,
  replay-complete, durable-commit, witness, and round times are recorded.
- [ ] Measured peak RSS, wall time, scratch/retained disk, state size, and
  transfer volume are recorded together with cgroup-effective RAM, swap,
  inodes, file limits, quota observations, sustained fsync/write and read
  rates. Production floors meet the approved measured RAM/disk/inode/time
  margins, with absolute and percentage headroom recorded.
- [ ] Exact depth-0/1/4 participant, acceptance, full-close, Phase 2
  initialization, finalization, and audit timings plus cold/warm transfer
  volumes produce an approved five-party schedule with abort and recovery
  slack. Structural count-boundary and release-inventory tests pass at 2 and
  20 participants; a later live ceremony with a larger roster requires
  count-specific capacity qualification.
- [ ] Every completed rehearsal result and generated artifact passes read-only
  resume-marker inspection; two independently produced allowlisted public
  packages contain no symlink/private material and have identical payload
  hashes.
- [ ] The rehearsal release fail-closes on one verified signed operational
  bundle covering all enrollments, both directional custody transfers for
  every head, every exact accepted chain prefix, two mirror receipts per head,
  two pre-round witness receipts per phase, and at least three distinct
  relay/operator/endpoint raw responses per phase.
- [ ] A separately administered failover host restored a fully accepted head,
  recovered coordinator authority through the approved secure process,
  derived the same next participant, passed production capacity/inspection,
  recovered one injected pre-publication failure, and met the approved
  recovery window without manual transcript repair.
- [ ] All parser, crash/retry, disk-full, fork/rollback, signature, beacon,
  wrong-circuit, wrong-destination, wrong-key, truncation, append, and
  publication failure tests pass.
- [ ] Two independent security reviewers signed the exact frozen code/build
  reports and every finding is resolved or formally accepted.

## Live Ceremony Gates

- [ ] The signed definition contains the complete intended production roster
  in exact order, with derived `minimum == len(participants) == 5` in both
  phases for the currently planned Mainnet ceremony; separate signed Phase 1
  and Phase 2 run cards bind the derived final sequence and all ten ordered
  rows. The tool remains valid for signed production rosters from 2 through 20,
  subject to count-specific qualification.
- [ ] Coordinator, every participant, both auditors, and release signer use
  distinct enrolled identities and out-of-band verified public keys.
- [ ] Every participant verified the frozen binary and circuit hashes on an
  approved ephemeral host with OS CSPRNG, swap/crash dumps/telemetry disabled,
  and no wallet or recovery secrets present.
- [ ] Every scheduled contribution, erasure attestation, verification, and
  acceptance exists in exact order; no participant is omitted and no fork or
  incident remains unresolved.
- [ ] Every actor and external witness/mirror operator has a verified
  proof-of-possession enrollment and accountable independence disclosure;
  every accepted head has coordinator-to-participant and
  participant-to-coordinator handoff/receiver pairs, its exact
  coordinator-signed chain prefix, and at least two independently controlled
  immutable-mirror receipts over that prefix and output evidence.
- [ ] Each signed closure was mirrored and independently timestamped through
  the approved append-only witness channels before its distinct future
  Quicknet round existed.
- [ ] Each archived beacon response agrees across independent relays and
  contains at least three distinct relay IDs, operator IDs, and endpoint
  digests, then verifies offline against the pinned chain hash, public key,
  scheme, round, and derived randomness.
- [ ] At least two independent auditors replayed the entire transcript on
  independent hosts and signed exact matching outputs.
- [ ] The distinct release signer verified the audits and atomically published
  the release with the mandatory operational evidence root/bundle/signature;
  independent verifiers passed `release verify` using the out-of-band release
  key.

## Mainnet Coherence Gates

- [ ] Native PK/VK, Cardano VK, signed key manifest, final transcript, chunk
  manifest, browser/desktop/helper proof assets, verifier service, deployment
  manifest, batch-transcript VK hash, and on-chain parameters all bind the
  same exact release.
- [ ] A repository-backed real derive/prove/verify/Cardano-export run succeeds
  with the final production bundle; wrong destination, public input, proof,
  VK, and transcript variants fail.
- [ ] The signed candidate and verification report hash-bind the published
  secret-free credential, destination, public-input digest, exact Cardano
  proof, and exact final Cardano VK. The independently built dynamic
  `verify-destination-proof` executable accepts the positive vector and
  rejects destination, credential/digest, proof/VK, truncation, and append
  mutations.
- [ ] Contract evaluation and serialization tests pass with the final Cardano
  bytes, and mainnet deployment consumes only the recorded verified hashes.
- [ ] At least two independent immutable archives contain the public
  transcript, evidence package, release, witness records, audit reports,
  incident record, capacity/failover reports, and this signed decision; each
  archive verifies the recorded public-package `SHA256SUMS` digest.

## Incidents And Exceptions

| ID | Description | Resolution / evidence | Governance signer |
| --- | --- | --- | --- |
| `<required; write "none" only if none>` | | | |

## Accountable Signatures

| Role | Name / organization | Key ID | Signature / evidence URI |
| --- | --- | --- | --- |
| Ceremony coordinator | `<required>` | `<required>` | `<required>` |
| Independent auditor 1 | `<required>` | `<required>` | `<required>` |
| Independent auditor 2 | `<required>` | `<required>` | `<required>` |
| Release signer | `<required>` | `<required>` | `<required>` |
| External security reviewer 1 | `<required>` | `<required>` | `<signed exact report URI>` |
| External security reviewer 2 | `<required>` | `<required>` | `<signed exact report URI>` |
| Public-witness lead | `<required>` | `<required>` | `<required>` |
| Mainnet deployment owner | `<required>` | `<required>` | `<required>` |
| Security/governance approver | `<required>` | `<required>` | `<required>` |

## Final Decision

Decision: `NO-GO`

Rationale: `<required>`

The decision may change to `GO` only after every checkbox is checked, every
exact value is filled, every exception is accepted, every signature verifies,
and independent reviewers reproduce the final release and deployment
coherence.
