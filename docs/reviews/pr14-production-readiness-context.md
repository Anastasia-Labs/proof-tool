# PR 14 production-readiness context

## Review boundary

- Pull request: `#14`, `colll78/preprod-web-app-claim-flow-wasm-lace`
- Review baseline: `7eaf071e5fb43b943a6d7dc47cd89dca094c9aff` (`main` after PR 16)
- Integrated review head: `f9029428e5a52ddf05e1e604640cada266df73a9`
- Scope: 25 files changed relative to the baseline, covering the web claim UI, a
  Vercel build-provenance endpoint, a real Lace/Playwright acceptance runner,
  local pre-push orchestration, CI orchestration, tests, and operator docs.
- Production code outside this diff is treated as a dependency, not as authored
  by PR 14. Its behavior is followed where the new lane relies on it.

This document records control flow and trust boundaries only. Review findings,
risk ratings, and remediation decisions belong in the separate differential
review report.

## Intended value

PR 14 adds an acceptance lane whose success means that a user-visible claim was
performed from the landing page through a real Lace approval and was then
observed on Cardano Preprod. It also adds a local push wrapper that runs the same
journey against a production build served on localhost while retaining the
canonical remote proof assets and Preprod dependencies.

## Actors and trust boundaries

| Actor or boundary | Capability and data |
| --- | --- |
| Pull-request author | Supplies the candidate source tree, tests, workflow, and Preview deployment. |
| Maintainer/reviewer | Reviews the diff and, where configured, authorizes protected acceptance execution. |
| GitHub-hosted resolver job | Reads deployment metadata and binds a successful Vercel Preview URL to the exact PR head SHA. |
| Vercel Preview | Serves the candidate web application and reports build provenance. A protection-bypass value may be required to reach it. |
| Lace acceptance host | Holds the dedicated Chromium profile, Lace extension, two wallet accounts, wallet password, and browser runtime. |
| `compromised_user` | Read-only Lace role used to discover the affected payment credential. Its recovery phrase is supplied only to the browser proof UI. |
| `safe_claim_destination` | Distinct Lace role whose address is the reviewed destination and whose key authorizes the claim transaction. |
| `reclaim_funder` | Local fixture role permitted to create one ADA-only Preprod claim for the compromised credential. |
| Hosted claim services | Return deployment metadata, indexed claim UTxOs, unsigned claim transaction data, submission receipts, and progress state. |
| Independent provider client | Queries the safe address directly and confirms the submitted transaction's exact output index and value. |
| Evidence directory | Receives the run ledger, 20 ordered screenshots, sanitized console/network observations, fixture artifacts, and provider confirmation. |

The most sensitive transition is from candidate code to the Lace acceptance
host. The host can expose persistent browser state and can authorize Preprod
transactions. The most important correctness transition is from the reviewed
build response to the transaction Lace signs and the provider later observes.

## Required invariants

1. The deployed target is an immutable non-production Vercel Preview for the
   exact PR head SHA and PR number, or an explicitly marked local production
   emulation for that exact SHA and PR.
2. Draft and fork pull requests cannot reach wallet-bearing execution.
3. The `compromised_user` and `safe_claim_destination` roles derive distinct
   payment credentials, and only the safe role may sign.
4. The compromised recovery phrase and all private wallet material remain
   local to the acceptance host and never enter URLs, logs, screenshots,
   uploaded artifacts, hosted payloads other than the browser's local proving
   computation, or repository state.
5. Fixture preparation yields exactly one unspent, valid, ADA-only claim for
   the compromised credential and binds it to one exact outref.
6. The UI journey begins on `/`, navigates through `/claim`, uses the normal
   browser UI for every state transition, and captures each of the 20 declared
   screens exactly once and in order.
7. The reviewed transaction selects exactly the prepared outref and has exactly
   one claim destination output matching the active safe Lace address.
8. Lace authorizes the transaction from the safe role; the submit receipt binds
   the same transaction hash and prepared outref.
9. Completion requires the prepared input to become spent and a provider query
   to observe the exact safe-destination output index and value under the
   submitted transaction hash.
10. A successful evidence bundle is emitted only after the complete screenshot
    ledger and artifact secret scan pass.
11. The local push wrapper pushes only the exact branch and SHA that completed
    the acceptance journey; a dirty or moved head fails closed.

## End-to-end state and data flow

1. The resolver receives repository, PR number, and exact PR head SHA. It lists
   GitHub deployments for that SHA, filters to Preview deployments, resolves
   their latest successful statuses, and emits a single immutable Vercel origin
   (`resolve-github-vercel-preview.mjs:18-159`).
