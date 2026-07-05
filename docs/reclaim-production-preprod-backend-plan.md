# Reclaim Production Preprod Backend Plan

## Purpose

This plan turns the current reclaim funding page and claim-page UI into a
production-suitable Cardano recovery webapp, with preprod as the mandatory
evidence gate before any mainnet values are enabled.

The plan covers:

- live preprod deployment of the reclaim contracts and deployment manifest;
- production hardening for the existing `/reclaim` funding page backend;
- implementation of the missing `/claim-api/*` backend for the owner claim page;
- destination-bound Proof Helper support for claim proofs;
- end-to-end preprod funding-to-claim acceptance;
- operational, observability, rollback, and mainnet-readiness gates.

This document intentionally does not replace the narrower UI/design plans:

- `docs/reclaim-funding-page-plan.md`
- `docs/reclaim-funding-page.md`
- `docs/reclaim-owner-claim-page-plan.md`
- `docs/reclaim-contracts-spec.md`
- `docs/reclaim-destination-binding-plan.md`
- `docs/proof-helper-desktop-tauri-plan.md`

Those documents remain the source of truth for their local surfaces. This plan
is the cross-surface implementation sequence.

## Implementation Readiness

This plan is ready to drive implementation, but the product is not ready to
deploy to mainnet until the explicit live preprod gates pass.

The highest-risk missing implementation work is not UI. It is:

- typed deployment manifest and on-chain coherence checks;
- `/reclaim-api` transaction inspection and submit hardening;
- `/claim-api` indexing, draft, build, submit, and progress routes;
- destination-bound helper/key-bundle support;
- automated end-to-end preprod tests that drive the application from funding a
  reclaim through proof creation and successful claim submission.

Implementation should proceed in the phase order below. Do not skip directly
from a visually complete claim page to a live mainnet deployment.

## Production Goal

Ship a mainnet-safe recovery webapp where:

1. Rescuers can lock swept ADA/native assets at the pinned `ReclaimBase`
   deployment with an inline datum for a 28-byte compromised payment key hash.
2. Original owners can discover matching public `ReclaimBase` UTxOs through
   `/claim`.
3. The impacted wallet is used only for local public credential discovery and
   never signs.
4. A separate safe wallet signs claim transactions and pays fees/collateral.
5. The local Proof Helper generates destination-bound proofs using signed,
   pinned key bundles.
6. Hosted backends never receive seed phrases, entropy, master XPrvs, or path
   metadata.
7. Claim transaction builders recompute chain data, proof order, destination
   bytes, value coverage, and verifier/deployment identity from pinned sources.
8. Preprod evidence proves funding, discovery, proof generation, claiming,
   progress refresh, and receipt behavior before mainnet.

## Non-Goals

- Do not implement mainnet deployment values until preprod acceptance is
  complete.
- Do not treat fixture UI, fixture helper success, or compile-only tests as
  production readiness.
- Do not add a server-side impacted credential filter for v1 unless explicitly
  accepted as a privacy tradeoff.
- Do not support ten-input retail batches in v1. Four UTxOs per claim
  transaction is the default until preprod evaluation and benchmark evidence
  justify anything larger.
- Do not broaden product copy beyond the actual proof claim: derivability of a
  28-byte Cardano payment key credential from a master XPrv at a CIP-1852 path.

## Current Baseline

Implemented:

- `/reclaim` funding page and `/reclaim-api/deployment`,
  `/reclaim-api/wallet-assets`, `/reclaim-api/build`, and
  `/reclaim-api/submit`.
- Next.js web service routing that keeps `/api/*` for the Go verifier service
  and web-owned reclaim routes under `/reclaim-api/*`.
- Funding backend environment manifest fields under `RECLAIM_*`.
- Koios or Blockfrost provider configuration.
- Funding transaction builder that pays selected wallet assets to the pinned
  `ReclaimBase` address with inline `ReclaimBaseDatum`.
- `/claim` route and claim UI visual fixture states.
- CLI destination-bound commands: `prove-destination`, `verify-destination`,
  and `export-cardano`.
- Destination-bound `ReclaimGlobal` contract path that recomputes
  `destinationAddressV1` from actual destination outputs and checks full
  multi-asset value coverage.

Missing or incomplete:

- No `/claim-api/*` route implementation.
- No reclaim UTxO index route with datum parsing and pagination.
- No live claim builder that spends `ReclaimBase` inputs through
  `ReclaimGlobal`.
- No claim draft endpoint that fixes ordered credentials, destination outputs,
  destination bytes, and batch caps before proof generation.
- No signed-transaction inspect gate for funding or claiming.
- No `/prove-destination` helper endpoint or destination proof profile exposed
  through the local helper.
- No destination-key bundle activation path in the desktop helper.
- No concrete preprod deployment manifest proving script hash, parameter NFT,
  verifier key hash, source commit, and contract-version coherence.

## Trust Boundaries

