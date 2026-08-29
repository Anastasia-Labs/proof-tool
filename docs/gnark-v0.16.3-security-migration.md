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

Key-bundle loaders, the browser WASM preflight, and key/chunk-manifest
coherence checks all require the exact `v0.16.3` version. Negative tests reject
an otherwise coherent manifest that claims the retired v0.15.0 version.

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

## Initial fixed-circuit setup evidence

A fresh single-operator Preprod setup was generated from clean source commit
`9e8cab701589cf77c1c8d74fa016d8b13faebd84`. This is not an MPC or trustless
ceremony: the operator explicitly acknowledged the toxic-waste boundary. The
signed key manifest verifies against its external trust anchor and pins:

- native VK hash
  `blake2b256:ebf91d8ffc17fab6d26afdee256798f7178ed010200001285468688f97abc514`;
- Cardano VK hash
  `blake2b256:4dfe550735d4f27a02e58de8a5567aee5aed66279cd4222b026d8059b18615da`;
- CCS hash
  `blake2b256:39bb5adabc2aec214c69f925578546c5e922d15b1104d03d290c57fcda371a80`;
- setup transcript hash
  `blake2b256:42996b1b070d2313e235de71001f58e3f3dbb31bc33dc3a1ac8c4fe9edd23740`.

The native PK is 1,834,843,511 bytes and the frozen CCS is 161,214,609
bytes. The local browser candidate splits the PK into 875 signed 2 MiB chunks
and compresses the CCS transport to 43,806,673 bytes while retaining both
identity and compressed-content hashes.

This candidate established the security migration before the circuit was
optimized. It is superseded for deployment by the optimized coherence set in
the cutover section below.

## Performance evidence

The native pre-migration baseline used the frozen v0.15.0 destination CCS and
key bundle on an AMD Ryzen 9 9950X3D with Go 1.26.5. Five real proofs all
verified. Proving times were 4,011.493 ms, 3,610.577 ms, 3,811.809 ms,
3,872.431 ms, and 4,094.230 ms; median 3,872.431 ms. Peak process RSS was
4,925,220 KiB.

The fixed v0.16.3 destination bundle used the same host and Go version. Five
real proofs all verified. Proving times were 5,372.055 ms, 5,037.937 ms,
4,880.453 ms, 4,878.902 ms, and 4,966.319 ms; median 4,966.319 ms. Peak process
RSS was 7,663,944 KiB.

| Measurement | v0.15.0 | v0.16.3 | Change |
| --- | ---: | ---: | ---: |
| Median native prove | 3,872.431 ms | 4,966.319 ms | +28.25% |
| Peak native RSS | 4,925,220 KiB | 7,663,944 KiB | +55.61% |
| Proving key size | 1,288,707,133 bytes | 1,834,843,511 bytes | +42.38% |
| Constraint system size | 129,221,468 bytes | 161,214,609 bytes | +24.76% |
| Proving key load | 9,772.896 ms | 22,959.641 ms | +134.93% |

The browser runtime was built twice from clean inputs; the proof WASM,
MSM-worker WASM, and `wasm_exec.js` were byte-identical between builds. A cold
loopback Playwright run then loaded the signed manifest, 2 MiB PK chunks,
compressed CCS, VK, and deployment descriptor, generated a real proof, and
verified it locally. On an intentionally bounded four-worker/eight-CPU run it
took 152.298 seconds, reported 1.194 GiB peak Go heap, completed all 56 worker
shards, and used no swap or contaminated samples. W1/W2/W3/W5/W6/W7 and pinned
decode were enabled. The post-review proof WASM SHA-256 is
`29dc252d97d0ed7e01ea9777684bb288e55fbf915dc423cc7abc91014757e303`.

Twenty fresh Cardano-format proofs were generated and verified natively before
serialization. The Plutus verifier suite then passed all 137 tests, including
ordinary, all-distinct, repeated-proof, malformed-proof, wrong-public-input,
reordering, substitution, and compiled-validator cases.

## Rollout invariant

The fixed constraint system, PK, VK, Cardano VK serialization, proof fixtures,
contract parameters, browser runtime, chunk manifest, deployment manifest, and
desktop pins form one coherence set. The new R2 release must use a new immutable
prefix. Old preprod objects must not be removed until a new preprod verifier is
deployed and every active manifest points at the fixed VK; replacing only the
PK/CCS would break proving or leave the old verifier relation active.

The legacy embedded ownership-v1 verifier is fail-closed during this migration.
It must not be re-enabled until an ownership-v2 key is generated and pinned.

## Optimized Preprod cutover

The reviewed migration source was merged before creating the final deployment.
The optimized destination circuit was then set up from source commit
`191ca9312b8081cfc5fd26581d7e8c2bcefcee73`; its signed coherence set pins:

- native VK hash
  `blake2b256:bb62fb1ab0bbc2d63f0e86dca668ee339dba8d3bc3c83f063a781261b2462ce7`;
- Cardano VK hash
  `blake2b256:b953a5133901bee9832254df08b76f28a8f5e5aba58683815623f6e1ec660fa7`;
- CCS hash
  `blake2b256:d1215047c4e53cba141fa1b25debd2b060330baf893ba90a6ac75fac19ca302c`.

The corresponding Preprod deployment transaction is
`dd557660decbd9c1b648f59004243ad4f600bba3139adb68732aff270e8e4a81`.
The browser release uses the fresh immutable R2 prefix
`proof-assets/preprod-v3-191ca93-opt-bb62-07d48bc5-r1/`; the desktop release
is `proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1`.

The stable descriptors must be merged only after all R2 objects are publicly
range-readable and the exact cutover commit passes the live Preprod
prove/build/submit/confirm lane. Previous v2 releases remain immutable rollback
artifacts; promotion retires their active pointers but does not delete them.

The current Lean formal-assurance lock remains historical evidence for the
previous v2 Preprod deployment. It must not be attributed to this v3 cutover:
the pinned Lean/PlutusCore importer does not yet decode the Plutus 1.66/UPLC
artifacts used by the new contract deployment. Public-chain regeneration did
independently reproduce the v3 policy, Base, and Global identities and byte
digests, but refreshing the theorem corpus remains a separate open assurance
task.

The hosted legacy ownership API is a separate surface: it remains deliberately
unavailable until a fresh ownership-v2 (non-destination) verifier key is
generated and pinned.
