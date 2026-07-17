# Local PR Web-App Claim Flow: Browser WASM + Lace

## Purpose

This document specifies the local production acceptance test for the claim
journey that an actual web-app user performs before a PR branch is pushed. To
test without pushing, run:

```bash
pnpm --dir apps/ownership-proof-web test:e2e:preprod:web-app-claim-flow-wasm-lace:local-pr -- --live-preprod
```

To run the same test and push only the exact successful commit, run:

```bash
node scripts/push-pr-with-local-lace-claim-flow.mjs --live-preprod
```

The lane builds the exact clean PR commit with `next build`, serves it through
`next start` on loopback, launches Playwright's bundled Chromium with the
dedicated Lace profile, starts on the public landing page, and completes every
normal claim step through the public UI. It uses browser-WASM proving, Lace for
wallet connection and safe-wallet signing, Cardano Preprod for the transaction,
remote R2-backed proof assets, and provider-visible confirmation for the
result.

The command is a real, spending Preprod acceptance lane. It is not a fixture
test, a component test, a Desktop Helper test, an API-stage composition, a
Lace injection smoke test, or a production-site check.

## Non-Negotiable Acceptance Contract

A passing run proves all of the following about one exact commit and its local
production build:

1. The tested URL is an origin-only `http://127.0.0.1:<port>/` loopback URL,
   never the production domain or an arbitrary remote site.
2. The production build reports the expected Git commit SHA, branch, and PR
   number through explicit local provenance before any mnemonic is entered.
3. The browser is Playwright's bundled Chromium, launched as a headed persistent
   context with one explicitly supplied unpacked Lace extension and one
   run-isolated copy of a dedicated, test-only profile template.
4. The journey starts at `/`, verifies the landing-page identity, and reaches
   `/claim` by activating the same `Claim funds` action a user activates.
5. Every claim step is performed through the web page or Lace UI in order. The
   harness may observe APIs, but it must not call build, prove, submit, or state
   transition APIs in place of a user action.
6. The impacted Lace wallet is connected and matched to the expected
   compromised payment credential. It never signs the claim transaction.
7. The app discovers the known, freshly prepared one-input claim fixture through
   its normal scan flow and displays it to the user.
8. A distinct safe Lace wallet is connected, identity-checked, explicitly
   confirmed as the destination, and is the only wallet allowed to sign.
9. `Prove in this browser` is selected explicitly. The production browser-WASM
   capability preflight passes and a real destination-bound proof is generated
   by the locally hosted app using the committed remote proof-asset hosts.
10. The recovery phrase is entered only into the claim page, is blocked if it
    appears in an outgoing URL or request body, is cleared after proof generation
    begins, and is absent from retained traces, screenshots, URLs, console logs,
    and text artifacts.
11. The transaction is built through the claim UI and its actual CBOR is
    independently parsed before approval. Its hash, prepared input, safe-wallet
    funding/collateral inputs, plain safe-address outputs, destination value, and
    absence of unrelated mint/certificate/governance actions must match the
    review. The harness must also observe that Lace receives that exact CBOR in
    the one allowed partial-sign call.
12. The receipt transaction hash matches the submitted hash, the fixture outref
    is provider-visible as spent, and the expected value reaches the safe-wallet
    destination according to the configured Preprod provider.
13. A secret-safe screenshot exists for every stable user-visible web-app state
    and every Lace approval surface listed in this document.
14. Any missing, ambiguous, stale, or mismatched condition fails closed with a
    typed reason. No step is silently skipped or accepted because a later screen
    happened to appear.

Only a run satisfying all fourteen conditions may be treated as successful
local pre-push evidence. A hosted Vercel Preview merge gate is explicitly
deferred and is not installed by this local-only change.

## Current Repository Audit

Status on 2026-07-17, after integrating current `main` commit `7eaf071`: the
local package command, guarded push wrapper, lane-managed fixture preparation,
local provenance route, focused contract tests, Lace role/signing/CBOR guards,
recovery-phrase egress guard, and twenty-screen production journey are
implemented. The exact executable head `bae4357` completed the full local lane
as Preprod transaction
`d92bf8f6d2148495084f49545c296cb7da01350da53ef00bc3f97d3497664158`.
The subsequent changes only narrow the PR to this local lane and update
documentation; final verification must still run against the exact merge head.