### Hosted Webapp

- May receive public wallet addresses, requested token bundles, selected
  outrefs, proof artifacts, unsigned/signed transaction CBOR, and transaction
  hashes.
- Must not receive seed phrases, entropy, master XPrvs, private keys, wallet
  passwords, derivation paths, helper request bodies, or proof witness material.
- Must not trust client-supplied script addresses, verifier hashes,
  destination bytes, datum contents, UTxO values, proof order, public input
  digest, or deployment identity.

### Local Helper

- May receive master XPrv and target credentials over loopback after exact-origin
  and token checks.
- Must bind destination-bound proofs to backend-provided draft material.
- Must strip `path` and `paths` from backend-bound artifacts by default.
- Must fail closed if the signed destination proving-key bundle is missing,
  malformed, wrong-profile, wrong-hash, or unsigned.

### Wallets

- Impacted wallet: public reads only. Allowed calls are `getNetworkId`,
  `getUsedAddresses`, and `getChangeAddress`. Do not call `signTx`.
- Safe wallet: signs only final claim transactions and pays fees/collateral.
  It must not provide seed phrase or master key material.

### Contracts

- `ReclaimBase` enforces that the matching `ReclaimGlobal` rewarding script is
  invoked.
- `ReclaimGlobal` enforces proof coverage, proof order, destination binding,
  parameter reference input, and full value coverage.
- Contract parameters and the immutable parameter UTxO are part of the
  deployment coherence set, not user input.

## Canonical Deployment Coherence Set

Treat these as one signed/published set. If any field changes, refresh and
verify the whole set:

- source commit and release tag;
- contract version;
- network: `Preprod` first, then `Mainnet`;
- `ReclaimBase` script bytes/hash/address;
- `ReclaimGlobal` script bytes/hash/rewarding credential;
- `ReclaimBase` required global credential;
- one-shot parameter NFT policy id and token name;
- parameter UTxO tx hash/index;
- parameter holder script/address and inline datum;
- destination-bound verifier key bytes and `vk_hash`;
- proving-key bundle manifest/signature/checksums;
- `export-cardano` outputs: `proof.hex`, `vk.hex`, `pub.hex`, `format.txt`
  for golden fixtures;
- batch caps and ex-unit safety margins;
- provider/indexer identity and network.

The deployment manifest should be stored as a versioned JSON artifact under
`deployments/reclaim/preprod/<deployment-id>.json` and optionally mirrored into
server environment variables for Vercel.

## Local Preprod Test Configuration

Local-only preprod secrets and reusable test wallets are stored outside tracked
source files:

- `.env.local`
  - `RECLAIM_NETWORK=Preprod`
  - `RECLAIM_PROVIDER=blockfrost`
  - `RECLAIM_BLOCKFROST_URL=https://cardano-preprod.blockfrost.io/api/v0`
  - `RECLAIM_BLOCKFROST_PROJECT_ID`
  - `BLOCKFROST_PROJECT_ID`
- `deployments/reclaim/preprod/test-wallets.local.json`
  - `deployer`: deploy contracts and reference scripts to preprod;
  - `reclaim_funder`: fund `ReclaimBase` test UTxOs through `/reclaim`;
  - `compromised_user`: impacted test wallet whose payment credential is
    recorded in reclaim datums;
  - `safe_claim_destination`: safe wallet that receives claimed funds.

Both files are ignored by Git and Vercel. They are for preprod testing only and
must never be reused for mainnet.

The E2E harness must load these files explicitly through environment variables,
for example:

```bash
PREPROD_TEST_WALLETS_FILE=deployments/reclaim/preprod/test-wallets.local.json
RECLAIM_E2E_LIVE_PREPROD=1
```

The harness must fail before submitting any transaction if:

- the configured network is not `Preprod`;
- the Blockfrost/Koios provider does not report preprod;
- the wallet file is missing or malformed;
- any test wallet is underfunded for its role;
- the manifest source commit does not match the current clean test target.

## Manifest Schema

Add a typed manifest layer instead of relying only on loose environment
variables.

Required fields:

```json
{
  "schema": "proof-tool-reclaim-deployment-v1",
  "deployment_id": "preprod:<base-script-hash>:<source-commit>",
  "network": "Preprod",
  "network_id": 0,
  "source_commit": "...",
  "contract_version": "...",
  "reclaim_base": {
    "address": "...",
    "script_hash": "...",
    "required_global_credential": "..."
  },
  "reclaim_global": {
    "script_hash": "...",
    "rewarding_credential": "...",
    "params_currency_symbol": "...",
    "verifier_vk_hash": "...",
    "proof_profile": "single-destination"
  },
  "params_utxo": {
    "tx_hash": "...",
    "output_index": 0,
    "policy_id": "...",
    "token_name": "...",
    "holder_address": "...",
    "datum_reclaim_base_script_hash": "..."
  },
  "proof": {
    "circuit_id": "root-ownership-destination-v1/bls12-381/groth16",
    "key_version": "ownership-destination-v1",
    "destination_address_encoding": "destination-address-v1",
    "vk_hash": "...",
    "cardano_vk_blake2b256": "..."
  },
  "batching": {
    "default_utxo_count": 4,
    "optimization_utxo_count": 5,
    "hard_max_utxo_count": 5,
    "max_tx_cpu_percent": 80,
    "max_tx_mem_percent": 80
  },
  "provider": {
    "primary": "blockfrost",
    "fallback": "koios"
  }
}
```

