# Reclaim Owner Claim Page Plan

## Purpose

Add a retail-facing claim page for original owners whose payment credentials
were compromised. The page lets a user:

1. Connect the impacted CIP-30 wallet.
2. See reclaim-base UTxOs whose inline datum payment credential belongs to that
   impacted wallet.
3. Connect a separate safe CIP-30 wallet.
4. Generate the destination-bound local proof work required to spend those
   UTxOs.
5. Submit claim transactions until every matching reclaim-base UTxO is claimed
   to the safe wallet.

This is the owner claim page. It is distinct from the existing `/reclaim`
funding page, which lets rescuers lock funds at `mkReclaimBase`.

Recommended route:

```text
/claim
```

Keep `/reclaim` as the funding page. Navigation should use user-facing labels
such as "Fund recovery" and "Claim funds", not contract names.

## Current Baseline

- `apps/ownership-proof-web/app/reclaim/page.tsx` renders the funding page.
- `docs/reclaim-funding-page-plan.md` defines the funding flow and explicitly
  excludes owner proof generation and reclaim spending.
- `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs` protects UTxOs
  with an inline datum containing a 28-byte payment key hash.
- `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs` spends base
  inputs with one destination-bound proof per reclaim-base input.
- `cmd/proof-tool` already has `prove-destination`, `verify-destination`, and
  `export-cardano` support for the single destination-bound proof path.
- The local helper currently exposes only the ownership `/prove` endpoint; it
  does not yet expose destination-bound single-proof HTTP APIs.

## Deployment Compatibility

This plan targets the single `ReclaimGlobal` validator only.

`ReclaimBase` is parameterized by the rewarding credential that must appear in
the withdrawal set. The claim page must therefore only operate on a
reclaim-base deployment whose required global credential is the single
`ReclaimGlobal` credential for the pinned verifier key.

The claim page must therefore treat the deployment manifest as the source of
truth for:

- the reclaim-base address;
- the global credential that the base validator requires;
- the single `ReclaimGlobal` script hash/credential;
- the destination-bound single verifier key and circuit/key bundle.

If the manifest points at a base address parameterized by any other global
credential, this page should render an unsupported deployment state rather than
attempting to claim those UTxOs.

## Product Principle

The UI should feel like a guided recovery checklist, not a protocol console.
Use the terms:

- Impacted wallet: the old wallet whose payment credentials may have been
  compromised.
- Safe wallet: the new wallet that will receive reclaimed funds.
- Matching funds: public reclaim-base UTxOs whose datum credential matches the
  impacted wallet.
- Claim batch: the next group of UTxOs to reclaim in one transaction.

Avoid telling retail users to reason about `mkReclaimBase`, `mkReclaimGlobal`,
redeemers, ex-units, datum CBOR, verifier keys, or public inputs in the primary
flow. Keep those details in review expanders and diagnostics.

The impacted wallet connection is for discovery only. The page must not request
`signTx` from the impacted wallet. The safe wallet signs claim transactions.

## Design Source

Use the generated design set as the visual source of truth for the claim page
implementation:

```text
Windows: C:\Users\phili\.codex\generated_images\019f325a-a453-7690-a8f6-03fa112a2ec2
WSL:     /mnt/c/Users/phili/.codex/generated_images/019f325a-a453-7690-a8f6-03fa112a2ec2
```

The user-provided directory id was truncated as
`019f325a-a453-7690-a8f6-03fa112a2`; locally it resolves to the directory with
the `ec2` suffix above.

Canonical design assets:

| Asset | Claim page state |
| --- | --- |
| `DeploymentReview.png` | deployment review before wallet connection |
| `ImpactedWallet.png` | impacted wallet connection |
| `AvailableClaimsPage1.png` | available claims table, page 1 |
| `AvailableClaimsPage2.png` | available claims table, page 2 |
| `AvailableClaimsAssetModal.png` | UTxO asset inspection modal |
| `SafeWallet.png` | safe wallet connection |
| `CreateProofsReady.png` | proof creation ready, phrase entry empty |
| `CreateProofsGenerating.png` | destination-bound proof generation in progress |
| `CreateProofsComplete.png` | all proofs generated and ready to claim |
| `CurrentBatch.png` | next claim batch ready |
| `ClaimFundsInitialOverview.png` | all prerequisites complete, claim overview |
| `ClaimReview.png` | recovery complete with receipt actions |

`AvailableClaimsPage2SupersededRowNumbers.png` is reference-only. Do not add a
new row-number column unless a later design explicitly restores it; the
canonical page-two table is `AvailableClaimsPage2.png`.

## Important Flow Correction

Final reclaim proofs are destination-bound. They require the destination address
bytes for the safe wallet output. Therefore the page cannot safely generate the
final `mkReclaimGlobal` proof before the safe wallet is known.

The retail flow can still feel like "construct proofs, then claim", but the
implementation should split proof work into two phases:

1. Before safe wallet connection: discover matching credentials and optionally
   ask the local helper to find derivation paths for those credentials.
2. After safe wallet connection: generate the final destination-bound proof for
   the selected claim batch using destination bytes computed from the safe
   wallet output.

Do not generate a proof against a placeholder destination or a user-editable
destination byte string.

## End-To-End User Flow

### 1. Load Deployment

The page loads a claim deployment manifest from a web-owned API route such as:

```text
GET /claim-api/deployment
```

The manifest must include the pinned network, reclaim-base address/script hash,
the base validator's required single global credential, parameter NFT/UTxO
identity, destination-bound single verifier key hash, supported single proof
circuit, source commit, and contract version.

If deployment data is missing, the page must render a disabled state and refuse
wallet connections for claim submission.

### 2. Connect Impacted Wallet

The user connects the impacted CIP-30 wallet. The app reads only public wallet
data:

- `getNetworkId()`
- `getUsedAddresses()`
- `getChangeAddress()`

The app extracts payment key credentials locally from Shelley payment addresses
and rejects unsupported address forms for matching purposes. Script payment
credentials, reward-only addresses, malformed addresses, and network-mismatched
addresses are not claim identities for this proof.

The page should not call `signTx` on this wallet.

### 3. Discover Matching Reclaim UTxOs

The page needs an index of public UTxOs at the pinned reclaim-base script
address. Recommended API:

```text
GET /claim-api/reclaim-utxos?cursor=...
```

The response is paginated public chain data:

- tx hash and output index;
- inline datum credential;
- full value, including native assets;
- block/slot confirmation metadata where available;
- datum parse status;
- deployment id.

The browser filters this public list against the impacted wallet's local
credential set. This avoids sending the full impacted-wallet credential cluster
to the backend during discovery.

If mainnet volume makes full public pagination too slow, add an optional
server-side filter endpoint later, but label it as a privacy tradeoff because it
reveals the queried credential set to the service.

### 4. Show Matching Funds

Show a simple recovery summary:

- total ADA;
- native-token count and major assets;
- number of matching UTxOs;
- number of distinct matching payment credentials;
- pending, claimed, and remaining counts.

Group details by asset and by UTxO. Keep the default action as "Claim next
batch"; advanced UTxO selection can be added later, but the default should be
automatic and deterministic.

Before final proof generation, call these "matching funds" or "funds ready to
check". After the local proof succeeds for a batch, call that batch "ready to
claim". The proof establishes derivability of the payment key credential, not
wallet ownership, balance ownership, or stake credential ownership.

### 5. Prepare Proof Helper

CIP-30 does not expose the master XPrv and cannot create this zk proof by
itself. The claim page therefore needs the local Proof Helper.

The canonical UI should not make Proof Helper a separate primary rail step.
Surface helper readiness as:

- a compact status tile in the claim overview;
- the first summary tile on the Create Proofs screen;
- explicit local-only copy beside the recovery-phrase inputs.

The page may check helper availability after matching funds are found, but it
must not ask for the recovery phrase or generate destination-bound proofs until
the safe wallet destination is known.

Required helper additions:

```text
GET  /status
POST /prove-destination
```

or a versioned `/prove` endpoint with explicit proof profile fields.

The helper must support:

- destination-bound single proof requests;
- multiple destination-bound single proof requests in contract input order;
- path search for retail users who do not know account/role/index;
- the signed and pinned destination-bound single key bundle;
- backend artifacts with `path` and `paths` stripped by default.

The seed phrase or master XPrv must stay local to the browser/helper boundary
and must never reach hosted APIs, URLs, logs, analytics, localStorage, or
sessionStorage.

### 6. Connect Safe Wallet

After matching funds are found, prompt the user to connect the safe CIP-30
wallet. The helper can be checked in the background, but the destination-bound
proof flow stays blocked until the safe wallet destination is known.

The safe wallet flow reads:

- `getNetworkId()`;
- `getUsedAddresses()`;
- `getChangeAddress()`;
- UTxOs for fees/collateral through the backend provider.

The page must check that the safe wallet network matches the deployment. It
should also extract safe-wallet payment credentials and block or strongly warn
if any safe-wallet credential overlaps the impacted wallet's credential set.
The app cannot prove a wallet has never been compromised, but it can prevent
obvious reuse of the impacted credential set.

The safe wallet must have enough ADA to pay fees, collateral, and any extra
min-ADA needed by destination outputs. Protected reclaim input value must not be
reduced for fees.

### 7. Draft Claim Batch

The backend selects the next claim batch from still-unclaimed matching UTxOs and
returns a proof request plan:

```text
POST /claim-api/draft
```

Request:

- deployment id;
- selected reclaim-base outrefs, or "next batch";
- safe wallet change address;
- safe wallet address set;
- safe wallet network id.

Response:

