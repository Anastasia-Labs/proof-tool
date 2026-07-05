# Reclaim Funding Page Plan

## Purpose

Add a second website page at `/reclaim` that lets a rescuer connect a Cardano
wallet and lock swept funds at the deployed `ReclaimBase` script address with
the inline datum required by the reclaim contracts:

```haskell
ReclaimBaseDatum
  { reclaimPaymentKeyHash = compromisedPaymentKeyHash
  }
```

The page is for funding the reclaim script. It is not the owner proof page. It
does not ask for a recovery phrase, master private key, proof artifact, or
derivation path. The original owner later reclaims the protected funds by
spending the `ReclaimBase` output through `ReclaimGlobal` with a proof that
their master private key derives to the compromised payment key credential.

## Current Baseline

- The website currently has one Next.js page at
  `apps/ownership-proof-web/app/page.tsx`.
- The root page renders `ProofFlow`, which generates and verifies credential
  proofs through the local Proof Helper.
- The web package now uses Lucid Evolution for backend transaction construction:
  `@lucid-evolution/lucid`, `@lucid-evolution/provider`, and
  `@lucid-evolution/core-types`.
- `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs` defines
  `ReclaimBaseDatum` with one 28-byte `reclaimPaymentKeyHash` field.
- `docs/reclaim-contracts-spec.md` specifies the reclaim-base and
  reclaim-global contracts. The funding page must match that spec.
- The repo uses Vercel rewrites that send `/api/:path*` to the Go verifier
  service. Any web-owned API routes for this page need a non-conflicting path
  or a rewrite change.

## Product Scope

The v1 page should support:

- CIP-30 wallet discovery and connection.
- Network detection and mismatch errors.
- Entry of a compromised Cardano payment key credential as 56 hex characters.
- Raw 56-hex payment key credential entry. Address-to-credential extraction is a
  later enhancement.
- Selection of ADA and native tokens from the connected wallet to deposit into
  `ReclaimBase`.
- Backend construction of a transaction with one script output at the deployed
  `ReclaimBase` address and an inline `ReclaimBaseDatum`.
- Wallet signing and submission.
- A submitted transaction hash and enough metadata to let operators audit what
  credential the output was locked for.

The v1 page should not support:

- Recovery phrase entry.
- Proof generation.
- Reclaim spending by the original owner.
- Backend custody of wallet signing keys.
- Depositing to an unpinned or user-supplied script address.
- Script credentials as the compromised credential datum.
- Reward/stake credentials as the compromised credential datum.

## Route and Navigation

Implemented:

- `apps/ownership-proof-web/app/reclaim/page.tsx`
- `apps/ownership-proof-web/app/reclaim-api/deployment/route.ts`
- `apps/ownership-proof-web/app/reclaim-api/wallet-assets/route.ts`
- `apps/ownership-proof-web/app/reclaim-api/build/route.ts`
- `apps/ownership-proof-web/app/reclaim-api/submit/route.ts`
- `apps/ownership-proof-web/components/ReclaimFundingFlow.tsx`
- `apps/ownership-proof-web/components/ReclaimFundingFlow.test.tsx`
- shared validation/types under `apps/ownership-proof-web/lib/reclaim/`
- shared backend config and transaction-building helpers under
  `apps/ownership-proof-web/lib/reclaim-server/`

The existing root page remains the ownership proof page. Add a small shared
navigation affordance so users can move between:

- `/` - prove ownership of a payment key credential.
- `/reclaim` - deposit rescued funds for a compromised credential.

Keep the visual system consistent with `ProofFlow`: left-side status summary,
right-side work area, compact sections, restrained buttons, and explicit status
bands.

## Deployment Manifest

Do not hard-code reclaim deployment values directly in component logic. The
implemented page loads deployment data from `GET /reclaim-api/deployment`, which
reads server environment variables:

- `RECLAIM_NETWORK` (`Mainnet`, `Preprod`, or `Preview`)
- `RECLAIM_BASE_ADDRESS`
- `RECLAIM_BASE_SCRIPT_HASH`
- `RECLAIM_GLOBAL_CREDENTIAL`
- `RECLAIM_GLOBAL_SCRIPT_HASH`
- `RECLAIM_PARAMS_CURRENCY_SYMBOL`
- `RECLAIM_PARAMS_TOKEN_NAME`
- `RECLAIM_VERIFIER_VK_HASH`
- `RECLAIM_CONTRACT_VERSION`
- `RECLAIM_SOURCE_COMMIT`

