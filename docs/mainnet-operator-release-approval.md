# Mainnet release approval

The repository author witnessed the ceremony. On 2026-10-01, the author reviewed
and approved its result and the existing Mainnet deployment. The signed GO authorizes
release
`proof-assets-ownership-v3-mainnet-8471106-6eff` for the ownership-proof web app
against that deployment.

## Verified release checks

- The exact ceremony verifier binary was reproduced and verified the supplied
  signed release records and coordinator replay binding.
- The proving key, constraint system, native and Cardano verification keys,
  transcript and all 64 proving-key chunks match their signed hashes.
- A browser-generated proof using the supplied Mainnet keys passed native and
  compiled Plutus verification. Altered proof and destination bytes were rejected.
- The production app completed a real Preprod claim in Microsoft Edge and Lace
  with the committed Preprod deployment and keys. The provider confirmed the
  reviewed destination, and secret-egress and artifact checks passed.
- Hosted Mainnet release verification passed, including the GO signature,
  approved artifact hashes, runtime pins and canonical proving-worker preflight.
- Mainnet ledger checks confirmed three unspent reference outputs, matching
  scripts, the parameters NFT and inline datum, and the registered reward account.

## Signed authorization

The GO authorization and detached Ed25519 signature are published under
`/proof-releases/proof-assets-ownership-v3-mainnet-8471106-6eff/approval/`.
The application pins the public key and approval digest in
`apps/ownership-proof-web/lib/reclaim-server/operator-approval-pins.json`.
The server verifies the approval before serving the Mainnet configuration.

The approval binds the deployment descriptor, runtime pins, supplied archive,
ceremony and release identifiers, and exact artifact and evidence hashes. The
[signed approval record](../apps/ownership-proof-web/public/proof-releases/proof-assets-ownership-v3-mainnet-8471106-6eff/approval/operator-approval.json)
contains the signed authorization and evidence details.

Run the complete release check with:

```sh
pnpm --dir apps/ownership-proof-web verify:proof-release
```

Signatures cover `proof-tool/operator-release-approval/v1\n` followed by UTF-8 JSON
with recursively sorted object keys, array order preserved and no whitespace or
trailing newline. The approval ID is SHA256 of that JSON without the prefix.
Artifact hashes cover exact file bytes.
