# Proof Assets Release Inventory

Last verified: 2026-07-07.

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

## Current Preprod Proof-Assets Release

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

## Archive Digests

- Archive size: `2079528960`
- SHA-256:
  `dd08bb8f59420b92a7176529032adb438cb5596a9be5ee1dc37f7ea4ca848df0`
- BLAKE2b-256:
  `017cf1c1b6059917d5453fd275422df68488011fde2f1677ac9db55652f1af0b`

## Key Bundle Identity

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

## Deployment Identity

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
gh release view proof-assets-ownership-destination-v1-preprod-d2c944d-r3 \
  --repo Anastasia-Labs/proof-tool-release \
  --json tagName,name,isPrerelease,isDraft,publishedAt,url,assets
gh release download proof-assets-ownership-destination-v1-preprod-d2c944d-r3 \
  --repo Anastasia-Labs/proof-tool-release \
  --pattern '*.sha256' \
  --pattern '*.blake2b256' \
  --pattern '*.release-manifest.json' \
  --pattern '*.cardano-vk-format.txt' \
  --pattern '*.cardano-vk.hex' \
  --pattern 'reclaim-deployment-*.json'
```
