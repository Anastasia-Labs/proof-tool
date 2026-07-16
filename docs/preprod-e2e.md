# Preprod Deployment And End-to-End Harness

## Scope

`apps/ownership-proof-web/e2e/preprod` contains the production-shaped Cardano
Preprod deployment and funding-to-claim acceptance harness. The deterministic
default wallet mode injects test-only CIP-30 wallets; the separate Lace mode is
operator-driven and remains under `manual-lace-claim-flow-qa-plan.md`.

This harness can submit real Preprod transactions. It has no mainnet route and
must not be run with `NODE_ENV=production`.

## Code Map

- `run.mjs`: preflight, run manifest, transaction approval, app lifecycle,
  stage orchestration, redaction, and final leakage scan.
- `preflight.mjs`: explicit live gate, wallet-role file, clean Git state,
  deployment-source ancestry and manifest coherence, provider and server-secret
  checks.
- `deploy-reclaim-preprod.mjs`: one-shot NFT, parameter holder, parameterized
  ReclaimGlobal/ReclaimBase scripts, reference scripts, reward-account
  registration, and enabled manifest creation.
- `app-server.mjs`: starts a local Next app or targets `RECLAIM_E2E_APP_URL`.
- `wallet-driver.mjs`, `cip30-harness.mjs`, `real-lace-driver.mjs`: wallet mode
  abstraction.
- `funding-stage.mjs`: ADA-only and native-asset `/reclaim` transactions.
- `claim-discovery-stage.mjs`: impacted-wallet discovery through `/claim`.
- `proof-stage.mjs`: desktop-helper or browser-WASM destination proofs.
- `guardrails-stage.mjs`: negative product/security assertions.
- `claim-ui-stage.mjs` and `tail-stage.mjs`: UI-driven build/sign/submit,
  progress, continuation batches, and receipt.

Unit tests sit beside each stage. Keep stage logic testable without a live
provider; the live command is final evidence, not the first debugging tool.

## Required Local Inputs

Use the ignored `deployments/reclaim/preprod/test-wallets.local.json`. It may be
an object or array of role records, but must provide distinct test mnemonics for
the required roles (deployer, reclaim funder, compromised user, and safe claim
destination). Never place these values in tracked files or command arguments.

The harness also requires:

- a clean webapp commit whose history contains the enabled Preprod manifest's
  `source_commit` (the contract deployment may legitimately predate the webapp
  release);
- `RECLAIM_REVIEW_TOKEN_SECRET` and a configured Preprod provider;
- `RECLAIM_DEPLOYMENT_MANIFEST_JSON` or one supported manifest path variable;
- a loopback destination helper target and token for the desktop provider;
- a signed destination key bundle whose VK hash matches the deployment;
- a lowercase native-asset unit for the full injected-wallet lane.

Source the repo-root `.env.local` when serving the local app so claim and
funding routes use the canonical deployment/provider configuration.

## Safety Gates

Two explicit gates are required:

- `RECLAIM_E2E_LIVE_PREPROD=1` enables Preprod preflight.
- `RECLAIM_E2E_SUBMIT_TRANSACTIONS=1` authorizes browser signing and provider
  submission for this run.

Without the second gate, the runner writes a blocked run manifest and exits
before browser automation, wallet signing, proof bodies, witnesses, CBOR, or
provider submission. Mainnet remains unapproved regardless of these values.

The helper URL must be plain HTTP on `localhost`, `127.0.0.1`, or `::1`, with no
path, query, credentials, or fragment. Helper tokens are written only as
`[redacted]` in artifacts.

## Deployment

The deployer refuses a dirty/unpushed source tree: `HEAD` must equal
`origin/main`. It never creates proof keys. It exports parameterized Plutus V3
scripts through the contract executable, mints the one-shot parameter NFT,
registers the ReclaimGlobal reward account when needed, creates the immutable
parameter and base/global reference-script outputs, confirms them through the
provider, and writes the ignored enabled manifest.

The destination bundle must be verified against an independently provisioned
manifest public key and the approved signer ID before export. Do not satisfy
this boundary by copying or linking the bundle's own public-key file to an
external-looking path; direct, symlink-contained, and hard-linked bundle
anchors are rejected.

