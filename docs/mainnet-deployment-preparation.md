# Mainnet deployment preparation

`cmd/mpc-ceremony` creates and verifies the production proving-key release. The
Mainnet deployment preparation lane consumes that final release and derives the
exact `global-v2`, `ReclaimBase`, one-shot policy, and params-holder scripts
without building, signing, or submitting a transaction:

```sh
pnpm --dir apps/ownership-proof-web \
  deploy:reclaim:mainnet:prepare -- \
  --dry-run \
  --network Mainnet \
  --network-id 1 \
  --source-signed-tag vX.Y.Z \
  --mpc-ceremony-bin /read-only/release-build/mpc-ceremony \
  --ceremony /read-only/transcript/ceremony.json \
  --ceremony-signature /read-only/transcript/ceremony.sig.json \
  --coordinator-public-key-file /trusted/coordinator-public-key.hex \
  --release-dir /read-only/final-mpc-release \
  --release-public-key-file /trusted/release-public-key.hex \
  --release-signature-key-id release-2026 \
  --seed-out-ref '<64-lowercase-hex>#<index>' \
  --production-decision /trusted/production-decision.json \
  --decision-signature /trusted/production-decision.coordinator.sig.json \
  --decision-signature /trusted/production-decision.auditor-1.sig.json \
  --decision-signature /trusted/production-decision.auditor-2.sig.json \
  --decision-signature /trusted/production-decision.release-signer.sig.json \
  --decision-evidence-root /read-only/production-decision-evidence \
  --out-dir output/mainnet-deployment-preparation
```

The command fails closed unless:

- the checkout is completely clean and `HEAD` is the commit named by a
  successfully verified annotated Git tag;
- the final MPC release passes `mpc-ceremony release verify` twice using an
  out-of-band release public key, and its production ceremony, source commit,
  two audits, native keys, Cardano export, candidate v2, verification report
  v2, public finalization evidence, and checksums cohere;
- `mpc-ceremony decision verify` authenticates the canonical `GO` decision
  using exactly the coordinator, two enrolled auditors, and distinct release
  signer; its release-manifest SHA-256 must equal the exact local release used
  by this lane;
- the decision's source tag name, full 40-hex OpenPGP primary-key fingerprint,
  and SHA-256 of the complete annotated tag object match a fresh successful
  `git verify-tag`;
- the native gnark `ownership.vk` hash remains distinct from the BLAKE2b-256
  hash of the 672-byte Cardano BSB22 VK, with `global-v2` bound to the Cardano
  hash;
- the destination is a fresh directory. No existing output is replaced.

The production decision uses
`proof-tool-mpc-production-decision-v1`. It content-addresses the complete
signed release, operational evidence, two independent ceremony audits, two
external security audits, the exact K=21 rehearsal, the Mainnet plan and formal
checklist, and every production gate. The four required role signatures cover
the exact canonical decision bytes. Evidence URIs are immutable publication
bindings; verification hashes caller-supplied local copies and performs no
network fetch.

The fresh output contains only:

- `deployment-plan.json`, an offline reference-output plan that records the
  verified release, approval, script hashes, addresses, fixed output ordering,
  and all remaining live-ledger gates; and
- `reclaim-deployment.unsigned-template.json`, deliberately disabled with null
  transaction hashes.

Neither file is a transaction. The lane has no provider or wallet integration,
never reads a mnemonic or XPrv, runs the contract exporter in Cabal offline
mode, emits no transaction CBOR, and cannot submit.

When the disabled template is later completed from confirmed ledger output
references, preserve its MPC provenance fields unchanged. The Mainnet
proof-asset generator and release verifier require all of the following to
cohere:

- `proof.vk_hash` is the native gnark VK BLAKE2b-256 from the signed key
  manifest;
- `proof.cardano_vk_blake2b256`,
  `reclaim_global.verifier_vk_hash`, and
  `reclaim_global.batch_transcript_vk_hash` are the distinct BLAKE2b-256 of
  the exact 672-byte Cardano BSB22 VK;
- `proof.setup_transcript_hash`, `proof.mpc_ceremony_id`, and
  `proof.mpc_candidate_id` remain the values inspected from the exact release;
  and
- `planning.production_decision_id`, `planning.mpc_release_id`, and
  `planning.release_manifest_sha256` remain the authenticated GO-decision
  values. The last value must equal the SHA-256 of the signed key manifest
  copied into the proof-asset release.

The signed chunk manifest carries the same MPC and decision identities. The
web proof-release verifier rejects Mainnet assets if any of those fields,
native/Cardano hashes, setup transcript, batch transcript, or deployment
identity drifts.

Before a separate Mainnet transaction-building review, recheck that the seed
UTxO is unspent, obtain fresh protocol parameters, resolve reward-account
registration, calculate minimum lovelace/fees/collateral/change, and preserve
the approved output identities. After confirmation, populate actual out-refs,
run the repository deployment/release coherence checks, sign the final
deployment manifest, and obtain a separate explicit submission approval.
