# MPC Trusted Setup Ceremony

> **Production stop — NO-GO (2026-07-24).** The first exact K21 rehearsal
> exposed a closure-timing failure and did not complete. The superseded binary
> SHA-256
> `98df69583a3e8fb445cbeef227f2de74a27f4957a413f0c8b90118a3e5152d31`
> and every artifact from `/ceremony/rehearsal-e94abad-k21-3p` are barred from
> use. The dedicated raw rehearsal volume was deleted on 2026-07-24 after this
> incident summary and the binary hash were recorded. Treat any surviving copy
> as incident evidence only. Do not use it or this working tree for Mainnet
> until the fresh-rehearsal,
> independent-audit, operational, coherence, and signed-GO gates in
> `docs/mpc-production-readiness.md` pass.

This runbook governs `cmd/mpc-ceremony`, the dedicated sequential MPC setup
path for this repository's Groth16 BLS12-381 destination circuit. It is
designed for production phase rosters of 2 through 20 enrolled participants.
The signed definition sets each phase's exact scheduled count, and production
requires `minimum` to equal that complete count. The currently planned Mainnet
ceremony schedules five parties in each phase. Twenty is the tool's supported
ceiling, not a required production roster size.

The binary binds the ceremony to this repository's compiled
`ownership-destination-v2` R1CS, verifies gnark Phase 1 and Phase 2 update
proofs, and emits native gnark proving and verifying keys. It also reuses the
repository's signed manifests, Cardano verifier export, and coherence checks.
It accepts only public setup artifacts and ceremony identity signing keys. It
must never receive a seed phrase, master XPrv, wallet file, derivation path, or
other user recovery secret.

The command provides the cryptographic and artifact-integrity foundation for a
production ceremony. Production-grade operation additionally requires
independent participants and auditors, reviewed builds, controlled ephemeral
hosts, public observation of signed closures before the chosen beacons exist,
immutable mirrors, and the release gates in this document.

The existing `proof-tool setup-ceremony` path is explicitly single actor. Its
artifacts are not MPC evidence and must not be described as trustless or as the
result of this procedure.

## Guarantee Boundary

The software enforces:

- the ceremony id, curve, backend, Phase 1 domain, circuit id, key version,
  source commit, dependency versions, and exact serialized BLS12-381
  R1CS/CCS digest;
- strict canonical records, bounded full-file reads, artifact hashes,
  participant/coordinator signatures, and the ordered predecessor chain;
- gnark Phase 1 and Phase 2 update-proof verification;
- offline verification of the two pinned drand Quicknet responses and
  deterministic challenge derivation;
- native gnark PK/VK serialization, Cardano verifier export, signed release
  manifest, audit bundling, checksums, and coherence verification;
- fresh outputs, safe transcript-relative artifact resolution, and no implicit
  `latest`, overwrite, or network-fetch behavior.

The software cannot prove:

- that enrolled identities are independent people or organizations;
- that a participant's hardware, OS, hypervisor, build chain, or entropy source
  was uncompromised;
- that swap, crash dumps, snapshots, telemetry, or process memory retained no
  contribution randomness;
- that a participant honestly destroyed its environment;
- that a coordinator's claimed timestamps correspond to when records became
  publicly observable;
- that an archive is available or non-equivocating outside its signed chain.

`attest-erasure` creates a signed operational statement. It is not technical or
cryptographic proof of erasure.

## Protocol And Roles

The ceremony is sequential:

1. Phase 1 participants update the circuit-independent Powers of Tau state.
2. The coordinator closes Phase 1 and commits to a future Quicknet round.
3. An offline, authenticated Quicknet response is recorded and applied to seal
   Phase 1.
4. Phase 2 is initialized from the sealed Phase 1 commons and this repository's
   exact compiled R1CS.
5. Phase 2 participants update the circuit-specific state.
6. The coordinator closes Phase 2 and commits to a distinct future round.
7. `finalize prepare` verifies the second response, replays both phases,
   applies its challenge, and emits preliminary native gnark/Cardano keys. A
   separate public-only helper proves the committed golden finalization
   witness against those exact keys; `finalize complete` verifies and embeds
   that evidence before emitting the coordinator-signed candidate.
8. At least two enrolled independent auditors reproduce the candidate.
9. The separate release signer atomically publishes the signed release.

At least one participant in each phase must independently generate and destroy
its contribution randomness for the MPC trust assumption to hold. Production
policy requires at least two scheduled contributors in each phase and requires
every scheduled contributor to be accepted before closure; use more whenever
practical. The signed `minimum` must therefore equal the scheduled participant
count in production. The current Mainnet profile therefore uses
`minimum == count == 5` in both phases and, when the same five parties
contribute to both phases, produces ten ordered contribution rows. Rehearsals
may use a smaller threshold only when they are not qualifying a particular
production roster. The beacon is reproducible defense in depth, not a
replacement for an honest contribution.

gnark samples contribution randomness from Go's `crypto/rand.Reader`. The CLI
does not accept dice, HSM, file, deterministic, or operator-supplied entropy.

Use distinct Ed25519 keys for the coordinator, release signer, every auditor,
and every participant. These are ceremony identity secrets, not wallet or
recovery keys. Never reuse a user's recovery key as a ceremony identity key.

## Freeze Before Enrollment

Before `init`, freeze and publish:

- a clean, signed source tag and exact commit;
- reviewed binary hashes and reproducible build instructions;
- Go, gnark, gnark-crypto, and drand dependency versions;
- BLS12-381, Groth16, the Phase 1 domain, circuit id, and key version;
- the compiled R1CS/CCS bytes, hashes, counts, and circuit source commit;
- the ordered phase participant lists and minimums;
- coordinator, release signer, participant, and auditor identities and public
  keys;
- archive locations, mirrors, beacon-observation procedure, abort procedure,
  and release gates.

Production `init` requires an exact clean source build. The current production
destination circuit uses domain `2^21` (`K=21`). Do not infer or replace that
domain from a small rehearsal.

## Reproducible Ceremony Binary

Build the frozen participant-facing Linux/amd64 binary from two independent
clean environments. Production mode requires a verified signed tag resolving
to the exact clean `HEAD`:

```sh
scripts/build-mpc-ceremony-release.sh \
  --mode production \
  --signed-tag "$SIGNED_TAG" \
  --tag-signer-fingerprint "$TAG_SIGNER_FINGERPRINT" \
  --build-signing-key "$BUILD_SIGNING_KEY" \
  --out-dir "$FRESH_BUILD_A"
```

The second builder checks out the same tag independently and writes a different
fresh output directory. Compare the complete build packages:

```sh
scripts/verify-mpc-ceremony-reproducible.sh \
  --mode production \
  --expected-commit "$SOURCE_COMMIT" \
  --expected-tag "$SIGNED_TAG" \
  --tag-signer-fingerprint "$TAG_SIGNER_FINGERPRINT" \
  --trusted-build-public-key-file "$TRUSTED_BUILD_PUBLIC_KEY_FILE" \
  "$FRESH_BUILD_A" \
  "$FRESH_BUILD_B"
```

The build refuses a dirty tree, untracked source, a non-tagged production
commit, Go other than 1.26.5, `GOEXPERIMENT`, module replacements, vendor
symlinks/drift, or an existing output. It builds with `CGO_ENABLED=0`,
`GOTOOLCHAIN=local`, vendored dependencies, VCS metadata, `-trimpath`, and an
empty Go build id. The build occurs under one commit-derived canonical source
path because vendored assembly can otherwise embed checkout-specific paths.

Each package includes:

- the read-only executable and SHA-256/BLAKE2b-256 manifest;
- embedded Go build information and source commit/epoch;
- the signed-tag status and build mode;
- a deterministic CycloneDX SBOM for linked Go modules;
- exact SHA-256 manifests for every tracked source and vendored dependency
  file.

Builders must publish their build environment, host/toolchain provenance, and
package hashes independently. Identical output from two directories on one
host is a useful regression test but does not satisfy the two-independent-
environment production gate.

## Strict Canonical Initialization Files

`participants.json`, `policy.json`, and every participant `environment.json`
are exact canonical JSON, not ordinary JSON configuration files. The decoder
rejects unknown fields, duplicate fields, reordered fields, pretty printing,
extra whitespace, trailing JSON, and a trailing newline. `jq -S` is not a
valid construction method because alphabetical key sorting changes the schema
order.

The exact `participants.json` field shape and order are:

```text
{"coordinator":IDENTITY,"release_signer":IDENTITY,"auditors":[IDENTITY,...],"roster":[{"identity":IDENTITY},...]}
```

Each `IDENTITY` has this exact field order:

```text
{"id":"ID","display_name":"DISPLAY NAME","key_id":"KEY-ID","ed25519_public_key_hex":"64-lowercase-hex","public_key_fingerprint":"sha256:64-lowercase-hex"}
```

The fingerprint is SHA-256 of the raw 32-byte Ed25519 public key. Across the
coordinator, release signer, every auditor, and every participant, all identity
ids, key ids, and public-key fingerprints must be unique. At least two auditors
and between 1 and 20 roster participants are required. Production mode requires
at least two participants scheduled in each phase, with `minimum` equal to the
complete scheduled participant count. The release signer must be distinct from
the coordinator.

The exact `policy.json` schema and pinned Quicknet policy are below. This
example is valid when `participant-01` and `participant-02` are enrolled:

```json
{"phase1_policy":{"participants":["participant-01","participant-02"],"minimum":2},"phase2_policy":{"participants":["participant-01","participant-02"],"minimum":2},"beacon_policy":{"provider":"drand","network":"quicknet-mainnet","chain_hash_hex":"52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971","public_key_hex":"83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a","scheme":"bls-unchained-g1-rfc9380","genesis_time_unix":1692803367,"period_seconds":3,"extraction":"sha256-domain-separated-length-prefixed-v1","minimum_challenge_bytes":32,"future_round_required":true}}
```

The order of each phase's `participants` array is the enforced contribution
order. It is not just a set.

Each participant uses a host-specific canonical `environment.json`. This exact
example is valid:

```json
{"os":"linux","architecture":"amd64","entropy_source":"operating-system-csprng","swap_disabled":true,"crash_dumps_disabled":true,"telemetry_disabled":true,"ephemeral_environment":true,"ephemeral_destruction_required":true}
```

Use the real OS and architecture. The entropy value must be exactly
`operating-system-csprng`, and all five Boolean controls must be `true`.

Construct these files with a small reviewed repository-local Go generator that:

1. loads the existing public halves of the ceremony Ed25519 keys;
2. calls `mpcceremony.NewIdentity` for every identity;
3. assembles `mpcceremony.InitParticipants`, `mpcceremony.InitPolicy`, and
   `mpcceremony.ContributionEnvironment` structs;
4. calls each type's `Validate` method and then
   `mpcceremony.MarshalCanonical`;
5. writes the returned bytes exactly, without adding a newline.

Do not hand-invent public-key fingerprints or serialize maps. Validate the
generated inputs with a fresh rehearsal `init` before freezing production
bytes. `init` uses existing keys; it does not generate identity keys. Omit
`--session-nonce-hex` to let the binary securely generate the required 32-byte
nonce unless an independently generated exact 32-byte lowercase hex nonce has
already been committed.

## Example Paths And Time Rules

Examples derive the authoritative sequence lengths from the signed ceremony;
they never hardcode a final chain index:

```sh
MPC_BIN=./dist/mpc-ceremony
CEREMONY_DIR=/ceremony/public
PRIVATE_DIR=/ceremony/private
CONFIG_DIR=/ceremony/config
CANDIDATE_DIR=/ceremony/candidates
AUDIT_DIR=/ceremony/audits
```

After `init`, derive and freeze the production run-card variables:

```sh
EXPECTED_P1_COUNT=5
EXPECTED_P2_COUNT=5
read -r P1_COUNT P1_MIN P2_COUNT P2_MIN < <(
  node - "$CEREMONY_DIR/ceremony.json" <<'NODE'
const fs = require("node:fs");
const definition = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const p1 = definition.phase1_policy;
const p2 = definition.phase2_policy;
if (!p1 || !p2 || !Array.isArray(p1.participants) ||
    !Array.isArray(p2.participants)) {
  throw new Error("signed ceremony is missing phase participant policies");
}
process.stdout.write(
  `${p1.participants.length} ${p1.minimum} ` +
  `${p2.participants.length} ${p2.minimum}\n`,
);
NODE
)
if [ "$P1_COUNT" -ne "$EXPECTED_P1_COUNT" ] ||
   [ "$P2_COUNT" -ne "$EXPECTED_P2_COUNT" ] ||
   [ "$P1_MIN" -ne "$P1_COUNT" ] ||
   [ "$P2_MIN" -ne "$P2_COUNT" ]; then
  echo "production counts or minimums do not match the approved roster" >&2
  exit 1
fi
P1_FINAL_SEQUENCE=$(printf '%04d' "$P1_COUNT")
P2_FINAL_SEQUENCE=$(printf '%04d' "$P2_COUNT")
P1_FINAL_CHAIN="$CEREMONY_DIR/phase1/chain-$P1_FINAL_SEQUENCE.json"
P1_FINAL_CHAIN_SIGNATURE="$CEREMONY_DIR/phase1/chain-$P1_FINAL_SEQUENCE.sig"
P2_FINAL_CHAIN="$CEREMONY_DIR/phase2/chain-$P2_FINAL_SEQUENCE.json"
P2_FINAL_CHAIN_SIGNATURE="$CEREMONY_DIR/phase2/chain-$P2_FINAL_SEQUENCE.sig"
```

The expected counts above are five for the currently approved production
profile. A future ceremony may set each expectation to another independently
approved value from 2 through 20, but must regenerate its run cards and
count-specific rehearsal, capacity, and governance evidence.

Copy those exact values, the ordered participant IDs, predecessor hashes,
binary hash, and ceremony ID onto the signed run card. Recompute them from the
received signed ceremony on every independent host; do not copy a coordinator's
unverified count or substitute a nominal count such as five or twenty.

Every output path described as fresh must not exist before the command.
Operational timestamps are signed claims and must use observed UTC times; do
not fabricate them. Closure time and beacon schedule are generated inside the
core rather than accepted from the operator. The implementation enforces:

- `contributed-at` is after ceremony creation and the preceding acceptance;
- `destroyed-at` is after that contribution;
- `accepted-at` is after destruction, and acceptances strictly increase;
- `closed-at` is sampled after full replay and is after creation and the final
  acceptance;
- `beacon-not-before` exactly equals the pinned Quicknet round schedule, and a
  second clock check enforces the signed lead plus publication margin before
  atomic closure publication;
- `published-at` is at or after both the not-before time and scheduled round;
- finalization cannot predate Phase 2 beacon publication;
- `audited-at` is UTC and strictly after candidate finalization;
- `released-at` is UTC and cannot predate the latest audit.

Choose comfortably separated actual times. Do not depend on equality at an
accepted boundary.

## Initialize

```sh
"$MPC_BIN" init \
  --key-version ownership-destination-v2 \
  --participants "$CONFIG_DIR/participants.json" \
  --policy "$CONFIG_DIR/policy.json" \
  --coordinator-key-id coordinator-2026 \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --created-at 2026-09-01T00:00:00Z \
  --mode production \
  --out-dir "$CEREMONY_DIR"
```

The exact initial outputs are:

```text
/ceremony/public/ceremony.json
/ceremony/public/ceremony.sig
/ceremony/public/coordinator-public-key.hex
/ceremony/public/ownership-destination.ccs
/ceremony/public/phase1/genesis.bin
/ceremony/public/phase1/chain-0000.json
/ceremony/public/phase1/chain-0000.sig
```

Publish and mirror these artifacts before accepting contributions. Distribute
`coordinator-public-key.hex` over an independent authenticated channel.

The signed roster and policy are immutable. The CLI implements no amendment,
replacement, or skip event: a missing scheduled participant cannot be bypassed
to accept a later one. In production, a withdrawal, no-show, or scheduled
omission requires a new ceremony even after the signed minimum is reached. A
rehearsal may close on an exact accepted prefix after reaching its minimum.
An identity-key or ordering change always requires a new ceremony. Do not claim
that an external note amended the signed genesis.

## Phase 1 Contribution, Erasure, And Acceptance

For the first scheduled participant:

```sh
"$MPC_BIN" phase1 contribute \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --transcript-dir "$CEREMONY_DIR" \
  --chain "$CEREMONY_DIR/phase1/chain-0000.json" \
  --chain-signature "$CEREMONY_DIR/phase1/chain-0000.sig" \
  --participant-id participant-01 \
  --participant-signing-key /secure/participant-01.ed25519.private.hex \
  --environment /secure/participant-01.environment.json \
  --contributed-at 2026-09-01T01:00:00Z \
  --out-dir "$CANDIDATE_DIR/phase1-0001"
```

The fresh candidate contains:

```text
/ceremony/candidates/phase1-0001/contribution.bin
/ceremony/candidates/phase1-0001/attestation.json
/ceremony/candidates/phase1-0001/attestation.sig
```

