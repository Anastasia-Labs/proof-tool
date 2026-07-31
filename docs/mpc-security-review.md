# MPC Ceremony Security Review Record

This record scopes the repository-maintained review of `cmd/mpc-ceremony` and
the exact dependency lines frozen into its release binary. It is an input to,
not a replacement for, independent security review. A production evidence
package must copy this record, the exact vendored source manifests, the binary
SBOM, automated vulnerability-scan results, and reviewer dispositions for the
same clean signed commit.

Review date: 2026-07-24.

Pinned direct cryptographic dependencies:

- `github.com/consensys/gnark v0.15.0`;
- `github.com/consensys/gnark-crypto v0.20.1`;
- `github.com/drand/drand/v2 v2.1.6`;
- Go `1.26.5`;
- BLS12-381 Groth16 with gnark's vendored `mpcsetup` implementation.

The signed ceremony definition and every contribution attestation repeat these
versions. The running binary derives them from embedded Go build information
and refuses a mismatch. The reproducible-build package also contains
`sbom.cdx.json`, exact source and vendor SHA-256 manifests, executable build
information, and executable SHA-256/BLAKE2b-256 digests.

## Published Advisory Disposition

The review queried the maintainers' official advisory pages. An empty published
advisory list is not proof that a dependency has no vulnerabilities.

### gnark