2. The runner validates its environment, target origin, PR/SHA identity,
   fixture mode, explicit live-transaction gate, profile paths, and wallet
   password (`web-app-claim-flow-contract.mjs:55-144`).
3. Before browser launch, the runner fetches build provenance and claim
   deployment metadata and validates Preview identity, Preprod network, browser
   proving availability, and verifier-key shape
   (`web-app-claim-flow-wasm-lace.mjs:80-112`).
4. The real Lace driver derives public role identities from the local wallet
   fixture, loads the unpacked extension and persistent Chromium profile, and
   exposes role-specific connect, disconnect, switch, and approve operations
   (`real-lace-driver.mjs:43-347`).
5. Fixture preparation first searches for an existing unique claim. If absent,
   it uses the fixture wallet harness and normal `/reclaim` funding UI to create
   one, then polls until that transaction produces the unique indexed claim
   (`web-app-claim-fixture.mjs:16-97`).
6. The runner rechecks that the exact outref is unspent, unique for the
   compromised credential, and ADA-only
   (`web-app-claim-flow-wasm-lace.mjs:369-420`).
7. The persistent Chromium context starts with the compromised role selected.
   The app loads at `/`; browser storage is cleared; the runner follows normal
   UI controls through service review, impacted wallet authorization, claim
   discovery, wallet disconnection, safe wallet authorization, browser-WASM
   proof generation, transaction review, safe-wallet signing, submission, and
   recovery completion (`web-app-claim-flow-wasm-lace.mjs:142-257`).
8. Response observers record the successful `/claim-api/build` and
   `/claim-api/submit` JSON. Contract checks bind the build to the selected
   outref and safe address, and bind the submit receipt to the build hash and
   outref (`web-app-claim-flow-contract.mjs:333-353`).
9. After the UI reports completion, the runner polls claim progress for spent
   state and separately queries the provider for an output under the submitted
   transaction hash whose index, address, and complete asset map equal the
   reviewed destination (`web-app-claim-provider.mjs:7-66`).
10. The runner writes final evidence, closes the browser context, scans every
    supported artifact for known secret values, and returns success only when
    the scan passes (`web-app-claim-flow-wasm-lace.mjs:267-321`).

## High-risk entry-point microstructure

### Workflow: `.github/workflows/preprod-web-app-claim-flow-wasm-lace.yml`

- Inputs: pull-request event or manual dispatch, PR identity, GitHub token,
  environment secrets/variables, repository checkout, persistent profile.
- Blocks: resolve exact Preview; execute wallet flow; aggregate required result.
- Effects: checks out candidate code, installs dependencies/browser, may submit
  two Preprod transactions (fixture funding and claim), uploads evidence.
- Dependencies: GitHub deployments API, Vercel, pnpm registry/cache, Playwright,
  Lace profile, remote proof assets, Preprod provider.

### `GET` build provenance (`route.ts:6-25`)

- Inputs: Vercel build environment variables embedded into the server runtime.
- Checks: none; nullable fields are represented explicitly.
- Effects: returns no-store JSON identifying environment, deployment/branch/
  production hosts, commit SHA/ref, PR id, and local-emulation marker.
- Downstream consumers: acceptance contract provenance validation.

### `ClaimFlow` wallet discovery change (`ClaimFlow.tsx:599-2197`)

- Inputs: injected `window.cardano` wallet providers and browser lifecycle
  events.
- New block: refresh providers immediately, every 250 ms for ten seconds, on
  `cardano#initialized`, focus, and visibility changes.
- State effects: updates provider list and preserves valid impacted/safe
  selections; otherwise chooses available defaults.
- Dependencies: CIP-30 injection timing and component cleanup.

### `runLocalPrClaimFlow` (`local-web-app-claim-flow-wasm-lace.mjs:28-115`)

- Inputs: local git state, PR metadata, manifest/env configuration, port.
- Checks: PR context, clean tree, proof-asset hosts, local provenance identity.
- Blocks: build production web app; start production server; wait for health;
  invoke the full Lace runner; stop child process.
- Effects: creates build/output artifacts and performs live Preprod fixture and
  claim transactions.

### `runPrPushWithLocalClaimFlow` (`push-pr-with-local-claim-flow.mjs:8-48`)

- Inputs: push arguments and repository state.
- Blocks: capture branch/SHA/status; run local claim flow; recapture state;
  require stability; invoke `git push` for the tested branch.
- Effects: live Preprod transactions, evidence creation, and remote git update.

### `createRealLaceProfileDriverFromEnv` and `RealLaceProfileDriver`
(`real-lace-driver.mjs:43-347`)