After copying the public candidate to safe storage and destroying the
ephemeral contribution environment, the participant records that statement:

```sh
"$MPC_BIN" phase1 attest-erasure \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --participant-id participant-01 \
  --participant-signing-key /secure/participant-01.ed25519.private.hex \
  --candidate-dir "$CANDIDATE_DIR/phase1-0001" \
  --destroyed-at 2026-09-01T01:30:00Z
```

This adds:

```text
/ceremony/candidates/phase1-0001/erasure.json
/ceremony/candidates/phase1-0001/erasure.sig
```

Only then may the coordinator accept it:

Coordinator acceptance authenticates the accepted head and verifies the one
new native gnark transition. Participant contribution, phase closure,
finalization, and audit independently replay the complete prefix. Accepted
verification records use
`proof-tool-mpc-contribution-verification-v2` and explicitly name
`direct-transition-from-authenticated-head-v1`; v1 rehearsal records are not
production release evidence.

```sh
"$MPC_BIN" phase1 verify \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --transcript-dir "$CEREMONY_DIR" \
  --chain "$CEREMONY_DIR/phase1/chain-0000.json" \
  --chain-signature "$CEREMONY_DIR/phase1/chain-0000.sig" \
  --candidate-dir "$CANDIDATE_DIR/phase1-0001" \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --accepted-at 2026-09-01T02:00:00Z
```

Acceptance writes:

```text
/ceremony/public/phase1/contributions/0001/contribution.bin
/ceremony/public/phase1/contributions/0001/attestation.json
/ceremony/public/phase1/contributions/0001/attestation.sig
/ceremony/public/phase1/contributions/0001/erasure.json
/ceremony/public/phase1/contributions/0001/erasure.sig
/ceremony/public/phase1/contributions/0001/verification.json
/ceremony/public/phase1/chain-0001.json
/ceremony/public/phase1/chain-0001.sig
```

Publish the accepted chain before inviting the next scheduled participant.
Repeat using the exact new chain and increasing index and timestamps.

Rejected candidates do not enter the authoritative chain. Create a canonical
`governance` record with kind `rejection`, binding the current head and retained
candidate/verifier evidence, then use the `ops` offline-signing workflow and
preserve it in the public incident archive.

## Close, Observe, Record, And Seal Phase 1

After every scheduled Phase 1 contribution is accepted and
`$P1_FINAL_CHAIN` is publicly mirrored, choose a Quicknet round that does not
yet exist and close the phase:

```sh
"$MPC_BIN" phase1 close \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --transcript-dir "$CEREMONY_DIR" \
  --chain "$P1_FINAL_CHAIN" \
  --chain-signature "$P1_FINAL_CHAIN_SIGNATURE" \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --beacon-round "$P1_BEACON_ROUND"
```

This writes:

```text
/ceremony/public/phase1/closure/record.json
/ceremony/public/phase1/closure/record.sig
```

The pinned beacon is drand `v2.1.6`, provider `drand`, network
`quicknet-mainnet`, chain
`52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`,
scheme `bls-unchained-g1-rfc9380`, genesis Unix time `1692803367`, and a
three-second period. Its 96-byte public key is the exact
`beacon_policy.public_key_hex` value shown above.

The CLI derives `beacon_not_before` from the pinned round, samples `closed_at`
only after full replay, and checks the policy lead plus publication margin
again immediately before atomically committing the closure directory. Choose
the round far enough ahead to cover the measured close replay in addition to
the signed witness lead. Immediately mirror and independently timestamp the
atomic directory before the selected round is emitted. A local clock and
signature cannot prove that the closure was publicly observable before the
beacon, so without external observation a dishonest coordinator could still
roll back its host clock or claim a formerly future
round. This operational step is mandatory for production.

Fetch the exact chosen round through independent relays after it is available.
Do not fetch `latest`. Store the raw response exactly as received, without a
newline. The accepted unchained response shape is:

```text
{"round":N,"randomness":"64-lowercase-hex","signature":"96-lowercase-hex"}
```

`previous_signature` must be absent or empty. The beacon command performs no
network access. It verifies the BLS signature against the pinned Quicknet key
and scheme, verifies that `randomness` is SHA-256 of the signature, derives the
domain-separated protocol challenge, and archives the exact response. The
operator cannot supply randomness or a challenge.

```sh
"$MPC_BIN" phase1 beacon \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --closure "$CEREMONY_DIR/phase1/closure/record.json" \
  --closure-signature "$CEREMONY_DIR/phase1/closure/record.sig" \
  --raw-response "/ceremony/incoming/quicknet-phase1-round-${P1_BEACON_ROUND}.json" \
  --published-at "$P1_BEACON_PUBLISHED_AT" \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --transcript-dir "$CEREMONY_DIR"
```

This writes:

```text
/ceremony/public/phase1/beacon/raw-response.bin
/ceremony/public/phase1/beacon/record.json
/ceremony/public/phase1/beacon/record.sig
```

Seal Phase 1:

```sh
"$MPC_BIN" phase1 seal \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --transcript-dir "$CEREMONY_DIR" \
  --closure "$CEREMONY_DIR/phase1/closure/record.json" \
  --closure-signature "$CEREMONY_DIR/phase1/closure/record.sig" \
  --beacon "$CEREMONY_DIR/phase1/beacon/record.json" \
  --beacon-signature "$CEREMONY_DIR/phase1/beacon/record.sig" \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --out-dir "$CEREMONY_DIR/phase1/sealed"
```

This writes:

```text
/ceremony/public/phase1/sealed/commons.bin
/ceremony/public/phase1/sealed/seal.json
/ceremony/public/phase1/sealed/seal.sig
```

Sealing works from independently deserialized inputs because gnark's seal
operation mutates in-memory state. The archived contribution files remain
unchanged.

## Initialize And Run Phase 2

```sh
"$MPC_BIN" phase2 init \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --phase1-transcript-dir "$CEREMONY_DIR" \
  --phase1-seal "$CEREMONY_DIR/phase1/sealed/seal.json" \
  --phase1-seal-signature "$CEREMONY_DIR/phase1/sealed/seal.sig" \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --out-dir "$CEREMONY_DIR/phase2"
```

The fresh Phase 2 outputs are:

```text
/ceremony/public/phase2/genesis.bin
/ceremony/public/phase2/chain-0000.json
/ceremony/public/phase2/chain-0000.sig
```

For the first scheduled Phase 2 participant:

```sh
"$MPC_BIN" phase2 contribute \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --phase1-seal "$CEREMONY_DIR/phase1/sealed/seal.json" \
  --phase1-seal-signature "$CEREMONY_DIR/phase1/sealed/seal.sig" \
  --transcript-dir "$CEREMONY_DIR" \
  --chain "$CEREMONY_DIR/phase2/chain-0000.json" \
  --chain-signature "$CEREMONY_DIR/phase2/chain-0000.sig" \
  --participant-id participant-01 \
  --participant-signing-key /secure/participant-01.ed25519.private.hex \
  --environment /secure/participant-01.environment.json \
  --contributed-at 2026-09-03T01:00:00Z \
  --out-dir "$CANDIDATE_DIR/phase2-0001"
```

The fresh candidate contains:

```text
/ceremony/candidates/phase2-0001/contribution.bin
/ceremony/candidates/phase2-0001/attestation.json
/ceremony/candidates/phase2-0001/attestation.sig
```

After destroying the ephemeral environment:

```sh
"$MPC_BIN" phase2 attest-erasure \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --participant-id participant-01 \
  --participant-signing-key /secure/participant-01.ed25519.private.hex \
  --candidate-dir "$CANDIDATE_DIR/phase2-0001" \
  --destroyed-at 2026-09-03T01:30:00Z
```

This adds:

```text
/ceremony/candidates/phase2-0001/erasure.json
/ceremony/candidates/phase2-0001/erasure.sig
```

Then accept:

As in Phase 1, coordinator acceptance verifies the authenticated new edge.
Participant contribution, closure, finalization, and audit retain full replay.

```sh
"$MPC_BIN" phase2 verify \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --phase1-seal "$CEREMONY_DIR/phase1/sealed/seal.json" \
  --phase1-seal-signature "$CEREMONY_DIR/phase1/sealed/seal.sig" \
  --transcript-dir "$CEREMONY_DIR" \
  --chain "$CEREMONY_DIR/phase2/chain-0000.json" \
  --chain-signature "$CEREMONY_DIR/phase2/chain-0000.sig" \
  --candidate-dir "$CANDIDATE_DIR/phase2-0001" \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --accepted-at 2026-09-03T02:00:00Z
```

Acceptance writes:

