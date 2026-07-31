# Next steps to Mainnet

**Status date:** 2026-07-28

This is the updated ledger for the 2026-07-16 readiness audit. It preserves the
original task IDs so old discussions remain traceable.

Status meanings:

- **DONE** — acceptance intent is present in tracked code and evidence.
- **PARTIAL** — meaningful tracked progress exists, but an acceptance condition
  remains.
- **WORKING TREE** — substantial local work exists but is not committed,
  independently reviewed, or production evidence.
- **OPEN** — the required control/evidence is not implemented.
- **EXTERNAL** — depends on independent actors, custody, infrastructure, or
  live-ledger execution after repository preparation.

Working-tree status never counts as release completion.

## P0 — Mainnet blockers

| ID | Status | Current evidence | Required closure |
| --- | --- | --- | --- |
| P0-1 Mainnet deployment path | **WORKING TREE** | `e2e/mainnet/prepare-reclaim-mainnet.mjs` verifies signed source, exact MPC release/decision, and derives scripts in dry-run mode. | Add and separately review the live-ledger transaction path, rehearse the exact tooling on Preprod, enforce rotation safety, and retain explicit Mainnet submission approval. |
| P0-2 Mainnet manifest/env | **WORKING TREE** | Preparation emits a disabled unsigned template. | Commit a schema-valid `deployments/reclaim/mainnet/` sample and documented production env template; populate it only from confirmed ledger identities. |
| P0-3 Mainnet proof assets | **WORKING TREE / EXTERNAL** | MPC finalization, packaging, provenance, and Mainnet release checks exist locally. | Complete accepted ceremony and audits, generate the final signed assets, verify byte/hash coherence, publish immutably, and commit the enabled descriptor. |
| P0-4 VK-to-script reproducibility | **PARTIAL + WORKING TREE** | Exporters rebuild parameterized scripts; the Mainnet lane distinguishes native and 672-byte Cardano VK hashes and derives exact script hashes. | Make the rebuild/hash comparison a mandatory tracked release/CI gate for the final deployment and retain golden/tamper evidence. |
| P0-5 Build/CI coherence | **PARTIAL** | CI verifies signed proof releases and broad tests. | Gate production builds on reclaim manifest/network/assets, script reconstruction, fixture flags, and required output presence; `pnpm build` is still a bare Next build. |
| P0-6 Patched gnark guard | **PARTIAL** | Bootstrap, vendor-drift CI, constraint gates, and frozen CCS digest checks exist. | Add a direct patched-build sentinel or guaranteed pre-prove refusal and test the unbootstrapped failure path. |
| P0-7 PR CI | **PARTIAL (mostly implemented)** | Tracked CI covers full Go, real proofs, web/client/desktop, Rust, and contracts. | Add missing production build/coherence jobs and confirm repository-host branch protection makes the intended jobs required. |
| P0-8 Reproducible WASM toolchain | **PARTIAL** | Versions are pinned in workflows/scripts and runtime hashes are release-pinned. | Enforce all tool versions, build twice cleanly in CI, compare hashes, and document/release any delta. |
| P0-9 CSP | **OPEN** | COOP/COEP/CORP only. | Enforce and test a strict CSP across the supported browser matrix, workers, WASM, and asset hosts. |
| P0-10 HSTS/nosniff/referrer | **OPEN** | Headers are absent from `next.config.mjs`. | Add them, verify document and asset responses on a production-equivalent deployment, and record the preload decision. |
| P0-11 Canonical V2 specification | **DONE** | The tracked contract spec and audit context make `ReclaimGlobalV2` canonical and describe its four-field statement-bound redeemer. | Keep spec, formal model, code, fixtures, and deployed hashes coherent on every change. |
| P0-12 One-base-per-global invariant | **PARTIAL** | The parameter datum and builders bind a concrete base hash. | State the exclusivity/misdeployment threat explicitly and add deployment/on-chain inventory attestation that no second base uses the same rewarding credential. |
| P0-13 Exact G2 on Preprod | **OPEN / accepted exception only** | Seven-input evaluation and real six/four-input claims exist. The exact seven-input on-chain claim is explicitly waived. | Execute and record the exact accepted all-distinct-seven transaction, or retain a consciously scoped exception that must not be promoted to Mainnet evidence. |
| P0-14 Monitoring/alerting | **OPEN** | Daily signed-release probe is useful integrity evidence, not an ops stack. | Monitor app, deployment API, provider, and signed assets; add server-side redacted error tracking, alert ownership, and staged failure drills without client secret telemetry. |
| P0-15 Signing-key custody | **WORKING TREE / EXTERNAL** | MPC workflow defines coordinator, auditors, release signer, authenticated decisions, and custody evidence. | Implement real independent custody and rotation, publish trusted fingerprints, remove unsafe production auto-generation, and complete transfer/compromise drills. |
| P0-16 Gnark provenance | **PARTIAL** | Patch stack and drift checks are documented and reproducible. | Land reviewed durable fork/upstream provenance or equivalent immutable source binding; keep per-patch rationale and remove patches only through audited releases. |
| P0-17 Hosted verifier decision | **PARTIAL** | Production claim authorization is on-chain; the Go verifier remains a local/development surface. | Record the explicit launch decision and align all docs. If deployed, add service hardening, rate limits, logging policy, shutdown, and CORS. |
| P0-18 Desktop launch scope | **PARTIAL** | Helper architecture, pairing, signed bundles, tests, progress, and Linux artifacts exist. | Decide launch scope; either complete signed cross-platform release/update gates or remove user steering to an unavailable helper. |
| P0-19 Claim finality | **OPEN** | UI tracks submitted hashes, but progress still produces `spent_or_unknown`. | Track the submitted transaction to a documented confirmation depth; distinguish own tx, competing spend, provider ambiguity, and rollback/reappearing UTxO. |
| P0-20 Funding credential safety | **OPEN** | Explicit input and safety documentation exist. | Derive/reconcile the credential against the recovery key, or require a genuinely hard irreversibility confirmation; cover the same account/index search scope and mismatch cases. |

