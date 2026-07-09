# Manual Lace Claim Flow Automation Plan

## Purpose

Turn the manual Edge + Lace claim-flow test ritual into a repeatable,
evidence-producing Preprod smoke lane.

Reported bug and UX findings live separately in
`docs/manual-lace-claim-flow-findings.md`. This document is the automation plan
for reproducing the full end-user flow and producing bug-report-ready evidence
when those findings recur.

## Manual Test Context

The target manual loop uses:

- Microsoft Edge with Lace installed and the Preprod test wallets already added.
- Wallet seeds from the ignored local file
  `deployments/reclaim/preprod/test-wallets.local.json`.
- A fresh install/run of the Proof Helper desktop app for each test run.
- Manual deletion of the desktop app release after each run.
- The full claim path: connect impacted wallet, discover claims, pair Proof
  Helper, generate proofs, connect safe wallet, build, sign, submit, and review
  claim progress.

Installing and running the desktop app is intentional. The purpose of this lane
is to test the same end-user path a claimant would experience, including app
installation, first-run state, helper startup, browser pairing, and shutdown or
cleanup afterward.

## Existing Automation Surfaces

The repo already has a useful starting point:

- `apps/ownership-proof-web/e2e/preprod/run.mjs`
  orchestrates the Preprod stages.
- `apps/ownership-proof-web/e2e/preprod/wallet-driver.mjs`
  separates wallet role from provider choice.
- `apps/ownership-proof-web/e2e/preprod/real-lace-driver.mjs`
  introduces a real Lace profile driver.
- `apps/ownership-proof-web/e2e/preprod/lace-profile-setup.mjs`
  validates a persistent Lace profile.
- `apps/ownership-proof-web/e2e/preprod/claim-ui-stage.mjs`
  drives the browser claim UI path.
- `docs/real-lace-wallet-smoke-plan.md`
  describes the existing harness-vs-Lace smoke lane.

The key gap is not whether Playwright can run a browser. It is making the real
desktop-helper, real Lace profile, and real claim UX reliable enough to produce
actionable failures instead of ambiguous manual friction.

## Automation Plan

### Phase 1: Freeze The Manual Baseline

Add a small QA checklist and artifact schema for this exact manual flow:

- Edge/Lace profile path and browser channel.
- Desktop app release/build identity.
- Proof assets identity.
- Wallet role labels expected in Lace.
- Claim run stages and pass/fail observations.
- Known UX checks from `docs/manual-lace-claim-flow-findings.md`.

The checklist should live in the preprod e2e output for each run, not in source
control with secrets.

### Phase 2: Validate The Existing Edge + Lace Profile

Adapt the Lace profile setup command to support the existing Edge profile:

```bash
PW_USER_DATA_DIR=/home/gumbo/playground/proof-zk-recovery/proof-tool/output/playwright/lace-official-preprod-profile \
RECLAIM_E2E_LACE_BROWSER_CHANNEL=msedge \
PREPROD_TEST_WALLETS_FILE=deployments/reclaim/preprod/test-wallets.local.json \
pnpm --dir apps/ownership-proof-web e2e:preprod:lace:setup
```

The current `real-lace-driver.mjs` shape still expects
`RECLAIM_E2E_LACE_EXTENSION_DIR` and loads an unpacked Lace build. For the
manual Edge profile, add an installed-profile mode first, for example:

- `RECLAIM_E2E_LACE_EXTENSION_SOURCE=profile|unpacked`;
- in `profile` mode, do not require `RECLAIM_E2E_LACE_EXTENSION_DIR`;
- discover the Lace extension id from the persistent Edge profile's extension
  targets or configured provider metadata;
- keep the existing unpacked-extension path as the clean-room fallback.

The setup step should not import wallets by default. First it should validate
that the existing profile already contains the expected role wallets, Lace is on
Preprod, and each role can be selected and matched to the local wallet file.

If Edge cannot be launched against that profile from WSL, keep the same profile
contract but run it through the Windows-side Playwright entrypoint instead of
weakening the checks.

### Phase 3: Automate Desktop Install And Helper Lifecycle

The smoke lane should preserve the deliberate end-user install path while
making it reproducible:

- Identify the exact desktop release, installer, or dev build under test.
- Install or launch the desktop app through a test-controlled flow.
- Reset only test-scoped app data/profile state before the run.
- Wait for proof assets readiness and sidecar readiness.
- Capture the browser claim URL opened by the desktop app, or provide the
  helper URL/token through the existing helper-target env path for narrower
  development runs.
- Record desktop app version, sidecar version, proof assets identity, helper
  readiness, and paired-URL provenance in the run artifact.
- Shut down the helper and clean only test-scoped state after the run.

The primary lane should exercise desktop installation because that is part of
the user journey. An already-running helper should remain a developer shortcut
for focused browser tests, not the definition of end-to-end success.

### Phase 4: Drive The Full Claim UI With Real Lace

Use `RECLAIM_E2E_WALLET_MODE=lace` and the existing `claim-ui-acceptance` stage,
but harden it around the reported UX failures:

1. Open the paired claim URL from the helper.
2. Select and connect the impacted Lace wallet.
3. Verify claim discovery reaches real claim rows.
4. Continue to safe wallet.
5. Select and connect the safe Lace wallet with one primary action.
6. Assert the UI advances or changes to a continue state after connection.
7. Fill the impacted recovery phrase only on the local proof step.
8. Generate proofs and record progress-state evidence.
9. Build claim review.
10. Approve Lace signing only for the safe-wallet role.
11. Submit and wait for receipt or next-batch progress.

Screenshots should be issue-focused, not mandatory for every happy-path state.
Capture screenshots when the UI is confusing, blocked, visually static, or
otherwise bug-report-worthy. The Preprod wallet phrases in
`test-wallets.local.json` are test-only, so screenshots may include those UI
fields when needed to document the problem. Still redact helper tokens, pairing
fragments, wallet passwords, master XPrvs, witness sets, proof bytes, and any
non-test secrets from screenshots and metadata.

### Phase 5: Convert Findings Into Assertions

Add explicit checks so the smoke lane fails with useful artifacts when known UX
regressions occur:

- `desktop_pairing_not_ready`
- `stale_pairing_not_recoverable`
- `safe_wallet_double_connect_required`
- `proof_progress_feedback_missing`
- `unexpected_lace_signing_prompt`
- `claim_submit_no_receipt_or_next_batch`

Keep environment and test-harness failures separate from product findings:

- `lace_active_wallet_mismatch`
- `lace_profile_not_preprod`
- `desktop_install_failed`
- `desktop_helper_not_ready`
- `secret_leakage_detected`

Each failure should include an issue-focused screenshot when visual evidence is
useful, URL without helper fragment, current stage, active role, visible
headings/actions, and browser console errors.

### Phase 6: Keep Harness And Lace Lanes Separate

The injected CIP-30 harness remains the deterministic CI lane. The Lace smoke is
operator-approved, headed, Preprod-only, and allowed to submit test
transactions.

Recommended command shape once the profile and helper manager are ready:

```bash
PW_USER_DATA_DIR=/home/gumbo/playground/proof-zk-recovery/proof-tool/output/playwright/lace-official-preprod-profile \
RECLAIM_E2E_LACE_BROWSER_CHANNEL=msedge \
RECLAIM_E2E_WALLET_MODE=lace \
RECLAIM_E2E_LIVE_PREPROD=1 \
RECLAIM_E2E_SUBMIT_TRANSACTIONS=1 \
PREPROD_TEST_WALLETS_FILE=deployments/reclaim/preprod/test-wallets.local.json \
pnpm --dir apps/ownership-proof-web test:e2e:preprod:lace-smoke
```

Do not paste mnemonics, wallet passwords, helper tokens, or master XPrvs into
commands or bug reports.

## Done Criteria

- Reported findings live in `docs/manual-lace-claim-flow-findings.md`, not in
  this plan.
- A headed Edge + Lace profile validation command confirms the three wallet
  roles and Preprod network before a claim run starts.
- The smoke lane installs or launches the intended desktop app build, starts
  Proof Helper, pairs the browser, and runs at least one ADA-only claim submit
  on Preprod.
- The run produces redacted, bug-report-ready artifacts under
  `output/preprod-e2e/<run-id>/`.
- Secret leakage checks scan artifacts for helper tokens, wallet passwords,
  master XPrvs, witness sets, proof bytes, and any non-test secrets. The
  ignored Preprod test mnemonics may appear in issue screenshots when needed to
  document the local test flow.