- selected reclaim-base outrefs;
- ordered datum credentials exactly as the contract will scan them;
- proof profile: single destination-bound proof per selected input;
- destination output address for each selected input;
- destinationAddressV1 bytes for each corresponding output, computed by the
  backend;
- expected destination output start index;
- required value for each corresponding output;
- estimated safe-wallet fee/collateral requirement;
- reason if the batch had to be reduced.

The draft must be based on chain-queried UTxOs and pinned deployment data, not
client-supplied UTxO contents.

### 8. Generate Batch Proof

The browser sends the draft proof request to the local helper. For each selected
reclaim-base input, the proof request binds that input's datum credential to the
corresponding safe-wallet destination output:

```json
{
  "profile": "single-destination",
  "requests": [
    {
      "out_ref": "txhash#0",
      "target_credential": "...",
      "destination_address_encoding": "destination-address-v1",
      "destination_address": "..."
    }
  ]
}
```

The helper returns one proof artifact per request. If several selected UTxOs use
the same datum credential and the same safe destination address, the helper may
reuse the same proof artifact for those entries. The browser sends only the
proof artifacts and selected outrefs back to the backend. Path metadata must be
omitted unless the user explicitly enters a local debug/support mode.

### 9. Build, Inspect, Sign, Submit

The backend builds the final unsigned transaction:

```text
POST /claim-api/build
```

Builder requirements:

- spend the selected reclaim-base inputs;
- include the parameter reference input;
- include the relevant rewarding withdrawal for global validation;
- ensure the withdrawal credential exactly matches the credential required by
  the selected reclaim-base deployment;
- set the redeemer proof bytes and destination output index;
- pay each selected reclaim input's full value to its corresponding proof-bound
  destination output;
- fund fees and collateral from safe-wallet inputs;
- never reduce protected reclaim input value for fees;
- recompute datum credentials from chain data;
- recompute destinationAddressV1 from each actual destination output;
- reject if proof order, credential order, destination bytes, or value coverage
  do not match the draft.

Before returning unsigned CBOR, the backend must inspect the final transaction
and return a normalized review summary. The browser then asks the safe wallet to
sign. Submission can reuse a route like:

```text
POST /claim-api/submit
```

or share the existing signed/witness-set assembly pattern from
`/reclaim-api/submit`.

### 10. Refresh Progress

After submission:

1. Mark the selected batch as pending.
2. Show the transaction hash.
3. Poll provider status or rescan the reclaim-base address.
4. Remove confirmed spent UTxOs from remaining matching funds.
5. If a transaction is dropped or replaced, move those UTxOs back to remaining.
6. Automatically prepare the next batch until no matching funds remain.

The page should keep the user on the same progress screen for the whole reclaim
process.

## Batching Policy

### Benchmark Evidence

I ran:

```bash
cd contracts/ownership-verifier
cabal v2-bench ownership-verifier-bench
```

Current benchmark settings:

- protocol major version: 11;
- max tx memory: `14,000,000`;
- max tx CPU: `10,000,000,000`;
- single rows use destination-bound proofs and one destination output per
  reclaim-base input.

Relevant rows:

| Case | UTxOs | Total Mem | Mem % | Total CPU | CPU % |
| --- | ---: | ---: | ---: | ---: | ---: |
| single repeated proof | 5 | 3,036,338 | 21.688% | 4,267,518,110 | 42.675% |
| single repeated proof | 10 | 5,958,688 | 42.562% | 4,948,713,210 | 49.487% |
| single repeated proof | 20 | 11,806,538 | 84.332% | 6,311,648,360 | 63.116% |
| single distinct proofs | 1 | 699,214 | 4.994% | 3,722,692,818 | 37.227% |
| single distinct proofs | 5 | 3,183,266 | 22.738% | 8,659,716,750 | 86.597% |
| single distinct proofs | 10 | 6,289,276 | 44.923% | 14,831,126,895 | 148.311% |

The repeated single-proof rows are cheaper because the validator can reuse proof
work for identical proof material. That helps when several reclaim-base UTxOs
have the same datum credential and safe destination. The distinct-proof rows are
the safer default budget model because a retail wallet can have matching UTxOs
under different payment credentials.

### Recommendation

Use the single `mkReclaimGlobal` validator and claim four reclaim-base UTxOs per
transaction by default.

Reasons:

- five distinct proofs fit the benchmark but use 86.597% of tx CPU, leaving
  little room for production evaluator drift, transaction-builder overhead, or
  future script changes;
- ten distinct proofs exceed the tx CPU budget, so the page must not scale by
  simply adding more proofs;
- four UTxOs keeps the retail flow moving while leaving more headroom than the
  measured five-distinct-proof case;
- repeated-proof batches are cheaper, but relying on that optimization would
  make the user's batch size depend on hidden credential grouping.

