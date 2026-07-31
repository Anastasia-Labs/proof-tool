# Trusted Setup Ceremony

This repository has two deliberately separate Groth16 setup paths:

- `proof-tool setup-ceremony` is a reproducible, signed, single-actor local
  setup.
- `cmd/mpc-ceremony` is the two-phase multi-party workflow whose production
  process is documented in
  [`mpc-ceremony-runbook.md`](mpc-ceremony-runbook.md).

The commands, transcripts, and trust claims are not interchangeable.

## Single-Actor Local Setup

Run the local path with:

```sh
go run ./cmd/proof-tool setup-ceremony \
  --out-dir output/ceremony/ownership-v1-YYYYMMDD \
  --signature-key-id proof-helper-release-YYYYMMDD \
  --signing-key /secure/path/proof-helper-release.ed25519.private.hex \
  --require-clean-git \
  --acknowledge-single-actor
```

The command writes `ownership.pk`, `ownership.vk`, `manifest.json`,
`manifest.sig`, `manifest-public-key.hex`, `setup-transcript.json`,
`TOXIC-WASTE-HANDLING.md`, `README.md`, and `checksums.sha256`.

The manifest is signed with Ed25519 over the exact `manifest.json` bytes. Verify
a bundle with a trusted public key:

```sh
go run ./cmd/proof-tool verify-key-bundle \
  --keys-dir output/ceremony/ownership-v1-YYYYMMDD \
  --manifest-public-key-file /trusted/path/proof-helper-release.ed25519.public.hex \
  --signature-key-id proof-helper-release-YYYYMMDD
```

For local integrity checks only, `verify-key-bundle` can fall back to the
bundled `manifest-public-key.hex`. Production installers should pin the public
key and expected `signature_key_id` out of band.

## Trust Boundary

`setup-ceremony` documents a single-actor gnark Groth16 setup. It does not turn
the setup into a public multi-party ceremony. Public users must either trust the
named setup operator and release signing key, or require a true public MPC
ceremony or a transparent proof system.

For a signed rehearsal or explicitly trusted single-operator release, run from
a clean tagged commit with
`--require-clean-git`, record the operator and host controls in release notes,
publish the signed bundle and transcript, and keep the Ed25519 private signing
key outside the published bundle. Do not label such a bundle "multi-party",
"trustless", or production MPC evidence.

The dedicated MPC command uses gnark's BLS12-381 `mpcsetup` package, requires
ordered contributions in both phases, uses separate future public beacons for
Phase 1 and Phase 2, and supports full independent transcript replay. Software
verification alone is still insufficient: participant independence, host
controls, entropy quality, erasure, public archival, and independent audits are
operational requirements. See the full
[`MPC ceremony operator, contributor, and auditor runbook`](mpc-ceremony-runbook.md).
Its current Mainnet decision is **NO-GO**; see
[`mpc-production-readiness.md`](mpc-production-readiness.md) before using any
ceremony binary or artifact.

## Toxic Waste Handling

gnark samples the Groth16 trapdoor in process memory during `groth16.Setup`.
This tool does not write ptau, zkey, toxic-waste, or trapdoor transcript files.
After the command exits, the process memory is released back to the operating
system, but Go does not provide a ceremony-grade zeroization proof.

For stronger production hygiene, use an ephemeral controlled host, disable or
destroy swap, avoid persistent crash dumps, publish `TOXIC-WASTE-HANDLING.md`,
and destroy the ceremony host or VM after the artifacts are signed and copied.

The MPC path narrows the trust assumption to require at least one honest
independent contributor in each phase, but it does not cryptographically prove
that a contributor erased its randomness. Every accepted participant must use
and attest to the host controls in the MPC runbook.
