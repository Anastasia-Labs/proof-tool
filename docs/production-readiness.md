# Production readiness assessment

**Target:** Cardano Mainnet recovery flow: local proving, web funding and claim
flows, hosted APIs, Plutus V3 reclaim validators, proof assets, and the optional
desktop helper.

**Assessment date:** 2026-07-28

**Compared state:** tracked `HEAD`
`dcc271bca5df7ad29da573de1afcac55e398c6f7` plus the explicitly identified
uncommitted Mainnet/MPC work in this checkout.

Companion status ledger:
[next-steps-to-mainnet.md](next-steps-to-mainnet.md).

## Evidence boundary

This repository is currently dirty. That matters for every readiness claim:

- **Tracked** means the implementation is present in `HEAD` and can be reviewed
  as ordinary repository history.
- **Working-tree only** means useful implementation exists locally but is not
  yet durable, reviewable release history and must not be treated as shipped.
- **External** means repository preparation can be complete while independent
  people, infrastructure, custody, or live-ledger evidence is still missing.

The Mainnet preparation lane, production MPC implementation, MPC runbooks, and
MPC readiness records are working-tree-only as of this assessment. The current
MPC decision is explicitly **NO-GO** after the 2026-07-24 exact-K21 rehearsal
closure-timing failure. No production ceremony, final Mainnet proof release, or
Mainnet deployment exists.

## Verdict

**Not Mainnet-ready.**

The security-critical core is considerably stronger than the 2026-07-16 audit
reported: PR CI now spans Go, real Groth16 round trips, web/client/desktop
tests, Rust, and the Plutus suite; `ReclaimGlobalV2` is the canonical tracked
contract and is specified; signed proof releases are checked locally and after
deployment; mutable integrity roots no longer receive immutable caching; and
the optimized Preprod V2 deployment has real prove/build/submit evidence.

Those improvements do not close the production decision. The remaining
Mainnet blockers are:

1. **The MPC release is NO-GO.** The first exact K=21 rehearsal did not
   complete. A fresh qualified rehearsal, independent builds and actors,
   external reviews, operational evidence, signed GO decision, and final
   release verification are still required.
2. **There is no live Mainnet deployment.** The working-tree Mainnet lane is a
   deliberately non-submitting preparation tool. It emits a disabled unsigned
   manifest template and deployment plan, not transaction CBOR. There is no
   committed `deployments/reclaim/mainnet/` release, confirmed Mainnet params
   UTxO, reference scripts, or enabled proof-asset release.
3. **The web secret surface still lacks CSP and transport hardening headers.**
   COOP/COEP/CORP are present; CSP, HSTS, nosniff, and an explicit referrer
   policy are not.
4. **Operations are still incomplete.** There is no repository-backed
   production monitoring/alerting deployment, `/healthz`, incident drill
   evidence, or request-time provider failover.
5. **Settlement is not finality-aware.** Claim progress still maps a missing
   out-ref to `spent_or_unknown`; it does not prove that the submitted
   transaction reached the chosen confirmation depth or distinguish rollback
   and competing-spend cases. Funding still reports success at submission.
6. **The lock-funds credential remains a stranding risk.** The UI requires an
   explicit 28-byte credential and the docs warn about it, but the value is
   still free text and is not derived from, or strongly reconciled with, the
   recovery key before funds are locked.
7. **Release governance remains partial.** Dependabot and broad CI exist, but
   required branch checks are repository-host configuration, no CODEOWNERS file
   is present, the patched gnark provenance/sentinel story is incomplete, and
   reproducible WASM release verification is not a complete gate.
8. **Product support decisions remain open.** The desktop helper has meaningful
   implementation and Linux release work, but Windows signing/updater and final
   launch-scope decisions remain open. Browser, wallet, accessibility, mobile,
   and legal/support matrices are incomplete.

## Updated scorecard