Validation rules:

- `deployment_id` must be stable and returned by every funding and claim
  endpoint.
- `source_commit` must be a clean tag or commit used by the deployed webapp and
  verifier; never a dirty working tree snapshot.
- `reclaim_base.required_global_credential` must equal the single
  `ReclaimGlobal` rewarding credential for this deployment.
- `params_utxo.datum_reclaim_base_script_hash` must equal
  `reclaim_base.script_hash`.
- `proof.vk_hash` must equal the destination-bound key bundle manifest and the
  verifier key committed in `ReclaimGlobal`.
- Missing, malformed, unsupported, or mismatched fields must disable funding
  and claiming.

## API Surface

### Funding APIs

Existing routes remain under `/reclaim-api/*`.

Required hardening:

- `GET /reclaim-api/deployment`
  - Return the validated manifest, not just raw env field availability.
  - Include deployment id, network, contract version, base/global hashes,
    verifier hash, params NFT identity, and provider readiness.
  - Return disabled state when coherence checks fail.

- `POST /reclaim-api/wallet-assets`
  - Continue querying UTxOs from CIP-30-provided change/used addresses.
  - Add provider health metadata and pagination/failure behavior.
  - Sanitize errors so raw provider payloads do not leak into user-visible
    responses or logs.

- `POST /reclaim-api/build`
  - Build one `ReclaimBase` output from pinned manifest data only.
  - Return fee, min-ADA, actual protected output value, selected inputs, change
    summary, datum CBOR, and normalized review hash.
  - Persist or return a signed review token that binds the unsigned tx to the
    expected protected output for `/submit`.

- `POST /reclaim-api/inspect`
  - Decode unsigned or signed CBOR.
  - Confirm exactly the reviewed protected output, inline datum, and selected
    multi-asset bundle.
  - Confirm network, base address, base script hash, deployment id, and datum
    credential.
  - Reject tampered address, missing datum, wrong datum, missing asset, changed
    value, or unexpected deployment.

- `POST /reclaim-api/submit`
  - Stop acting as a generic relay.
  - Require either a build-session token or an explicit inspection request.
  - Assemble witness sets only for a reviewed unsigned tx.
  - Inspect the final signed tx before provider submission.
  - Return tx hash plus review summary and provider submission metadata.

### Claim APIs

Add routes under `/claim-api/*`.

- `GET /claim-api/deployment`
  - Return the same manifest plus claim-specific capability flags:
    proof profile, batch caps, helper key version, destination encoding,
    indexer status, and whether the deployment is single-global-compatible.
  - Refuse deployments whose `ReclaimBase` is parameterized by a different
    global credential.

- `GET /claim-api/reclaim-utxos?cursor=...`
  - Return paginated public UTxOs at the pinned `ReclaimBase` address.
  - Include tx hash, output index, parsed inline datum credential, value, datum
    parse status, slot/block metadata, deployment id, and pagination cursor.
  - Do not require impacted wallet credentials in the request for v1.
  - Mark spent/pending states when known.

- `POST /claim-api/draft`
  - Input: deployment id, selected outrefs or `next batch`, safe wallet network
    id, safe wallet change address, safe wallet address set, optional client
    pending outrefs.
  - Query chain data for selected outrefs. Do not trust client UTxO contents.
  - Select up to four UTxOs by default: oldest confirmation, then
    `txHash#index`.
  - Precheck safe-wallet fee/collateral/min-ADA capacity from provider-queried
    safe-wallet UTxOs.
  - Return ordered reclaim inputs, ordered datum credentials, proof profile,
    destination outputs, backend-computed `destinationAddressV1` bytes,
    expected destination output start index, full value for each destination
    output, and batch-size reduction reasons.

- `POST /claim-api/build`
  - Input: deployment id, draft id, selected outrefs, backend-bound proof
    artifacts, safe wallet addresses/change address, network id.
  - Requery selected reclaim-base UTxOs and safe-wallet UTxOs.
  - Recompute datum credentials from inline datums.
  - Verify proof artifact shape, circuit id, `vk_hash`, destination field,
    public input digest, and Cardano proof bytes.
  - Build a transaction that:
    - spends selected `ReclaimBase` inputs;
    - includes the parameter reference input;
    - invokes the configured `ReclaimGlobal` rewarding withdrawal;
    - sets `reclaimParamsIdx`, `reclaimDestinationOutStartIdx`, and ordered
      proof bytes;
    - pays each protected input value in full to its corresponding safe-wallet
      destination output;
    - pays fees and collateral from safe-wallet inputs;
    - does not reduce protected reclaim value for fees.
  - Inspect final transaction body before returning unsigned CBOR.
  - Run provider evaluation before wallet signing and reduce/redraft if over
    margin.