The official [gnark advisory
index](https://github.com/Consensys/gnark/security/advisories) currently lists
eight advisories:

| Advisory | Published affected/patched range | Disposition for v0.15.0 |
| --- | --- | --- |
| [GHSA-95v9-hv42-pwrj](https://github.com/Consensys/gnark/security/advisories/GHSA-95v9-hv42-pwrj), EdDSA/ECDSA scalar checks | affected `<0.13.0`; patched after v0.14.0 | Version is outside the affected range. The ownership circuit does not use gnark's EdDSA/ECDSA signature-verifier gadgets. |
| [GHSA-9fvj-xqr2-xwg8](https://github.com/Consensys/gnark/security/advisories/GHSA-9fvj-xqr2-xwg8), fake-GLV prover denial of service | affected exactly v0.12.0; patched at v0.13.0 and later | Version is outside the affected range. |
| [GHSA-cph5-3pgr-c82g](https://github.com/Consensys/gnark/security/advisories/GHSA-cph5-3pgr-c82g), crafted-key deserialization allocation | affected through v0.11.0; patched after v0.11.0 | Version is outside the affected range. MPC files additionally undergo exact-size and every-length-prefix preflight before native decoding. |
| [GHSA-q3hw-3gm4-w5cr](https://github.com/Consensys/gnark/security/advisories/GHSA-q3hw-3gm4-w5cr), multiple Groth16 commitments | affected through v0.10.0; patched at v0.11.0 and later | Version is outside the affected range. The frozen circuit binding also requires exactly one commitment. |
| [GHSA-9xcg-3q8v-7fq6](https://github.com/Consensys/gnark/security/advisories/GHSA-9xcg-3q8v-7fq6), non-hiding private-witness commitments | affected through v0.10.0; patched at v0.11.0 and later | Version is outside the affected range. |
| [GHSA-rjjm-x32p-m3f7](https://github.com/Consensys/gnark/security/advisories/GHSA-rjjm-x32p-m3f7), range checker width | affected before v0.9.2; patched at v0.9.2 | Version is outside the affected range. This is relevant because the circuit uses range checking; regression tests remain required. |
| [GHSA-498w-5j49-vqjg](https://github.com/Consensys/gnark/security/advisories/GHSA-498w-5j49-vqjg), comparison/binary decomposition | affected before v0.9.0; patched at v0.9.0 | Version is outside the affected range. This is relevant because the circuit uses bounded `ToBinary`; circuit negative tests remain required. |
| [GHSA-7p92-x423-vwj6](https://github.com/Consensys/gnark/security/advisories/GHSA-7p92-x423-vwj6), Plonk Solidity verifier | affected through v0.9.0; patched at v0.9.1 | Version is outside the affected range and the affected backend is not used. |

### gnark-crypto

The official [gnark-crypto advisory
index](https://github.com/Consensys/gnark-crypto/security/advisories) currently
lists three advisories:

| Advisory | Published affected/patched range | Disposition for v0.20.1 |
| --- | --- | --- |
| [GHSA-fj2x-735w-74vq](https://github.com/Consensys/gnark-crypto/security/advisories/GHSA-fj2x-735w-74vq), vector deserialization allocation | patched releases include v0.18.1 and v0.19.1 and later lines | Version contains the incremental-allocation fix. The ceremony does not rely on that alone: its native MPC parser proves the exact file size and all encoded vector lengths before calling the upstream decoder. |
| [GHSA-fr8m-434r-g3xp](https://github.com/Consensys/gnark-crypto/security/advisories/GHSA-fr8m-434r-g3xp), ECDSA/EdDSA input range checks | affected before v0.12.0; fixed in v0.12.0 and later | Version is outside the affected range; the affected signature serializers are not used for ceremony authentication, which uses the standard-library Ed25519 implementation. |
| [GHSA-pffg-92cg-xf5c](https://github.com/Consensys/gnark-crypto/security/advisories/GHSA-pffg-92cg-xf5c), GT `ExpGLV` correctness | affected through v0.12.0; patched at v0.12.1 | Version is outside the affected range. |

### drand

The official [drand advisory
index](https://github.com/drand/drand/security/advisories) currently reports no
published advisories. This CLI uses the library offline only: it accepts a
bounded archived response, strictly parses it, verifies the round and pinned
BLS public key/scheme, recomputes randomness from the verified signature, and
does not fetch from the network.

### Go standard library and automated source scan

An official `govulncheck v1.6.0` source scan against the four ceremony roots
and the current `vuln.go.dev` database initially found reachable
[GO-2026-4602](https://pkg.go.dev/vuln/GO-2026-4602) in Go 1.26.0 through the
ceremony's directory-entry validation. The production toolchain pin was
therefore moved to Go 1.26.5. The scan was then repeated with the patched
standard library across 22 modules and reported:

- zero symbol vulnerabilities reachable from the ceremony;
- zero vulnerabilities in imported packages;
- one module-only advisory for the unmaintained
  `golang.org/x/crypto/openpgp` package, which is neither imported nor called
  by the ceremony.

This is working-tree remediation evidence, not the required final scan. The
same scanner (or an independently approved replacement), database timestamp,
complete SBOM, and frozen executable must be scanned again after the signed
production tag is created.

## Repository-Controlled Defenses Reviewed

- Every untrusted MPC artifact is a non-symlink regular file with an exact
  circuit-derived size. Length prefixes, compressed-point flags, truncation,
  trailing bytes, and canonical round-trip serialization are checked before
  native objects are accepted.
- gnark Phase 1 and Phase 2 contribution verification is replayed in order.
  Upstream native decoding, encoding, cloning, mutation, and verification
  panics are contained at the CLI engine boundary and converted into rejecting
  errors.
- The participant process redirects gnark's default global logger away from
  stdout before command execution, preserving the `--format json` guarantee
  that stdout contains exactly one machine-readable result object.
- Phase 2 initialization, every participant contribution before secret
  sampling, closure, finalization, and audit independently replay the complete
  closed Phase 1 chain, verify the archived public beacon response, derive
  `commons.bin` from the authenticated head and beacon, and compare its exact
  digest with the signed archive. Coordinator acceptance verifies only the new
  transition from the authenticated head and checks the signed commons against
  the already-bound Phase 2 genesis; the verification record names this
  incremental mode. That record uses
  `proof-tool-mpc-contribution-verification-v2`; the superseded v1 rehearsal
  schema is not release evidence. Full replay remains mandatory at every
  secret-sampling and release boundary.
- Exact canonical signed JSON rejects unknown fields, duplicate keys, reordered
  fields, non-canonical whitespace, and trailing input. Trust roots are
  supplied out of band.
- Contributions bind the previous payload digest into gnark's challenge and
  into participant/coordinator evidence. The signed state machine enforces the
  ordered roster, predecessor, index, erasure statement, threshold, closure,
  and exact retry behavior.
- The current close path owns `closed_at`, derives `beacon_not_before` from the
  pinned Quicknet schedule, samples time only after full replay, rechecks the
  signed lead plus a publication margin, and commits record plus signature as
  one no-replace directory. The final userspace time check is immediately
  before the no-replace rename syscall; process suspension between that check
  and the syscall cannot be made atomic with the wall clock, so a late
  publication is an abort rather than a recoverable close. The 2026-07-24
  rehearsal exposed and invalidated the superseded caller-timestamp design;
  this replacement is unqualified until a fresh exact-circuit rehearsal
  passes. Local time remains a host claim, so independent timestamped public
  witnesses are an external gate.
- Two-stage finalization independently replays both phases to a signed
  preliminary PK/VK tree. A separate local-only golden-vector helper
  authenticates that tree and emits only public credential, destination,
  public-input digest, and Cardano proof bytes. `finalize complete` replays
  again, verifies that exact public proof against the replayed VK, and
  hash-binds the vector, native negative results, and exact Cardano VK into the
  report and signed candidate. The ceremony binary exposes no seed, master
  XPrv, derivation-path, assignment, or proving input. The exact K=21 finish
  gate then runs the dynamic Plutus verifier and requires destination,
  credential/digest, proof/VK, truncation, and append negatives before either
  audit. Two distinct enrolled auditors must repeat replay before a distinct
  release signer may atomically publish a release.
- The portable file layer rejects symlink components and no-replace publishes
  immutable records. Linux production release-directory publication uses
  `renameat2(RENAME_NOREPLACE)` so a concurrent empty destination is not
  replaced. The path layer does not claim Linux `openat2` race-free component
  resolution; ceremony roots and their parent directories must still be
  dedicated, local, access-controlled filesystems.

## Open Review Gates

This record does not close:

1. a repeated automated vulnerability scan of the signed, frozen executable
   and complete SBOM against a current database;
2. independent line review of the exact vendored `mpcsetup`, adapter, parser,
   state machine, beacon, finalization, audit, and release code;
3. independent extended execution of the committed canonical-JSON,
   native-Phase-1-preflight, and drand-response fuzz targets, plus reviewer
   fuzzing beyond those targets;
4. an exact five-party `K=21` end-to-end rehearsal for the currently planned
   Mainnet profile, using five independent contributor hosts, distinct future
   beacons, measured resources, two auditors, and signed release verification;
5. participant host integrity, CSPRNG health, erasure, public observation, and
   governance acceptance.

## Blocking findings discovered by exact-circuit rehearsal

1. **Closure timing / future-beacon TOCTOU (fixed in working tree, unqualified).**
   The superseded CLI accepted `--closed-at` before replay. A three-contributor
   K=21 close crossed the selected round during replay and nevertheless
   published. The run is invalid. Acceptance requires post-replay expiry,
   exact-boundary, rollback, atomic-publication, complete-retry, and external
   witness tests against a fresh binary.
2. **Phase 1 commons provenance at the Phase 2 boundary (fixed in working
   tree, unqualified).** The prior loader checked only a coordinator-signed
   commons digest. It now replays the accepted Phase 1 chain, derives the
   commons from the authenticated beacon, and rejects signed well-formed
   commons derived from deterministic genesis.
3. **Replay amplification / denial of service (open).** Participant creation
   deliberately replays its full prefix before sampling entropy. The prior
   coordinator path redundantly replayed that prefix again and has been
   changed to direct-transition verification, but exact K21 close, Phase 2,
   finalization, audit, cold-cache, and the planned five-party transfer window
   remain unmeasured. Availability and ceremony scheduling are production
   gates. The tool continues to enforce a 20-participant ceiling, but any
   future ceremony above five requires capacity qualification for its own
   signed roster count.

Any newly published advisory, changed dependency, vendor drift, changed Go
toolchain, or changed circuit invalidates this disposition and requires a new
review against a new frozen binary.