```text
/ceremony/public/phase2/contributions/0001/contribution.bin
/ceremony/public/phase2/contributions/0001/attestation.json
/ceremony/public/phase2/contributions/0001/attestation.sig
/ceremony/public/phase2/contributions/0001/erasure.json
/ceremony/public/phase2/contributions/0001/erasure.sig
/ceremony/public/phase2/contributions/0001/verification.json
/ceremony/public/phase2/chain-0001.json
/ceremony/public/phase2/chain-0001.sig
```

Repeat in the exact Phase 2 policy order.

Close after every scheduled Phase 2 contribution:

```sh
"$MPC_BIN" phase2 close \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --phase1-seal "$CEREMONY_DIR/phase1/sealed/seal.json" \
  --phase1-seal-signature "$CEREMONY_DIR/phase1/sealed/seal.sig" \
  --transcript-dir "$CEREMONY_DIR" \
  --chain "$P2_FINAL_CHAIN" \
  --chain-signature "$P2_FINAL_CHAIN_SIGNATURE" \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --beacon-round "$P2_BEACON_ROUND"
```

This writes:

```text
/ceremony/public/phase2/closure/record.json
/ceremony/public/phase2/closure/record.sig
```

Publish and independently timestamp the atomically committed directory before
the chosen, distinct Quicknet round exists. Apply the same post-replay timing
and public-observation requirement as Phase 1. The Phase 1 round must not be
reused.

Record the Phase 2 response:

```sh
"$MPC_BIN" phase2 beacon \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --closure "$CEREMONY_DIR/phase2/closure/record.json" \
  --closure-signature "$CEREMONY_DIR/phase2/closure/record.sig" \
  --raw-response "/ceremony/incoming/quicknet-phase2-round-${P2_BEACON_ROUND}.json" \
  --published-at "$P2_BEACON_PUBLISHED_AT" \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --transcript-dir "$CEREMONY_DIR"
```

This writes:

```text
/ceremony/public/phase2/beacon/raw-response.bin
/ceremony/public/phase2/beacon/record.json
/ceremony/public/phase2/beacon/record.sig
```

There is no separate `phase2 seal` command. Both finalization stages replay
the exact transcript; `finalize prepare` verifies and applies the Phase 2
beacon, and `finalize complete` publishes the signed Phase 2 seal only after
verifying the separate public finalization evidence.

## Exact Reduced Replay Evidence

`finalize prepare`, `finalize complete`, and `audit` require the same reduced,
explicit replay flags:

```text
--transcript-root DIR
--phase1-chain FILE --phase1-chain-signature FILE
--phase1-close FILE --phase1-close-signature FILE
--phase1-beacon FILE --phase1-beacon-signature FILE
--phase1-seal FILE --phase1-seal-signature FILE
--phase2-chain FILE --phase2-chain-signature FILE
--phase2-close FILE --phase2-close-signature FILE
--phase2-beacon FILE --phase2-beacon-signature FILE
```

Do not add a second list of contribution paths. The signed chains name every
accepted contribution, attestation, erasure statement, and verification
record. The engine resolves those names strictly beneath `--transcript-root`.

## Prepare Keys, Generate Public Evidence, And Complete The Candidate

```sh
"$MPC_BIN" finalize prepare \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --transcript-root "$CEREMONY_DIR" \
  --phase1-chain "$P1_FINAL_CHAIN" \
  --phase1-chain-signature "$P1_FINAL_CHAIN_SIGNATURE" \
  --phase1-close "$CEREMONY_DIR/phase1/closure/record.json" \
  --phase1-close-signature "$CEREMONY_DIR/phase1/closure/record.sig" \
  --phase1-beacon "$CEREMONY_DIR/phase1/beacon/record.json" \
  --phase1-beacon-signature "$CEREMONY_DIR/phase1/beacon/record.sig" \
  --phase1-seal "$CEREMONY_DIR/phase1/sealed/seal.json" \
  --phase1-seal-signature "$CEREMONY_DIR/phase1/sealed/seal.sig" \
  --phase2-chain "$P2_FINAL_CHAIN" \
  --phase2-chain-signature "$P2_FINAL_CHAIN_SIGNATURE" \
  --phase2-close "$CEREMONY_DIR/phase2/closure/record.json" \
  --phase2-close-signature "$CEREMONY_DIR/phase2/closure/record.sig" \
  --phase2-beacon "$CEREMONY_DIR/phase2/beacon/record.json" \
  --phase2-beacon-signature "$CEREMONY_DIR/phase2/beacon/record.sig" \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --prepared-at 2026-09-05T00:00:00Z \
  --out-dir "$CEREMONY_DIR/preliminary-final-keys"

CEREMONY_ID="$(
  node -e '
    const fs = require("node:fs");
    const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^sha256:[0-9a-f]{64}$/.test(v.ceremony_id)) process.exit(1);
    process.stdout.write(v.ceremony_id);
  ' "$CEREMONY_DIR/ceremony.json"
)"

/independently-built/mpc-finalization-evidence \
  --keys-dir "$CEREMONY_DIR/preliminary-final-keys" \
  --ceremony-id "$CEREMONY_ID" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --out "$CEREMONY_DIR/public-finalization-evidence.json"

"$MPC_BIN" finalize complete \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --transcript-root "$CEREMONY_DIR" \
  --phase1-chain "$P1_FINAL_CHAIN" \
  --phase1-chain-signature "$P1_FINAL_CHAIN_SIGNATURE" \
  --phase1-close "$CEREMONY_DIR/phase1/closure/record.json" \
  --phase1-close-signature "$CEREMONY_DIR/phase1/closure/record.sig" \
  --phase1-beacon "$CEREMONY_DIR/phase1/beacon/record.json" \
  --phase1-beacon-signature "$CEREMONY_DIR/phase1/beacon/record.sig" \
  --phase1-seal "$CEREMONY_DIR/phase1/sealed/seal.json" \
  --phase1-seal-signature "$CEREMONY_DIR/phase1/sealed/seal.sig" \
  --phase2-chain "$P2_FINAL_CHAIN" \
  --phase2-chain-signature "$P2_FINAL_CHAIN_SIGNATURE" \
  --phase2-close "$CEREMONY_DIR/phase2/closure/record.json" \
  --phase2-close-signature "$CEREMONY_DIR/phase2/closure/record.sig" \
  --phase2-beacon "$CEREMONY_DIR/phase2/beacon/record.json" \
  --phase2-beacon-signature "$CEREMONY_DIR/phase2/beacon/record.sig" \
  --coordinator-signing-key "$PRIVATE_DIR/coordinator.ed25519.private.hex" \
  --public-evidence "$CEREMONY_DIR/public-finalization-evidence.json" \
  --finalized-at 2026-09-05T00:00:01Z \
  --out-dir "$CEREMONY_DIR/final-candidate"
```

The separately built helper accepts only preliminary public keys, ceremony ID,
and the coordinator public key. It uses the repository's committed golden
witness and must never accept a seed, master XPrv, derivation path, wallet
secret, or arbitrary witness input. Hash and independently verify the helper
binary before use. Preserve the preliminary directory, helper result JSON,
helper executable hash, and timing as immutable evidence. A missing, changed,
or non-verifying public-evidence file prevents `finalize complete`.

The fresh coordinator-signed, unsigned-for-release candidate contains exactly
these root artifacts:

```text
/ceremony/public/final-candidate/candidate.json
/ceremony/public/final-candidate/candidate.sig.json
/ceremony/public/final-candidate/verification-report.json
/ceremony/public/final-candidate/public-finalization-evidence.json
/ceremony/public/final-candidate/ownership.pk
/ceremony/public/final-candidate/ownership.vk
/ceremony/public/final-candidate/ownership-destination.ccs
/ceremony/public/final-candidate/cardano-vk.bin
/ceremony/public/final-candidate/cardano-vk.hex
/ceremony/public/final-candidate/cardano-vk-format.txt
/ceremony/public/final-candidate/candidate-checksums.sha256
/ceremony/public/final-candidate/phase2-seal.json
/ceremony/public/final-candidate/phase2-seal.sig.json
```

The candidate does **not** contain `manifest.json` or
`setup-transcript.json`; those release artifacts are created only after
independent audits. Do not deploy or distribute the candidate as a signed key
release.

`public-finalization-evidence.json` is intentionally public and contains only
the 28-byte credential, 58-byte destination, derived public-input digest, and
exact 336-byte Cardano proof. It contains no seed, master XPrv, derivation
path, or wallet key. `verification-report.json` records SHA-256 and
BLAKE2b-256 hashes of the raw proof and of the complete evidence file;
`candidate.json` hash-binds both the report and evidence plus the exact final
Cardano VK.

