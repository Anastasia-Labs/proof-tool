# PR 14 production-readiness differential review

## Executive summary

PR 14 provides meaningful regression protection that did not previously exist:
it drives the public claim journey from the landing page through twenty ordered
web/Lace states, performs real browser-WASM proving, signs with a distinct safe
Lace role, submits on Preprod, and requires provider-visible postconditions. It
also makes the same production build/R2-backed journey available as an explicit
local PR-push gate.

The initial review found five merge-blocking trust-boundary defects. The branch
now contains code fixes for all five:

1. the wallet host no longer checks out or executes PR-controlled code;
2. the exact CBOR passed to Lace is observed and independently inspected;
3. the persistent Lace template is copied into an isolated one-run profile;
4. every third-party GitHub Action is pinned by full commit SHA; and
5. the branch-controlled manual workflow dispatch path is removed.

Static, focused, full-suite, typecheck, and production-build verification pass
for the hardened working tree. Final merge approval remains conditional on a
fresh exact-SHA live local Lace journey, review of its twenty screenshots and
provider evidence, publication of the hardened commit, and the separately
approved repository/runner/Vercel configuration described below.

## Review scope and baseline

- Pull request: `#14`, `colll78/preprod-web-app-claim-flow-wasm-lace`
- Original reviewed PR head: `247062622675e33a257039d015a44e95406c5a1e`
- Current-main baseline integrated into the branch:
  `7eaf071e5fb43b943a6d7dc47cd89dca094c9aff`
- First integrated review head:
  `f9029428e5a52ddf05e1e604640cada266df73a9`
- Original differential size: 25 files, 4,649 additions, 245 deletions
- Commit series reviewed: 13 PR commits from `5d9d37d` through `2470626`, plus
  the current-main merge and production-readiness changes.

The companion context artifact is
`docs/reviews/pr14-production-readiness-context.md`. It records actors,
invariants, data flow, and high-risk entry-point microstructure without mixing
in findings.

## Method

The review used a security-focused differential pass rather than treating test
code as harmless. It included:

- full changed-file inventory and per-file diff review;
- call-path tracing from GitHub event to resolver, browser, Lace approval,
  claim submit, provider confirmation, evidence, and push;
- history review of all 13 feature commits;
- blame/history review of the replaced wallet-discovery behavior and Lace 2.1.1
  signing changes;
- adversarial modeling of a fork author, same-repository PR author, stale or
  ambiguous deployment, malicious/incorrect build response, wrong Lace account,
  persistent runner compromise, secret leakage, fixture drift, and provider lag;
- official GitHub, Vercel, and Playwright documentation review; and
- focused tests, the complete Preprod harness suite, complete web-app suite,
  typecheck, syntax/YAML checks, production build, and diff hygiene.

## Threat model

The lane crosses three unusually sensitive boundaries:

1. candidate web code receives a disposable compromised Preprod recovery phrase
   so browser-WASM proving can be tested;
2. Lace exposes a real CIP-30 signing prompt for a funded, test-only safe wallet;
3. the runner holds a browser profile, password, provider credentials, and a
   fixture funder capable of submitting Preprod transactions.

The design must therefore assume the candidate Preview is untrusted until a
maintainer approves the protected environment. No candidate shell code may run
on the wallet host. All wallets must remain disposable, Preprod-only, minimally
funded, and isolated from unrelated secrets or accounts.

## Findings and resolutions

### F-01 — Critical — PR code executed on a persistent wallet-bearing runner

**Initial condition.** The original workflow used `pull_request`, checked out
the PR head in both jobs, ran `pnpm install`, installed Chromium, and executed
the PR's runner on a persistent self-hosted machine holding the Lace profile and
secrets. Candidate code could persist on the host before the secret-bearing step
or alter the harness that decided what to sign and upload.

**Impact.** A same-repository PR could compromise the runner, profile, wallet
password, provider token, future runs, or evidence. This contradicted GitHub's
public-repository self-hosted-runner guidance.

**Resolution.** The workflow now uses `pull_request_target` and derives a
`harness_sha` from `github.event.pull_request.base.sha`. Both checkouts use that
trusted SHA; the PR head is used only to resolve and verify its remote Vercel
Preview (`.github/workflows/preprod-web-app-claim-flow-wasm-lace.yml:7-118`).
Fork and draft gates execute before the wallet job. The required runner label is
`proof-tool-preprod-lace-ephemeral`, and the operating contract requires a
GitHub `--ephemeral` one-job registration after independent environment
approval.

**Status:** code-resolved; external environment and runner configuration remain
required before activation.

### F-02 — High — Lace approval was not bound to the reviewed CBOR

**Initial condition.** The runner validated `/claim-api/build` review JSON, then
approved the first visible Lace signing prompt. It did not inspect the unsigned
transaction body or observe the actual argument supplied to CIP-30 `signTx`.
Post-submit checks proved that one expected output existed, but did not rule out
foreign inputs, additional destinations, or unrelated wallet actions.