### Reusable implementation

- `components/ClaimFlow.tsx` implements the seven-step public claim journey:
  service review, impacted wallet, available claims, safe wallet, proof
  creation, claim submission, and claim review.
- Browser-WASM production assets, workers, descriptor validation, signed-asset
  preflight, isolation headers, and destination-bound proving are implemented.
- `e2e/preprod/real-lace-driver.mjs` can launch a persistent bundled-Chromium
  context with an unpacked Lace extension and handle selected wallet prompts.
- `e2e/preprod/lace-profile-setup.mjs` and an ignored profile provide a useful
  bootstrap surface.
- The Preprod runner already has provider-backed deployment, funding, claim,
  redaction, and artifact primitives that can be reused at explicit harness
  boundaries.
- `/claim-api/deployment` and `/claim-api/progress` expose deployment and claim
  state that the runner can observe without replacing UI actions.

### Implementation status and remaining gates

| Area | Current implementation | Remaining gate |
| --- | --- | --- |
| Command | `test:e2e:preprod:web-app-claim-flow-wasm-lace:local-pr` invokes the no-push local runner; the root wrapper adds guarded push. | Run from a clean committed PR branch with `--live-preprod`. |
| Start point | The runner clears only app-origin session/local storage, opens `/`, captures `00-landing.png`, and follows `Claim funds`. | Keep all twenty captures mandatory. |
| Target | The contract requires an origin-only loopback URL and rejects production, remote, credential-bearing, path, query, and fragment targets. | Keep the production Next server bound to `127.0.0.1`. |
| Deployment identity | `/claim-api/build-provenance` exposes non-secret local build URL/SHA/branch/PR data; the runner requires an exact match. | Keep provenance bound to the clean local `HEAD`. |
| Proof path | The runner explicitly selects `Prove in this browser` and waits for production capability/asset readiness before phrase entry. | Keep the remote proof-asset host allowlist pinned. |
| Duplicate work | The dedicated runner never calls prove/build/submit APIs to advance state; responses are observed only after UI actions. | Confirm network evidence from the first live run. |
| Safe-wallet step | The runner captures the populated destination and activates `Confirm destination and continue`. | Validate the real safe Lace address and draft on Preprod. |
| Wallet mapping | Lace selection is scoped to the account-center card containing the configured wallet label; the dedicated Lace 2.1.1 profile passes non-spending unlock and both-role switching validation, active CIP-30 addresses are revalidated, and the actual `signTx` CBOR is observed before approval. | Confirm both local profile roles before each live run. |
| Fixture | The default mode uses a separate headless bundled-Chromium setup context and the ignored Preprod funder wallet to create one ADA-only claim through `/reclaim`; it then discovers the submitted transaction's exact outref. A single unspent fixture may be resumed after an interrupted run. | Verify the local funder balance and provider configuration. |
| Screenshots | The runner enforces the ordered twenty-file ledger and masks phrase/password inputs. | Review the first live artifact bundle for any extension-specific sensitive surface. |
| Completion | The actual transaction body, observed CIP-30 CBOR, build/submit responses, receipt hash, exact outref state, and safe destination are cross-checked; provider progress must report the outref spent. | Obtain a real transaction hash and provider confirmation on the hardened final SHA. |
| Hosted PR gate | Deferred; no GitHub wallet-runner workflow or required check is included in this local-only merge. | Design and provision it in a separate reviewed change. |
| Local PR push | `push-pr-with-local-lace-claim-flow.mjs` builds and serves the current clean commit with production Next commands, performs the live claim against localhost, rechecks the commit, and pushes only after success. | Retain its twenty-screen/provider evidence as exact pre-push confidence. |

The generic deterministic lane remains valuable for broad regression coverage.
It must not be renamed or represented as this real-browser acceptance lane.

