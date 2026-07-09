# Manual Lace Claim Flow Findings

## Purpose

Track bug and UX findings reported during manual Edge + Lace testing of the
Preprod claim flow.

These are operator-reported findings, not fresh repro results from this
document. Each entry should be confirmed by a focused manual repro or the real
Lace Playwright smoke lane before being closed.

## Test Context

Manual testing currently uses:

- Microsoft Edge with Lace installed.
- The Preprod test wallets from the ignored local file
  `deployments/reclaim/preprod/test-wallets.local.json`.
- A fresh Proof Helper desktop app install/run for each test pass.
- The full end-user claim flow: connect impacted wallet, discover claims, pair
  Proof Helper, generate proofs, connect safe wallet, build, sign, submit, and
  review claim progress.

Installing and running the desktop app during each pass is deliberate end-user
flow coverage. It is not itself a finding.

## Findings

### P1: Desktop Pairing Is Brittle And Error-Prone

The desktop Proof Helper to web-app pairing flow is currently a poor user
experience. Manual runs depend on the desktop app opening or pairing with the
browser in exactly the right state, and recovery from a missed or stale pairing
is not obvious.

Expected behavior:

- The desktop app makes helper readiness and browser pairing state obvious.
- The web app recovers cleanly from stale helper fragments, missing helper
  state, and reloads.
- A fresh paired tab does not require the user to understand loopback URLs,
  tokens, or helper internals.

Automation check:

- Start from a fresh desktop/helper state.
- Assert that the browser receives a valid paired `/claim#helper=...&pair=...`
  entrypoint.
- Reload during or after pairing and verify the page either resumes safely or
  gives a clear reconnect path.
- Capture console errors, visible helper status, and a redacted pairing
  artifact.

### P1: Safe Wallet Step Requires Two Connect Actions

The safe-wallet page can require the user to hit `Connect wallet` twice before
advancing. After the first successful connection, the UI should either advance
or turn the primary action into an explicit continue action.

Expected behavior:

- First click opens Lace and establishes the safe-wallet CIP-30 session.
- Once the wallet is connected and validated, the page advances automatically
  or shows a clear `Continue` button.
- A connected safe wallet does not leave the same button label in a state that
  implies the connection did not happen.

Automation check:

- Click the safe-wallet connect action once.
- Approve Lace connection.
- Assert the UI leaves the connection-only state without a second identical
  click.
- Fail with a screenshot and accessibility snapshot if the button still reads
  as a connection action while the wallet is already connected.

### P2: Proof Generation Lacks Useful Progress Feedback

The proof step does not provide enough feedback during the slow proof-generation
period. Users cannot tell whether Proof Helper is actively working, waiting on
input, stuck, or done with some subset of proofs.

Expected behavior:

- The UI shows clear phases such as preparing requests, proving locally,
  verifying artifacts, and ready.
- If the helper cannot stream real per-proof progress yet, the UI shows an
  honest indeterminate state with proof count, helper liveness, and elapsed
  time.
- Non-fixture mode does not show fake percentages or fake partial-completion
  rows.

Automation check:

- During proof generation, assert that the UI enters a visible in-progress
  state quickly.
- Record elapsed time to `Proofs ready`.
- Fail if the page is visually static for a long interval with no phase,
  spinner, elapsed-time, or helper status change.