## P1 — Required hardening and product completeness

| ID | Status | Current evidence and remaining acceptance |
| --- | --- | --- |
| P1-1 Prove watchdog | **OPEN** — add worker heartbeat/stall detection and a tested recovery path. |
| P1-2 Mobile/low-memory steering | **PARTIAL** — capability checks exist, but there is no reliable pre-download supported-device decision aligned with helper scope. |
| P1-3 18/21-word phrases | **OPEN** — support and test all intended recovery-phrase lengths or document a deliberate product exclusion. |
| P1-4 Manifest signatures fail closed | **PARTIAL** — signed production proof assets are verified; audit every descriptor/config path so no production mode can omit trust anchors. |
| P1-5 Secret-free prover stdout | **PARTIAL** — strong redaction exists and MPC reserves stdout for machine output; add an end-to-end secret-shaped stdout/console regression for every prover surface. |
| P1-6 Helper pairing | **PARTIAL** — courier relay and tests address timing/handoff failures; close the manual finding with installed-app/browser evidence. |
| P1-7 Safe-wallet double connect | **PARTIAL** — the UI now explains staged signing/connect states; close with a single-connect path or accepted, tested guided limitation. |
| P1-8 Helper proof progress | **DONE** — helper discovery/key-open/per-proof progress is surfaced and documented. |
| P1-9 Failure messaging | **OPEN** — finish unsupported device, browser, wallet, provider, helper, and recovery paths. |
| P1-10 Browser matrix | **OPEN** — establish tested Chromium/Firefox/Safari support and CSP/COEP behavior. |
| P1-11 Load/rate limiting | **OPEN** — run abuse/slow-client/provider tests and implement bounded rate/concurrency controls. |
| P1-12 Fixture production guards | **PARTIAL** — fixture/live separation and tests are strong; make production build failure unconditional for every fixture flag/path. |
| P1-13 Mutable-path caching | **DONE** — stable runtime/assets revalidate; only content-addressed proof releases are immutable. |
| P1-14 Edge configuration as code | **PARTIAL** — behavior and probes are documented; replace remaining dashboard-only state with reviewed configuration/export and drift checks. |
| P1-15 Dependency/review governance | **PARTIAL** — Dependabot covers Actions, Go, npm, and Cargo; add ownership/review policy, security update gates, and required checks. |
| P1-16 Desktop release gates | **PARTIAL** — Linux work exists; complete signing, updater, Windows/macOS policy, controlled key bundle, publication, and rollback if helper ships. |
| P1-17 Freeze/pre-ceremony | **WORKING TREE / EXTERNAL** — extensive MPC tooling exists, but the current exact-K21 decision is NO-GO. Freeze a reviewed signed tag only after the replacement rehearsal/audit plan is accepted. |
| P1-18 Ops runbook/drills | **WORKING TREE / EXTERNAL** — detailed MPC and deployment runbooks exist locally; complete real incident, restore, coordinator failover, CDN/provider, and rollback drills with owners and evidence. |
| P1-19 Provider failover | **OPEN** — the manifest may advertise a fallback, but request-time provider failover is not implemented. |
| P1-20 Launch pages | **PARTIAL** — English/Japanese product routes exist; error boundary, 404, privacy/legal/support, and complete metadata remain. |
| P1-21 Scheduled real Preprod E2E | **PARTIAL** — a guarded real Lace/Preprod lane exists locally; schedule and gate a secret-safe real proof/chain/UI run. The daily proof-release probe is not equivalent. |
| P1-22 Disaster recovery | **OPEN** — prove restore of app config, immutable assets, manifests, provider state, keys, and operator records within approved objectives. |
| P1-23 Wallet matrix | **OPEN** — define and test supported CIP-30 and hardware-wallet combinations. |
| P1-24 Funding settlement | **OPEN** — track the funding transaction through documented confirmation/rollback states instead of reporting submission as settlement. |
| P1-25 Deployment rotation | **OPEN** — inventory and claim old deployments or block rotation while protected UTxOs remain; test manifest/deployment migration. |
| P1-26 Discovery/proving asymmetry | **PARTIAL** — explicit paths and larger local scans improve proving, but discovery must cover or clearly guide every supported account/path that proving accepts. |

