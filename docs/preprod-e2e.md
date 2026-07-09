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

The deployer refuses a dirty/unpushed source tree and never creates proof keys.
It exports parameterized Plutus V3 scripts through the contract executable,
mints the one-shot parameter NFT, registers the ReclaimGlobal reward account
when needed, creates the immutable parameter and base/global reference-script
outputs, confirms them through the provider, and writes the ignored enabled
manifest.

```bash
set -a
source .env.local
set +a

RECLAIM_E2E_LIVE_PREPROD=1 \
RECLAIM_E2E_SUBMIT_TRANSACTIONS=1 \
PREPROD_TEST_WALLETS_FILE=deployments/reclaim/preprod/test-wallets.local.json \
RECLAIM_E2E_DESTINATION_KEYS_DIR=output/preprod-e2e/destination-keys.local \
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