Before either auditor signs, run the dynamic Plutus verifier against this
exact candidate:

```sh
scripts/verify-mpc-final-plutus-evidence.sh \
  "$CEREMONY_DIR/final-candidate" \
  /independently-built/verify-destination-proof
```

The command requires the positive vector to pass and rejects mutations of the
destination, credential, public-input digest, proof, and VK, plus truncated and
appended proof/VK encodings. It emits one JSON evidence record binding the
verifier executable, report, public vector, proof, and VK hashes. Preserve
that JSON and the command timing in the immutable ceremony evidence package.
If no verifier path is supplied, the script resolves the executable with
`cabal list-bin` from `contracts/ownership-verifier`; production should pass
an independently built, pre-hashed executable explicitly.

## Independent Audits

At least two enrolled auditors under independent control fetch the full
transcript and candidate from independently checked mirrors. Each uses its own
private signing key and fresh output paths. Example for `auditor-01`:

```sh
"$MPC_BIN" audit \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --transcript-root "$CEREMONY_DIR" \
  --phase1-chain "$P1_FINAL_CHAIN" \
  --phase1-chain-signature "$P1_FINAL_CHAIN_SIGNATURE" \
  --phase1-close "$CEREMONY_DIR/phase1/closure/record.json" \
  --phase1-close-signature "$CEREMONY_DIR/phase1/closure/record.sig" \
  --phase1-beacon "$CEREMONY_DIR/phase1/beacon/record.json" \
  --phase1-beacon-signature "$CEREMONY_DIR/phase1/beacon/record.sig" \
  --phase1-seal "$CEREMONY_DIR/phase1/sealed/seal.json" \
  --phase1-seal-signature "$CEREMONY_DIR/phase1/sealed/seal.sig" \
  --phase2-chain "$P2_FINAL_CHAIN" \
  --phase2-chain-signature "$P2_FINAL_CHAIN_SIGNATURE" \
  --phase2-close "$CEREMONY_DIR/phase2/closure/record.json" \
  --phase2-close-signature "$CEREMONY_DIR/phase2/closure/record.sig" \
  --phase2-beacon "$CEREMONY_DIR/phase2/beacon/record.json" \
  --phase2-beacon-signature "$CEREMONY_DIR/phase2/beacon/record.sig" \
  --candidate-bundle "$CEREMONY_DIR/final-candidate" \
  --auditor-id auditor-01 \
  --auditor-signing-key /secure/auditor-01.ed25519.private.hex \
  --audited-at 2026-09-06T00:00:00Z \
  --out "$AUDIT_DIR/auditor-01.json" \
  --audit-signature "$AUDIT_DIR/auditor-01.sig"
```

Run the same complete invocation independently for `auditor-02`, changing the
auditor id, key, later UTC timestamp, and fresh output paths to
`/ceremony/audits/auditor-02.json` and `.sig`.

An audit independently compiles the destination-v2 circuit, authenticates and
replays both phases, verifies both raw Quicknet responses, reproduces native
keys and Cardano export, and checks candidate coherence. A coordinator
self-audit does not count toward the required independent reports. Auditors
should additionally run the production release gates below from a clean source
checkout.

## Atomic Release And Verification

Production release is fail-closed on one coordinator-signed
`proof-tool-mpc-operational-evidence-bundle-v1`. It content-addresses:

- proof-of-possession enrollments from the coordinator, release signer, every
  auditor, every scheduled participant, and each external witness and mirror
  operator used;
- each coordinator-signed accepted chain and, for every authenticated accepted
  head in both phases, the coordinator-to-participant predecessor/input
  handoff and participant receipt, the participant-to-coordinator
  candidate-output handoff and coordinator receipt, and the coordinator-signed
  exact chain prefix through that acceptance. At least two distinct enrolled
  immutable mirrors must receipt the accepted output evidence and that exact
  chain-prefix record/signature;
- at least two distinct enrolled public witnesses per phase. Witness identity,
  key ID, and public key must not overlap any ceremony actor. Observation must
  be after closure and at least the definition's signed lead time before the
  beacon round; production definitions require at least 24 hours;
- at least three cryptographically verified raw beacon responses per phase
  from distinct relay IDs, endpoint hashes, and operator IDs. Three hostnames
  run by one operator do not qualify. Use independently operated official
  relays—for example drand.sh, Cloudflare, and SecureWeb3—and retain each exact
  endpoint hash and raw response;
- signed incident, rejection, abort, and restart records. A restart binds the
  old ceremony and accepted head plus evidence and names a distinct new
  ceremony ID.

Signatures make disclosures accountable and substitutions detectable. They
cannot prove that organizations or hosts are actually independent; reviewing
those disclosures and the public timestamps remains an external governance
gate.

Private Ed25519 seeds need not be present on the online host. Export exact
canonical bytes and a digest:

```sh
"$MPC_BIN" ops export-signing \
  --record-type enrollment \
  --record "$OPS_DRAFTS/participant-01.enrollment.json" \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --out-dir "$OFFLINE_EXPORT/participant-01-enrollment"
```

After the offline device checks `signing-request.json` and signs the exact
`canonical.json` bytes with Ed25519, import either 64 raw signature bytes or
their 128-character lowercase hexadecimal encoding:

```sh
"$MPC_BIN" ops import-signature \
  --record-type enrollment \
  --canonical "$OFFLINE_EXPORT/participant-01-enrollment/canonical.json" \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --signer-public-key-file /trusted/participant-01.ed25519.public.hex \
  --raw-signature "$OFFLINE_RETURN/participant-01.sig.raw" \
  --out "$OPS_EVIDENCE/enrollments/participant-01.sig"
```

Run `ops verify` on each arrival; each directional receiver receipt additionally
requires `--related-record` naming its exact canonical handoff. Finally use the
same export/import flow with record type `evidence-bundle`. Missing enrollment,
accepted-chain, accepted-head, mirror, witness, relay-operator, or raw-response
evidence must prevent production release and is not an operator exception.

The distinct release signer supplies at least two report/signature pairs in
matching order:

```sh
"$MPC_BIN" release sign \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --candidate-bundle "$CEREMONY_DIR/final-candidate" \
  --audit-report "$AUDIT_DIR/auditor-01.json" \
  --audit-signature "$AUDIT_DIR/auditor-01.sig" \
  --audit-report "$AUDIT_DIR/auditor-02.json" \
  --audit-signature "$AUDIT_DIR/auditor-02.sig" \
  --operational-evidence-root "$CEREMONY_DIR" \
  --operational-bundle "$CEREMONY_DIR/operational/evidence-bundle.json" \
  --operational-bundle-signature "$CEREMONY_DIR/operational/evidence-bundle.sig" \
  --release-signing-key "$PRIVATE_DIR/release.ed25519.private.hex" \
  --signature-key-id mainnet-mpc-release-20260907 \
  --released-at 2026-09-07T00:00:00Z \
  --release-dir "$CEREMONY_DIR/release"
```

The command stages and validates the entire tree before atomically publishing
the fresh release directory. For two audits, its fixed root is below; it also
contains every verified operational artifact under its original logical path
(`operational/`, accepted `phase1/`/`phase2/` chain prefixes, payloads,
contribution evidence, and closures). `checksums.sha256` enumerates the exact
complete tree, and `release verify` rejects a missing or extra entry:

```text
/ceremony/public/release/ownership-destination.ccs
/ceremony/public/release/ownership.pk
/ceremony/public/release/ownership.vk
/ceremony/public/release/cardano-vk.bin
/ceremony/public/release/cardano-vk.hex
/ceremony/public/release/cardano-vk-format.txt
/ceremony/public/release/verification-report.json
/ceremony/public/release/public-finalization-evidence.json
/ceremony/public/release/phase2-seal.json
/ceremony/public/release/phase2-seal.sig.json
/ceremony/public/release/candidate.json
/ceremony/public/release/candidate.sig.json
/ceremony/public/release/candidate-checksums.sha256
/ceremony/public/release/setup-transcript.json
/ceremony/public/release/manifest.json
/ceremony/public/release/manifest.sig
/ceremony/public/release/manifest-public-key.hex
/ceremony/public/release/audits/0001.json
/ceremony/public/release/audits/0001.sig
/ceremony/public/release/audits/0002.json
/ceremony/public/release/audits/0002.sig
/ceremony/public/release/operational/evidence-bundle.json
/ceremony/public/release/operational/evidence-bundle.sig
/ceremony/public/release/operational/...
/ceremony/public/release/phase1/...
/ceremony/public/release/phase2/...
/ceremony/public/release/checksums.sha256
```