**Impact.** A transaction-building regression or candidate app mismatch could
cause the safe wallet to sign more than the evidence claimed.

**Resolution.** `validateClaimTransactionSafety` parses the actual CML
transaction, recomputes its hash, requires the prepared input, restricts every
other spending/collateral input to a provider snapshot of the safe wallet,
requires plain outputs to the safe address, checks the exact destination index
and value, validates collateral return, and rejects mint/certificate/governance
actions (`web-app-claim-flow-contract.mjs:350-452`). Lace 2.1.1 exposes its
immutable CIP-30 provider through a `window.postMessage` request transport, so
the driver installs a passive listener before navigation and records every
serialized `signTx` request without replacing the provider. The runner refuses
approval unless exactly one partial-sign request contains the reviewed CBOR
and `partialSign=true` (`real-lace-driver.mjs:145-188,395-437` and
`web-app-claim-flow-wasm-lace.mjs:253-278`).

**Residual trust boundary.** Candidate page code shares Lace's window-message
channel and could deliberately spoof an observed request. This check is strong
regression protection, not a substitute for protected-environment approval of
the candidate Preview. Exact body validation, the Lace review UI, provider
confirmation, and same-repository human approval remain independent layers.

**Status:** resolved to the intended regression-detection threat model and
covered by positive/negative tests.

### F-03 — High — Mutable action tags in a secret-bearing workflow

**Initial condition.** `actions/checkout`, `pnpm/action-setup`,
`actions/setup-node`, and `actions/upload-artifact` used floating `@v4` tags.

**Impact.** Tag movement or upstream compromise could change code executed on
the wallet host without a repository diff.

**Resolution.** Every action reference is pinned to the full SHA returned by
the corresponding official GitHub repository. A workflow-contract test rejects
any non-SHA action reference.

**Status:** resolved.

### F-04 — High — Persistent profile state crossed runs

**Initial condition.** The workflow launched the configured Lace profile path
directly. Candidate-origin authorization and extension state could survive into
later jobs, and a failed run could leave the template mutated.

**Impact.** State from one PR could influence another PR, invalidate account
handoff assertions, or become a persistence channel.

**Resolution.** The configured profile is now a stopped, protected template.
The trusted workflow copies it to a unique guarded `$RUNNER_TEMP` path, tightens
permissions, launches only the copy, and removes only a prefix-validated run
path in an `always()` cleanup step (`workflow:126-174`). The agent itself must
be registered as a one-job ephemeral runner.

**Status:** code-resolved; host template permissions and runner lifecycle must
be verified operationally.

### F-05 — Medium — Branch-controlled manual dispatch could reach the runner

**Initial condition.** `workflow_dispatch` instructed maintainers to select a PR
branch as the workflow ref. GitHub loads the workflow definition from the
selected ref, so branch-controlled YAML could modify the wallet job.

**Impact.** Manual operation bypassed the trusted-workflow premise even though
input SHA checks appeared strict.

**Resolution.** `workflow_dispatch` and operator-supplied Preview URL handling
were removed. The only hosted entry point is the protected-base
`pull_request_target` workflow. Direct package execution remains diagnostic and
cannot publish the required PR check.

**Status:** resolved.

### F-06 — Medium — No pre-request recovery-phrase egress guard

**Initial condition.** Input clearing, screenshot masking, log sanitization, and
post-run artifact scanning were present, but the browser did not stop the phrase
from appearing in an outgoing URL or request body.

**Impact.** An accidental frontend regression could transmit the disposable
test phrase before artifact scanning noticed anything.

**Resolution.** The context installs an HTTP(S) route before navigation. It
aborts a request containing the normalized phrase or at least three phrase
words in its URL/body and makes that typed failure override downstream browser
errors (`web-app-claim-flow-wasm-lace.mjs:368-400`; contract helper at
`web-app-claim-flow-contract.mjs:455-480`).

**Residual risk.** This guard catches accidental plain/structured leakage, not a
deliberately encoded covert channel. Independent environment approval,
same-repository-only execution, human review, and disposable test-only wallets
remain mandatory.

**Status:** resolved to the intended accidental-regression threat model.

## File-by-file coverage