The backend may try a five-UTxO batch only as an optimization after final
transaction evaluation passes with the configured safety margin. If five fails
or is above margin, shrink to four or fewer and regenerate proofs for the
smaller ordered input set.

Do not batch ten or more UTxOs in the retail v1 page, even when the selected
UTxOs share the same datum credential. Larger repeated-proof batches need
transaction-size benchmarks, wallet-signing compatibility checks, and final
`evaluateTx` gates before becoming product defaults.

Each claim build should still run provider evaluation before wallet signing. If
evaluation exceeds the configured safety margin, reduce the batch and regenerate
the proof for the smaller ordered input set.

Suggested v1 policy:

```text
validator:          single ReclaimGlobal
proofs:             one destination-bound proof per selected UTxO
default batch:      4 UTxOs
optimization batch: 5 UTxOs only if final evaluateTx is within margin
hard max v1:        5 UTxOs
hard rule:          never submit without final tx inspection and evaluateTx
```

## Batch Selection

The automatic selector should be deterministic:

1. Remove UTxOs already pending in submitted transactions.
2. Sort remaining UTxOs by oldest confirmation first, then `txHash#index`.
3. Pick up to four UTxOs for the default batch.
4. Optionally test a five-UTxO draft if the user has many remaining UTxOs and
   the backend can evaluate before signing.
5. If the safe wallet lacks fee/collateral ADA, stop before proof generation.
6. Draft the transaction and return the exact credential order from the draft.

The contract input order is the source of truth for proof credential order. The
builder must preserve or revalidate this order before returning unsigned CBOR.
If final transaction assembly changes the order, the backend must reject and
produce a new draft/proof request.

## Claim API Surface

Use `/claim-api/*` to avoid colliding with the Go verifier rewrite and the
existing funding routes.

Required routes:

- `GET /claim-api/deployment`
  Returns pinned deployment and supported proof profiles.
- `GET /claim-api/reclaim-utxos`
  Returns paginated public reclaim-base UTxOs with parsed datum/value.
- `POST /claim-api/draft`
  Selects or validates the next batch and returns ordered proof material.
- `POST /claim-api/build`
  Builds and inspects the final unsigned claim transaction from proof artifacts.
- `POST /claim-api/submit`
  Assembles wallet witnesses or submits fully signed CBOR.
- `GET /claim-api/progress?outrefs=...`
  Optional helper for pending transaction status and spent-output refresh.

The backend must never trust client-supplied:

- script addresses;
- verifier key hashes;
- parameter UTxO identity;
- claim validator profile;
- base/global credential compatibility;
- reclaim-base UTxO datum/value;
- destinationAddressV1 bytes;
- proof credential order;
- public input digest.

It must recompute these from pinned deployment data, provider chain data, and
the final transaction body.

## UI Design Requirements

The claim page should implement the attached designs as an operational recovery
workspace. It should not look like a landing page or protocol console. The
first screen is the actual claim workflow with the claim-funds tab selected.

### App Shell

Implement a claim-specific shell matching the designs:

- fixed left recovery rail, top product navigation, and one main work surface;
- brand lockup: shield mark, `ReclaimGlobal`, and `Cardano Recovery`;
- top navigation: `Proof`, `Fund recovery`, and active `Claim funds`;
- right-side icon actions for `Help` and `Settings`;
- page background near white with subtle panel borders, pale teal active
  surfaces, dark navy text, and teal primary actions;
- use `lucide-react` icons where possible instead of custom SVGs;
- buttons should be icon-and-text for primary actions and icon-only only for
  compact utilities with accessible labels.

The canonical left rail order is:

1. Deployment
2. Impacted Wallet
3. Available Claims
4. Safe Wallet
5. Create Proofs
6. Current Batch
7. Claim Review

Rail statuses are `Pending`, `In progress`, and `Complete`. Completed steps use
teal check circles connected by the vertical progress line. The current step is
a pale teal highlighted row with a numbered teal circle. Pending steps are
outlined circles. Keep the persistent bottom assurance panel:

```text
Your recovery is secured by ReclaimGlobal.
We never access your funds.
```

Do not implement `Proof Helper` as a separate rail step in the canonical flow.
Helper state belongs inside Create Proofs and overview summary cards.

### Shared Claim Components

Build reusable components for the repeated design language:

- `ClaimShell`: app frame, top nav, left rail, bottom action bar, and responsive
  page gutter.
- `ClaimStepRail`: canonical seven-step progress with icon, label, status, and
  active/completed styling.
- `ClaimSummaryTile`: icon circle, label, primary value, secondary value, and
  status line for wallet, ADA, UTxO, proof, batch, and receipt metrics.
- `ClaimInfoPanel`: explanatory right rail panels such as `What happens next`,
  `Why these match`, `During proof generation`, and `Before you claim`.
- `ClaimDataTable`: stable-width table with copy buttons, row actions,
  pagination, empty/loading/error rows, and no layout shift when badges change.