The API response is the product boundary between deployment and UI. If any
required value is missing, `/reclaim` renders a disabled deployment state instead
of accepting deposits to a placeholder.

## Wallet and Transaction Architecture

Use CIP-30 for wallet connection and signing. Keep signing in the browser, but
build transactions on the backend with Lucid Evolution.

Required v1 implementation:

1. The browser discovers CIP-30 wallets, connects to one wallet, reads the
   wallet network id, `getChangeAddress()`, and `getUsedAddresses()`.
2. The browser sends a build request to the backend containing only public wallet
   transaction intent: network id, change address, used wallet addresses,
   selected ADA/native-token quantities, target credential, and deployment id.
   It must not call `getUnusedAddresses()`, because unused addresses are not
   evidence of spendable UTxOs. The UI must not expose a wallet-address input
   field; all wallet addresses come from CIP-30.
3. The backend queries UTxOs for the supplied wallet address set through its
   configured provider and deduplicates the resulting inputs.
4. The backend initializes Lucid Evolution for the deployment network and
   selects the address-only wallet with
   `lucid.selectWallet.fromAddress(changeAddress, utxos)`. This gives Lucid the
   change address and queried UTxO set for transaction balancing without giving
   the backend signing keys.
5. The backend builds and completes an unsigned transaction against the pinned
   deployment manifest.
6. The completed unsigned transaction must contain exactly one protected output at
   `reclaim_base_address` with inline `ReclaimBaseDatum`.
7. The protected output must include the selected ADA and selected native tokens,
   plus any min-ADA required by the multi-asset inline-datum output.
8. Fees should be funded from wallet inputs/change where possible. If selected
   rescued value must be reduced for fees, the response must make that explicit
   and require a separate user confirmation before signing.
9. The backend returns completed unsigned transaction CBOR plus a normalized review
   summary: protected output address, datum credential, selected token bundle,
   min-ADA, estimated fee, wallet/change address, and deployment id.
10. The browser asks the wallet to sign the returned CBOR.
11. The browser asks the wallet for a CIP-30 witness set and sends the unsigned
   transaction plus witness set to `/reclaim-api/submit`, where Lucid assembles
   and submits the signed transaction through the configured provider. The
   submit route also accepts fully signed transaction CBOR for future wallet
   flows that return it.
12. Before production submission, the client or backend must inspect the signed transaction
    and refuse to submit if the expected `ReclaimBase` output, inline datum, or
    selected token bundle is missing or changed.

The frontend must treat wallet material as user data. Do not log full UTxO
sets, addresses, submitted transaction CBOR, or wallet API responses outside
explicit local debug mode.

The backend builder must not receive seed phrases, private keys, wallet
passwords, or signed witnesses before the user approves signing in their wallet.
It also must not accept a caller-supplied script address; it must load the
address and script metadata from the pinned deployment manifest.

The backend should treat the supplied change address and wallet address list as
untrusted public input. It must validate that each address belongs to the
requested network, query UTxOs from its provider, and fail if the requested
ADA/native-token bundle is not available from those queried UTxOs.

## User Flow

1. Page loads deployment manifest.
2. Page shows whether the reclaim deployment is available for the selected
   network.
3. User connects a CIP-30 wallet.
4. Page verifies the wallet network id matches the deployment manifest.
5. User enters the compromised payment key credential.
6. Page validates that the datum credential is exactly 28 bytes and is a key
   payment credential.
7. User selects ADA and native tokens to lock. The frontend can show balances
   from wallet data or a backend inventory response, but the build request sends
   the CIP-30 change address, CIP-30 used payment addresses, and requested
   multi-asset bundle rather than raw signing keys or private wallet material.
8. Page requests a backend-built transaction with one protected output:
   - change address: the connected wallet change address used by Lucid;
   - wallet addresses: the connected wallet used addresses queried for funds;
   - address: `reclaim_base_address` from the deployment manifest;
   - datum: inline `ReclaimBaseDatum(compromisedPaymentKeyHash)`;
   - value: selected lovelace and native tokens plus any min-ADA needed for the
     output.
9. Backend returns completed unsigned transaction CBOR and a review summary.
10. Wallet signs the transaction.
11. Page submits the transaction.
12. Page shows the transaction hash, locked value summary, datum credential, and
    deployment id.

## Datum Encoding

The datum encoder must be tested against the Haskell `ReclaimBaseDatum` shape:

```haskell
data ReclaimBaseDatum = ReclaimBaseDatum
  { reclaimPaymentKeyHash :: BuiltinByteString
  }

PlutusTx.makeIsDataIndexed ''ReclaimBaseDatum [('ReclaimBaseDatum, 0)]
```

The CBOR/Plutus data shape is constructor `0` with one bytes field. The bytes
field is the raw 28-byte compromised payment key hash, not:

- bech32 text;
- hex text bytes;
- a full address;
- a stake credential;
- a script credential;
- a hash of a hash.

Implementation requirements:

- Normalize hex by trimming whitespace and lowercasing.
- Reject anything other than 56 hex characters after optional `0x` removal.
- Convert to exactly 28 raw bytes for the Plutus data bytes field.
- Encode inline datum as Plutus constructor `0 [B bytes28]`. The implemented
  server uses `Data.to(new Constr(0, [credentialHex]))` from Lucid Evolution.
- Add golden tests that compare the TypeScript datum CBOR against a Haskell or
  CLI-generated fixture.

## Address-to-Credential Extraction

Address parsing is not implemented in the current V1 page. If it is added later,
it must be local and strict:

- Accept Shelley payment addresses only when the payment credential is a key
  credential.
- Extract only the 28-byte payment key credential.
- Reject script payment credentials.
- Reject stake-only/reward addresses.
- Reject Byron addresses unless a later proof circuit explicitly supports the
  desired semantics.
- Reject malformed or network-mismatched addresses.
- Show the extracted 56-hex credential before the user signs.

The page must avoid language implying that a pasted address is what the owner
will prove. The reclaim contract uses the payment key credential in the datum.

## Value Selection

V1 must support multi-asset deposits. Depositing only ADA is just one possible
selection in the same multi-asset builder, not a separate first implementation.

Selection requirements:

- User can select ADA and native tokens to include in the protected output.
- Native tokens must be displayed by policy id, asset name bytes/hex, quantity,
  and display name when metadata is available.
- User can choose whole-token quantities for fungible assets and explicit NFTs
  by asset id.
- Page computes or receives from the backend the min-ADA required for the output
  containing the selected assets and inline datum.
- Page refuses selections that cannot satisfy min-ADA, fee, or wallet-balance
  requirements.
- Backend independently queries the supplied wallet address set and refuses build
  requests for token quantities unavailable across those UTxOs.
- Page shows whether fees are paid from separate wallet inputs/change or reduce
  the selected rescued value.
- Page can add UTxO-level selection after asset-level selection, but any UTxO
  mode must still show the exact protected multi-asset bundle before signing.

Do not add an unrestricted "send everything" button until token display,
min-ADA, fees, and datum preview are proven reliable. A wrong datum or wrong
deployment address can lock every selected asset for the wrong owner.

## Backend and Config Surface

The page needs server support for Lucid Evolution transaction construction. Use
explicit routes that do not conflict with the current verifier rewrite. Keep
`/api/*` for the Go verifier service and use `/reclaim-api/*` for the web
service unless the Vercel routing model is changed deliberately.

Required server endpoints:

- `GET /reclaim-api/deployment`
  Returns the deployment manifest.
- `POST /reclaim-api/wallet-assets`
  Accepts change address, wallet address list, and network id, then returns the
  backend-observed ADA and native-token inventory for those addresses.
- `POST /reclaim-api/build`
  Accepts change address, wallet address list, network id, selected
  ADA/native-token bundle, target credential, and deployment id. It queries
  address UTxOs, calls `lucid.selectWallet.fromAddress(changeAddress, utxos)`,
  and returns completed unsigned transaction CBOR for wallet signing.
- `POST /reclaim-api/submit`
  Accepts fully signed transaction CBOR, or unsigned transaction CBOR plus a
  CIP-30 witness set. In the witness-set path, it assembles with
  `lucid.fromTx(unsigned).assemble([witness]).complete()` and submits through
  the configured provider.

Optional server endpoints:

- `POST /reclaim-api/inspect`
  Verifies that unsigned or signed transaction CBOR still contains the expected
  protected output, inline datum, and multi-asset value before submission.

All endpoints should be network-specific and refuse requests for a network that
does not match the deployment manifest.

## UI States

Left-side status rows:

- Deployment: loading, ready, unavailable, network mismatch.
- Wallet: not connected, connected, wrong network, unsupported.
- Datum: empty, valid, invalid.
- Transaction: draft, ready to sign, signing, submitting, submitted, failed.

Main sections:

- Deployment summary.
- Wallet connection.
- Compromised credential.
- Funds to lock.
- Review and submit.
- Submitted transaction.

Review screen must show:

- Reclaim base address.
- Reclaim base script hash.
- Datum credential.
- Network.
- ADA and native tokens being locked.
- Estimated fee.
- Wallet funding/change address, shortened.
- Whether the transaction includes native assets.

## Safety Requirements

- Never ask for a recovery phrase on `/reclaim`.
- Never send funds to an address supplied by query string, localStorage, or a
  user-editable field.
- Never accept a missing or malformed deployment manifest.
- Require a wallet network match before building a transaction.
- Require the user to see and confirm the datum credential before signing.
- Treat the datum credential as the future claimant identity. If it is wrong,
  the true owner may not be able to reclaim.
- Keep transaction preview deterministic and re-render it after any wallet,
  amount, asset, credential, or deployment change.
- Production hardening should refuse to submit if the signed transaction does
  not contain the expected `ReclaimBase` output, inline datum, and protected
  multi-asset value. The current implementation returns and displays a backend
  review summary, but does not yet include a separate signed-transaction inspect
  gate.

## Testing Plan

Unit tests:

- Credential normalization accepts lowercase/uppercase 56-hex strings.
- Credential normalization rejects wrong lengths and non-hex input.
- Datum encoder should match the Haskell `ReclaimBaseDatum` fixture.
- Deployment manifest validation rejects missing, malformed, and mismatched
  fields.
- Transaction-output inspection detects the exact expected script output and
  inline datum.

Component tests:

- Missing deployment disables wallet connection so deposits cannot proceed
  without pinned deployment data.
- Wrong network blocks the transaction builder.
- Invalid credential blocks signing.
- Changing the credential after draft creation invalidates the draft.
- Submitted state shows tx hash and locked credential.

Integration tests:

- Mock CIP-30 wallet signs the backend-built unsigned transaction path.
- Mock backend build route returns unsigned CBOR and a review summary.
- Mock provider accepts signed CBOR through the backend submit route.
- Multi-asset transaction includes one inline-datum output at the configured
  base address.
- Native-token transaction preserves selected asset quantities.
- Add a signed transaction post-check that rejects tampered address, missing
  datum, and wrong datum before production deposits.

Manual/live tests:

- Preprod wallet connects.
- Preprod ADA plus native-token deposit submits.
- Explorer shows the output at the reclaim base address with inline datum and
  the expected multi-asset value.
- A follow-up reclaim spend can consume that output with the owner proof flow.

## Implementation Phases

### Phase 1: Static Page and Manifest

- Add `/reclaim` route and shared navigation.
- Add deployment manifest schema and disabled state.
- Add UI sections and status rows without transaction submission.
- Add tests for manifest validation and page states.

### Phase 2: Wallet Connection

- Add CIP-30 provider discovery and connect flow.
- Add wallet diagnostics when `window.cardano` is missing.
- Add network id detection and mismatch handling.
- Add mocked wallet tests.

### Phase 3: Credential and Datum

- Add credential normalization.
- Add inline datum encoder.
- Add golden datum tests.

### Phase 4: Backend Multi-Asset Builder

- Add Lucid Evolution to the backend/web package and pin it at implementation
  time.
- Add `/reclaim-api/build` with server-only deployment manifest loading.
- Build one protected script output containing selected ADA and native tokens.
- Return completed unsigned transaction CBOR and normalized review summary.
- Add backend tests for datum, address, min-ADA, fee, and token preservation.

### Phase 5: Sign, Inspect, And Submit

- Add review screen.
- Add sign and submit flow.
- Add `/reclaim-api/submit`.
- Add signed-transaction post-check and optional `/reclaim-api/inspect`.
- Validate on preprod.

### Phase 6: Swept UTxO Selection

- Add UTxO-level selection for swept funds.
- Add "fund fees separately when possible" behavior.
- Add tests for preserving selected asset values.

### Phase 7: Reclaim Round Trip

- Deposit a preprod output with the page.
- Generate an owner destination-bound proof for the datum credential.
- Spend the deposited output through `ReclaimGlobal`.
- Save the tx hashes and command/browser evidence in the runbook.

## Open Decisions

- Whether to add local Cardano address-to-credential extraction after V1.
- Which deployment manifests exist for preprod and mainnet.
- Whether deposits should use single-output per submission or allow batching.
- Whether an operator audit export is required after submission.
- How the reclaim owner page will discover deposited UTxOs for a credential.