The atomic release is self-contained for candidate, audit, key, final
transcript, manifest, and checksum artifacts. It intentionally does not bundle
`ceremony.json`, `ceremony.sig`, or the coordinator trust key. Verification
therefore still requires the externally archived signed ceremony, its
out-of-band coordinator public key, and the out-of-band release public key.
Publish only the complete atomic release directory together with stable
references to those external trust anchors.

Verify it using a release public key obtained out of band, not the public key
bundled next to the manifest:

```sh
"$MPC_BIN" release verify \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --keys-dir "$CEREMONY_DIR/release" \
  --manifest-public-key-file /trusted/release.ed25519.public.hex \
  --signature-key-id mainnet-mpc-release-20260907
```

`release verify` has no transcript-root flag. It authenticates the release
signer from the out-of-band key and strictly verifies the bundled transcript,
audit evidence, candidate signature, native keys, Cardano export, manifest,
and checksums against the externally supplied signed ceremony and trust
anchors.

## Participant Host Controls

Every participant must independently verify the signed ceremony, exact current
chain, binary hash, and its scheduled index before contributing. Use a
participant-controlled physical host or stateless live environment where
practical. If using a VM, the participant must control the hypervisor and
prevent snapshots and memory inspection.

Required controls include:

- a reviewed/hash-pinned binary and a healthy initialized OS CSPRNG;
- disabled swap, hibernation, core dumps, crash collectors, kdump, tracing,
  profiling, telemetry, support bundles, memory-capturing EDR, and snapshots;
- encrypted ephemeral storage, sufficient RAM/disk, and no shell tracing or
  process/environment dumps;
- only public ceremony inputs and the participant identity signing key;
- no wallet, seed, XPrv, derivation path, or recovery secret;
- post-output destruction of the process, ephemeral volume, swap key,
  snapshots, temporary media, and staging copies.

Sign the public contribution and erasure records from a separate identity-key
system if possible. Process exit and file deletion are not evidence of memory
erasure; destruction remains an operational attestation.

## Abort, Retry, Fork, And Roster Rules

- A local failure before publication may be retried from the same accepted head
  with fresh OS randomness after destroying the failed environment.
- A coordinator publication command interrupted by process or host failure may
  be rerun only with the identical original arguments. The CLI resumes an
  exact, authenticated publication prefix and removes only its recognized
  unpublished temporary files; any mismatching or unexpected artifact halts
  the retry. Never repair a partial publication by hand.
- A published but unaccepted candidate may be retained outside the transcript
  with a signed `governance` rejection record binding its evidence hashes.
- The scheduled participant at the next index cannot be skipped in favor of a
  later participant. In production, withdrawal, replacement, no-show, omission,
  or order change requires a new ceremony even after an accepted prefix exists.
  A rehearsal may close on an exact accepted prefix after its signed minimum is
  reached. Signed amendments are not implemented.
- Two candidate outputs from one predecessor form a fork and cannot be merged.
  Once one is accepted, the other is stale. Bind the selected head and both
  candidate evidence hashes in a signed `governance` incident or rejection.
  If equivocation or selection is disputed, halt and restart.
- Any invalid update proof, hash mismatch, malformed/trailing data, signature
  failure, rollback, unexplained equivocation, or missing accepted artifact
  halts the ceremony.
- Resume only from the last fully verified public head when the immutable
  policy and history remain unambiguous. Restart the ceremony if roster,
  policy, genesis, software, circuit/domain, accepted history, or coordinator
  provenance is uncertain.
- A circuit change invalidates Phase 2. A domain change invalidates Phase 1 as
  well. A serialization or dependency change requires a new frozen ceremony
  unless a separately reviewed migration proves exact compatibility.

Never overwrite, delete, reorder, or silently renumber a published artifact.
Production release-directory publication is qualified on Linux, where the CLI
uses kernel `RENAME_NOREPLACE`; non-Linux directory rename is retained only for
development portability and is not a production ceremony publication path.

## Capacity Planning

At `K=21`, Phase 1 genesis is `603,980,121` bytes and each contribution is
`603,980,153` bytes. Genesis plus 20 accepted outputs are
`12,683,583,181` bytes (about 11.8 GiB), and the self-contained release copies
each unique operationally referenced payload once. Budget separately for the
working transcript, candidates, release copy, mirrors, replay scratch, and
failed attempts; do not size only for the final PK/VK.

Participant creation deliberately replays the complete accepted prefix before
sampling entropy. Participant 20 therefore needs `12,079,603,028` Phase 1
input bytes locally before producing its `603,980,153`-byte output. Across 20
independent hosts, prefix inputs total about 126.8 GB before uploads, mirrors,
and later full replays. A head-only custody transfer does not remove that
prefix synchronization requirement. Phase 2 is circuit-dependent; the current
destination proving key alone is approximately 1.3 GB and exact Phase 2
retained, transfer, replay, and release sizes must come from the frozen
rehearsal.

Those 20-participant figures describe the maximum supported envelope, not the
currently scheduled ceremony. With five Phase 1 participants, genesis plus
five accepted outputs are `3,623,880,886` bytes, participant five receives a
`3,019,900,733`-byte prefix, and cumulative prefix inputs across the five hosts
are `9,059,702,135` bytes (about 9.06 GB). The five-party production schedule
and its safety margins must be based on a complete five-party `K=21`
rehearsal. A later ceremony with a larger signed roster requires capacity
qualification for that scheduled count.

Before production:

- run a small-domain complete rehearsal;
- run a full `K=21` rehearsal using the exact frozen binary/circuit and the
  planned production phase count—five genuinely independent contributors for
  the current Mainnet profile;
- exercise count-boundary and inventory behavior at 2 and 20 participants to
  preserve the declared supported range, without treating a structural
  maximum-count test as capacity approval for a future 20-party ceremony;
- measure state sizes, peak RAM, wall time, temporary disk, and transfer time;
- provision participants for several times the largest measured input/output
  and coordinators/auditors for all immutable states, mirrors, native keys, and
  replay scratch;
- maintain at least two independently operated archive copies.

Use 10 GB free space on participant hosts and 100 GB on
coordinator/auditor hosts only as initial planning floors. Replace them with
measured `K=21` requirements plus a governance-approved safety margin before
production. At minimum, reserve effective RAM equal to the larger of twice
measured peak RSS or peak RSS plus 16 GiB; starting free disk equal to measured
maximum consumption plus the larger of 100 GiB or twice the largest atomic
output; ten times measured peak inode use; and contribution/failover windows
three times the measured p95. Record absolute and percentage headroom. A floor
copied from this document without the exact rehearsal measurements is not
capacity approval.

### Exact K=21 Local Rehearsal Harness

The staged local harness exercises the exact compiled
`ownership-destination-v2` circuit through the released CLI, retains every
native state, measures every command with `/usr/bin/time -v`, finalizes native
PK/VK and Cardano output, runs two signed audits, signs the release, and runs
`release verify`. Before either local auditor runs, `finish` also executes the
dynamic Plutus verifier over the exact hash-bound public finalization vector
and all required mutation negatives.

It deliberately refuses every stage below configurable measured floors or on
an unqualified/non-local filesystem. The probe evaluates remaining bytes and
inodes, host and cgroup-effective memory, configured/active swap, open-file and file-size
limits, quota visibility, sustained write+fsync/read rates, and no-clobber
publication collisions:

```sh
MPC_K21_MIN_FREE_BYTES="$APPROVED_FREE_FLOOR" \
MPC_K21_MIN_AVAILABLE_MEMORY_BYTES="$APPROVED_RAM_FLOOR" \
MPC_K21_MIN_FREE_INODES="$APPROVED_INODE_FLOOR" \
MPC_K21_MIN_WRITE_BYTES_PER_SECOND="$APPROVED_WRITE_FLOOR" \
MPC_K21_MIN_READ_BYTES_PER_SECOND="$APPROVED_READ_FLOOR" \
MPC_K21_REQUIRE_SWAP_DISABLED=1 \
MPC_K21_REQUIRE_QUOTA_VISIBILITY="$QUOTAS_MUST_BE_VISIBLE" \
scripts/check-mpc-k21-capacity.sh "$QUALIFIED_WORK_PARENT" |
  tee "$CAPACITY_EVIDENCE"
```

Defaults are 100 GiB remaining, 16 GiB effective available RAM, 100,000 free
inodes, a 4,096-file soft limit, a 16 GiB file-size limit, and 20 MiB/s for
both 256 MiB direct-I/O fsync-write and read probes. Those are rehearsal admission floors,
not measured production approval. The starting volume must hold all retained
transcript, candidate, audit, release, and failed-attempt data in addition to
the configured remaining-space floor. Set `QUOTAS_MUST_BE_VISIBLE=1` only when
the approved volume uses an enforced user/project quota; otherwise keep it
zero and retain the recorded `mount_options`/`quota_visibility` observation.
`prepare` saves its successful probe as
`measurements/prepare-capacity.txt` and binds it into the completed-stage
manifest; later stages re-run the same admission probe before mutation.

