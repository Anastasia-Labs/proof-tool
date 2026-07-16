# PR Preview Web-App Claim Flow: Browser WASM + Lace

## Purpose

This document specifies the merge-gating acceptance test for the claim journey
that an actual web-app user performs. The required command is:

```bash
pnpm test:e2e:preprod:web-app-claim-flow-wasm-lace
```

The test must launch Playwright's bundled Chromium with the repository's
dedicated Lace profile, navigate to the exact Vercel Preview deployment for the
commit under review, start on the public landing page, and complete every
normal claim step through the public UI. It must use browser WASM proving,
Lace for wallet connection and safe-wallet signing, Cardano Preprod for the
transaction, and provider-visible confirmation for the result.

The command is a real, spending Preprod acceptance lane. It is not a fixture
test, a component test, a Desktop Helper test, an API-stage composition, a
Lace injection smoke test, or a production-site check.

## Non-Negotiable Acceptance Contract

A passing run proves all of the following about one exact commit and one exact
deployment:

1. The tested URL is an immutable Vercel Preview deployment, not the production
   domain and not a mutable branch alias.
2. The deployment reports the expected Git commit SHA and Vercel Preview
   environment before any wallet or mnemonic is exposed to it.
3. The browser is Playwright's bundled Chromium, launched as a headed persistent
   context with one explicitly supplied unpacked Lace extension and one
   dedicated, test-only profile.
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
   by the deployed app.
10. The recovery phrase is entered only into the claim page, remains local, is
    cleared after proof generation begins, and is absent from retained traces,
    screenshots, URLs, console logs, and text artifacts.
11. The transaction is built through the claim UI, reviewed, approved through
    Lace, submitted, and shown first as submitted/pending and then as complete.
12. The receipt transaction hash matches the submitted hash, the fixture outref
    is provider-visible as spent, and the expected value reaches the safe-wallet
    destination according to the configured Preprod provider.
13. A secret-safe screenshot exists for every stable user-visible web-app state
    and every Lace approval surface listed in this document.
14. Any missing, ambiguous, stale, or mismatched condition fails closed with a
    typed reason. No step is silently skipped or accepted because a later screen
    happened to appear.

Only a run satisfying all fourteen conditions may publish the required PR
check as successful.

## Current Repository Audit