- `POST /claim-api/submit`
  - Assemble safe-wallet witness sets or accept fully signed CBOR only after
    inspection.
  - Reinspect signed tx against the reviewed claim build.
  - Submit through provider.
  - Return tx hash, selected outrefs, destination summary, deployment id, and
    status poll hints.

- `GET /claim-api/progress?outrefs=...`
  - Return whether selected outrefs are unspent, pending, confirmed spent,
    dropped, or replaced.
  - Rescan remaining matching UTxOs and return next-batch availability.

## Claim Indexer Strategy

Preprod acceptance may start with provider-backed address UTxO queries if the
provider returns inline datums reliably for the `ReclaimBase` address.

Mainnet readiness should use an owned indexer path:

- preferred: Kupo plus Ogmios for address UTxO pagination and transaction
  submission/evaluation;
- acceptable alternative: db-sync-backed service;
- fallback only: Blockfrost/Koios provider endpoints with explicit rate-limit,
  pagination, datum-availability, and outage handling.

Indexer requirements:

- paginate all UTxOs at the pinned `ReclaimBase` address;
- expose inline datum bytes and parsed credential status;
- expose value including native assets;
- expose confirmation slot/block and spent status;
- support outref lookup for draft/build revalidation;
- avoid logging queried impacted credential sets.

## Proof Helper Destination Profile

Add a destination-bound helper API without weakening the existing ownership
proof path.

Preferred route:

```text
POST /prove-destination
```

Request shape:

```json
{
  "master_xprv_base64": "...",
  "profile": "single-destination",
  "requests": [
    {
      "out_ref": "txhash#0",
      "target_credential": "...56 hex...",
      "destination_address_encoding": "destination-address-v1",
      "destination_address": "...58-byte hex..."
    }
  ],
  "search": {
    "max_account": 9,
    "max_index": 999
  },
  "include_debug_path": false
}
```

Response shape:

```json
{
  "profile": "single-destination",
  "artifacts": [
    {
      "out_ref": "txhash#0",
      "artifact": {
        "schema": "root-ownership-proof-artifact-v1",
        "circuit_id": "root-ownership-destination-v1/bls12-381/groth16",
        "vk_hash": "...",
        "target_credential": "...",
        "destination_address_encoding": "destination-address-v1",
        "destination_address": "...",
        "public_input": "...",
        "proof": "...",
        "cardano": {
          "format": "...",
          "proof_hex": "...",
          "public_input_digest_hex": "..."
        }
      }
    }
  ]
}
```

Rules:

- Reuse current loopback binding, exact-origin allowlist, per-session token,
  constant-time token check, and Private Network Access preflight behavior.
- `/status` must report destination profile readiness, key version, key hash,
  and compatibility.
- Production mode must use `LoadOwnershipDestinationProver`; it must not create
  local keys silently.
- Artifacts sent to hosted backends must omit `path` and `paths`.
- Optional local debug artifacts may include path metadata only when explicitly
  requested.
- Batch responses must preserve request order and include outrefs so the browser
  and backend can detect mismatches.

## Key Bundle And Ceremony Work

Extend current key-bundle tooling beyond ownership-only keys.

Required work:

- support `ownership-destination-v1` in ceremony, manifest verification,
  helper status, desktop key activation, and release packaging;
- include circuit id, key version, VK hash, proving-key SHA-256/BLAKE2b-256,
  verifying-key SHA-256/BLAKE2b-256, file sizes, source commit, gnark version,
  setup transcript hash, signature key id, and artifact URLs;
- verify Ed25519 manifest signatures before trusting checksums;
- verify file sizes and hashes before activation;
- keep active and temporary cache directories profile-specific;
- document that a single-actor ceremony is not MPC or trustless production
  provenance unless replaced by a real ceremony.

## Implementation Phases

### Phase 0: Freeze And Audit The Starting Point

- Commit or otherwise preserve the current dirty/untracked reclaim work before
  deploying anything.
- Create a clean tag or commit for the first preprod candidate.
- Confirm `RECLAIM_SOURCE_COMMIT` will equal that tag/commit.
- Record current known gaps in the release notes so fixture UI is not confused
  with live claim readiness.

Exit criteria:

- Reproducible source id exists.
- No preprod deployment points at an uncommitted working tree.

### Phase 1: Deployment Manifest And Coherence Verifier

- Add `deployments/reclaim/preprod/<deployment-id>.json`.
- Add TypeScript manifest schema validation under
  `apps/ownership-proof-web/lib/reclaim-server/`.