- `ClaimActionBar`: bottom `Back` or `Go back` secondary action plus one teal
  primary action matching the current step.
- `TechnicalDetailsDisclosure`: collapsed by default and reserved for datum,
  proof, verifier, destination, ex-unit, and transaction details.
- `CopyableValue`: truncated hashes/addresses with accessible copy action and
  no full secret or phrase values copied into hosted logs.

Cards are appropriate here because the designs use cards as concrete status,
review, and table containers. Keep their radius restrained and avoid nested
decorative card stacks.

### Deployment Review Screen

Use `DeploymentReview.png`.

Components:

- header: `Review deployment`;
- top status strip with `Network`, `Deployment`, and `Claim flow`;
- `Smart contracts` panel with `mkReclaimBase` and `mkReclaimGlobal` rows,
  script hashes, and copy buttons;
- `Recovery parameters` panel with params UTxO and parsed datum;
- `Pinned source` panel with git commit and external GitHub link;
- bottom actions: `Back` and `I reviewed deployment`.

If deployment data is unavailable or unsupported, reuse this layout with a
blocking banner and disabled wallet actions. Do not move users into wallet
connection while deployment identity is unknown.

### Impacted Wallet Screen

Use `ImpactedWallet.png`.

Components:

- header: `Connect impacted wallet`;
- prominent notice about SecondFi maintenance and importing the recovery phrase
  into a CIP-30 wallet first;
- informational banner stating this step reads addresses and credentials only
  and will not sign with the impacted wallet;
- wallet chooser list with Lace recommended, Eternl, and Yoroi rows where
  detected providers appear first and unavailable providers are disabled;
- right `What happens next` panel showing matching credential discovery,
  ReclaimBase scanning, and claimable-funds display;
- bottom actions: `Back` and `Connect impacted wallet`.

The impacted wallet connector must call only public CIP-30 reads. The visual
state must never show an impacted-wallet signing prompt.

### Available Claims Screen

Use `AvailableClaimsPage1.png` and `AvailableClaimsPage2.png`.

Components:

- header: `Available claims`;
- summary tiles for impacted wallet, total claimable ADA/tokens, matching
  UTxOs/distinct credentials, and estimated batches;
- `Funds you can reclaim` table with search, `All`/`ADA`/`Tokens` segmented
  filter, refresh action, truncated tx id, output index, credential, ADA,
  assets, and `View` action;
- pagination for page 1 and page 2 using the canonical no-row-number table;
- right `Why these match` panel with three check items: credential in datum,
  credential belongs to impacted wallet, and unclaimed at ReclaimBase;
- bottom actions: `Back` and `Continue to safe wallet`.

No row should imply proof success yet. Before proof generation, rows are
matching public funds, not `ready to claim`.

### UTxO Asset Modal

Use `AvailableClaimsAssetModal.png`.

Components:

- centered modal over a dimmed page;
- title `UTxO assets` and truncated tx reference;
- top metric strip for credential, ADA, unique assets, and claim status;
- reassurance banner that claiming sends all listed value to the safe wallet;
- search by policy id or asset name;
- `All`/`Tokens`/`NFTs` segmented control;
- `Copy tx reference` action;
- scrollable asset table with policy id, asset name, and quantity;
- footer showing visible asset range and `Close` / `Done reviewing` actions.

The modal must be keyboard accessible, close on Escape, trap focus while open,
and restore focus to the triggering row action.

### Safe Wallet Screen

Use `SafeWallet.png`.

Components:

- header: `Connect safe wallet`;
- `Use a clean destination` panel warning not to connect the impacted wallet;
- `Why this comes before proofs` panel explaining destination-bound proofs;
- compact CIP-30 wallet tile grid;
- right `Funds will arrive here` panel showing safe wallet connection status,
  receive address preview, fees paid by safe wallet, and impacted wallet
  signature not required;
- bottom actions: `Back` and `Connect safe wallet`.

If a safe-wallet credential overlaps the impacted credential set, block the
primary action and render a clear red warning in the right panel. The user must
choose a different safe wallet.

### Create Proofs Screen

Use `CreateProofsReady.png`, `CreateProofsGenerating.png`, and
`CreateProofsComplete.png`.

Ready state components:

- header: `Create proofs`;
- summary tiles for local helper, safe wallet, proofs needed, and generated;
- local-only banner stating the recovery phrase goes only to the Proof Helper
  running locally and never to ReclaimGlobal servers;
- 24-word recovery phrase grid with `Show words` toggle and `Paste phrase`
  action;
- `Proof plan` side panel showing available claims, destination bound to the
  safe wallet, default batch size, and estimated claim transactions;
- bottom actions: `Back` and `Generate proofs`.

Generating state components:

- summary tiles for local helper status, safe wallet, proofs generated, and
  remaining proofs;
- large circular progress indicator with percentage, completed/total proofs,
  current claim reference, and estimated time remaining;