| Area | Current grade | Evidence and remaining gap |
| --- | --- | --- |
| Secret locality | **A-** | Seed phrases and master XPrvs remain local; worker/helper boundaries, redaction, and zeroization are strong. Browser CSP and independent release review remain necessary. |
| Proof/verifier coherence | **A- / working-tree dependent** | Signed releases, native/Cardano VK separation, frozen CCS pins, and fail-closed checks are strong. The strongest Mainnet/MPC coherence machinery is not yet committed or accepted. |
| On-chain validators | **A- on Preprod** | Canonical V2 spec, tracked formal assurance workspace, negative tests, and real optimized-V2 Preprod claims exist. Exact all-distinct-seven on-chain G2 remains waived by explicit exception. |
| Mainnet deployment | **F** | Offline preparation exists only in the working tree; no live scripts, params UTxO, enabled manifest, or final proof release exists. |
| CI and release checks | **B+** | Broad PR CI and deployed proof-release verification are tracked. Production build wiring, required-check administration, reproducible WASM, and full Mainnet coherence still need closure. |
| Web security headers | **C** | Cross-origin isolation is configured. CSP, HSTS, nosniff, and referrer policy are absent. |
| Claim/funding correctness | **C+** | Strong draft/build/review-token and signed-CBOR inspection gates. Finality, rollback, competing-spend, funding confirmation, credential derivation, and expiry remain open. |
| Operations and resilience | **D** | Local guarded Preprod acceptance and signed-release probes exist. Monitoring, alert routing, failover, disaster recovery, and scheduled real-chain acceptance are incomplete. |
| MPC and key custody | **D / NO-GO** | Extensive working-tree protocol, tooling, audit package, and decision machinery exist. The failed rehearsal, external gates, and missing signed GO prevent production use. |
| Desktop helper | **C+ / pre-release** | Pairing, signed key bundles, local-only service, progress, tests, and Linux artifacts exist. Launch scope and cross-platform signed release/update gates remain incomplete. |

## Material improvements since the 2026-07-16 assessment

- `.github/workflows/ci.yml` now gates lint, full Go tests, real Groth16
  round-trips, web/client/desktop checks, Rust tests, and the Plutus validator
  suite.
- `.github/workflows/proof-release-coherence.yml` verifies signed local releases
  and deployed production release assets, including a daily deployed-release
  probe.
- `docs/reclaim-contracts-spec.md` and
  `docs/reclaim-contract-audit-context.md` now make statement-bound
  `ReclaimGlobalV2` canonical; V1 is no longer presented as the deployed path.
- The optimized V2 Preprod scripts and signed proof release are deployed.
  Confirmed six-input and four-input live claims are recorded in
  `docs/preprod-e2e.md`.
- Stable proof-runtime and proof-asset paths use revalidation while only
  content-addressed proof-release paths receive immutable caching.
- The tracked formal assurance workspace and optimized contract evidence now
  match the active Preprod deployment.
- Browser proving improved from the old roughly 70-second reference to measured
  41.46-second warm and 47.68-second cold 16-worker reference runs, without a
  circuit change.
- The working tree adds strict Mainnet preparation and MPC release/decision
  machinery. It correctly refuses to create or submit a Mainnet transaction,
  but it is not yet committed production evidence.

## Mainnet release gates

Mainnet remains **NO-GO** unless all of the following are true:

1. The exact source is a clean, reviewed, signed release commit.
2. A fresh exact-K21 rehearsal completes with the planned participant count and
   approved capacity margins.
3. Independent builds, ceremony actors, witnesses, auditors, custody transfers,
   mirrors, restore/failover drills, and external reviews satisfy
   `docs/mpc-production-readiness.md`.
4. The final MPC release and accountable signed GO decision verify against
   trusted out-of-band public keys.
5. The Mainnet scripts, params NFT/UTxO, reference scripts, deployment manifest,
   native VK, Cardano VK, CCS, proof assets, source, ceremony, and decision are
   one machine-verified coherence set.
6. The live transaction plan receives a separate review and explicit submission
   approval; confirmation and post-deploy coherence are recorded.
7. Security headers, monitoring, alerting, provider resilience, finality-aware
   settlement, and credential-safety controls are demonstrated in a
   production-equivalent environment.
8. Supported browser, wallet, helper, accessibility, recovery, incident, and
   legal/support decisions are explicit and tested.

Preprod success and an internally coherent dry-run are necessary evidence, but
neither is Mainnet authorization.