## Research-Backed Runtime Decisions

Authoritative references for the decisions in this section are Playwright's
[Chrome extension guidance](https://playwright.dev/docs/chrome-extensions),
Vercel's [GitHub integration](https://vercel.com/docs/git/vercel-for-github),
[generated deployment URL](https://vercel.com/docs/deployments/generated-urls),
and [system environment variable](https://vercel.com/docs/environment-variables/system-environment-variables)
documentation, plus GitHub's [Deployments REST API](https://docs.github.com/en/rest/deployments),
[workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[pull-request-target event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target),
[secure use of self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use),
[deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[required-check troubleshooting](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks),
and [protected-branch](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
documentation. Repository behavior must be rechecked against these sources
when the lane contract changes.

### Browser and extension

Playwright documents that Chromium extensions require a persistent context and
that Chrome and Microsoft Edge removed the command-line flags needed to
side-load them. Therefore this lane uses the `chromium` binary bundled with the
repo-pinned Playwright version, `launchPersistentContext`,
`--disable-extensions-except`, and `--load-extension`. It does not launch Edge
and does not use the Playwright MCP browser-extension bridge.

The context is headed because Lace connect and signing windows are part of the
acceptance surface. The dedicated profile is test-only, ignored, single-owner,
and never archived or uploaded. Stop every process using it before a run; the
lane must never copy a live daily browser profile or kill unrelated browser
processes.

### Local provenance and future Preview identity

The local runner supplies only non-secret Vercel-shaped build identity fields
for the exact clean commit, branch, PR number, and loopback host. The
`/claim-api/build-provenance` route exposes those fields with an explicit
`localPreviewEmulation: true` marker. The local contract requires that marker
and exact identity; deployed-Preview acceptance must reject it.

A future hosted gate must independently resolve an immutable successful Vercel
Preview for the exact PR-head SHA, verify the route against that deployment,
and reject production, mutable aliases, ambiguous deployments, and local
emulation. No GitHub Preview resolver is included in the current local-only
merge.

### Future GitHub merge enforcement (deferred)

No self-hosted wallet runner, protected environment, automatic workflow, or
required status check is included in this change. A future hosted gate must be
reviewed separately and must execute only a trusted base-branch harness, keep
candidate code inside the remote Preview/browser boundary, use disposable
Preprod-only wallets, require independent environment approval, and use a
dedicated ephemeral runner. Until then, the commands in this document provide
explicit maintainer-run pre-push evidence rather than automatic merge
enforcement.

## Test Inputs and Preconditions

### Required environment

| Variable | Contract |
| --- | --- |
| `RECLAIM_E2E_PREVIEW_URL` | Internal runner value pinned to the origin-only loopback production server. |
| `RECLAIM_E2E_EXPECTED_COMMIT_SHA` | Internal full local `HEAD` SHA required from build provenance. |
| `RECLAIM_E2E_EXPECTED_PR_NUMBER` | Internal PR number resolved for the current local branch. |
| `RECLAIM_E2E_LACE_EXTENSION_DIR` | Read-only unpacked Lace package with validated manifest identity/version. |
| `PW_USER_DATA_DIR` | Dedicated ignored Chromium/Lace profile selected by `profile.env`. |
| `RECLAIM_E2E_LACE_WALLET_PASSWORD` | Lace test-profile password loaded from the ignored mode-0600 `profile.env`. |
| `RECLAIM_E2E_LACE_ROLE_LABELS_JSON` | Optional exact role-to-label mapping for an already-provisioned profile; defaults to the short labels below. |
| `PREPROD_TEST_WALLETS_FILE` | Mode-0600 ignored Preprod fixture wallet file. |
| `RECLAIM_E2E_FIXTURE_MODE` | Optional `prepare` (default without an outref) or `existing` (requires an explicit outref). |
| `RECLAIM_E2E_CLAIM_OUTREF` | Optional one-input ADA-only outref for explicit `existing` recovery/debug mode; unset when preparing a fresh fixture. |
| `RECLAIM_PROVIDER` and provider credentials | Optional local read/funding provider configuration; defaults to public Preprod Koios. |
| `RECLAIM_E2E_SUBMIT_TRANSACTIONS` | Must equal `1` as the explicit live-Preprod approval gate. |
| `RECLAIM_E2E_OUTPUT_DIR` | Ignored output root; the runner adds a unique timestamp/SHA run directory. |

No required secret may be accepted as a command-line argument.

### Wallet roles

The claim journey uses two Lace roles:

| Role | Lace label | Rights |
| --- | --- | --- |
| `compromised_user` | `compromised_user` | Connect/read only; must never approve a signature. |
| `safe_claim_destination` | `safe_claim_dest` | Connect/read and approve the final claim transaction only. |

The funder is a harness precondition, not a claim-flow user step. Before the
claimant journey, the default `prepare` mode opens the local production
`/reclaim` page in a separate headless bundled-Chromium context, injects only
the ignored `reclaim_funder` Preprod wallet, and creates one ADA-only reclaim
UTxO for `compromised_user` through the funding UI. It records the submitted
funding hash, discovers that hash's exact outref through the provider-backed
index, and waits for provider visibility before closing the setup context.
Neither Lace nor claim-page storage is used during setup.

The wallet file's compromised credential must equal the credential exposed by
the dedicated Lace profile, and only `reclaim_funder` may sign during setup. If
one eligible ADA-only fixture already exists after an interrupted lane, the
runner resumes and consumes it; zero causes funding, and more than one fails
closed. The journey then launches a fresh headed Lace context at `/` and
consumes exactly that outref. Funding setup artifacts are separate from the
mandatory claimant screenshot ledger.

## Full User Journey and Screenshot Ledger

Screenshot names are ordered and stable. Every capture includes the full page
or full Lace approval page plus the current URL/state name in the run manifest.
Secret-bearing locators are masked. Extension screenshots may additionally
mask balances, addresses, and account identifiers that are not needed for the
assertion.

| Capture | User-visible state and required action/assertion |
| --- | --- |
| `00-landing.png` | `/`; heading identifies recovery; activate `Claim funds`. |
| `01-service-review.png` | `/claim`; `Verify this recovery service`; Preprod deployment identity is shown; activate `Continue`. |
| `02-impacted-wallet.png` | `Connect impacted wallet`; activate the Lace option. |
| `03-lace-impacted-connect.png` | Lace connect prompt; selected account is `compromised_user`; approve connection. |
| `04-impacted-connected.png` | App displays the impacted wallet identity and begins the normal scan. |
| `05-scanning-claims.png` | `Scanning for reclaimable funds` or equivalent in-progress state. |
| `06-available-claims.png` | `Available claims`; exact prepared outref/value appears and is selected; activate `Continue to safe wallet`. |
| `07-safe-wallet.png` | `Connect safe wallet`; activate the Lace option. |
| `08-lace-impacted-disconnect.png` | Lace Settings → Authorized DApps lists the exact app origin under the impacted account; disconnect that origin. |
| `09-lace-safe-connect.png` | Lace connect prompt; selected account is `safe_claim_dest`; approve connection. |
| `10-safe-destination.png` | App shows distinct safe destination; activate `Confirm destination and continue`. |
| `11-proof-method.png` | `Choose how to create proofs`; select `Prove in this browser`; capability/preflight state is ready; activate `Continue`. |
| `12-create-proofs-ready.png` | `Create proofs`; phrase controls are present and masked; enter the ignored test phrase and activate `Generate proofs`. |
| `13-proofs-generating.png` | Browser-WASM generation is visibly in progress; phrase controls are cleared or masked; wait without bypassing the UI. |
| `14-proofs-ready.png` | `Proofs ready`; proof count covers the one selected input; activate `Continue to current batch`. |
| `15-current-batch.png` | `Claim funds`; exact input and destination summary shown; activate the UI build/review action. |
| `16-transaction-review.png` | Built transaction review shows the expected input, safe destination, value/fees, and no unexpected signer; activate `Sign and submit claim`. |
| `17-lace-signing.png` | Lace transaction approval surface; selected wallet is revalidated as `safe_claim_dest`; approve once. |
| `18-submitted.png` | `Claim submitted`/pending review; transaction hash is visible and recorded. |
| `19-recovery-complete.png` | `Recovery complete`; receipt hash matches submission and no next batch remains. |

If the UI displays a stable intermediate screen not listed here, the test must
capture it and the ledger must be updated. The runner holds only the relevant
read response while capturing the scanning and submitted states; it does not
manufacture product state or replace a UI action. All listed screens and Lace
prompts are mandatory.

The runner asserts the seven top-level step indicators advance in order:

1. Verify service
2. Impacted wallet
3. Available claims
4. Safe wallet
5. Create proofs
6. Claim funds
7. Claim review

It records each state start, screenshot, user action, and completion in a
machine-readable manifest. Landing directly on a later state, calling an API to
advance, or satisfying a step only because local storage/profile state leaked
from a previous run is a failure.

## Browser-WASM Proof Requirements

Before phrase entry, the deployed app must establish the production capability
contract used by `ClaimFlow`: WebAssembly, Worker/fetch support,
`crossOriginIsolated`, SharedArrayBuffer, sufficient hardware concurrency,
nested workers, signed asset availability/integrity, and the deployment-pinned
VK hash. The test records only redacted capability outcomes and asset identity;
it does not retain proof bytes, recovery path metadata, mnemonic material, or
worker payloads.

The test must explicitly select the browser method even if it is currently the
default. It must detect and fail on a silent fallback to Desktop Helper,
fixture proving, a hosted proving API, or a pre-existing proof in browser
storage. Browser/profile storage used by the claim origin is cleared before the
journey while Lace extension state is preserved.

Use one claim input so the real proof stays bounded. Timeout guidance is based
on current proving behavior, not on ordinary UI waits: allow up to ten minutes
for proof generation and twenty-five minutes for the full lane, with
progress-based diagnostics and no automatic transaction retry.

## Assertions Beyond the UI

Read-only observations are allowed and required at harness boundaries:

- capture deployment and build provenance before browser secret entry;
- verify the prepared outref is unspent and matches the manifest before the
  headed Lace context opens `/`;
- observe relative page/API failures to diagnose the deployed app;
- record the transaction hash returned through the normal UI request;
- after submission, poll the configured provider or `/claim-api/progress` until
  the exact outref is spent and the app reports completion;
- independently confirm the safe destination received the expected output/value
  under the transaction hash, accounting for the displayed fee and min-ADA.

These observations must never substitute for clicking a normal user action.
The runner fails if the UI says complete but the provider does not, or if the
provider confirms a different transaction than the receipt.

## Artifacts and Secret Safety

Each run writes an ignored directory containing:

- `run.json`: status, expected/observed deployment identity, commit, PR,
  browser/Lace versions, fixture outref, screen ledger, typed failure, and tx
  hash;
- `screenshots/*.png`: only the enumerated masked captures;
- `network-summary.json`: method/path/status/timing only, with query values and
  sensitive headers removed;
- `console.log`: filtered browser messages with secret-bearing payloads
  rejected;
- `provider-confirmation.json`: exact outref, transaction hash, safe destination
  credential hash, confirmation status, and non-secret values;
- `fixture-setup/`: redacted funding summary and setup screenshot when the lane
  creates a fixture; this is explicitly outside the claimant screenshot ledger;
- optional Playwright trace only when its content policy can exclude phrase
  values, extension storage, request bodies, and screenshots containing
  unmasked inputs. Until then, traces and video are disabled.

The final artifact step scans every retained text file for all fixture words,
master-key encodings, Lace password, bypass secret, helper tokens, and known
sensitive path metadata. It also verifies no profile files are under the
artifact directory. A hit fails the run and quarantines publication.

Screenshots are taken with Playwright locator masks. Phrase fields are captured
empty before entry and masked while populated; the generating screenshot is
taken only after the page has cleared or hidden the phrase, otherwise it is
masked. No screenshot is taken during password entry unless the password input
is masked.

## Failure Taxonomy

Failures must be typed so a failed local run is actionable:

- `preview_url_invalid`
- `preview_deployment_not_ready`
- `preview_deployment_ambiguous`
- `preview_is_production`
- `preview_provenance_unavailable`
- `preview_commit_mismatch`
- `preview_pr_mismatch`
- `preview_protection_failed`
- `preprod_manifest_incoherent`
- `fixture_mode_invalid`
- `fixture_wallet_identity_mismatch`
- `fixture_signing_policy_invalid`
- `fixture_funding_confirmation_timeout`
- `fixture_not_ada_only`
- `fixture_outref_missing_or_spent`
- `lace_profile_in_use`
- `lace_extension_version_unapproved`
- `lace_unlock_failed`
- `lace_role_ambiguous`
- `lace_role_identity_mismatch`
- `unexpected_compromised_wallet_signature`
- `claim_step_missing_or_out_of_order`
- `prepared_claim_not_discovered`
- `safe_destination_overlap`
- `browser_wasm_unavailable`
- `browser_wasm_asset_preflight_failed`
- `browser_wasm_proof_failed`
- `transaction_review_mismatch`
- `lace_signature_rejected`
- `claim_submission_failed`
- `receipt_transaction_mismatch`
- `provider_confirmation_timeout`
- `provider_destination_mismatch`
- `provider_destination_timeout`
- `artifact_secret_detected`

Automatic retries are limited to idempotent reads and UI waits. The harness
must never retry a Lace signing approval or submit a second transaction after
an ambiguous submission. It resolves ambiguity by querying the exact outref and
recorded transaction hash.

## Implementation Work Packages

Implementation status below describes the current working tree, not live
acceptance evidence.

### A. Local production provenance and target guard

- **Implemented:** add a small Node-runtime route that returns non-secret build
  provenance.
- **Implemented:** add pure validation helpers and tests for the exact loopback
  URL, explicit local-emulation marker, commit/PR match, and production or
  arbitrary-remote rejection.

### B. Lace driver hardening

- **Implemented:** restrict the journey to the compromised and safe roles.
- **Implemented:** select roles by Lace UI identity rather than fixed index.
- **Implemented:** re-enable Lace on the app page and compare active address/payment
  credential after every switch and before signing.
- **Implemented:** make connect/sign prompt handling return the extension page so it can be
  asserted and screenshotted.
- **Implemented:** add a hard guard that the compromised role can never enter the signing path.

### C. Dedicated full-journey runner

- **Implemented:** add `e2e/preprod/web-app-claim-flow-wasm-lace.mjs` and focused modules rather
  than adding more conditional stages to the generic runner.
- **Implemented:** clear only the loopback origin's app storage, preserve Lace profile state, and
  begin at `/`.
- **Implemented:** drive/assert every ledger step with accessible roles and visible user labels.
- **Implemented:** instrument requests for observation while prohibiting direct transition API
  calls from the harness.
- **Implemented:** capture per-step masked screenshots and incremental `run.json` state.

### D. Fixture and provider boundary

- **Implemented:** default to a separate setup context that funds one ADA-only
  claim through the local `/reclaim` UI and discovers its exact provider-visible
  outref; resume exactly one eligible fixture after an interrupted run.
- **Implemented:** keep the funder outside Lace, allow only its expendable
  Preprod role to sign setup, and require wallet-file/Lace compromised identity
  agreement.
- **Implemented:** require UI discovery of that exact outref and fail if the
  compromised credential has any other unspent claim.
- **Implemented:** add provider-visible postconditions for spent input, receipt hash, and safe
  destination output index/address/value under the submitted transaction hash.

### E. Package commands and guarded push

- **Implemented:** add the no-push local package script and root test-and-push
  wrapper.
- **Implemented:** add focused unit/contract tests that do not spend funds.
- **Implemented:** independently parse the transaction body and observe the
  exact CIP-30 `signTx` CBOR before Lace approval; block recovery-phrase
  material in outgoing browser URLs and request bodies.
- **Implemented:** scan retained local evidence for configured secrets and
  refuse the push if the branch, commit, or worktree changes during the run.
- **Deferred:** automatic hosted execution, wallet-runner provisioning, and a
  branch-protection-facing required check.

### Future trusted-runner operation

Hosted wallet-runner configuration is deliberately outside this local-only
merge and must be specified, reviewed, provisioned, and validated separately.

### Local production claim before a PR push

The local lane provides explicit pre-push evidence for an existing PR. From the
repository root, run:

```bash
node scripts/push-pr-with-local-lace-claim-flow.mjs --live-preprod
```

Or, from `apps/ownership-proof-web`, run:

```bash
pnpm push:pr:with-local-claim-flow -- --live-preprod
```

Use `--remote <name>` after `--live-preprod` when the PR branch is not pushed
to `origin`. This is intentionally an explicit PR-push command, not a global
`pre-push` Git hook and not a replacement for ordinary `git push`. The
`--live-preprod` acknowledgement is required because one invocation prepares
a fresh locked Preprod fixture and then submits the claim transaction.

The command fails before browser startup unless:

- the worktree is clean and `HEAD` is a full commit;
- the current branch is named and is neither `main` nor `master`;
- GitHub reports an existing open PR whose head branch is the current branch;
- a no-hook push dry-run confirms authentication, permission, and fast-forward
  safety for the selected Git remote;
- the ignored repository `.env.local` selects the canonical Preprod reclaim
  manifest; and
- the ignored dedicated Lace `profile.env` exists with both required wallets.

Linked worktrees automatically look for those two ignored files in the primary
checkout. They can instead be selected explicitly with
`RECLAIM_E2E_LOCAL_ENV_FILE` and
`RECLAIM_E2E_LACE_PROFILE_ENV_FILE`. No value from either file is committed
or placed in a process argument.

The local lane uses `next build` followed by `next start`, sets only
non-secret Vercel identity fields for the current commit and PR, and exposes an
explicit `localPreviewEmulation: true` provenance marker. The local lane
requires that marker, and any future deployed lane must reject it. This keeps
localhost evidence distinct from remote Preview evidence.

The Next build and server keep production mode. The separate local test driver
removes production mode only from its own process so the existing fixture
funder may prepare a fresh Preprod input; that harness is never injected into
the production web app or used as the signing wallet.

The driver unlocks and selects the compromised test wallet before creating the
web-app tab so Lace injects its real CIP-30 provider when the page is created.
It first removes any stale authorization for the exact local origin through
Lace Settings → Authorized DApps; this happens before the journey starts at
the landing page. It still selects and connects Lace through the visible claim
UI afterward. For Lace 2.1.1, connection approval selects Source Account,
chooses the wallet by its configured label, captures the extension review, and
then authorizes.

After the impacted scan, the runner follows Lace's normal multi-wallet path:
it opens Settings → Authorized DApps, captures screenshot 08, disconnects only
the exact app origin, switches to `safe_claim_dest`, and reconnects through
the visible safe-wallet UI in screenshot 09. A missing approval dialog is a
failure; the runner never silently reuses the impacted account.

The app refreshes detected wallets on the Cardano initialization event, window
focus or visibility changes, and a bounded ten-second fallback poll so a
slightly delayed extension injection does not leave a user at No wallet found.

The lane pins the exact commit's Vercel stable-pointer manifest at
`public/proof-assets/reclaim-deployment.json` instead of trusting an older
ignored manifest path. That manifest must keep browser-WASM proving enabled,
with the proving key at `proof-assets.reclaim-proof.com` and the optimized
constraint system at `proof-assets-2m.reclaim-proof.com`. Small signed
manifests and the WASM runtime
are served by the production Next build as they are on Vercel; the large proof
assets stay on the remote R2-backed host. The journey still starts at the
landing page, creates all twenty screenshots, signs only with
`safe_claim_destination`, submits to Preprod, and requires provider-visible
spent-input and safe-destination confirmation.

Before browser startup, the wrapper runs a no-hook push dry-run so authentication,
permission, or non-fast-forward failures cannot waste a funded fixture. After
success, it re-reads the branch, commit, and worktree. If anything changed
during the long proof, it refuses to push. Otherwise it runs a normal
non-forced push of that exact `HEAD`. Any build, browser, Lace, transaction,
provider, or provenance failure leaves the remote branch untouched.

For diagnosis without pushing, run the local lane directly:

```bash
pnpm --dir apps/ownership-proof-web test:e2e:preprod:web-app-claim-flow-wasm-lace:local-pr -- --live-preprod
```

Local success cannot prove that Vercel deployed the same commit or behaves
identically in its hosted runtime. That limitation is explicit; this change
does not install a partial or unprovisioned hosted workflow.

### Current verification evidence

- The focused provenance/contract/fixture/provider/Lace/app-server and local
  PR-push tests passed before the production-readiness review; the hardened
  transaction/observer/egress tests add further focused coverage.
- `pnpm typecheck`, the Next production build, Node syntax checks, direct
  reclaim-manifest verification, and `git diff --check` pass for the reviewed
  executable tree.
- A fresh ignored Lace 2.1.1 profile was built with only the repo-backed
  `compromised_user` and `safe_claim_destination` Preprod fixtures, a generated
  test-only password persisted in a mode-0600 ignored `profile.env`, and the
  Testnet network selected. `pnpm e2e:preprod:lace:setup` then passed against
  that profile and reported the two account-center labels and distinct redacted
  addresses. The driver selects each containing wallet card by label instead of
  using an array index; the fixture funder remains outside Lace.
- On executable head `bae4357`, typecheck and the production Next build passed,
  the complete web-app suite passed 416 of 416 tests across 48 files, and the
  live local twenty-screen journey completed as transaction
  `d92bf8f6d2148495084f49545c296cb7da01350da53ef00bc3f97d3497664158`.
  Provider evidence matched the exact submission/build hash, spent claim input,
  safe destination, and 2,000,000-lovelace output; the final receipt showed
  `1 of 1` claimed and zero remaining.
- Any executable change after that evidence requires a fresh exact-head local
  run before push. Documentation-only descendants must identify the validated
  executable parent instead of pretending they were separately spending-tested.

## Verification Matrix

| Level | Required evidence |
| --- | --- |
| Static | Typecheck, lint/style where configured, manifest verification, package script exists. |
| Unit | URL/provenance guards, state-order assertions, screenshot ledger, redaction, role/signing guards, ambiguous-submit handling. |
| Non-spending integration | Real Lace profile launch, both role mappings, connect prompts, browser-WASM capability preflight against the local production build. |
| Live acceptance | Fresh fixture, all twenty captures, real browser-WASM proof, safe Lace signature, submitted tx, final receipt, provider-visible confirmation. |
| Guarded push | Clean PR branch and exact `HEAD` rechecked after acceptance; normal non-force push occurs only when unchanged. |

Mocks may satisfy unit coverage only. A Lace connect smoke cannot satisfy the
claim journey. A UI receipt without provider confirmation cannot satisfy live
acceptance. Local evidence must not be described as deployed-Preview evidence.

## Definition of Done

This plan is complete only when:

- the exact package command exists and fails closed on missing inputs;
- it uses bundled Chromium, the dedicated Lace profile, and the unpacked Lace
  package without Computer Use or an installed Edge session;
- it builds and verifies the exact clean PR `HEAD` through the loopback
  production server and local provenance marker;
- it starts at the landing page and performs every user claim step in order;
- it explicitly uses real browser-WASM proving and generates no proof outside
  the page;
- only the distinct safe Lace wallet signs;
- all mandatory screenshots and redacted run artifacts are present;
- the receipt and provider-visible chain result agree;
- focused tests pass and one live Preprod run produces acceptance evidence;
- the guarded wrapper refuses to push a changed branch, commit, or worktree;
- this document's implementation status is reconciled to the checked-in code
  and the retained evidence without overstating partial results.

Until every item is met, report the local lane as incomplete and do not use the
existing Lace smoke command as equivalent evidence.