| File or group | Review result |
| --- | --- |
| Workflow | Exact deployment binding is sound; trust boundary, action pins, profile isolation, runner lifecycle, and dispatch path were hardened. |
| Build-provenance route/tests | No secret fields; no-store response; Preview/SHA/PR validation is fail closed. |
| `ClaimFlow.tsx` and tests | Bounded delayed-wallet discovery fixes real extension injection timing without changing claim semantics; listener/interval cleanup and provider-identity preservation are tested. |
| Local production runner/tests | Clean non-main PR context, exact commit provenance, production Next build/server, remote R2 proof assets, and shutdown behavior are fail closed. |
| Local push wrapper/tests | Rechecks branch/SHA/status after the live journey and performs a non-force exact-head push only on success. |
| Real Lace driver/tests | Role labels, active addresses, DApp disconnect/reconnect, Lace 2.1.1 auth, compromised-role signing ban, and exact `signTx` observation are covered. |
| Preview resolver/tests | Exact full SHA, successful Preview deployment, immutable project host, ambiguity rejection, and safe GitHub outputs are covered; manual URL mode was removed. |
| Base runner secret scan | Export-only change reuses the established known-secret artifact scan; no weakening of matching or file eligibility. |
| Fixture/tests | One valid unspent ADA-only claim, exact compromised credential, only funder signing, and exact submitted funding hash are enforced. |
| Journey contract/tests | Target/provenance/deployment/screenshot/build/submit contracts plus independent body and phrase-egress checks are covered. |
| Full journey | All twenty states use UI/Lace actions; no prove/build/submit shortcut; response barriers exist only to make transient states observable. |
| Provider/tests | Exact submitted hash, destination index/address, and normalized full asset-map equality are required. |
| Package/docs/root wrapper | Commands match implementation; docs now distinguish trusted hosted acceptance from local confidence and prohibit branch dispatch. |

No changed file was excluded from the review. Test files were assessed both for
positive coverage and for missing negative assertions.

## Verification evidence

Evidence for the current hardened working tree:

- `pnpm exec vitest run e2e/preprod`: **180/180 passed** across 27 files.
- `pnpm test`: **416/416 passed** across 48 files, including all four
  workflow-security assertions.
- `pnpm typecheck`: passed.
- `pnpm build`: passed; `/claim-api/build-provenance` is present in the
  production route table.
- Node syntax checks for the changed runners: passed.
- YAML parse and `git diff --check`: passed.
- Workflow-security contract: trusted event, trusted checkout refs, full action
  SHA pins, protected environment, ephemeral label, guarded profile copy and
  cleanup: **4/4 passed**.

Earlier exact-head operational evidence exists for `2470626`: 403 tests, a
production build, twenty screenshots, and provider-confirmed Preprod claim
transaction
`8899aa3ddcc595c87d49a069c80216356e14f18fe6a3d9d89363c53784707325`.
It is useful compatibility evidence but is not final acceptance evidence for
the hardened SHA.

The first hardened live attempt against `193c29f` failed closed before the
landing screenshot because Lace 2.1.1 does not permit replacing its injected
provider's `enable` function. No Lace approval or claim submission occurred.
The observer was subsequently changed to the passive transport-compatible
implementation above; its focused compatibility test passes. A fresh live run
against the final commit remains the acceptance condition.

The next attempt against `884fc75` confirmed that compatibility fix by reaching
the exact Lace transaction-review screen and recording 18 of 20 checkpoints.
It then failed closed before signing because the driver force-clicked Lace's
password confirmation instead of waiting for the control to become enabled.
The dedicated profile and both configured roles still validate. The driver now
uses Playwright's normal actionable click for authentication, and its focused
test rejects a regression back to a forced click. No claim submission occurred
in either failed attempt.

## Blast radius

- Product runtime change is limited to bounded CIP-30 wallet rediscovery in
  `ClaimFlow`; existing claim build/prove/submit server logic is unchanged.
- The new provenance route exposes only deployment identifiers already used by
  Vercel/GitHub and is explicitly no-store.
- Live-test code can fund and spend disposable Preprod fixtures and mutate only
  a run-local Lace profile copy.
- The local push wrapper can update an existing PR branch, never `main`, and
  refuses force push or a moved/dirty head.
- Hosted activation changes repository governance: environment reviewers,
  ephemeral runner registration, Vercel bypass, secrets/variables, and a
  required check. Those changes require explicit operational approval and
  validation.

## Residual operational requirements

Before the check can protect `main`:

1. create/protect `preprod-lace-e2e` with an independent required reviewer and
   no self-review;
2. provision only disposable/minimally funded Preprod wallet inputs and a
   stopped read-only Lace profile template;
3. register a dedicated `proof-tool-preprod-lace-ephemeral` runner with
   GitHub's `--ephemeral` mode only for an approved job;
4. add the documented environment variables/secrets and Vercel automation
   bypass without printing them;
5. require the stable aggregate check for `main` and protect the workflow via
   CODEOWNERS/ruleset;
6. after PR 14 is on `main`, exercise the trusted-base workflow on a follow-up
   same-repository PR, because a new `pull_request_target` workflow cannot run
   from PR 14 until the workflow itself exists on the base branch.

## Recommendation

**Provisional: do not merge yet.** The implementation now has a defensible
production design and passes non-spending verification, but final approval
requires the hardened exact-SHA live local journey, screenshot/provider review,
committed and pushed evidence, and explicit authorization/verification of the
external protected environment, Vercel bypass, secrets, and ephemeral runner.
The final recommendation should change to **merge** only if those checks pass
without material exceptions.
