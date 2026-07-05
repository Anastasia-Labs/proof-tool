# AGENTS.md

Keep this file short. It is not a README; task-specific details belong in the
relevant code, docs, or skills.

## Project Context

This repo is intended for production use on Cardano mainnet. It supports a
recovery flow for funds sent to contracts after payment credentials were
compromised: the original owner reclaims by proving possession of the
uncompromised master private key that derives the affected credential.

The system spans local proving, hosted verification/UI, and Plutus V3 on-chain
validators. Mistakes can expose recovery secrets, strand or misdirect real
funds, or overstate what a proof establishes.

## North Star

Ship a mainnet-safe recovery mechanism where secrets stay local, proof claims
remain narrow and honest, verifier/key artifacts stay coherent, and on-chain
reclaim rules enforce proof coverage plus destination binding.

Prefer implementations that preserve the production trust boundary over quick
demo convenience.

## High-Level Structure

- Go is the proof engine and service layer: `cmd/proof-tool`, `cmd/api`, and
  `internal/...` cover deriving, proving, verifying, exporting Cardano bytes,
  setup/key bundles, helper APIs, and verifier APIs.
- `packages/client-ts` mirrors browser-side derivation and worker helpers.
- `apps/ownership-proof-web` is the Next.js user flow.
- `apps/proof-helper-desktop` is the Tauri/local-helper path.
- `contracts/ownership-verifier` contains the Plutus V3 verifier and reclaim
  validators.
- `docs/` holds current specs and plans for specific surfaces. Read the
  relevant doc before changing that surface, but do not copy those details into
  this always-loaded file.

## General Approach

Keep the claim precise: the core proof establishes derivability of a 28-byte
Cardano payment key credential from a master XPrv at a CIP-1852 path. Do not
broaden that into proof of a wallet, balance, UTxO entitlement, stake
credential, script credential, or full address unless the circuit and contracts
actually prove it.

Seed phrases and master XPrvs must stay local. Do not send them to hosted
services, URLs, logs, analytics, local/session storage, production command
lines, or React/server payloads.

Treat verifier keys, proving keys, pinned hashes, Cardano export fixtures,
contract parameters, and ceremony manifests as one coherence set. When one
moves, refresh and verify the others together.

Use repo-backed golden vectors and fixtures for examples and tests. Avoid
inventing credentials, proof bytes, public inputs, or Cardano wire values.

For security or protocol changes, prefer real derive/prove/verify/export and
contract-path evidence with negative tests over compile-only evidence.

Preserve in-flight work in the dirty tree. Scope edits tightly and do not clean
or regenerate unrelated artifacts just to make status look tidy.

## Known Pitfalls

- The gnark proof JSON is not the on-chain redeemer format. Contract-facing data
  must come from the Cardano serializers/export path with the committed byte
  layout.
- Local or single-actor setup evidence is not ceremony-grade production
  provenance. Do not describe it as trustless or MPC; document the operator,
  signing key, and toxic-waste boundary plainly.
- Fixture mode proves control flow only. Do not treat fixture helper/verifier
  success as a real credential proof or as mainnet readiness.
- The backend/verifier must not trust client-supplied `vk_hash`, path metadata,
  destination bytes, or public input when the service or contract can pin or
  recompute them.
- Path metadata is sensitive. Shared/backend artifacts should omit it by
  default and include it only for explicit local debug/support.
- Production helpers must not silently create fresh local key bundles; those
  proofs may not match the hosted verifier. Use a signed and pinned bundle.
