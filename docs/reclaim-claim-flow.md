# Reclaim Claim Flow

## Purpose And Route

`/claim` is the original-owner flow. It discovers `ReclaimBase` outputs for an
impacted payment credential, chooses a separate safe wallet, creates
destination-bound proofs locally, builds and reviews a claim transaction, asks
only the safe wallet to sign, submits, and follows all selected outrefs to a
receipt or the next batch.

The UI entrypoint is
`apps/ownership-proof-web/components/ClaimFlow.tsx`. Public request/response
types live under `apps/ownership-proof-web/lib/claim`; server-owned
index/draft/build/submit/progress logic lives under
`apps/ownership-proof-web/lib/claim-server`.

## Runtime Sequence

1. `GET /claim-api/deployment` loads and validates the pinned deployment.
2. The impacted CIP-30 wallet is used for public address/network reads only.
3. `GET /claim-api/reclaim-utxos` lists provider-backed `ReclaimBase` UTxOs.
4. The UI selects only locally matched outrefs and excludes pending outrefs.
5. The safe wallet is connected. It must be on the deployment network, use a
   key payment credential, have enough ADA, and not overlap the impacted
   wallet's payment credentials.
6. `POST /claim-api/draft` fixes input order, safe destination outputs,
   destination-address-v1 bytes, proof requests, batch cap, and expected output
   start index.
7. The user chooses Proof Helper Desktop or browser WASM. Proof generation is
   local and all-or-nothing for the draft.
8. `POST /claim-api/build` revalidates proof coverage and deployment coherence,
   constructs/evaluates the unsigned transaction, and returns a review,
   review hash, and bound review token.
9. The safe wallet calls `signTx(txCbor, true)` once. The browser sends the
   witness set plus the unchanged review/token to `POST /claim-api/submit`.
10. `GET /claim-api/progress` follows submitted outrefs. Confirmed spends are
    removed before the next locally selected batch is drafted.

`ClaimFlow` intentionally separates build from sign/submit. Provider rejection
or wallet signature rejection returns to a retryable review state without
forcing proof regeneration when the draft is still valid.

## API And Code Map

| Route | Server implementation | Main responsibility |
| --- | --- | --- |
| `/claim-api/deployment` | `apps/ownership-proof-web/lib/reclaim-server/manifest.ts` | Manifest/env coherence and capabilities |
| `/claim-api/reclaim-utxos` | `apps/ownership-proof-web/lib/claim-server/indexer.ts` | Provider index and datum parsing |
| `/claim-api/draft` | `apps/ownership-proof-web/lib/claim-server/draft.ts` | Deterministic ordered batch and destinations |
| `/claim-api/build` | `apps/ownership-proof-web/lib/claim-server/build-submit.ts` | Proof revalidation, reference scripts, tx build/evaluation |
| `/claim-api/submit` | `apps/ownership-proof-web/lib/claim-server/build-submit.ts` | Review binding, witness assembly, signed-tx inspection, provider submit |
| `/claim-api/progress` | `apps/ownership-proof-web/lib/claim-server/progress.ts` | Outref state and next-batch availability |

Shared Cardano parsing and transaction helpers live under
`apps/ownership-proof-web/lib/cardano` and
`apps/ownership-proof-web/lib/claim`.

## Wallet And Secret Boundaries

- The impacted wallet never signs the claim transaction.
- The safe wallet supplies public addresses for drafting and the only signing
  API retained in memory.
- The recovery phrase is read and cleared immediately before derivation.
- `packages/client-ts` derives the 96-byte master XPrv in a terminated-after-use
  worker.
- Proof Helper receives the master XPrv only in a loopback request body.
- Browser proving transfers it to a dedicated local prover worker.
- Master bytes are zeroed in `finally`; phrase/XPrv/path data is excluded from
  logs, hosted requests, errors, proof artifacts, and resume storage.

Helper pairing accepts only loopback HTTP origins from a fragment URL, checks
the `single-destination` profile and deployment VK hash, and rejects any helper
artifact containing `path` or `paths`.

## Proof Providers

`apps/ownership-proof-web/lib/proving/desktop-helper.ts` preserves the helper
POST contract: `/prove-destination`, profile `single-destination`, search bounds
through account 9 and index 5000, and `include_debug_path: false`.

`apps/ownership-proof-web/lib/proving/browser-wasm.ts` first checks WebAssembly,
worker support, cross-origin isolation, `SharedArrayBuffer`, nested workers,
hardware, signed assets, and the deployment VK hash. It proves requests
sequentially in one worker because a proof uses roughly 2.3 GiB of main WASM
heap. Cancellation terminates the worker; completed partial batches are not
committed.

See `browser-proving.md` for runtime and asset details.

## Batching And Review Invariants

The default batch cap is 4 and hard maximum is 5. The backend fixes input order
and destination output order; the contract consumes proofs in that order. A
draft is stale if the deployment, network, selected/matched UTxOs, pending
outrefs, or safe-wallet destination changes.

The build review records input order, destination start index, destination
outputs, parameter/reference-script inputs, and per-proof public-input digests.
Submission requires the matching HMAC-bound review token and reinspects the
signed transaction before provider submission.

## Resume Behavior

`proof-tool.claim-flow.resume.v1` stores a best-effort, two-hour local snapshot
of public UI state, draft, proof artifacts, and optional unsigned build. It does
not store the phrase, master XPrv, derivation path, helper token, or live CIP-30
API. A resumed built transaction therefore requires reconnecting and validating
the same safe wallet before signing.

## UI Fixtures And Visual Checks

Fixture screens are enabled only with `NEXT_PUBLIC_CLAIM_UI_FIXTURE=1` and are
selected with `/claim?fixtureState=<screen>`. They exercise rendering and
control flow, not real proving or chain behavior.

```bash
NEXT_PUBLIC_CLAIM_UI_FIXTURE=1 pnpm --dir apps/ownership-proof-web dev --hostname 127.0.0.1 --port 3026
pnpm --dir apps/ownership-proof-web visual:claim
```

Review-mode output is under `output/playwright/reclaim-owner-claim/`. The strict
command compares against generated design references and may fail on accepted
visual differences:

```bash
pnpm --dir apps/ownership-proof-web visual:claim:strict
```

## Tests

```bash
pnpm --dir apps/ownership-proof-web test components/ClaimFlow.test.tsx
pnpm --dir apps/ownership-proof-web test
pnpm --dir apps/ownership-proof-web typecheck
```

The operator-approved real chain route is documented in `preprod-e2e.md`.