Start with a fresh root and the byte-reproducible rehearsal binary:

```sh
scripts/run-mpc-k21-local-rehearsal.sh \
  prepare "$FRESH_REHEARSAL_ROOT" "$MPC_BIN" 5
```

The helper creates CSPRNG-backed, same-host Ed25519 identities and canonical
configuration strictly for this local rehearsal. Those private identity keys
remain below `control/keys/`, must not be published, and are not production
enrollment. They are never wallet, seed-phrase, master-XPrv, or recovery keys.
Minimal/offline runners may prebuild the same coordinator-only helper and set
`MPC_REHEARSAL_CONFIG_BIN` to its absolute path during `prepare`. The harness
rejects a symlink or non-executable file and records the helper mode and
SHA-256 under `state/`; without the variable it records a digest of the
repository helper source used by `go run`. `prepare` also builds and
SHA-256-binds the same-host operational-evidence helper into `control/tools/`;
minimal runners may instead supply
`MPC_REHEARSAL_OPERATIONAL_EVIDENCE_BIN`. This helper exists only to exercise
the complete evidence/release path with disclosed same-host witness and mirror
identities; it is not a production enrollment, custody, independence, or
public-observation tool.

Complete the expensive Phase 1 contribution work before selecting a beacon:

```sh
scripts/run-mpc-k21-local-rehearsal.sh \
  phase1-contribute "$FRESH_REHEARSAL_ROOT" "$MPC_BIN"
```

Then select a Quicknet round far enough ahead for both the measured full close
replay and the recorded rehearsal witness lead, and close Phase 1. The signed
lead default is 300 seconds and the harness refuses values below 60 seconds;
the selected round must be farther away than that when close replay is
non-trivial. Set
`MPC_REHEARSAL_BEACON_LEAD_SECONDS` only during `prepare`, and retain
`state/beacon-lead-seconds.txt`. This shortened same-host rehearsal delay does
not weaken the signed production policy's 24-hour minimum:

```sh
scripts/run-mpc-k21-local-rehearsal.sh \
  phase1-close "$FRESH_REHEARSAL_ROOT" "$MPC_BIN" "$PHASE1_FUTURE_ROUND"
```

Publish and independently timestamp the signed closure before the round
exists. After the round, compare the response obtained through independently
operated relays, preserve one exact raw response, and resume:

```sh
scripts/run-mpc-k21-local-rehearsal.sh \
  phase1-beacon "$FRESH_REHEARSAL_ROOT" "$MPC_BIN" \
  "$PHASE1_RAW_RESPONSE" "$PHASE1_PUBLISHED_AT"
```

Complete Phase 2 contributions, then select and close on a distinct round:

```sh
scripts/run-mpc-k21-local-rehearsal.sh \
  phase2-contribute "$FRESH_REHEARSAL_ROOT" "$MPC_BIN"

scripts/run-mpc-k21-local-rehearsal.sh \
  phase2-close "$FRESH_REHEARSAL_ROOT" "$MPC_BIN" "$PHASE2_FUTURE_ROUND"

scripts/run-mpc-k21-local-rehearsal.sh \
  finish "$FRESH_REHEARSAL_ROOT" "$MPC_BIN" \
  "$PHASE2_RAW_RESPONSE" "$PHASE2_PUBLISHED_AT" \
  "$PHASE1_RELAY_DIR" "$PHASE2_RELAY_DIR"
```

Each relay directory is supplied explicitly and contains `relays.tsv` plus the
named raw JSON files. The header is exactly:

```text
relay_id	operator_id	endpoint_sha256	retrieved_at	filename
```

Provide 3-16 rows sorted or unsorted by relay ID; the helper canonicalizes
them and rejects duplicated relay, operator, or endpoint identities, unsafe
names, retrievals before the committed round, invalid drand responses, or
disagreement. `endpoint_sha256` is `sha256:` plus 64 lowercase hexadecimal
characters, and every `retrieved_at` is RFC3339 UTC. The harness binds both
relay manifests before generation, emits signed enrollments, bidirectional
custody handoffs/receipts, exact accepted-chain prefixes, two mirror receipts
per head, two pre-round witness receipts per phase, and multi-relay evidence,
then independently runs `ops verify --record-type evidence-bundle`. The
release command receives the mandatory operational root, bundle, and bundle
signature flags and copies every verified reference into the release.

For a minimal/offline runner without Cabal, set
`MPC_PLUTUS_VERIFIER_BIN=/absolute/path/to/verify-destination-proof` during
`finish`. The harness rejects a symlink or non-executable path, and the
`final-plutus-evidence` JSON result records its SHA-256. Failure of the
positive contract check or any required negative prevents audits, signing,
`release verify`, and the `finish.complete` marker.

The harness performs no network access. Each completed step has a strict
artifact allowlist; its result JSON and every generated transcript, candidate,
audit, and release artifact are SHA-256-bound in resume markers.
Operator-supplied step timestamps are persisted before invocation and failed
timing attempts are preserved; phase closure time is instead sampled by the
core after full replay and recovered from the signed atomic closure. Inspect
without running a capacity probe, writing markers, or invoking a ceremony
command:

```sh
scripts/run-mpc-k21-local-rehearsal.sh \
  inspect "$FRESH_REHEARSAL_ROOT" "$MPC_BIN"
```

`inspect` fails on a changed/missing artifact, unsafe marker, binary mismatch,
or unbound legacy step. A later mutable stage can upgrade an already-running
pre-hardening rehearsal only after hashing its exact allowlisted artifacts;
`inspect` never upgrades state. New step markers store only root-relative
measurement paths, so an exact full-root restore can be inspected at a
different absolute mount path; changing any restored byte still fails. Stage
manifests also bind every persisted per-step runner epoch and, at the relevant
boundary, the selected beacon round/epoch, signed closure epoch, and recorded
publication time/epoch.

The lightweight wrapper self-tests run without compiling the circuit or
allocating K=21 transcripts:

```sh
scripts/run-mpc-k21-local-rehearsal.sh self-test-state
scripts/run-mpc-k21-local-rehearsal.sh self-test-close-recovery
```

The close-recovery test executes the production close-stage state machine
against already-published stand-in closure files. It covers recovery after the
round deadline, different-round rejection, malformed-closure rejection, and
Phase 2 round-reuse rejection. Its process boundary is `/bin/false`, proving
that recovery adopts the captured successful result without rerunning the
ceremony binary. This is parser and wrapper-state coverage only; the Go
integration tests cover closure signature and transcript verification, and
the exact K=21 rehearsal remains required for resource and end-to-end
evidence.

Create a fresh public evidence directory after each publishable milestone.
This fail-closed packager copies only an explicit public allowlist, rejects
symlinks and private-material names/markers, and hashes every package payload:

```sh
scripts/package-mpc-public-evidence.sh \
  create "$FRESH_REHEARSAL_ROOT" "$FRESH_PUBLIC_PACKAGE"
scripts/package-mpc-public-evidence.sh verify "$FRESH_PUBLIC_PACKAGE"
```

Externally witness the printed `SHA256SUMS` digest. Private control keys remain
outside the package. Raw GNU `time` reports, command-result captures, retained
directory reports, and filesystem-capacity reports remain private operational
records because they can contain command lines or absolute host paths. The
package instead contains a deterministic numeric-only
`measurements/command-resources.tsv` with wall time, CPU time, peak RSS,
filesystem counters, and exit status, plus root-relative non-secret artifact
sizes. `package-mpc-public-evidence.sh verify` rejects command-line/private-key
markers and Unix, Windows, UNC, or `file://` absolute host paths in all
publishable text.

This same-host harness is strong software-path and capacity evidence only. It
does not satisfy independent participant, auditor, build-host, public-witness,
or erasure gates. For the current Mainnet profile, five genuinely independent
contributor hosts must repeat the same `K=21` flow before production, and all
scheduled production participants must execute the live ceremony.

### Count-Derived Production Run Cards

Generate separate Phase 1 and Phase 2 cards directly from the verified signed
`phase1_policy.participants` and `phase2_policy.participants` arrays. Each row
contains phase, one-based index, exact participant ID and key fingerprint,
predecessor chain path/hash, candidate hash, erasure-attestation hash,
verification result, accepted chain path/hash, operator, witnessed publication
URI, and UTC start/end. The header binds the ceremony ID, policy, binary and
R1CS hashes, the derived final-chain variables above, and `minimum == count`
for that phase. For the currently planned Mainnet ceremony, both phase counts
are five and both signed minimums are five.