```bash
set -a
source .env.local
set +a

RECLAIM_E2E_LIVE_PREPROD=1 \
RECLAIM_E2E_SUBMIT_TRANSACTIONS=1 \
PREPROD_TEST_WALLETS_FILE=deployments/reclaim/preprod/test-wallets.local.json \
RECLAIM_E2E_DESTINATION_KEYS_DIR=output/preprod-e2e/destination-keys.local \
RECLAIM_E2E_STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE=/independent/path/manifest-public-key.hex \
RECLAIM_E2E_STAGE2G_V2_SIGNATURE_KEY_ID='<approved-signer-id>' \
pnpm --dir apps/ownership-proof-web deploy:reclaim:preprod
```

Verify the resulting manifest before using it:

```bash
pnpm --dir apps/ownership-proof-web verify:reclaim-manifest \
  ../../deployments/reclaim/preprod/live.local.json
```

The harness snapshots the manifest into each run directory before app startup,
preventing a concurrent deployment-file change from mixing page state with a
different backend deployment.

## Statement-Bound V2 Stage 2g Evaluation

Before deploying the statement-bound V2 validator, run its guarded seven-slot
provider evaluation from a clean release candidate. This stage is deliberately
unsigned and non-submitting: it constructs a production-shaped transaction
with seven distinct credential/proof/digest slots and asks the configured
Preprod provider to evaluate it.

First generate the ignored, local-only material with the signed bundle and an
independently provisioned manifest trust identity. The public-key file must be
outside the key-bundle directory and must not be linked to a bundle file.

```bash
set -a
source .env.local
set +a

unset RECLAIM_E2E_SUBMIT_TRANSACTIONS
RECLAIM_E2E_LIVE_PREPROD=1 \
RECLAIM_E2E_STAGE2G_V2_MATERIAL=1 \
RECLAIM_E2E_STAGE2G_V2_KEYS_DIR=/path/to/signed-v2-key-bundle \
RECLAIM_E2E_STAGE2G_V2_MANIFEST_PUBLIC_KEY_FILE=/independent/path/manifest-public-key.hex \
RECLAIM_E2E_STAGE2G_V2_SIGNATURE_KEY_ID='<approved-signer-id>' \
RECLAIM_E2E_STAGE2G_V2_MATERIAL_FILE=output/preprod-e2e/stage2g-v2/material.local.json \
pnpm --dir apps/ownership-proof-web e2e:preprod:stage2g:v2:material
```

The generator verifies the external trust anchor, expected signer identity,
manifest signature, and bundle hashes before it reads either wallet role.

```bash
set -a
source .env.local
set +a

unset RECLAIM_E2E_SUBMIT_TRANSACTIONS
RECLAIM_E2E_LIVE_PREPROD=1 \
RECLAIM_E2E_STAGE2G_V2_EVALUATE=1 \
RECLAIM_E2E_STAGE2G_V2_MATERIAL_FILE=output/preprod-e2e/stage2g-v2/material.local.json \
RECLAIM_E2E_STAGE2G_V2_EVIDENCE_FILE=output/preprod-e2e/stage2g-v2/evaluation.local.json \
pnpm --dir apps/ownership-proof-web e2e:preprod:stage2g:v2:evaluate
```

To reproduce the provider-only V1/V2 comparison against the same all-distinct
material and canonical order, keep submission disabled and run:

```bash
unset RECLAIM_E2E_SUBMIT_TRANSACTIONS
RECLAIM_E2E_LIVE_PREPROD=1 \
RECLAIM_E2E_STAGE2G_V2_COMPARE=1 \
RECLAIM_E2E_STAGE2G_V2_MATERIAL_FILE=output/preprod-e2e/stage2g-v2/material.local.json \
pnpm --dir apps/ownership-proof-web e2e:preprod:stage2g:v2:compare
```

The comparison builds complete unsigned direct-script transactions for both
profiles and reports redacted script identities/sizes, transaction-byte counts,
per-redeemer provider units, totals, deltas, and headroom. It cannot sign or
submit and, by itself, is not on-chain acceptance evidence.