- Add a CLI or script that verifies manifest fields against local contract
  exports and, where possible, provider chain data.
- Update `/reclaim-api/deployment` to return the typed manifest.
- Add `/claim-api/deployment` using the same manifest validator.
- Keep existing `RECLAIM_*` env support as Vercel injection, but validate it
  against the JSON manifest or generate envs from the manifest.

Exit criteria:

- Missing or mismatched manifest disables funding and claiming.
- Manifest validation tests cover wrong network, wrong global credential, wrong
  verifier hash, wrong params datum, missing params UTxO, and malformed script
  hashes.

### Phase 2: Funding Backend Hardening

- Add transaction inspection utilities for unsigned and signed CBOR.
- Add `POST /reclaim-api/inspect`.
- Add build-session binding between `/build`, user review, and `/submit`.
- Add fee/min-ADA/protected-output value to review responses.
- Require final signed transaction inspection before provider submission.
- Sanitize provider and Lucid errors.
- Add finality/polling status after funding submission.

Exit criteria:

- Tampered signed txs are rejected before submit.
- `/reclaim-api/submit` cannot be used as a generic public relay.
- Tests cover wrong address, wrong datum, missing datum, missing asset, reduced
  protected value, wrong deployment, and changed unsigned tx.

### Phase 3: Preprod Funding Beta

- Configure preprod provider credentials, preferably Blockfrost for acceptance
  with Koios as fallback.
- Deploy web/verifier from the clean preprod tag.
- Run one ADA-only and one ADA-plus-native-token `/reclaim` deposit.
- Confirm on-chain outputs at the preprod `ReclaimBase` address with inline
  `ReclaimBaseDatum` and exact value.
- Save tx hashes, datum credential, selected value, deployment id, provider,
  source commit, and screenshots/log snippets in a runbook.

Exit criteria:

- Funding path produces auditable preprod `ReclaimBase` UTxOs.
- Funding receipts contain enough data for later claim discovery.

### Phase 4: Claim UTxO Index And Local Impacted-Wallet Filtering

- Add claim types under `apps/ownership-proof-web/lib/claim/`.
- Add claim server modules under
  `apps/ownership-proof-web/lib/claim-server/`.
- Add `GET /claim-api/reclaim-utxos`.
- Add strict datum parser for `ReclaimBaseDatum`.
- Add browser-local Shelley payment credential extraction.
- Wire impacted wallet public reads into `/claim`.
- Filter public reclaim-base UTxOs against locally extracted impacted-wallet
  payment credentials.
- Keep server-side credential filtering disabled in v1.

Exit criteria:

- Impacted wallet never calls `signTx`.
- No impacted credential list is sent to hosted APIs during discovery.
- Tests cover malformed datums, non-28-byte credentials, script credentials,
  reward-only addresses, wrong network, and no matching funds.

### Phase 5: Safe Wallet, Draft, And Destination Bytes

- Wire safe wallet CIP-30 connection.
- Detect overlap between safe-wallet and impacted-wallet payment credentials.
- Add fee/collateral/min-ADA prechecks from provider-queried safe-wallet UTxOs.
- Add `POST /claim-api/draft`.
- Implement deterministic batch selection: oldest confirmation, then
  `txHash#index`, four UTxOs by default.
- Compute destination outputs and `destinationAddressV1` bytes server-side from
  safe-wallet output addresses.
- Return proof request plan and draft id.

Exit criteria:

- Proof generation remains blocked until safe wallet destination is known.
- Safe/impacted credential overlap blocks the claim path.
- Draft tests cover order, pending exclusion, batch cap, reduced batch, and
  destination byte golden vectors.

### Phase 6: Destination-Bound Helper And Key Bundle

- Add Go helper request/response types for destination proof sets.
- Add `/prove-destination`.
- Add destination generator using `LoadOwnershipDestinationProver`.
- Update `/status` to report destination profile compatibility.
- Generalize desktop key activation to `ownership-destination-v1`.
- Add signed destination key bundle verification.
- Add web helper client support for destination profile requests.

Exit criteria:

- `POST /prove-destination` returns backend-bound artifacts without path
  metadata.
- Full destination proof round trip passes:
  `prove-destination -> verify-destination -> export-cardano`.
- Production helper fails closed without the signed destination key bundle.

### Phase 7: Claim Transaction Builder, Inspector, And Evaluator

- Add `POST /claim-api/build`.
- Requery all selected reclaim-base UTxOs and safe-wallet UTxOs.
- Verify proof artifacts against pinned manifest and draft material.
- Build `ReclaimGlobal` transactions for one through four inputs.
- Include parameter reference input and rewarding withdrawal.
- Set redeemer fields in contract input order.
- Pay each protected input value in full to corresponding safe destination
  outputs.
- Inspect unsigned tx before returning CBOR.
- Evaluate tx before wallet signing and redraft if over margin.

Exit criteria:

