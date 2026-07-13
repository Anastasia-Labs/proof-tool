# Developer Documentation

Start here when choosing which part of the repository to change. Plans describe
unfinished work; the documents below describe the implementation that exists.

## Credit

This project builds substantially on
[Charles Hoskinson's `CharlesHoskinson/proof-zk-recovery`](https://github.com/CharlesHoskinson/proof-zk-recovery),
which deserves credit for the heavy lifting behind the work inherited here.
All code, proof-system and Cardano integration work, designs, fixtures,
documentation, and other material sourced or adapted from that repository are
credited to Charles Hoskinson and its contributors. This repository builds on
that foundation.

## Proof Engine And Local Services

- [`ownership-proof-system.md`](ownership-proof-system.md): circuit profiles,
  Go package map, artifact boundaries, helper/verifier APIs, and test routes.
- [`non-technical-ownership-proof-runbook.md`](non-technical-ownership-proof-runbook.md):
  fixture and real local smoke commands.
- [`trusted-setup-ceremony.md`](trusted-setup-ceremony.md): setup provenance and
  signed key-bundle handling.
- [`proof-assets-release-inventory.md`](proof-assets-release-inventory.md): the
  current release identity and coherence values.

## Reclaim Product And Contracts

- [`reclaim-funding-page.md`](reclaim-funding-page.md): `/reclaim`, CIP-30
  funding addresses, backend transaction construction, and funding safety.
- [`reclaim-claim-flow.md`](reclaim-claim-flow.md): `/claim`, its API sequence,
  wallet separation, proof providers, resume behavior, and UI test fixtures.
- [`reclaim-contracts-spec.md`](reclaim-contracts-spec.md): Plutus V3 validator
  rules, destination binding, multi-proof encoding, fixtures, and benchmarks.
- [`reclaim-contract-audit-context.md`](reclaim-contract-audit-context.md):
  entrypoints, branches, state transitions, and threat boundaries.
- [`preprod-e2e.md`](preprod-e2e.md): deployment and operator-approved Preprod
  funding-to-claim harness.

## Desktop Helper

- [`proof-helper-desktop.md`](proof-helper-desktop.md): Tauri/React/Go sidecar
  architecture, key cache, local development, and tests.
- [`proof-helper-desktop-security-review.md`](proof-helper-desktop-security-review.md):
  implemented controls and release gates.
- [`proof-helper-windows-release-runbook.md`](proof-helper-windows-release-runbook.md):
  staging and validating Windows artifacts.

## Browser Proving

- [`browser-proving.md`](browser-proving.md): production browser-provider
  architecture, worker/runtime map, accepted tuning, and developer checks.
- [`browser-proving-asset-hosting.md`](browser-proving-asset-hosting.md): signed
  asset production, the live Cloudflare R2 custom domain and cache/rule
  configuration, and the same-origin/ranged-host split.
- [`worker-owned-pk-fetch-design.md`](worker-owned-pk-fetch-design.md): detailed
  authenticated proving-key chunk transport and security design.

## Active Plans

These remain plans because their external acceptance gates are still open:

- [`manual-lace-claim-flow-qa-plan.md`](manual-lace-claim-flow-qa-plan.md):
  installed Edge/Lace profile plus desktop-install smoke automation.
- [`proof-helper-windows-release-plan.md`](proof-helper-windows-release-plan.md):
  Authenticode signing, packaged Windows validation, and publication.
- [`vercel-preprod-browser-proving-deployment-plan.md`](vercel-preprod-browser-proving-deployment-plan.md):
  Vercel environment and hosted Preprod browser-proving rollout; the ranged host
  is already live.