- proof queue table with ready/generating/waiting states;
- right guidance panel: keep helper running, do not refresh, seed phrase stays
  local, pause if needed, and proofs are destination-bound;
- `Pause` secondary action and disabled/loading primary action.

Complete state components:

- header: `Proofs ready`;
- summary tiles for local helper complete, safe wallet, proofs generated, and
  next step;
- `Ready to claim` success banner;
- claim plan summary with total claims, batch size, transactions needed, and
  first batch;
- generated proof summary table grouped by batch;
- `Before you claim` checklist;
- bottom actions: `Back` and `Continue to current batch`.

Recovery phrases, entropy, master XPrv, helper request bodies, and derivation
paths must never be written to URL params, localStorage, sessionStorage,
analytics, hosted API payloads, or browser console logs.

### Current Batch And Claim Overview Screens

Use `CurrentBatch.png` and `ClaimFundsInitialOverview.png`.

Components:

- prerequisite summary tiles for impacted wallet, available claims, create
  proofs, safe wallet, and next batch;
- recovery summary strip with total ADA, token count, matching UTxOs, pending
  not claimed, and ready to claim;
- next-batch table with tx reference, ADA, token count, asset summary, status,
  and total row;
- review strip confirming funds go to the safe wallet, fees are paid by the
  safe wallet, and no impacted-wallet signature is needed;
- collapsed technical details disclosure with safe wallet destination and fee;
- refresh funds action;
- bottom action `Claim next batch`.

`ClaimFundsInitialOverview.png` contains a non-canonical rail variant with
`Proof Helper` and `Submitted claims`. Implement its main content as the
overview state, but keep the canonical seven-step rail above.

### Claim Review And Receipt Screen

Use `ClaimReview.png`.

Components:

- header: `Claim review`;
- success banner `Recovery complete`;
- summary tiles for recovered value, claimed UTxOs, claim transactions,
  remaining claims, and safe-wallet destination verified;
- claim transaction ledger with batch number, tx hash, explorer link,
  recovered value, confirmed status, and total recovered row;
- receipt panel with `Download CSV`, `Copy summary`, and `Open safe wallet`;
- bottom actions: `Start another recovery` and `Done`.

For the pending-submission and refreshing states that happen before final
completion, reuse this ledger layout with pending badges and a status banner
instead of introducing a separate design language.

### Error, Empty, And Loading States

The provided design set does not include every negative state. Implement these
as layout-preserving variants of the nearest canonical screen and include them
in screenshot verification:

- deployment unavailable or unsupported;
- impacted wallet wrong network;
- scanning available claims;
- no matching funds found;
- helper unavailable;
- safe wallet overlaps impacted credentials;
- insufficient safe-wallet ADA for fees/collateral;
- proof generation failed with retry;
- wallet signature rejected;
- submitted transaction pending, dropped, or replaced.

Retail copy should focus on action and outcome. Technical details belong in
expanders:

- matching datum credential;
- tx out ref;
- proof circuit id;
- verifier hash;
- destination address bytes;
- ex-unit evaluation result.

## Security Requirements

- The impacted wallet must never sign.
- The safe wallet must never provide seed phrase or master key material.
- The proof helper must not send seed phrase, entropy, master XPrv, or path
  metadata to hosted APIs.
- The final proof must bind to the safe-wallet destination output.
- The backend must build against pinned deployment data only.
- The backend must query selected reclaim-base UTxOs from the provider and parse
  their inline datums itself.
- The backend must verify that every selected input value is paid to its
  corresponding proof-bound safe destination output.
- Fees must come from safe-wallet inputs, not from reducing reclaimed value.
- The page must block obvious safe/impacted wallet credential overlap.
- The page must clear pending proof inputs from memory where practical and avoid
  logging wallet addresses, UTxO inventories, CBOR, proof requests, and helper
  request bodies outside explicit local debug mode.
- Shared/backend proof artifacts should omit derivation path metadata by
  default.

## Testing Plan

### Playwright Visual Verification

The UI implementation must include deterministic visual fixtures for the claim
flow and a Playwright screenshot comparison pass against the design source.
This is required before calling the UI complete.

Use a test-only fixture mode, for example:

```text
/claim?fixtureState=<state>
```

Fixture mode must be gated so it cannot be enabled accidentally in production,
for example by requiring `NEXT_PUBLIC_CLAIM_UI_FIXTURE=1` and refusing fixture
states in production builds. The fixture data should use the same visible values
as the design assets: `15.87 ADA`, `23` tokens, `18` matching UTxOs, `4` UTxOs
per batch, five estimated transactions, and the same truncated addresses and
hashes where shown. Avoid masking dynamic text unless the value is truly
non-deterministic; the better default is deterministic fixture data.

Capture at the design viewport:

```text
viewport: 1536x1024
deviceScaleFactor: 1
fullPage: false
theme: light
reducedMotion: reduce
```