- Tests cover one to four inputs, wrong proof order, wrong destination, wrong
  value, missing input, stale spent input, malformed proof, wrong vk hash, and
  native assets.
- Ten-input claim attempts are split or rejected before proof generation.
- Optional five-input path remains disabled unless final evaluation is inside
  configured margin.

### Phase 8: Claim Submit, Progress, And Receipt

- Add `POST /claim-api/submit`.
- Add `GET /claim-api/progress`.
- Reinspect signed claim tx before submit.
- Mark submitted outrefs as pending.
- Poll provider/indexer until spent or dropped.
- Return dropped/replaced states and restore UTxOs for retry.
- Refresh remaining matching funds and prepare the next batch.
- Wire final claim review receipt actions.

Exit criteria:

- UI can claim a first batch, refresh, and continue to the tail.
- Receipts include tx hashes, recovered value, destination, deployment id, and
  remaining claims.

### Phase 9: End-To-End Preprod Round Trip

Run the actual product flow on preprod:

1. Deploy manifest and confirm API deployment state.
2. Fund at least six `ReclaimBase` UTxOs through `/reclaim`.
3. Include ADA and at least one native asset in the test set.
4. Connect impacted wallet on `/claim` and discover all matching UTxOs.
5. Connect a different safe wallet with fee/collateral ADA.
6. Generate destination-bound proofs locally through Proof Helper.
7. Claim the first four UTxOs in one `ReclaimGlobal` transaction.
8. Refresh progress and claim the remaining tail.
9. Confirm no matching UTxOs remain at `ReclaimBase`.
10. Confirm all reclaimed values arrived at the safe wallet.

Record:

- deployment id and source commit;
- helper app/sidecar version and destination key hash;
- funding tx hashes;
- claim tx hashes;
- proof profile and batch sizes;
- final evaluation/ex-unit results;
- provider/indexer used;
- screenshots for all live UI states;
- redacted server logs proving no secret fields were logged.

Exit criteria:

- Full preprod funding-to-claim flow succeeds twice: once ADA-only and once
  with native assets.
- Any provider/indexer or wallet-specific issue has a documented retry or
  product response.

### Phase 9A: Automated Application E2E Tests

Add a live preprod E2E suite that drives the application, not only isolated
builders or fixture components.

Suggested command:

```bash
RECLAIM_E2E_LIVE_PREPROD=1 \
PREPROD_TEST_WALLETS_FILE=deployments/reclaim/preprod/test-wallets.local.json \
pnpm --dir apps/ownership-proof-web test:e2e:preprod
```

Required implementation:

- Add a Playwright preprod suite under `apps/ownership-proof-web/e2e/`.
- Add a test-only CIP-30 wallet harness that derives payment keys from the
  four local preprod mnemonics and exposes deterministic providers for:
  `deployer`, `reclaim_funder`, `compromised_user`, and
  `safe_claim_destination`.
- The harness must be enabled only when `RECLAIM_E2E_LIVE_PREPROD=1` and
  `NODE_ENV !== "production"`.
- The harness must sign real preprod transactions using the local test wallet
  keys; it must not mock `/reclaim-api`, `/claim-api`, provider calls, helper
  proof generation, transaction evaluation, or submission.
- Start the Next.js app with `.env.local` and the preprod manifest.
- Start the local Proof Helper with the destination-bound key profile.
- Deploy or verify the preprod `ReclaimBase`, `ReclaimGlobal`, parameter NFT,
  reference scripts, and manifest using the `deployer` wallet.
- Fund the `reclaim_funder`, `compromised_user`, and `safe_claim_destination`
  wallets as a setup precondition, or fail fast with faucet/funding
  instructions if balances are too low.

Required E2E test cases:

1. `deploy-or-verify-preprod-manifest`
   - uses the `deployer` wallet;
   - deploys missing contracts/reference scripts or verifies the existing
     manifest against chain state;
   - confirms `/reclaim-api/deployment` and `/claim-api/deployment` return the
     same deployment id and verifier hash.
2. `fund-ada-only-reclaim`
   - opens `/reclaim`;
   - connects the `reclaim_funder` wallet through the CIP-30 harness;
   - uses the payment credential derived from `compromised_user`;
   - builds, inspects, signs, submits, and confirms one ADA-only
     `ReclaimBase` UTxO.
3. `fund-native-asset-reclaims`
   - funds enough additional `ReclaimBase` UTxOs to reach at least six
     matching UTxOs total;
   - includes at least one native asset in the protected value;
   - confirms every output has the expected inline datum and value.
4. `discover-matching-claims`
   - opens `/claim`;
   - connects `compromised_user` as the impacted wallet;
   - asserts the impacted wallet is never asked to sign;
   - discovers all matching public `ReclaimBase` UTxOs through the UI.
