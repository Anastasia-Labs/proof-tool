# Summary

<!-- What does this PR change, and why? -->

## Checklist

- [ ] `pnpm test:all` (or the CI-covered subset relevant to this change) passes locally.
- [ ] No seed phrases, master XPrvs, or other recovery secrets are sent to hosted services, logs, URLs, storage, or React/server payloads.
- [ ] The proof claim stays narrow: derivability of a payment credential from a master XPrv at a CIP-1852 path — nothing in this change overstates it.
- [ ] If this touches verifier keys, proving keys, pinned hashes, Cardano export fixtures, contract parameters, or ceremony manifests: the whole coherence set was refreshed and verified together (`pnpm verify:proof-release`).
- [ ] Security- or protocol-relevant changes include real derive/prove/verify/export or contract-path evidence with negative tests, not compile-only evidence.
- [ ] New behavior is covered by tests that would fail without the change.