## P2 — Strongly recommended

| ID | Status | Required closure |
| --- | --- | --- |
| P2-1 Resume privacy | **OPEN** | Offer session-only/no-persistence behavior and minimize the snapshot TTL/data. |
| P2-2 Monolithic PK range behavior | **PARTIAL** | Chunked/ranged production assets work; either make the monolithic CPU fallback range-safe or disable it with clear capability messaging. |
| P2-3 Web `/healthz` | **OPEN** | Add a deployment-aware endpoint suitable for monitoring. |
| P2-4 pnpm workspace placeholder | **DONE** | The placeholder is gone; `allowBuilds` and `onlyBuiltDependencies` contain explicit booleans/lists for the approved native build dependencies. |
| P2-5 Verifier logging hygiene | **OPEN, conditional on P0-17** | Exclude credentials/bodies and document access-log/CORS policy if the verifier ships. |
| P2-6 MSM cancellation | **OPEN** | Plumb cancellation through in-flight worker/range operations and prove CPU/memory release. |
| P2-7 Funding fee display | **OPEN** | Show evaluated fee before signing. |
| P2-8 Small screens | **PARTIAL** | Funding visual captures include mobile; complete all informational/status screens at 360 px. |
| P2-9 V1/Multi deployment guard | **DONE for V1** | Canonical source/spec states there is no V1 deployment/export. Keep Multi explicitly separate and non-default. |
| P2-10 Deployment directory hygiene | **WORKING TREE / PARTIAL** | The sample is being refreshed, but move non-deployment credential fixtures out and verify every sample. |
| P2-11 Accessibility | **OPEN** | Keyboard, screen-reader, focus, contrast, and automated checks for every state. |
| P2-12 Vercel output assertion | **OPEN** | Fail the build if required VK/runtime/release assets are absent. |
| P2-13 Tx/review expiry | **OPEN** | Add validity intervals and authenticated issued/expiry times to both claim and funding flows with re-draft UX. |

## P3 — Post-launch quality follow-ups

| ID | Status | Follow-up |
| --- | --- | --- |
| P3-1 Benchmark private-input guard | **OPEN** | Make production descriptors impossible targets for private-input benchmark acceptance modes. |
| P3-2 Lace QA automation | **PARTIAL** | The real Lace driver and guarded pre-push lane exist; make the intended installed-extension journey repeatable in controlled CI/release infrastructure. |
| P3-3 Upstream gnark | **OPEN** | Track upstream changes and remove local patches only with coherence refresh and review. |
| P3-4 Documentation sweep | **PARTIAL** | Major V2, formal, MPC, and deployment docs are updated; keep verifier framing and network-neutral release inventory consistent. |
| P3-5 Explicit service key directory | **OPEN** | Remove cache/cwd fallback for long-running service use. |
| P3-6 Review-secret rotation grace | **OPEN** | Support old/new secrets for a bounded window without accepting stale or cross-deployment tokens. |

## Recommended sequence

1. Preserve, review, and split the current Mainnet/MPC working tree into
   reviewable commits without representing it as accepted production evidence.
2. Fix the 2026-07-24 rehearsal defect, complete self-tests, and run a fresh
   exact-K21 five-party rehearsal with capacity and recovery evidence.
3. In parallel, close web P0 controls: headers, finality, credential safety,
   monitoring, provider resilience, build coherence, and release governance.
4. Obtain independent build, ceremony, security-review, custody, witness, and
   signed GO evidence.
5. Generate the final signed Mainnet proof release and offline deployment plan;
   independently reproduce every native/Cardano/script/deployment hash.
6. Review and approve a separate live-ledger transaction process, deploy
   disabled, verify confirmation/coherence, then enable only after the complete
   launch checklist passes.

The production bar is not “all boxes have code.” It is that the exact reviewed
release, external evidence, live ledger identities, and operational controls
cohere and are accepted.