5. `generate-destination-bound-proofs`
   - connects `safe_claim_destination`;
   - drafts the first claim batch;
   - sends the draft proof request to the local Proof Helper;
   - verifies returned artifacts are destination-bound and path metadata is
     stripped before hosted/backend submission.
6. `claim-first-batch`
   - builds the first claim transaction for four UTxOs;
   - verifies provider evaluation is inside configured margins;
   - signs with `safe_claim_destination`;
   - submits and waits until the selected outrefs are spent.
7. `claim-tail-and-receipt`
   - refreshes progress;
   - claims the remaining matching UTxOs;
   - confirms no matching UTxOs remain at `ReclaimBase`;
   - confirms all protected ADA/native assets arrived at
     `safe_claim_destination`;
   - verifies the receipt UI shows funding txs, claim txs, recovered value,
     deployment id, and destination.
8. `negative-guardrails`
   - wrong network blocks both pages;
   - impacted wallet signing is impossible;
   - safe wallet overlapping impacted credentials is blocked;
   - tampered signed tx is rejected by inspect gate;
   - wrong destination proof is rejected before submit;
   - insufficient safe-wallet fee ADA blocks proof generation.

Artifacts to write under `output/preprod-e2e/<run-id>/`:

- run manifest and source commit;
- redacted wallet role summary;
- deployment manifest snapshot;
- funding tx hashes;
- claim tx hashes;
- selected outrefs;
- proof profile and destination verifier hash;
- provider evaluation/ex-unit summaries;
- Playwright screenshots for each major app state;
- redacted server/helper logs;
- final safe-wallet balance and remaining reclaim-base UTxO scan.

Exit criteria:

- The automated suite passes from a clean preprod state or a documented
  idempotent already-deployed state.
- The suite submits real preprod funding and claim transactions.
- No hosted log or artifact contains seed phrases, master XPrvs, derivation
  paths, helper request bodies, full CBOR, witness sets, or proof bytes.
- The suite can be rerun without confusing old pending/spent UTxOs with new
  matching funds.

### Phase 10: Mainnet Readiness Gate

Mainnet values stay disabled until all gates are complete:

- clean release tag;
- signed deployment manifest;
- signed destination proving-key bundle;
- verifier/key/Cardano export coherence verified;
- contract tests and benchmarks green;
- web, helper, desktop, and Go tests green;
- preprod round-trip evidence attached to release notes;
- audit findings resolved or explicitly accepted;
- logs and telemetry privacy-reviewed;
- provider/indexer SLA and fallback documented;
- rollback playbook reviewed;
- product copy reviewed for narrow proof claims.

## Verification Matrix

### Go And Proof

- `go test ./...`
- `PROOF_TOOL_RUN_FULL_PROOF=1 go test ./internal/prover -run TestOwnershipDestinationProofRoundTripIntegration -count=1`
- `proof-tool prove-destination`
- `proof-tool verify-destination`
- `proof-tool export-cardano`
- negative export/proof checks for changed destination, changed credential,
  wrong key bundle, and malformed artifacts.

### Web

- `pnpm --dir packages/client-ts build`
- `pnpm --dir packages/client-ts test`
- `pnpm --dir apps/ownership-proof-web typecheck`
- `pnpm --dir apps/ownership-proof-web test`
- `pnpm --dir apps/ownership-proof-web build`
- `NEXT_PUBLIC_CLAIM_UI_FIXTURE=1 pnpm --dir apps/ownership-proof-web visual:claim`
- strict visual comparison where practical, with side-by-side manual review for
  generated-PNG differences.

### Desktop Helper

- `pnpm --dir apps/proof-helper-desktop typecheck`
- `pnpm --dir apps/proof-helper-desktop test`
- `pnpm --dir apps/proof-helper-desktop build`
- Rust key-bundle and sidecar tests under `apps/proof-helper-desktop/src-tauri`.
- corrupt signature, wrong digest, wrong key profile, cancellation, delete
  cache, and rollback tests.

### Contracts

- `cd contracts/ownership-verifier && cabal v2-test all`
- `cd contracts/ownership-verifier && cabal v2-bench ownership-verifier-bench`
- Contract tests consuming exported destination `proof.hex`, `vk.hex`, and
  `pub.hex`.
- Negative tests for redirection, underpayment, missing native asset, wrong
  destination index, unused proof, missing proof, wrong parameter reference
  input, malformed datum, and no reclaim-base inputs.

### Live Preprod

- Provider health check.
- Manifest on-chain coherence check.
- Funding deposit and claim spend.
- Explorer confirmation of inline datum and value.
- Provider evaluation evidence before signing.
- Final safe-wallet balance confirmation.

### Automated E2E

- `RECLAIM_E2E_LIVE_PREPROD=1 pnpm --dir apps/ownership-proof-web test:e2e:preprod`
- Application-driven `/reclaim` funding of ADA-only and native-asset protected
  UTxOs.
- Application-driven `/claim` discovery, destination-bound proof generation,
  safe-wallet signing, claim submission, progress refresh, and receipt.