- Inputs: wallet fixture file, unpacked Lace extension, persistent user-data
  directory, role labels, password.
- Checks: required files/dirs, Lace manifest/route, distinct role identities,
  expected labels, role signing policy at the calling layer.
- Blocks: launch persistent bundled Chromium with extension; discover extension
  id; switch accounts; authorize/revoke DApp; unlock; approve signing.
- Effects: reads local mnemonic data, mutates persistent Lace/DApp state, and
  can authorize a Preprod transaction.

### `resolveGitHubVercelPreview` (`resolve-github-vercel-preview.mjs:18-69`)

- Inputs: repository, SHA, optional supplied URL, GitHub token, host prefix.
- Checks: exact identifier forms, HTTPS Vercel origin, project hostname prefix,
  non-production host, one successful Preview candidate.
- Effects: GitHub API reads and newline-safe GitHub output writes.
- Dependencies: deployment/status timestamps and immutable `environment_url`.

### `assertNoPreprodArtifactSecretLeakage` (`run.mjs:561-621`)

- Inputs: artifact paths, current environment, wallet fixture/config files.
- Checks: builds a deduplicated set of known sensitive strings and searches
  eligible artifacts byte-for-byte.
- Effects: throws on leakage; otherwise permits successful completion/upload.
- Assumption: secret material that must be detected is present in the collected
  environment or referenced local configuration.

### `prepareOrResumeAdaOnlyClaimFixture` (`web-app-claim-fixture.mjs:16-97`)

- Inputs: compromised payment credential, target origin, fetch/provider access,
  fixture wallet file, funding runner.
- Checks: zero-or-one initial matches, wallet identity and signing policy,
  submitted transaction hash shape, unique indexed result, ADA-only value.
- Effects: may submit a funding transaction and writes fixture-stage evidence.

### `runWebAppClaimFlowWasmLace` (`web-app-claim-flow-wasm-lace.mjs:34-321`)

- Inputs: complete acceptance environment plus injected browser/provider/wallet
  dependencies for tests.
- Blocks: validate target/deployment; validate roles; prepare fixture; run 20
  ordered UI/Lace states; validate build/submit; wait for provider confirmation;
  scan artifacts.
- Effects: browser/profile mutation, local secret use, Preprod transactions,
  evidence writes.
- Failure behavior: records sanitized failure, closes browser context, rethrows;
  artifact upload is controlled by the calling workflow.

### `waitForSafeDestinationOutput` (`web-app-claim-provider.mjs:7-66`)

- Inputs: reviewed build, safe address, submitted hash, read-only provider.
- Checks: exactly one destination output/index; address match; provider result
  under exact hash/index; exact normalized asset-map equality.
- Effects: provider reads only; returns a redacted confirmation object.

## Changed-file coverage map

| Surface | Files |
| --- | --- |
| CI orchestration | `.github/workflows/preprod-web-app-claim-flow-wasm-lace.yml` |
| Provenance | `app/claim-api/build-provenance/route.ts`, `route.test.ts` |
| UI compatibility | `components/ClaimFlow.tsx`, `ClaimFlow.test.tsx` |
| Hosted/local orchestration | `local-web-app-claim-flow-wasm-lace.mjs` and test; `push-pr-with-local-claim-flow.mjs` and test; root push wrapper |
| Preview resolution | `resolve-github-vercel-preview.mjs` and test |
| Lace automation | `real-lace-driver.mjs` and test |
| Journey contracts | `web-app-claim-flow-contract.mjs` and test |
| Fixture and provider | `web-app-claim-fixture.mjs` and test; `web-app-claim-provider.mjs` and test |
| Full journey | `web-app-claim-flow-wasm-lace.mjs` |
| Secret scanning/base runner | `run.mjs` |
| Commands and operator contract | `package.json`, `docs/manual-lace-claim-flow-qa-plan.md`, `docs/preprod-e2e.md` |

## External dependencies and operational assumptions

- The Lace extension is unpacked and compatible with Playwright's bundled
  Chromium persistent-context mode.
- The dedicated Lace profile contains exactly the configured compromised and
  safe accounts and is not used for production funds.
- The fixture wallet file derives the same compromised identity as Lace and
  contains a funded `reclaim_funder` role.
- Vercel exposes immutable deployment URLs and build provenance environment
  variables for Preview builds.
- The claim manifest pins coherent Preprod proof assets and verifier data.
- Provider/indexer lag fits within the configured polling windows.
- A branch protection/ruleset can require the aggregate acceptance job before
  merge.