The evaluator must report all safety fields false for signing, submission,
funding, minting, stake registration, and deployment. Passing requires total
CPU at or below 90% and memory at or below 80%. The release-facing redacted
record belongs under `contracts/ownership-verifier/bench/results/`; the raw
local material and provider response remain ignored.

Under the original gate contract, this provider result was not Gate G2 and could
not be described as an accepted claim. The originally requested closeout was:

1. Fund seven ReclaimBase UTxOs whose pairwise-distinct payment credentials
   are derived from the same test root private key.
2. Prove through the actual web application with the deployed signed bundle.
3. Build, evaluate, sign with the safe wallet, submit, and confirm the claim.
4. Record the evaluator units, accepted on-chain units, and transaction hash.
5. Stop and investigate before proceeding if measured on-chain units differ
   from the release benchmark by more than 5%.

Duplicate credentials are never a builder admission failure. The default batch
remains six; seven is explicit opt-in and is governed by measured execution
units, irrespective of credential duplication.

## Running The Injected-Wallet Lane

Start a real destination helper separately and set its printed loopback origin
and token through a local environment-loading mechanism that does not put the
token in shell history, process arguments, or tracked files. With those values
already present, run:

```bash
set -a
source .env.local
set +a

RECLAIM_E2E_LIVE_PREPROD=1 \
RECLAIM_E2E_SUBMIT_TRANSACTIONS=1 \
PREPROD_TEST_WALLETS_FILE=deployments/reclaim/preprod/test-wallets.local.json \
RECLAIM_E2E_HELPER_URL=http://127.0.0.1:<port> \
RECLAIM_E2E_NATIVE_ASSET_UNIT=<policy-id-and-token-name-hex> \
pnpm --dir apps/ownership-proof-web test:e2e:preprod
```

The configured stages are deployment verification, ADA funding, native-asset
funding, claim discovery, destination proofs, negative guardrails, and UI claim
acceptance. Set `RECLAIM_E2E_HEADED=1` for visible browser diagnosis. Optional
amount/count, batch, poll, timeout, app URL/port, and output-directory controls
are declared next to the corresponding stage constants; do not duplicate their
defaults in automation wrappers.

## Running The Local Production PR-Push Lane

To test the complete landing-page-to-confirmed-claim journey before updating an
existing PR, commit the intended changes and run from the repository root:

```bash
node scripts/push-pr-with-local-lace-claim-flow.mjs --live-preprod
```

This command requires a clean non-main branch with an open PR. It loads the
ignored root `.env.local` and dedicated Lace `profile.env`, runs a production
`next build`/`next start` server on `127.0.0.1`, and verifies that the
commit's Vercel stable-pointer manifest keeps the proving key and optimized CCS
on the approved remote R2-backed asset hosts. The ignored environment still
supplies provider/review configuration, but cannot replace the committed
deployment manifest. The command then performs the same real browser-WASM/Lace
journey, nineteen screenshots, Preprod submission, and provider confirmation as
the deployed lane. The Next build and server stay in production mode. Only the
separate fixture-funding driver drops production mode from its own process; it
is not injected into the app and Lace remains the transaction-signing wallet.

Before the app tab is created, the driver unlocks and selects the compromised
test wallet so the extension can inject its real CIP-30 provider at document
creation. The journey still selects and connects Lace through the visible UI.
The app also refreshes wallet discovery on the Cardano initialization event,
focus or visibility changes, and a bounded ten-second fallback poll to handle
slightly delayed extension injection.

The wrapper pushes the exact tested commit only after success and refuses to
push if the branch, commit, or worktree changes while proving. It never uses a
force push. The explicit `--live-preprod` flag acknowledges that the run funds
and spends a fresh Preprod fixture. Ordinary `git push` remains unchanged.
Local success is pre-push confidence only; the exact Vercel Preview workflow is
still the required merge check.

## Artifacts And Secret Scan

Runs write under `output/preprod-e2e/<timestamp>-<source-commit>/` (relative to
the web app when invoked with `pnpm --dir`). The run manifest records source,
wallet/proof modes, stage status, and redacted context. Stage artifacts include
deployment checks, reviewed transaction hashes, evaluations, progress, receipt,
and issue-focused screenshots.

