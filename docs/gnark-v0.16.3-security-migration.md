# gnark v0.16.3 Security Migration

Date: 2026-08-27

## Security reason

The repository previously used gnark v0.15.0. That release is affected by
[GHSA-3mvx-pp85-pm65](https://github.com/Consensys/gnark/security/advisories/GHSA-3mvx-pp85-pm65),
a critical under-constrained-hint issue that can permit false proofs. The
ownership circuits directly use the affected `std/math/emulated` and
`std/math/uints` packages. gnark v0.16.2 is the first fixed release; this
migration uses the current v0.16.3 release and gnark-crypto v0.21.0.

The old proving and verifying keys are retired. A verifier built for the old
constraint system remains unsafe even when its surrounding application is
rebuilt against a fixed gnark library.

## Regression evidence

`TestGHSA3mvxPackedKeyCollisionIsRejected` encodes the advisory's packed-key
collision against the uint lookup chain. It fails against the old v0.15.0
vendor tree because the forged witness is accepted, and passes against the
v0.16.3 vendor tree because the forged intermediate is range checked.

The local `uints-constant-fold.patch` was rebased so compile-time constant
operations remain folded while every dynamic lookup result retains upstream's
new 8-bit range check. `scripts/check-vendor-drift.sh` verifies that the vendor
tree is a clean v0.16.3 vendor operation plus the reviewed patch series.

## Circuit identities and size

The public statements and domain separators are unchanged. Circuit and key
identities are bumped so fixed proofs cannot be confused with proofs for an old
constraint system.

| Profile | Old identity | Fixed identity | Old constraints | Fixed constraints | Domain |
| --- | --- | --- | ---: | ---: | ---: |
| Ownership | `ownership-v1` | `ownership-v2` | 1,789,634 | 2,413,291 | K22 |
| Ownership + destination | `ownership-destination-v2` | `ownership-destination-v3` | 1,789,750 | 2,413,407 | K22 |
| Multi, count 2 | `ownership-multi-destination-v1-count2` | `ownership-multi-destination-v2-count2` | 3,447,616 | 4,694,932 | K23 |

The destination circuit grows by 623,657 constraints (34.85%). The increase is
the expected cost of constraining dynamic lookup outputs that the affected
version left under-constrained.

## Performance evidence

The native pre-migration baseline used the frozen v0.15.0 destination CCS and
key bundle on an AMD Ryzen 9 9950X3D with Go 1.26.5. Five real proofs all
verified. Proving times were 4,011.493 ms, 3,610.577 ms, 3,811.809 ms,
3,872.431 ms, and 4,094.230 ms; median 3,872.431 ms. Peak process RSS was
4,925,220 KiB.

The fixed-circuit proof timing and peak RSS are recorded here after the fresh
setup and end-to-end proof run complete.

## Rollout invariant

The fixed constraint system, PK, VK, Cardano VK serialization, proof fixtures,
contract parameters, browser runtime, chunk manifest, deployment manifest, and
desktop pins form one coherence set. The new R2 release must use a new immutable
prefix. Old preprod objects must not be removed until a new preprod verifier is
deployed and every active manifest points at the fixed VK; replacing only the
PK/CCS would break proving or leave the old verifier relation active.

The legacy embedded ownership-v1 verifier is fail-closed during this migration.
It must not be re-enabled until an ownership-v2 key is generated and pinned.
