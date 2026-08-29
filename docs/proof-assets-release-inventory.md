# Proof Assets Release Inventory

Last verified: 2026-08-29.

This document records the current proof-assets release state in
`Anastasia-Labs/proof-tool-release`. It is factual release inventory, not a
release plan.

## Repository

- Repository: `Anastasia-Labs/proof-tool-release`
- URL: `https://github.com/Anastasia-Labs/proof-tool-release`
- Visibility at verification time: public

Because the repository is public, the GitHub release asset URLs are currently an
anonymous public download route for the desktop app. The desktop app still pins
the archive size and hashes; GitHub's route is the transport, not the trust
root.

## Current Preprod Proof-Assets Release (v3 optimized)

- Tag: `proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1`
- Release URL:
  `https://github.com/Anastasia-Labs/proof-tool-release/releases/tag/proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1`
- Published at: `2026-08-29`
- Circuit: `root-ownership-destination-v3/bls12-381/groth16` (optimized
  gnark v0.16.3 circuit, source commit
  `191ca9312b8081cfc5fd26581d7e8c2bcefcee73`)
- The desktop app's `active_descriptor()` pins this release (archive size
  `1167165440`, `sha256:3da80038…`, `blake2b256:12264a7a…`).
- Native VK hash:
  `blake2b256:bb62fb1ab0bbc2d63f0e86dca668ee339dba8d3bc3c83f063a781261b2462ce7`.
- Cardano VK hash:
  `blake2b256:b953a5133901bee9832254df08b76f28a8f5e5aba58683815623f6e1ec660fa7`.

### v3 Assets

| Asset | Size | Notes |
| --- | ---: | --- |
| `proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1.tar` | `1167165440` | Signed key-bundle archive containing `manifest.json`, `manifest.sig`, `ownership.pk`, `ownership.vk`, and `ownership-destination.ccs`. |
| `proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1.tar.sha256` | `207` | SHA-256 sidecar. |
| `proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1.tar.blake2b256` | `207` | BLAKE2b-256 sidecar. |
| `proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1.release-manifest.json` | `2572` | Release manifest, contract identity, and trust-boundary provenance. |

## Previous Preprod Proof-Assets Release (v2)

- Tag: `proof-assets-ownership-destination-v2-preprod-9fac96b-g3a`
- Release URL:
  `https://github.com/Anastasia-Labs/proof-tool-release/releases/tag/proof-assets-ownership-destination-v2-preprod-9fac96b-g3a`
- Published at: `2026-07-13`
- Circuit: `root-ownership-destination-v2/bls12-381/groth16` (G3a freeze,
  source commit `9fac96bc0669285433ca51e62873b1ab1fa274de`)
- The desktop app formerly pinned this release (archive size `1417943040`,
  `sha256:ee2f232f…`, `blake2b256:2a44af40…`). It remains an immutable rollback
  artifact after the v3 pointer is promoted.

### v2 Assets

| Asset | Size | Notes |
| --- | ---: | --- |
| `proof-assets-ownership-destination-v2-preprod-9fac96b-g3a.tar` | `1417943040` | Key-bundle archive: `manifest.json`, `manifest.sig`, `ownership.pk`, `ownership.vk`, and the new `ownership-destination.ccs` (frozen compiled constraint system, blake2b256-pinned by the manifest, loaded by the helper instead of recompiling the circuit). |
| `proof-assets-ownership-destination-v2-preprod-9fac96b-g3a.tar.sha256` | `201` | SHA-256 sidecar. |
| `proof-assets-ownership-destination-v2-preprod-9fac96b-g3a.tar.blake2b256` | `201` | BLAKE2b-256 sidecar. |
| `proof-assets-ownership-destination-v2-preprod-9fac96b-g3a.release-manifest.json` | `2498` | Release manifest and provenance. |

## Earlier Preprod Proof-Assets Release (v1)

- Tag: `proof-assets-ownership-destination-v1-preprod-d2c944d-r3`
- Name: `Proof Assets: ownership-destination-v1 preprod d2c944d r3`
- Release URL:
  `https://github.com/Anastasia-Labs/proof-tool-release/releases/tag/proof-assets-ownership-destination-v1-preprod-d2c944d-r3`
- Published at: `2026-07-07T04:13:48Z`
- Draft: no
- Pre-release: yes

## Assets

