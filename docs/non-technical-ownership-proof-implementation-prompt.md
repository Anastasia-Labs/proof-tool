# Implementation Prompt: Non-Technical Ownership Proof Flow

You are an autonomous senior implementation agent working in:

`/home/gumbo/playground/proof-zk-recovery/proof-tool`

Your objective is to implement, test, debug, and keep iterating until a
non-technical user can prove ownership of a compromised Cardano payment key
credential and have that proof verified by a server.

Do not stop at a design sketch. Build the working flow, run it locally, test it
end to end, fix bugs, and leave clear run commands.

## Product Goal

Create a user-facing flow where a non-technical user can:

1. Open a website.
2. Enter their seed phrase locally.
3. Enter or paste the compromised target credential, and optionally a Cardano
   address if address-to-credential extraction is implemented.
4. Click one primary action to generate an ownership proof on their own machine.
5. Submit only the proof artifact to a server verifier.
6. See a plain-English verified/not-verified result.
7. Download or copy the proof artifact if they need to keep it.

The backend must never receive the seed phrase, entropy, master XPrv, or other
private witness material.

## Required Architecture

Implement the first production-shaped path as:

```text
Next.js website
  |
  | seed phrase stays browser-local
  v
Web Worker
  |
  | derives 96-byte master XPrv locally
  v
Local loopback Go prover helper
  |
  | creates ownership-proof.json
  v
Verifier API
  |
  | verifies proof artifact with pinned verifying key
  v
Plain-English verified result
```

Do not implement browser-only Groth16 proving as the main path. In this repo,
client-side proof generation means "on the user's device" through the native Go
helper.

## Context To Read First

Read these files before editing:

- `docs/ownership-proof-app-architecture-plan.md`
- `cmd/proof-tool/main.go`
- `internal/artifact/artifact.go`
- `internal/circuit/ownership/circuit.go`
- `internal/prover/prover.go`
- `packages/client-ts/src/index.ts`
- `packages/client-ts/test/master-xprv.test.ts`

Use the existing proof-tool contracts instead of inventing new proof formats.

## Non-Negotiable Security Requirements

- Never send seed phrase, entropy, or master XPrv to the hosted verifier.
- Do not pass master XPrv on a command line in the production helper path.
- Do not put seed phrase or master XPrv in URLs, localStorage, sessionStorage,
  cookies, server logs, analytics, crash reporting, or React Server Component
  payloads.
- Keep seed phrase handling in a client-only route and Web Worker.
- Prefer transferring bytes from the worker. Avoid XPrv hex strings in the
  production UI-to-helper path except where unavoidable for current helper
  compatibility; if used temporarily, document and test the follow-up to remove
  it.
- Local helper must bind only to `127.0.0.1`.
- Local helper must require a random per-session token or pairing code.
- Local helper must enforce allowed origins for the local development site and
  the configured production website origin.
- Local helper must not log request bodies or secret-bearing fields.
- Backend verifier must recompute public input from `target_credential`.
- Backend verifier must verify against a pinned verifying key and must not trust
  client-supplied keys.
- Backend-bound artifacts should omit optional `path` metadata unless the user
  explicitly chooses a debug/support export.
- Product text must say credential proof, not broad wallet/address/balance
  ownership.

## Implementation Scope

Build the smallest complete product-shaped system:

1. A Next.js App Router TypeScript web app.
2. A browser Web Worker that uses `packages/client-ts` for mnemonic validation
   and master XPrv derivation.
3. A local Go helper API, built from this repo, that:
   - starts on `127.0.0.1`,
   - exposes health/version/status,
   - accepts proof-generation requests with master XPrv, target credential, and
     optional path search bounds over request body only,
   - calls the existing ownership circuit/prover logic,
   - returns a proof artifact suitable for backend verification,
   - strips `path` for backend submission by default, while allowing a local
     debug artifact with explicit user consent.
4. A verifier API that accepts:
   - `artifact`
   - optional `expected_target_credential`
   It must recompute `public_input`, check `circuit_id`, check `vk_hash`, load a
   pinned verifying key, and return `verified: true/false`.
5. UI screens/states for:
   - helper not running,
   - helper connected,
   - invalid mnemonic,
   - invalid target credential,
   - path not found,
   - proving in progress,
   - proof generated,
   - verification in progress,
   - verified,
   - not verified,
   - unexpected failure with actionable next step.

If there is no existing Next app, scaffold one conservatively inside this repo
using the repo's package manager patterns where possible.

## User Experience Requirements