Status on 2026-07-16, on a branch based on `origin/main` commit `214dcbb`: the
dedicated runner, package command, lane-managed fixture preparation,
provenance route, automatic exact-Preview resolver, focused contract tests,
Lace role/signing guards, trusted-runner workflow, and explicit local-production
PR-push wrapper are implemented. The
entire lane was also applied to the exact active PR #13 head `448f3b6` and
verified there, so the current browser-WASM changes have compatibility
evidence before the live lane runs.
The lane is **not yet acceptance-complete** because it has not run against an
exact PR Preview, its self-hosted runner/environment variables are not verified,
and the stable check is not confirmed required by `main` branch protection. The
old Lace smoke command remains unacceptable merge evidence.

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
| Command | `test:e2e:preprod:web-app-claim-flow-wasm-lace` invokes the dedicated runner. | Run it live with the dedicated profile and lane-managed fixture. |
| Start point | The runner clears only app-origin session/local storage, opens `/`, captures `00-landing.png`, and follows `Claim funds`. | Confirm all nineteen captures against the deployed PR UI. |
| Target | The contract requires an exact HTTPS Vercel origin and rejects production/non-Vercel/path/query targets. | Exercise it against the immutable URL produced for a PR. |
| Deployment identity | `/claim-api/build-provenance` exposes non-secret Vercel environment/URL/SHA/PR data; the runner requires an exact match. | Deploy the route and confirm the Vercel project exposes system variables at runtime. |
| Proof path | The runner explicitly selects `Prove in this browser` and waits for production capability/asset readiness before phrase entry. | Complete a real WASM proof in the Preview runtime. |
| Duplicate work | The dedicated runner never calls prove/build/submit APIs to advance state; responses are observed only after UI actions. | Confirm network evidence from the first live run. |
| Safe-wallet step | The runner captures the populated destination and activates `Confirm destination and continue`. | Validate the real safe Lace address and draft on Preprod. |
| Wallet mapping | Lace selection is scoped to the account-center card containing the configured wallet label; the dedicated Lace 2.1.1 profile now passes non-spending unlock and both-role switching validation, and active CIP-30 addresses are revalidated after connection and before signing. | Confirm the connected CIP-30 identities against the exact Preview during the live run. |
| Fixture | The default mode uses a separate headless bundled-Chromium setup context and the ignored Preprod funder wallet to create one ADA-only claim through `/reclaim`; it then discovers the submitted transaction's exact outref. A single unspent fixture may be resumed after an interrupted run. | Verify the funder balance/provider configuration on the dedicated runner. |
| Screenshots | The runner enforces the ordered nineteen-file ledger and masks phrase/password inputs. | Review the first live artifact bundle for any extension-specific sensitive surface. |
| Completion | Build/submit responses, receipt hash, exact outref state, and safe destination are cross-checked; provider progress must report the outref spent. | Obtain a real transaction hash and provider confirmation. |
| PR gate | `preprod-web-app-claim-flow-wasm-lace.yml` automatically resolves the successful Vercel deployment for a same-repository, non-draft PR head, serializes the profile, requires environment approval, and publishes one fail-closed aggregate result. | Configure runner labels/variables/secrets, exercise the automatic trigger on a real PR, and require the stable aggregate job name in `main` protection. |
| Local PR push | `push-pr-with-local-lace-claim-flow.mjs` builds and serves the current clean commit with production Next commands, performs the same live claim against localhost, rechecks the commit, and pushes only after success. | Run the first live local invocation and retain its nineteen-screen/provider evidence as pre-push confidence, not as deployed-Preview acceptance. |

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
[pull-request event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request),
[required-check troubleshooting](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks),
and [protected-branch](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
documentation. Repository behavior must be rechecked against these sources
when the workflow contract changes.

### Browser and extension

Playwright documents that Chromium extensions require a persistent context and
that Chrome and Microsoft Edge removed the command-line flags needed to
side-load them. Therefore this lane uses the `chromium` binary bundled with the
repo-pinned Playwright version, `launchPersistentContext`,
`--disable-extensions-except`, and `--load-extension`. It does not launch Edge
and does not use the Playwright MCP browser-extension bridge.

The context is headed because Lace connect and signing windows are part of the
acceptance surface. The profile directory is test-only, ignored, single-owner,
and never archived. A profile lock fails with `lace_profile_in_use`; the runner
must not copy a live browser profile or kill unrelated browser processes.

### Vercel preview identity

Vercel creates a preview deployment for each Git push/PR update and exposes the
deployment through GitHub's deployment/check metadata. Vercel also exposes
`VERCEL_ENV`, `VERCEL_URL`, `VERCEL_GIT_COMMIT_SHA`, and
`VERCEL_GIT_PULL_REQUEST_ID` to the deployed application.

For a normal PR run, a GitHub-hosted resolver polls the Deployments API for the
exact PR-head SHA and accepts exactly one latest successful `Preview` status
whose `environment_url` belongs to the configured Vercel project. It does not
scrape a PR comment and does not substitute a branch alias. The explicit URL
input exists only for a maintainer's manual fallback. Before opening the claim
flow the protected runner requests a build-provenance route and requires:

- `environment === "preview"`;
- a normalized deployment hostname equal to the supplied target hostname;
- `commitSha === RECLAIM_E2E_EXPECTED_COMMIT_SHA`;
- the expected PR number when the deployment has PR metadata;
- the public deployment and claim manifests to be enabled for Cardano Preprod;
- browser proving to be enabled with the coherent signed descriptor/VK set.

If Vercel Deployment Protection is enabled, the runner adds the automation
bypass header at browser-context creation so relative page/API requests inherit
it. The secret is never placed in a URL, artifact, screenshot name, or log.

### GitHub merge enforcement

The stable aggregate check `Preprod web-app claim flow (WASM + Lace)` must be
required by branch protection for `main`. GitHub reports a `pull_request`
workflow check on the synthetic PR merge ref, while this lane deliberately
checks out, deploy-resolves, and tests `github.event.pull_request.head.sha`
because that is the exact commit Vercel Preview built. The run record must keep
both identities explicit; it must never describe the merge-ref SHA as the
deployed SHA. A later head push starts a new run and invalidates the earlier
result. Merge-queue support, if enabled, must either run an equivalent lane for
`merge_group` or be explicitly handled by the repository's required-check
policy.

This lane cannot safely run arbitrary fork code on a secret-bearing self-hosted
runner. The dedicated Lace wallets and mnemonic are expendable Preprod-only
fixtures with no mainnet value, but the preview JavaScript can still read data
entered into its page. Therefore:

- same-repository, non-draft PRs resolve their Preview on a GitHub-hosted runner
  and may proceed to the locked-down dedicated runner only after environment
  approval;
- fork PRs fail the stable aggregate check before the secret-bearing runner is
  scheduled; a maintainer must reproduce the reviewed commit on a trusted
  same-repository branch;
- the runner has no unrelated credentials, browser sessions, mainnet wallets,
  or access to a daily browser profile;
- concurrency is one per dedicated Lace profile;
- a hosted aggregate job fails unless both exact-Preview resolution and the
  protected live execution succeed; a skipped executor cannot become a green
  merge signal.

## Test Inputs and Preconditions

### Required environment

| Variable | Contract |
| --- | --- |
| `RECLAIM_E2E_PREVIEW_URL` | Exact immutable HTTPS Vercel Preview deployment URL. |
| `RECLAIM_E2E_EXPECTED_COMMIT_SHA` | Full PR-head commit SHA required from build provenance. |
| `RECLAIM_E2E_EXPECTED_PR_NUMBER` | PR number when the deployment was created for a PR. |
| `RECLAIM_E2E_PR_MERGE_SHA` | Optional GitHub synthetic merge-ref SHA retained separately in automatic-run evidence; never treated as the deployed SHA. |
| `RECLAIM_E2E_LACE_EXTENSION_DIR` | Read-only unpacked Lace package with validated manifest identity/version. |
| `PW_USER_DATA_DIR` | Dedicated ignored persistent Chromium profile. |
| `RECLAIM_E2E_LACE_WALLET_PASSWORD` | Lace test-profile password, supplied through the runner secret store. |
| `RECLAIM_E2E_LACE_ROLE_LABELS_JSON` | Optional exact role-to-label mapping for an already-provisioned profile; defaults to the short labels below. |
| `PREPROD_TEST_WALLETS_FILE` | Mode-0600 ignored Preprod fixture wallet file. |
| `RECLAIM_E2E_FIXTURE_MODE` | Optional `prepare` (default without an outref) or `existing` (requires an explicit outref). |
| `RECLAIM_E2E_CLAIM_OUTREF` | Optional one-input ADA-only outref for explicit `existing` recovery/debug mode; unset for the merge gate. |
| `RECLAIM_E2E_VERCEL_BYPASS_SECRET` | Optional deployment-protection automation secret. |
| `RECLAIM_E2E_VERCEL_PROJECT_HOST_PREFIX` | Optional repository variable used by automatic resolution; defaults to `proof-tool-` and must match immutable Preview hostnames. |
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
claimant journey, the default `prepare` mode opens the exact Preview's
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
| `08-lace-safe-connect.png` | Lace connect prompt; selected account is `safe_claim_dest`; approve connection. |
| `09-safe-destination.png` | App shows distinct safe destination; activate `Confirm destination and continue`. |
| `10-proof-method.png` | `Choose how to create proofs`; select `Prove in this browser`; capability/preflight state is ready; activate `Continue`. |
| `11-create-proofs-ready.png` | `Create proofs`; phrase controls are present and masked; enter the ignored test phrase and activate `Generate proofs`. |
| `12-proofs-generating.png` | Browser-WASM generation is visibly in progress; phrase controls are cleared or masked; wait without bypassing the UI. |
| `13-proofs-ready.png` | `Proofs ready`; proof count covers the one selected input; activate `Continue to current batch`. |
| `14-current-batch.png` | `Claim funds`; exact input and destination summary shown; activate the UI build/review action. |
| `15-transaction-review.png` | Built transaction review shows the expected input, safe destination, value/fees, and no unexpected signer; activate `Sign and submit claim`. |
| `16-lace-signing.png` | Lace transaction approval surface; selected wallet is revalidated as `safe_claim_dest`; approve once. |
| `17-submitted.png` | `Claim submitted`/pending review; transaction hash is visible and recorded. |
| `18-recovery-complete.png` | `Recovery complete`; receipt hash matches submission and no next batch remains. |

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

Failures must be typed so a red required check is actionable:

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

### A. Preview provenance and target guard

- **Implemented:** add a small Node-runtime route that returns non-secret Vercel build
  provenance.
- **Implemented:** add pure validation helpers and tests for exact URL, Preview environment,
  commit/PR match, deployment protection, and production rejection.
- **Implemented:** set Vercel automation headers at context creation.

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
- **Implemented:** clear only the preview origin's app storage, preserve Lace profile state, and
  begin at `/`.
- **Implemented:** drive/assert every ledger step with accessible roles and visible user labels.
- **Implemented:** instrument requests for observation while prohibiting direct transition API
  calls from the harness.
- **Implemented:** capture per-step masked screenshots and incremental `run.json` state.

### D. Fixture and provider boundary

- **Implemented:** default to a separate setup context that funds one ADA-only
  claim through the Preview `/reclaim` UI and discovers its exact provider-visible
  outref; resume exactly one eligible fixture after an interrupted run.
- **Implemented:** keep the funder outside Lace, allow only its expendable
  Preprod role to sign setup, and require wallet-file/Lace compromised identity
  agreement.
- **Implemented:** require UI discovery of that exact outref and fail if the
  compromised credential has any other unspent claim.
- **Implemented:** add provider-visible postconditions for spent input, receipt hash, and safe
  destination output index/address/value under the submitted transaction hash.

### E. Package command and merge gate

- **Implemented:** add the exact package script.
- **Implemented:** add focused unit/contract tests that do not spend funds.
- **Implemented:** add an automatic PR workflow that resolves exactly one
  successful Vercel Preview for the current same-repository PR-head SHA before
  entering the protected Lace environment. Keep an exact URL/SHA/PR manual
  dispatch only as a maintainer fallback; the default gate prepares its own
  fixture, while an outref input is optional for interrupted-run recovery or
  debugging.
- **Implemented:** publish the branch-protection-facing name from a hosted
  aggregate job that fails unless resolution and the protected executor both
  succeed, including when the executor is skipped.
- **Implemented:** upload only secret-scan-approved artifacts.
- **External repository setting:** configure the stable job/check name as
  required for `main`; document fork and merge-queue behavior.

### Trusted-runner operation

Configure the `preprod-lace-e2e` GitHub environment with approval protection,
the `proof-tool-preprod-lace` self-hosted runner label, these repository or
environment variables:

- `RECLAIM_E2E_LACE_EXTENSION_DIR`
- `RECLAIM_E2E_LACE_PROFILE_DIR`
- `RECLAIM_E2E_LACE_WALLET_FILE`
- optional `RECLAIM_E2E_VERCEL_PROJECT_HOST_PREFIX` (defaults to
  `proof-tool-`)
- optional `RECLAIM_E2E_LACE_ROLE_LABELS_JSON`
- optional `RECLAIM_PROVIDER`, `RECLAIM_KOIOS_URL`, and
  `RECLAIM_BLOCKFROST_URL`

and these secrets:

- `RECLAIM_E2E_LACE_WALLET_PASSWORD`
- optional `RECLAIM_E2E_VERCEL_BYPASS_SECRET`
- optional `RECLAIM_KOIOS_TOKEN` or `RECLAIM_BLOCKFROST_PROJECT_ID`

### Local production claim before a PR push

The deployed Vercel lane remains the only merge-gating acceptance result, but a
maintainer can require the same user journey before updating an existing PR.
From the repository root, run:

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
explicit `localPreviewEmulation: true` provenance marker. The deployed lane
rejects that marker, while the local lane requires it. This prevents localhost
evidence from being confused with a real Vercel Preview.

The Next build and server keep production mode. The separate local test driver
removes production mode only from its own process so the existing fixture
funder may prepare a fresh Preprod input; that harness is never injected into
the production web app or used as the signing wallet.

The lane pins the exact commit's Vercel stable-pointer manifest at
`public/proof-assets/reclaim-deployment.json` instead of trusting an older
ignored manifest path. That manifest must keep browser-WASM proving enabled,
with the proving key at `proof-assets.reclaim-proof.com` and the optimized
constraint system at `proof-assets-2m.reclaim-proof.com`. Small signed
manifests and the WASM runtime
are served by the production Next build as they are on Vercel; the large proof
assets stay on the remote R2-backed host. The journey still starts at the
landing page, creates all nineteen screenshots, signs only with
`safe_claim_destination`, submits to Preprod, and requires provider-visible
spent-input and safe-destination confirmation.

After success, the wrapper re-reads the branch, commit, and worktree. If
anything changed during the long proof, it refuses to push. Otherwise it runs
a normal non-forced push of that exact `HEAD`. Any build, browser, Lace,
transaction, provider, or provenance failure leaves the remote branch
untouched.

For diagnosis without pushing, run the local lane directly:

```bash
pnpm --dir apps/ownership-proof-web test:e2e:preprod:web-app-claim-flow-wasm-lace:local-pr -- --live-preprod
```

Local success is strong pre-push evidence, but it cannot prove that Vercel
deployed the same commit, applied the correct protection settings, or behaves
identically in its hosted runtime. PR #14 must still pass the exact deployed
Preview check before merge.

The normal merge gate needs no operator-supplied URL: opening, reopening,
updating, or marking a same-repository PR ready for review starts the resolver.
It polls GitHub's Vercel deployment status for that exact head SHA, then waits
for approval on `preprod-lace-e2e` before scheduling the dedicated runner.

`workflow_dispatch` is a maintainer fallback after this workflow exists on the
default branch. Dispatch it with the PR branch as the workflow ref so the
event SHA, checkout SHA, supplied SHA, deployed SHA, and PR metadata can all be
required to agree. Leave `claim_outref` unset for the ordinary self-preparing
run:

```bash
gh workflow run preprod-web-app-claim-flow-wasm-lace.yml \
  --ref <pr-branch> \
  -f preview_url=https://<immutable-deployment>.vercel.app/ \
  -f expected_sha=<full-pr-head-sha> \
  -f pr_number=<number>
```

Supplying `-f claim_outref=<tx-hash>#<output-index>` selects explicit
`existing` mode and skips fixture funding, but still requires uniqueness,
ADA-only value, provider visibility, and the full claimant UI journey.

The workflow fails if the event SHA, checkout SHA, GitHub deployment SHA,
Vercel build SHA, or Vercel PR id differ. Configure the aggregate job
`Preprod web-app claim flow (WASM + Lace)` as the required check for `main`;
do not require the resolver or executor job names independently. Protect this
workflow and the runner/environment configuration with repository ownership
and ruleset controls. Do not dispatch against the default branch while
supplying an arbitrary input SHA; the workflow explicitly rejects that shape.

### Current verification evidence

- The focused resolver/provenance/contract/fixture/provider/Lace/app-server and
  local PR-push tests pass: 41 tests across nine files.
- `pnpm typecheck`, the Next production build, Node syntax checks, YAML parsing,
  direct reclaim-manifest verification, and `git diff --check` pass for the
  current working tree.
- A fresh ignored Lace 2.1.1 profile was built with only the repo-backed
  `compromised_user` and `safe_claim_destination` Preprod fixtures, a generated
  test-only password persisted in a mode-0600 ignored `profile.env`, and the
  Testnet network selected. `pnpm e2e:preprod:lace:setup` then passed against
  that profile and reported the two account-center labels and distinct redacted
  addresses. The driver selects each containing wallet card by label instead of
  using an array index; the fixture funder remains outside Lace.
- After applying the lane to an isolated checkout of recorded `origin/main`
  (`214dcbb`), `pnpm typecheck`, the production Next build, and the complete
  web-app suite passed; the suite result was 389 of 389 tests across 45 files.
  The authoritative build and full suite used normal child-process permissions
  because the restricted filesystem sandbox prevents the build worker and
  manifest-verifier child processes from running correctly.
- Applied to exact active PR #13 head
  (`448f3b6ce584af401e3328f9afcc0d913a3dc31d`), focused tests passed 32 of
  32, typecheck passed, the complete web-app suite passed 393 of 393 tests
  across 45 files, and the production build passed with
  `/claim-api/build-provenance` in the route table. This is compatibility
  evidence only; PR #13's deployed Preview predates this lane.
- After adding the local-production PR-push wrapper on PR #14, typecheck passed,
  the complete web-app suite passed 398 of 398 tests across 47 files, and the
  production build passed with the provenance route in the route table.
- The exact deployed Preview merge gate has not completed yet. Therefore there
  is no deployed-Preview nineteen-screenshot acceptance bundle, transaction
  hash, provider confirmation, or branch-protection proof at this status; local
  pre-push evidence cannot fill that gap.

## Verification Matrix

| Level | Required evidence |
| --- | --- |
| Static | Typecheck, lint/style where configured, manifest verification, package script exists. |
| Unit | URL/provenance guards, state-order assertions, screenshot ledger, redaction, role/signing guards, ambiguous-submit handling. |
| Non-spending integration | Real Lace profile launch, both role mappings, connect prompts, browser-WASM capability preflight against the exact preview. |
| Live acceptance | Fresh fixture, all nineteen captures, real browser-WASM proof, safe Lace signature, submitted tx, final receipt, provider-visible confirmation. |
| Merge enforcement | Required aggregate check on the current PR merge candidate, with resolver/checkout/provenance all bound to the current PR head SHA; stale-head results are rejected. |

Mocks may satisfy unit coverage only. A local production build cannot satisfy
Preview provenance. A Lace connect smoke cannot satisfy the claim journey. A
UI receipt without provider confirmation cannot satisfy live acceptance.

## Definition of Done

This plan is complete only when:

- the exact package command exists and fails closed on missing inputs;
- it uses bundled Chromium, the dedicated Lace profile, and the unpacked Lace
  package without Computer Use or an installed Edge session;
- it targets and verifies the exact Preprod Vercel Preview for the expected PR
  head SHA;
- it starts at the landing page and performs every user claim step in order;
- it explicitly uses real browser-WASM proving and generates no proof outside
  the page;
- only the distinct safe Lace wallet signs;
- all mandatory screenshots and redacted run artifacts are present;
- the receipt and provider-visible chain result agree;
- focused tests pass and one live Preprod run produces acceptance evidence;
- the stable GitHub check is required before merge to `main` under the
  documented trusted-runner policy;
- this document's implementation status is reconciled to the checked-in code
  and the retained evidence without overstating partial results.

Until every item is met, report the lane as incomplete and do not use the
existing Lace smoke command as a merge-approval signal.