Save generated screenshots under:

```text
output/playwright/reclaim-owner-claim/actual/
output/playwright/reclaim-owner-claim/diff/
```

Do not store screenshots, traces, or design copies under app source
directories.

Required visual fixture matrix:

| Fixture state | Reference design |
| --- | --- |
| `deployment-review` | `DeploymentReview.png` |
| `impacted-wallet` | `ImpactedWallet.png` |
| `available-claims-page-1` | `AvailableClaimsPage1.png` |
| `available-claims-page-2` | `AvailableClaimsPage2.png` |
| `available-claims-asset-modal` | `AvailableClaimsAssetModal.png` |
| `safe-wallet` | `SafeWallet.png` |
| `create-proofs-ready` | `CreateProofsReady.png` |
| `create-proofs-generating` | `CreateProofsGenerating.png` |
| `create-proofs-complete` | `CreateProofsComplete.png` |
| `current-batch` | `CurrentBatch.png` |
| `claim-funds-overview` | `ClaimFundsInitialOverview.png` |
| `claim-review-complete` | `ClaimReview.png` |

Reference-only asset:

| Asset | Verification treatment |
| --- | --- |
| `AvailableClaimsPage2SupersededRowNumbers.png` | Do not compare as a canonical screenshot. Use it only as review context for the rejected row-number-table variant. |

Implementation requirements for the visual checker:

- start the Next.js app in fixture mode on an isolated local port;
- open each fixture state with Playwright Chromium;
- set viewport and device scale exactly to the design dimensions above;
- wait for fonts, mock data, and animations to settle before capture;
- screenshot every canonical state in the matrix;
- compare each screenshot with the matching PNG from the design directory;
- write actual and diff images to `output/playwright/reclaim-owner-claim/`;
- fail if a canonical state cannot be reached, a screenshot is missing, the
  design reference is missing, or the visual diff exceeds the agreed threshold;
- print a summary table with state name, reference image, actual image, diff
  image, mismatched pixel count, and pass/fail result.

Use a strict enough threshold to catch layout drift while tolerating font
anti-aliasing. Start with:

```text
pixelmatch threshold: 0.10
max differing pixels: 0.75% of viewport pixels
```

If the design images cannot be compared pixel-perfectly because the generated
mockup uses unavailable fonts or image-rendering differences, keep the
Playwright capture requirement and add a manual side-by-side review checklist
for the failed states. Do not waive screenshots entirely.

Suggested local commands:

```bash
DESIGN_DIR=/mnt/c/Users/phili/.codex/generated_images/019f325a-a453-7690-a8f6-03fa112a2ec2
OUT_DIR=output/playwright/reclaim-owner-claim
NEXT_PUBLIC_CLAIM_UI_FIXTURE=1 pnpm --dir apps/ownership-proof-web dev --hostname 127.0.0.1 --port 3026
```

In another terminal:

```bash
DESIGN_DIR=/mnt/c/Users/phili/.codex/generated_images/019f325a-a453-7690-a8f6-03fa112a2ec2 \
BASE_URL=http://127.0.0.1:3026 \
OUT_DIR=output/playwright/reclaim-owner-claim \
pnpm --dir apps/ownership-proof-web exec node scripts/claim-ui-visual-check.mjs
```

The checker should use the local `playwright` dependency already declared by
`apps/ownership-proof-web`. Add lightweight image diff dependencies such as
`pixelmatch` and `pngjs` only if the repo does not already provide an
equivalent image comparison helper.

Additional screenshots without direct design references must also be captured
for negative and loading states, but they are compared against the nearest
canonical layout by manual review:

- deployment unavailable or unsupported;
- scanning available claims;
- no matching funds found;
- wrong network;
- safe wallet overlaps impacted credentials;
- helper unavailable;
- insufficient safe-wallet ADA;
- proof generation failed;
- signature rejected;
- transaction submitted and refreshing.

Unit tests:

- payment credential extraction from CIP-30 addresses;
- local filtering of public reclaim-base UTxOs by impacted credentials;
- datum parser rejects malformed inline datums and non-28-byte credentials;
- batch selector picks four UTxOs by default and only keeps five when final
  evaluation is within margin;
- overlap detection between impacted and safe wallet credentials;
- destinationAddressV1 encoding matches Haskell golden vectors;
- proof request order matches draft input order;
- transaction inspector rejects wrong destination, wrong value, wrong datum,
  missing selected input, and reordered credentials.

Component tests:

- impacted wallet connection never calls `signTx`;
- wrong network blocks scanning and claiming;
- no matching funds state is clear and non-technical;
- matching funds summary updates after a submitted claim;
- safe wallet overlap blocks the claim path;
- helper unavailable blocks proof generation but not matching-funds viewing;
- failed submission restores pending UTxOs for retry.

Integration tests:

- mocked reclaim-base index returns mixed datum credentials and only impacted
  matches appear;
