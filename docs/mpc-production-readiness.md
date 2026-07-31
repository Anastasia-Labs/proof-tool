# MPC Ceremony Production Readiness

This is the acceptance record for using `cmd/mpc-ceremony` to create the
Groth16 proving and verifying keys for a Proof Tools Cardano mainnet release.
It supplements the operator procedure in
[`mpc-ceremony-runbook.md`](mpc-ceremony-runbook.md), the independent-review
handoff in
[`mpc-external-audit-package.md`](mpc-external-audit-package.md), and the
formal
[`mpc-production-go-no-go-template.md`](mpc-production-go-no-go-template.md).

The current decision is **NO-GO**. The implementation and its ordinary test
suite are not, by themselves, sufficient evidence for a production ceremony.
Every repository-controlled gate below must be recorded as passing against one
frozen clean commit and reproducible binary. The external gates must then be
accepted by named people or organizations outside the implementation team.

The tool supports production phase rosters from 2 through 20 participants. The
signed definition determines each phase's exact count and production requires
`minimum` to equal that complete scheduled count. The currently planned
Mainnet ceremony uses five participants in each phase; 20 is a supported
ceiling rather than the required live roster.

### Blocking rehearsal incident — 2026-07-24

Do not use binary SHA-256
`98df69583a3e8fb445cbeef227f2de74a27f4957a413f0c8b90118a3e5152d31`
or any artifact from
`/ceremony/rehearsal-e94abad-k21-3p` for Mainnet. Its Phase 1 close command
started with Quicknet round `30688386`, scheduled for
`2026-07-24T04:48:42Z`, but the hours-long replay did not return until about
`2026-07-24T05:50:20Z`. The superseded binary signed a caller-supplied
`closed_at` captured before replay, so the closure made an already available
beacon appear future. The closure and every potential descendant are invalid.
The dedicated raw rehearsal volume was deleted on 2026-07-24 after this
incident summary and the binary hash were recorded. Any surviving copy is
incident evidence only and must never be resumed, sealed, finalized, or
released.

The repository now removes caller-controlled closure time, derives the exact
Quicknet schedule from the round, checks the wall clock after replay and again
at atomic closure-directory publication, and splits contribution work from
beacon selection. Those changes require a new commit, binary, signed tag,
fresh root, independent review, and complete rehearsal; they do not
retroactively qualify the failed run.

### Working-tree qualification snapshot — not release evidence

After the fixes above, a clean local snapshot commit
`26108b70b989065ae171dd5b33a37b4015412d70` produced two semantically
verified, byte-identical rehearsal builds. Their `mpc-ceremony` SHA-256 is
`d6248c8c0bea6aef22479be4f4a531f9bbbc2f3f6e7c7ce83edbed94abac4431`.
This is useful regression evidence only: the snapshot is not an approved
repository ref, has no approved signed production tag or build-package
signature, was rebuilt twice on one host rather than independent build
environments, and has not completed a fresh exact K=21 rehearsal. The final
binary vulnerability scan was also not recorded because this execution
environment could not reach `vuln.go.dev`. It must not be distributed as a
production ceremony binary.

Do not use an artifact from a rehearsal, the single-actor
`proof-tool setup-ceremony` command, or a ceremony with an incomplete scheduled
roster as a mainnet proving key.

## Protocol Basis

The implementation follows the two-phase Groth16 MPC structure exposed by
gnark's BLS12-381 `mpcsetup` package: sequential Phase 1 contributions, a
public-randomness seal, circuit-specific Phase 2 contributions, and a second
seal producing native gnark PK/VK objects. The design and acceptance criteria
are informed by:

- Bowe, Gabizon, and Miers,
  [Scalable Multi-party Computation for zk-SNARK Parameters in the Random Beacon Model](https://eprint.iacr.org/2017/1050.pdf);
- the exact vendored gnark and gnark-crypto source at the frozen module
  versions, which is authoritative for serialization, update verification,
  randomness, and seal behavior used by this binary;
- drand's
  [cryptographic specification](https://docs.drand.love/docs/specification/)
  and the pinned
  [Quicknet deployment parameters](https://docs.drand.love/blog/2023/10/16/quicknet-is-live/);
- the
  [Reproducible Builds definition](https://reproducible-builds.org/) for
  independently deriving identical binaries from source;
- the Ethereum KZG ceremony's
  [public transcript, multiple implementations, and independent audit precedent](https://blog.ethereum.org/2024/01/23/kzg-wrap/).

These references do not audit or endorse this repository. In particular, the
published gnark audit list does not provide evidence that this exact
`mpcsetup` adapter and ceremony workflow have received an independent security
audit.

## Acceptance Matrix

Status meanings:

- `PASS`: repeatable evidence is committed or content-addressed and names the
  exact frozen commit/binary;
- `PARTIAL`: an implementation or local test exists, but production evidence
  is incomplete;
- `FAIL`: observed evidence violated the gate and a fresh run is required;
- `OPEN`: no acceptable evidence has been recorded;
- `EXTERNAL`: software cannot close this gate.

| Gate | Status | Required evidence |
| --- | --- | --- |
| Exact `ownership-destination-v2` BLS12-381 R1CS binding | PARTIAL | Clean-build output records exact R1CS bytes, both hashes, size, constraint/variable counts, `K=21`, commitment shape, source commit, and binary hash. |
| Native gnark Phase 1 and Phase 2 transition verification | PARTIAL | Adversarial and race-tested adapter plus independent code review of the exact vendored gnark/gnark-crypto paths. |
| Bounded canonical artifact parsing | PARTIAL | Parser review and tests for invalid lengths, allocation abuse, invalid/non-canonical points, truncation, append, symlink/path races, and time-of-check/time-of-use limitations. |
| Signed transcript state machine | PARTIAL | Review and tests for order, identity, predecessor, fork, replay, rollback, retry, crash, roster, threshold, closure, and timestamp transitions. |
| Distinct future beacon binding and replay | FAIL | The 2026-07-24 rehearsal published its Phase 1 closure after the selected round. The replacement must pass slow-replay/expiry/clock-rollback tests and produce two externally witnessed closures before their distinct rounds. |
| Native PK/VK, Cardano export, and candidate coherence | PARTIAL | Exact-circuit finalization and independent replay produce matching native key and Cardano verifier artifacts. The candidate/report must hash-bind the secret-free public credential/destination/digest/Cardano-proof vector, and the dynamic Plutus verifier must accept it while rejecting destination, credential/digest, proof/VK, truncation, and append mutations. |
| Atomic audit and release publication | PARTIAL | Crash/failure-injection evidence plus two distinct auditor signatures, a distinct release signer, exact tree/checksum verification, and immutable mirrors. |
| Clean reproducible release binary | PARTIAL | The pinned clean-build recipe, SBOM, source/vendor manifests, and byte-comparison gate pass in two local clean checkouts; two genuinely independent build environments and a frozen signed production tag remain required. |
| Full `K=21` multi-contributor rehearsal | FAIL | The first exact-circuit run stopped after an invalid Phase 1 closure. A fresh staged five-party run must complete both phases with five genuinely independent contributors, distinct future beacons, secret-free Plutus evidence and negatives, two audits, release signing, and `release verify`. Count-boundary behavior at 2 and 20 must also remain tested, but does not replace count-specific rehearsal evidence. |
| Measured production capacity | FAIL | The qualified volume passed admission and the three-contributor Phase 1 lane took about seven hours, exposing quadratic replay amplification. No complete Phase 2 or defensible five-party production runtime/transfer window exists. A fresh five-party run must record peak RSS, wall time, CPU, exact bytes, retained disk, cold/warm I/O, close replay, and per-participant transfer volume with approved margins. A later ceremony with a larger signed roster requires capacity qualification for that scheduled count; an unmeasured 20-party window is not a blocker for the currently planned five-party ceremony. |
| Resume, inspection, and public evidence integrity | PARTIAL | Every new rehearsal step binds its result, runner epoch, and explicit artifact allowlist; close/beacon stage manifests additionally bind round, closure, and publication state. Read-only `inspect` revalidates them. The public packager excludes raw command/timing/host-path reports, emits only numeric command-resource summaries, rejects symlinks/private material/absolute host paths, and hashes its complete payload. Crash/retry evidence and two independently reproduced public-package manifests remain required. |
| Complete operational evidence bundle | PARTIAL | Release now requires one coordinator-signed bundle covering proof-of-possession enrollments, both directional custody transfers and exact signed prefix for every accepted head, at least two immutable mirrors per head, a pre-round public-witness quorum, and at least three distinct relay/operator/endpoint raw responses per phase. The same-host rehearsal exercises the verifier, but production still requires independently controlled actors, custody, mirrors, witnesses, and retrievals. |
| Restore and coordinator failover | OPEN | A separately administered qualified host must restore a fully accepted head, recover signing authority through the approved secure channel, pass capacity and read-only inspection, derive the same next participant, exercise one pre-publication failure, and reproduce public-package payload hashes within the approved recovery window. |
| Repository/deployment/contract coherence | OPEN | Signed key-bundle, frozen R1CS, proof assets, deployment manifest, pinned hashes, Cardano bytes, hash-bound public finalization vector, real proof, and dynamic Plutus contract checks all agree. |
| Aggregate quality gate | PARTIAL | `pnpm test:all`, Go race tests, vet/static analysis, the documented direct-dependency advisory review, a complete automated SBOM vulnerability scan, and the exact-circuit MPC tests pass on the frozen commit. |
| Independent implementation/security audit | EXTERNAL | At least two reviewers independent of the authoring work accept the protocol adapter, file parser, state machine, beacon, finalization, and release paths, with findings resolved or explicitly accepted. |
| Participant independence and host integrity | EXTERNAL | Named ceremony governance verifies organizational independence, ephemeral host controls, CSPRNG health, erasure procedure, and no wallet/recovery secrets. |
| Public non-equivocating observation | EXTERNAL | Closures and transcript heads are mirrored through independent, append-only, timestamped channels before each future beacon exists. |
| Live production ceremony acceptance | EXTERNAL | Separate Phase 1/Phase 2 run cards are derived from the verified signed policies with `minimum == count`. For the currently planned ceremony this is `minimum == count == 5` in both phases and ten ordered rows. All scheduled rows, auditors, witnesses, coordinator, and release signer complete the frozen procedure and governance signs the final go/no-go statement. |

## Evidence Package Layout

The frozen release must publish a content-addressed package with at least:

```text
source/
  commit.txt
  tag-and-signature/
  dependency-locks/
  vendored-source-hashes/
build/
  recipe/
  environment-a/
  environment-b/
  mpc-ceremony
  mpc-ceremony.sha256
  mpc-ceremony.blake2b256
  build-info.txt
  sbom/
circuit/
  ownership-destination-v2.ccs
  binding.json
rehearsal/
  definition-and-public-keys/
  phase1/
  phase2/
  operational/
  candidate/
  audits/
  release/
  measurements/
reviews/
  protocol-adapter/
  parser-and-state-machine/
  beacon-and-release/
production/
  participant-governance/
  witness-plan/
  archive-and-mirror-plan/
  incident-and-abort-plan/
  final-go-no-go.md
```

Every generated report must identify the source commit, executable hashes,
ceremony id, circuit binding, and the command/environment that produced it.
Secrets, participant private signing keys, wallet files, seeds, and master
XPrvs must never enter this package.

Capacity evidence must state the configured floors, measured peak/remaining
values, effective cgroup limits, swap and quota observations, absolute and
percentage safety margins, and the signed approval for those margins. Recovery
evidence must state the accepted recovery point, failover duration, restored
head/package hashes, next scheduled participant, and both operators.

## Go/No-Go Sign-off

Production is `GO` only when:

1. every repository-controlled row above is `PASS` for the same frozen commit;
2. all security-review findings are resolved or explicitly risk-accepted by
   production governance;
3. every external gate has named accountable signers and immutable evidence;
4. the live definition schedules the intended participants in exact order with
   `minimum` equal to the complete list in both phases;
5. the release signer and two independent auditors reproduce and accept the
   final keys and Cardano artifacts;
6. the mainnet deployment consumes the exact verified release hashes.

Any missing participant, changed binary, changed circuit, changed dependency,
unresolved fork, failed signature/update proof, beacon publication dispute, or
coherence mismatch is `NO-GO` and requires a new ceremony unless the runbook
explicitly defines a safe exact retry.