| Asset | Size | Notes |
| --- | ---: | --- |
| `proof-assets-ownership-destination-v1-preprod-d2c944d-r3.tar` | `2079528960` | Proof-assets archive. |
| `proof-assets-ownership-destination-v1-preprod-d2c944d-r3.tar.sha256` | `199` | SHA-256 sidecar. |
| `proof-assets-ownership-destination-v1-preprod-d2c944d-r3.tar.blake2b256` | `199` | BLAKE2b-256 sidecar. |
| `proof-assets-ownership-destination-v1-preprod-d2c944d-r3.release-manifest.json` | `3787` | Release manifest and provenance. |
| `ownership-destination-v1-preprod-d2c944d-r3.cardano-vk.hex` | `1345` | Cardano verifier key bytes as hex. |
| `ownership-destination-v1-preprod-d2c944d-r3.cardano-vk-format.txt` | `24` | `groth16-bls12-381-bsb22`. |
| `reclaim-deployment-preprod-d2c944d-r3.json` | `2800` | Preprod reclaim deployment manifest. |

## Browser Distribution Through Cloudflare R2

The current GitHub release remains the desktop archive distribution route. The
browser prover obtains the same key bundle's bulk, hash-pinned assets from the
Cloudflare R2 bucket `proof-assets` through the custom domain
`proof-assets.reclaim-proof.com`.

- Object-key prefix:
  `proof-assets/preprod-v3-191ca93-opt-bb62-07d48bc5-r1/`
- Chunk-manifest base URL:
  `https://proof-assets.reclaim-proof.com/proof-assets/preprod-v3-191ca93-opt-bb62-07d48bc5-r1/`
- Bulk objects: 509 2 MiB `ownership.pk.part####` chunks,
  `ownership-destination.ccs` (`101185815` bytes), its compressed transport
  (`33386315` bytes), and the CPU-fallback `ownership.pk` (`1065962731`
  bytes).
- The reclaim descriptor's `pk_url` and `ccs_url`, and the signed chunk
  manifest's `transport.base_url`, use this custom domain.
- R2 is not a new trust root. The browser verifies chunk and CCS hashes against
  signed, same-origin manifests before those bytes affect proving.

The hostname has cache eligibility, immutable response headers, disabled
compression, wildcard read-only CORS, and Smart Tiered Cache. The chunks and CCS
are edge-cacheable; the monolithic fallback exceeds the normal 512 MB
cacheable-object limit and is served directly from R2. See
[`browser-proving-asset-hosting.md`](browser-proving-asset-hosting.md) for the
exact Ruleset Engine configuration, CORS policy, live verification results, and
maintenance checks.

## Legacy v1 Archive Digests

- Archive size: `2079528960`
- SHA-256:
  `dd08bb8f59420b92a7176529032adb438cb5596a9be5ee1dc37f7ea4ca848df0`
- BLAKE2b-256:
  `017cf1c1b6059917d5453fd275422df68488011fde2f1677ac9db55652f1af0b`

## Legacy v1 Key Bundle Identity

- Archive key bundle prefix:
  `key-bundle/ownership-destination-v1-preprod-d2c944d-r3`
- Key version: `ownership-destination-v1`
- Circuit id: `root-ownership-destination-v1/bls12-381/groth16`
- Verifier-key hash:
  `blake2b256:6057da91b15dea8f8e93997f1b1944c35bc2c86faf9a9de17b814f6a172d430a`
- Signature key id: `preprod-local-destination-d2c944dd753c-r3`
- Manifest public key:
  `e20b0fb38fb6dc0a66284a8f3a6e8d05bf55b8e966d86f53b77d284b524463d6`
- Cardano verifier-key BLAKE2b-256:
  `blake2b256:d35ce80449fddb17cacbf922dfe27e57c28afcd59bee44bcef8eecbd7b317acf`
- Cardano verifier-key format: `groth16-bls12-381-bsb22`

## Legacy v1 Deployment Identity

- Network: `Preprod`
- Network id: `0`
- Deployment id:
  `preprod:2fa284c094db10d9bf916a6f42199c883cc55a199ebe23b6b9070c54:71c224623824d44a648e42d1a7653535a78879bc`
- Deployment source commit: `71c224623824d44a648e42d1a7653535a78879bc`
- Reclaim base script hash:
  `2fa284c094db10d9bf916a6f42199c883cc55a199ebe23b6b9070c54`
- Reclaim global script hash:
  `1e837d0ee6c9e042375365b0194e463460c21f468afbc8cc0f8ff155`
- Params currency symbol:
  `05291445b5a19600fd357a3287bd812a6adb5349464e455d7a0f25c1`

## Trust Boundary

The release manifest states that this is a preprod single-actor local gnark
Groth16 setup. It is not mainnet-ready ceremony evidence. Public or mainnet
reliance requires an explicitly accepted ceremony and release process.

## Verification Commands

```sh
gh repo view Anastasia-Labs/proof-tool-release --json nameWithOwner,visibility,url
gh release view proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1 \
  --repo Anastasia-Labs/proof-tool-release \
  --json tagName,name,isPrerelease,isDraft,publishedAt,url,assets
gh release download proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1 \
  --repo Anastasia-Labs/proof-tool-release \
  --pattern '*.sha256' \
  --pattern '*.blake2b256' \
  --pattern '*.release-manifest.json'
```