The primary screen should be the actual proof flow, not a marketing landing
page.

For non-technical users:

- Use one clear primary action per stage.
- Show helper setup status clearly.
- Explain that the seed phrase stays on the user's device in concise language.
- Do not expose circuit jargon in primary UI copy.
- Allow users to paste a 28-byte hex credential.
- If address parsing is implemented, clearly reject unsupported/script
  credentials and do not overclaim what is proven.
- Show progress during proving because proving may be slow.
- Make failures recoverable with specific actions, such as "Start the local
  helper" or "Check the credential format."
- Provide a proof download button after successful proof generation.
- Provide a verification result that a user can understand without reading logs.

Use a restrained, work-focused UI. Avoid a decorative landing page. The first
viewport should be the tool itself.

## Backend / Hosting Target

Design the web app so it can be hosted on Vercel.

For the verifier, implement it so it can run locally first. Then decide whether
it is better as:

- a Next.js Route Handler that shells/calls the Go verifier,
- a Go HTTP service behind the Next route,
- or a separate containerized Go verifier.

Prefer a separate Go verifier service if Vercel bundle/runtime limits become
awkward. Do not use Edge Runtime for proof verification.

## Testing Requirements

You must create and run tests until the flow is demonstrably working or the
remaining blocker is explicit and reproducible.

Required tests:

- Existing Go tests still pass.
- Existing TypeScript derivation tests still pass.
- Go tests for verifier validation:
  - valid artifact succeeds,
  - wrong schema fails,
  - wrong circuit id fails,
  - mismatched target credential fails,
  - mismatched public input fails,
  - mismatched verifying key hash fails,
  - malformed proof fails.
- Go tests for local helper request validation and origin/token checks.
- TypeScript tests for the worker:
  - valid mnemonic derives expected 96-byte output,
  - invalid mnemonic returns a non-secret error,
  - no seed phrase is echoed in errors.
- Frontend tests for core UI states.
- Browser automation test with Playwright or equivalent:
  - load the app,
  - see helper-not-running state,
  - connect to a running local helper,
  - enter a test mnemonic and target credential,
  - generate proof,
  - submit artifact for verification,
  - see verified result.
- Negative browser test where the artifact is tampered and verification fails.

If full Groth16 proving is too resource-intensive for routine browser
automation, create two modes:

- `real` mode: uses the actual proof-tool prover and verifier and is run
  manually or in a high-resource environment.
- `fixture` mode: uses a checked-in or generated local fixture proof only for
  UI/control-flow testing.

Do not claim end-to-end proof success unless the real prover and real verifier
have been run successfully at least once, or clearly state the exact resource
blocker and command to resume.

## Development Loop

Work in this order:

1. Inspect the repo and confirm current commands.
2. Add or update the plan if current code contradicts the architecture.
3. Implement the verifier API and tests.
4. Implement the local helper API and tests.
5. Implement the Web Worker and tests.
6. Implement the Next.js UI.
7. Wire UI to helper and verifier.
8. Run unit tests.
9. Start local services.
10. Run browser automation.
11. Fix bugs.
12. Repeat until the non-technical happy path works.

Do not stop after the first failed test. Diagnose, fix, and rerun. Keep going
until either:

- the full user flow works end to end, or
- a concrete blocker remains that cannot be resolved in the current environment.

If blocked, the final answer must include:

- exact command that failed,
- exact error text,
- what was already verified,
- what remains unverified,
- next command to run after the blocker is resolved.

## Acceptance Criteria

The task is complete only when all of these are true:

- A non-technical user can open the local website and follow the visible flow.
- The UI clearly detects whether the local helper is running.
- The seed phrase is handled only in the browser/worker/local helper path.
- The backend verifier never receives the seed phrase or master XPrv.
- The local helper can generate an ownership proof using the current proof-tool
  circuit.
- The verifier can verify that proof with a pinned verifying key.
- A tampered proof or mismatched target credential fails verification.
- Backend-bound artifact sharing omits `path` metadata by default.
- Tests cover the critical verifier/helper/worker/UI behavior.
- The app has documented run commands for:
  - installing dependencies,
  - starting the web app,
  - starting the local helper,
  - starting the verifier,
  - running tests,
  - running the browser end-to-end flow.

## Final Response Format

When finished, report:

- what was implemented,
- exact files changed,
- commands run and whether they passed,
- local URLs for the web app/helper/verifier,
- whether the real prover was exercised,
- any remaining risks or follow-ups.

Keep the summary factual. Do not imply production readiness for any secret path
that was not actually tested.