The coordinator and participant sign the completed row before the next
participant is invited. Never copy, renumber, skip, or complete a row from a
nominal roster. Phase 2 gets a separate card even if its order matches Phase
1. Auditors compare all Phase 1 plus Phase 2 rows with both signed chains and
mirrors: ten rows for the current five-party profile and at most forty rows at
the supported ceiling.

### Restore And Failover Drill

Complete this drill against the frozen exact-circuit rehearsal and attach all
hashes, commands, timings, and operator signatures:

1. Stop at a fully accepted, publicly mirrored head. Package and verify public
   evidence, record head/package hashes, and accept no new contribution.
2. Restore the immutable public tree plus the content-bound non-public harness
   state/tooling on a separately administered qualified host. Recover
   coordinator signing authority only through the approved secure process; it
   never enters the public package. A public package alone is verification
   evidence, not a resumable private control root.
3. Verify the frozen binary out of band, run the capacity probe with production
   floors, run read-only `inspect`, and compare the derived next
   participant/index with the primary run card.
4. Re-run the last completed command with identical arguments and confirm it
   skips only after result and artifact verification. In a rehearsal, inject
   one pre-publication process failure, retain its failed timing evidence, and
   recover from the last fully verified head.
5. Build a fresh public package on the failover host and require matching
   payload hashes. An independent operator signs the drill result before
   resumption.

An ambiguous partial publication, marker mismatch, different next
participant, missing signing authority, or non-matching public package is an
abort, never permission to repair files by hand. Record recovery-point and
recovery-time results and provision at least three times measured failover
duration before the next participant window.

## Immutable Public Archive

Archive and mirror:

- signed genesis, roster/policy inputs, public keys, frozen R1CS/CCS, source
  tag, build recipe, binary hashes, and frozen command help;
- every accepted contribution, attestation, erasure statement, verification
  record, chain document, independent hash announcement, and operational
  incident record;
- the signed operational bundle, proof-of-possession enrollments and
  disclosures, both directional custody pairs for every head, signed prefixes,
  immutable-mirror receipts, public-witness quorum records, and all multi-relay
  observations/raw responses;
- both signed closures, independently witnessed publication evidence, exact
  raw beacon responses, signed beacon records, and pinned trust roots;
- Phase 1 commons/seal, Phase 2 genesis, final candidate, independent audit
  reports, complete atomic release, and release-verification report;
- participant handling attestations, test reports, and final acceptance
  statement.

Use content-addressed objects with at least two independent mirrors and an
append-only transparency mechanism. A convenience `latest` pointer is never a
trust root. Do not publish participant IP addresses, hostnames, or sensitive
environment details without consent.

## Production Release Gates

The release signer must reject the candidate unless:

- production source and dependencies were reviewed and frozen at a clean signed
  commit, with reproducible binary hashes;
- a complete exact-circuit `K=21` rehearsal measured resources and transfers
  with multiple independent contributors;
- curve, backend, domain, R1CS/CCS, circuit id, key version, source commit,
  tool, Go, gnark, gnark-crypto, and drand identities match genesis;
- every scheduled participant in each production phase was accepted in exact
  order, with no unresolved rejection, omission, or fork;
- every contribution, update proof, attestation, erasure statement,
  verification, acceptance, closure, beacon, chain, and seal verifies;
- the coordinator-signed operational bundle covers every enrolled actor,
  directional custody pair, exact accepted prefix, two independent mirrors
  per head, public-witness quorum, and at least three independent
  relay/operator/endpoint responses in each phase;
- both future beacon closures were publicly mirrored and independently
  timestamped before their distinct rounds existed, and both responses verify
  against the pinned Quicknet trust root;
- at least two independent auditors reproduce byte-identical commons, native
  PK/VK, Cardano verifier export, transcript roots, and candidate checks;
- the atomic release contains the candidate, both signed audits, final
  transcript, signed manifest, and exact checksums, and `release verify` passes
  with the out-of-band release key;
- repository signed-key-bundle, frozen-CCS, proof-asset, deployment, and
  contract coherence checks pass;
- real derive/prove/verify/Cardano-export and contract-path tests pass,
  including negative tests for wrong destination, public input, proof, VK,
  transcript order, beacon, circuit, domain, signature, truncation, and
  appended bytes;
- `pnpm test:all` and the exercised BLS12-381 MPC test suite pass;
- participant handling evidence, immutable mirrors, incident procedure, and
  final acceptance report are public.

Passing these gates gives reviewable production ceremony evidence. It does not
turn participant erasure claims or coordinator timestamps into cryptographic
proof.

## Canonical Production Decision

The machine-verifiable `proof-tool-mpc-production-decision-v1` record is a
post-release decision. Create it only after the final signed release,
operational bundle, both enrolled-auditor reports, two separately signed
external-review reports, exact K=21 rehearsal package, Mainnet deployment
plan, and formal Markdown checklist exist. Earlier readiness reviews remain
`NO-GO` working documents; they are not a substitute for this final-release
record.

The decision binds:

- the ceremony, candidate, and content-derived release IDs;
- the immutable URI, logical name, SHA-256, BLAKE2b-256, and size of every
  file in the exact release directory, including PK, VK, CCS, Cardano export,
  candidate, final transcript, reports, public evidence, manifest,
  signatures, and both checksum files;
- the source commit, signed annotated tag, exact OpenPGP v4 primary-key
  fingerprint, and SHA-256 of the complete archived tag object;
- the signed operational bundle and two enrolled-auditor records;
- exactly two external reviewers with distinct identities and keys, each
  signing the exact bytes of its pinned report;
- the exact `ownership-destination-v2`, BLS12-381, Groth16, K=21 rehearsal;
- the Mainnet deployment plan and formal Markdown checklist; and
- all 14 repository, ceremony, participant, witness, mirror, and attendance
  gates as explicit `PASS`, `FAIL`, or `PENDING` values.

The verifier never downloads a URI. Assemble one local evidence root whose
relative paths match every logical artifact name. The release `artifacts`
array must be the complete release-directory inventory in lexical logical-name
order. The bounded inventory permits up to 4,096 files, which covers the
per-head operational evidence for both phases at the supported 20-party
ceiling within the CLI's 16 MiB canonical-record limit. An extra, missing, symlinked,
non-regular, or changed release file is a verification failure.

Author a strict canonical
`proof-tool-mpc-production-decision-draft-v1` JSON record. The draft contains
the fields above but deliberately omits `release_id` and `decision_id`; the
tool derives both:

```sh
"$MPC_BIN" decision prepare \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --draft /governance/production-decision.draft.json \
  --out /governance/production-decision.json
```

Distribute the exact prepared decision, evidence root, signed ceremony, and
trusted coordinator key independently to the coordinator, both enrolled
auditors named in the decision, and release signer. For a `GO`, each signer
runs `decision sign` with its own independently verified local evidence root.
The command verifies all public evidence before loading the signing key:

```sh
"$MPC_BIN" decision sign \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --decision /governance/production-decision.json \
  --evidence-root /independent/local/evidence-root \
  --role auditor \
  --signer-id auditor-01 \
  --signing-key /secure/auditor-01.ed25519.private.hex \
  --out /governance/auditor-01.decision.sig.json
```

Use `--role coordinator` for the coordinator and `--role release_signer` for
the release signer. A signed `NO-GO` may omit `--evidence-root` so an
accountable role can record a fail-closed decision when evidence is
unavailable; this exception never applies to `GO`.

Verify the assembled `GO` from a fresh evidence copy:

```sh
"$MPC_BIN" decision verify \
  --ceremony "$CEREMONY_DIR/ceremony.json" \
  --ceremony-signature "$CEREMONY_DIR/ceremony.sig" \
  --coordinator-public-key-file "$CEREMONY_DIR/coordinator-public-key.hex" \
  --decision /governance/production-decision.json \
  --signature /governance/coordinator.decision.sig.json \
  --signature /governance/auditor-01.decision.sig.json \
  --signature /governance/auditor-02.decision.sig.json \
  --signature /governance/release-signer.decision.sig.json \
  --evidence-root /independent/final/evidence-root
```

A `GO` succeeds only when all gates are `PASS` and the same exact decision
bytes have distinct valid signatures from the coordinator, both named
enrolled auditors, and release signer. Duplicate, wrong-role, wrong-identity,
wrong-key, additional, missing, or stale signatures fail. A `NO-GO` requires
at least one `FAIL` or `PENDING` gate and may be authenticated by any one
authorized decision role.