Before reporting success, `run.mjs` scans text artifacts for secret-like env
values and wallet mnemonics. Artifacts must not contain helper tokens, wallet
passwords, master XPrvs, witness sets, proof bytes, secret CBOR, or non-test
secrets. A leakage finding fails the run even after browser work succeeds.

## Negative Gates Covered

The deterministic lane exercises wrong-network funding/claim, impacted-wallet
signing, impacted/safe credential overlap, tampered submit review, wrong
destination proof, insufficient safe-wallet ADA, deployment drift, helper/VK
mismatch, and path metadata leakage. Keep these failures before live claim
submission and retain only typed/redacted diagnostics.

## Verification Without Spending

```bash
pnpm --dir apps/ownership-proof-web exec vitest run e2e/preprod
pnpm --dir apps/ownership-proof-web typecheck
pnpm --dir apps/ownership-proof-web test
```

Omitting `RECLAIM_E2E_SUBMIT_TRANSACTIONS=1` is also a useful fail-closed
preflight check, but it is not live-flow completion evidence.

## Optimized V2 Live Cutover Evidence (2026-07-12)

The optimized destination circuit is active on the live Preprod web application
at deployment
`preprod:a4cd2a3208a0788aedd1aeea087f8902c58052dc2fcfa2c228ea34dd:c513fd78ecb14a4119769986675d602dffa741b4`.
The deployment transaction is
`a1fa4102a2db270b33a5c4d9f836f61bbfcd0847575376d5f1306429fef351db`.
The deployed coherence set pins:

- circuit ID `root-ownership-destination-v2/bls12-381/groth16`;
- bundle VK hash
  `b1c03cf24376bcd6c743cb372169ff71f93b210e0d8d52b2c6831808f50ded80`;
- Cardano/on-chain VK hash
  `06ce913c931a53561fe5d022ed45a5fbc033b06d80eebdd9f646d23a05b7d5c4`;
- signed asset prefix `proof-assets/preprod-9fac96b-g3a/`;
- proving key size 1,288,707,133 bytes, 77 chunks, and CCS size
  129,221,468 bytes.

The Stage 2g all-distinct-seven evaluator lane passed with V2 CPU
`8,974,493,908`, memory `1,715,363`, and transaction size 7,966 bytes.
The comparable V1 result was CPU `9,124,265,422`, memory `1,690,788`, and
8,546 bytes. V2 therefore passed the selected 90% CPU ceiling; V1 did not.

A real live-web V2 flow then funded, discovered, proved, built, signed,
submitted, and confirmed ten matching ReclaimBase inputs. Provider-visible
claim transactions were:

- `920023f0120374e21893a4317ce00f378548d7a20b06bbb398bfb8558047c143`:
  six V2 ReclaimBase inputs, eight safe-wallet outputs, seven redeemers;
- `5790e8b2597d7f03aa3cc6fd4d6605c8c5f46fbf97ef994e7ffa12d8a1c06258`:
  four V2 ReclaimBase inputs, six safe-wallet outputs, five redeemers.

After confirmation, the live ReclaimBase inventory was empty, the exact proved
outrefs reported `spent_or_unknown`, and the safe wallet held all five native
tokens again. Its provider-visible aggregate changed from 7 UTxOs and
10,174,916,815 lovelace before the claim to 17 UTxOs and 10,193,027,502
lovelace after it, a net increase of 18,110,687 lovelace.

Only after that on-chain confirmation, Cloudflare R2 deletion removed the old
V1 `ownership.pk` plus `ownership.pk.part0000` through
`ownership.pk.part0123` (125 objects, zero deletion errors). The old CCS was
retained. The V2 prefix was re-listed afterward and still contained the full
1,288,707,133-byte PK, all 77 chunks, and the 129,221,468-byte CCS.

This establishes the requested live optimized-V2 prove/build/submit/on-chain
path and the post-success R2 rotation. On 2026-07-13 the operator reviewed the
remaining distinction and accepted G2 by exception using the passing
all-distinct-seven Stage 2g evaluation plus the confirmed six-input and
four-input live V2 claims. The exact accepted all-distinct-seven transaction was
not run and is explicitly waived, not represented as existing evidence. The
paired G2/G3 disposition is recorded in
contracts/ownership-verifier/bench/results/g2-g3-operator-acceptance-2026-07-13.md.