- Negative guardrail tests for wrong network, impacted-wallet signing, safe
  wallet overlap, tampered transaction, wrong destination proof, and
  insufficient fee ADA.
- Output artifacts under `output/preprod-e2e/<run-id>/`.

## Logging And Observability

Allowed log fields:

- request id;
- route;
- status code;
- duration;
- deployment id;
- network;
- provider/indexer name;
- high-level error code;
- transaction hash after submission;
- circuit id and verifier hash;
- batch size and count summary.

Disallowed log fields:

- seed phrase;
- entropy;
- master XPrv;
- derivation path metadata;
- helper request bodies;
- wallet address inventories;
- full UTxO lists;
- full CBOR;
- witness sets;
- proof bytes;
- public input if paired with wallet/session identifiers;
- full addresses unless explicit local debug mode is enabled.

## Rollback And Kill Switches

Add or document:

- Vercel rollback to previous web/verifier deployment.
- Server-side manifest disable flag that makes funding and claiming read-only.
- Provider failover from primary to fallback.
- Helper updater rollback.
- Key-bundle rollback to the previous signed active profile.
- Mainnet emergency banner.
- Explicit note that bad immutable contract parameters require a new contract
  deployment; frontend rollback cannot fix funds sent to an invalid on-chain
  deployment.

## Risk Register

| Risk | Mitigation |
| --- | --- |
| Dirty deployment source cannot be reproduced | Require clean tag and exact `source_commit` |
| Manifest/env mismatch strands funds | Signed manifest and coherence verifier |
| Wrong datum locks funds for wrong claimant | Clear review, strict credential validation, receipt evidence |
| Funding submit acts as generic relay | Build-session binding and signed tx inspect gate |
| Server trusts client UTxO/destination/proof order | Requery chain data and recompute destination/order/value |
| Destination proof generated before safe wallet known | Draft requires safe wallet destination first |
| Helper uses ownership-only or dev-created keys | Destination profile status and fail-closed signed bundle loading |
| Path metadata leaks account structure | Strip `path`/`paths` by default and reject on backend where possible |
| Provider stale data hides UTxOs | Owned indexer plan, provider parity tests, progress refresh |
| Batch exceeds ex-unit margin | Four-input default, evaluate before signing, split over-margin drafts |
| Protected value reduced for fees | Safe-wallet-only fee funding and transaction inspector |
| Hosted logs expose secrets or wallet inventory | Redacted logging policy and tests where feasible |
| Fixture UI mistaken for readiness | Fixture env gate and live preprod acceptance requirement |

## Suggested Work Ownership

- Funding backend hardening:
  `apps/ownership-proof-web/app/reclaim-api/*`,
  `apps/ownership-proof-web/lib/reclaim-server/*`,
  `apps/ownership-proof-web/lib/reclaim/*`.
- Claim backend:
  `apps/ownership-proof-web/app/claim-api/*`,
  `apps/ownership-proof-web/lib/claim-server/*`,
  `apps/ownership-proof-web/lib/claim/*`.
- Claim UI wiring:
  `apps/ownership-proof-web/components/ClaimFlow.tsx` and tests.
- Helper/proof:
  `internal/helper/*`, `internal/prover/*`, `cmd/proof-tool/*`,
  `internal/artifact/*`.
- Desktop/key bundle:
  `apps/proof-helper-desktop/src-tauri/*` and desktop UI tests.
- Contracts/benchmarks:
  `contracts/ownership-verifier/src/*`,
  `contracts/ownership-verifier/test/*`,
  `contracts/ownership-verifier/bench/*`.
- Deployment/runbooks:
  `deployments/reclaim/*`, `docs/*`, Vercel env configuration, and release
  notes.

## Open Decisions

- Whether preprod acceptance can rely on Blockfrost/Koios for claim discovery,
  or whether Kupo/Ogmios must be introduced before the first live round trip.
- Whether the destination helper endpoint should be a new `/prove-destination`
  route or a versioned `/prove` route with explicit profiles.
- How build-session binding should be represented: signed token, server-side
  short-lived store, or deterministic review hash.
- Whether the optional five-UTxO batch is ever exposed to users or remains an
  operator-only optimization.
- Which release infrastructure publishes destination proving-key bundles.
- Whether seed phrase entry remains in hosted JS for v1 or moves into the signed
  Tauri app before mainnet.

## Mainnet Readiness Verdict

The next implementation work is backend and deployment work, not more fixture UI.
The correct sequence is:

1. freeze a coherent preprod deployment set;
2. harden `/reclaim-api` so funding deposits are inspectable and not relay-like;
3. implement `/claim-api`, destination helper support, and claim transaction
   construction;
4. run a full preprod funding-to-claim round trip;
5. only then enable mainnet deployment values.

Until those phases are complete, `/claim` should be treated as a designed UI
shell and visual fixture harness, not a production claim workflow.