- mocked helper returns a set of destination-bound single proofs and build
  receives stripped artifacts;
- safe wallet signs the returned unsigned transaction;
- submit route assembles witness sets and returns a tx hash;
- progress refresh removes spent UTxOs and continues to the next batch.

Contract/transaction tests:

- claim builder produces valid single `ReclaimGlobal` transactions for one
  through four inputs;
- optional five-input claim transaction is accepted only when final evaluation
  is within margin;
- ten distinct input claims are rejected or split before proof generation;
- final transaction evaluation stays under configured ex-unit margins;
- native assets are preserved in full, not only lovelace.

Manual preprod acceptance:

1. Fund at least six reclaim-base UTxOs for credentials in the impacted wallet.
2. Connect impacted wallet and verify the page finds all matching UTxOs.
3. Connect a different safe wallet with fee ADA.
4. Claim the first four UTxOs in one single-validator transaction.
5. Refresh and claim the remaining tail.
6. Confirm no matching UTxOs remain at the reclaim-base address.
7. Confirm all reclaimed values arrived at the safe wallet address.

## Implementation Phases

### Phase 1: Claim Shell, Static Screens, And Visual Fixtures

- Add `/claim`.
- Add shared navigation among proof, funding, and claim flows with `Claim funds`
  active.
- Build `ClaimShell`, `ClaimStepRail`, summary tiles, info panels, data table,
  modal, action bar, and technical-details disclosure.
- Add deterministic fixture states for every canonical design asset.
- Add the Playwright visual checker and capture every design-backed state at
  `1536x1024`.
- Add deployment loading, unavailable, and unsupported states.

### Phase 2: Impacted Wallet Discovery

- Add CIP-30 discovery for the impacted wallet.
- Extract local payment credentials from used/change addresses.
- Add public reclaim-base UTxO index route.
- Filter matching UTxOs locally.
- Render the impacted wallet, available claims, available-claims pagination,
  no-matches, scanning, and asset-modal states.

### Phase 3: Claim Manifest And Batch Planner

- Extend deployment manifest with the single global script identity, parameter
  UTxO metadata, destination-bound verifier hash, and batch caps.
- Add deterministic batch selection.
- Add `/claim-api/draft`.
- Add benchmark-informed caps and evaluateTx safety policy.

### Phase 4: Safe Wallet And Draft Preconditions

- Add safe wallet CIP-30 connection.
- Add overlap detection.
- Add fee/collateral/min-ADA prechecks.
- Render the safe-wallet screen and blocking negative states.
- Compute the safe wallet destination before any destination-bound proof request.

### Phase 5: Helper Proof Profiles And Create Proofs

- Add destination-bound single-proof helper endpoint.
- Add key status for the destination-bound single key bundle.
- Add path search for multiple credentials.
- Strip path metadata from artifacts sent to the backend.
- Render proof-ready, proof-generating, paused, failed, and proof-complete
  states.
- Verify the proof screens never send secrets to hosted APIs, URLs, storage, or
  logs.

### Phase 6: Claim Builder And Batch Submission

- Add backend transaction builder for single `ReclaimGlobal`.
- Add signed transaction inspection and submit flow.
- Render the current-batch, claim overview, wallet-signing, submitted, and retry
  states.

### Phase 7: Progressive Claim Loop And Receipt

- Add pending transaction state.
- Add progress polling/rescan.
- Remove claimed UTxOs from the displayed total.
- Automatically prepare the next batch until complete.
- Render the final claim review and receipt actions.
- Export CSV and copy-summary receipt data from confirmed claim transactions.

### Phase 8: Visual Acceptance And Preprod Round Trip

- Rerun the Playwright screenshot comparison against every canonical design
  asset.
- Save actual and diff screenshots under `output/playwright/reclaim-owner-claim/`.
- Run the full funding-to-claim flow on preprod.
- Save tx hashes, proof profile, batch sizes, and ex-unit evaluations in the
  runbook.
- Only then enable mainnet deployment values.

## Open Decisions

- Which provider/indexer should back the public reclaim-base UTxO pagination.
- Whether the production page should support only client-side filtering or also
  an optional server-side credential filter for large mainnet datasets.
- Whether the optional five-UTxO optimization should be exposed in the first
  release or kept behind a dev/operator flag.
- Whether helper path search should scan only account 0 by default or expose a
  guided "search more wallet history" mode.
- Whether the first release supports advanced manual UTxO selection or only the
  automatic next-batch flow.
- Confirmation depth for marking a submitted claim as final on mainnet.

## Readiness Verdict

This is implementation-ready as a product and architecture plan for the single
validator path. The main remaining dependency is helper/API support for
destination-bound single proof sets plus backend claim-transaction construction
and final `evaluateTx` gating. The retail default should be four UTxOs per
transaction until preprod round trips show the optional five-UTxO path is
consistently inside the configured margin.
