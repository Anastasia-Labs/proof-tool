# Reclaim Funding Page Documentation

## What This Page Is

The reclaim funding page is the rescuer side of the recovery flow. It lets
someone who has already swept funds away from a compromised Cardano credential
lock those funds at the project's `ReclaimBase` script address with an inline
datum identifying the compromised payment key credential.

The intended route is:

```text
/reclaim
```

The page is deliberately separate from the ownership proof page. A rescuer does
not need the original owner's recovery phrase. The original owner later proves,
with the proof tool, that their master private key derives to the compromised
payment key credential recorded in the datum.

## Roles

### Rescuer

The rescuer controls the wallet currently holding the swept funds. The rescuer
uses `/reclaim` to deposit those funds into the reclaim script. The rescuer must
know the compromised payment key credential that should be allowed to reclaim
the funds later.

### Original Owner

The original owner controls the master private key or recovery phrase that
derives to the compromised payment key credential. The owner does not use this
funding page to prove ownership. They later use the ownership proof flow and the
reclaim transaction flow to spend the script output.

### Deployment Operator

The operator publishes the reclaim deployment manifest. The manifest identifies
the network, reclaim base address, reclaim base script hash, global reclaim
credential, parameter NFT, contract version, and verifier key hash.

## What The Page Does

The page helps the rescuer build and submit a Cardano transaction with a script
output like:

```text
address = deployed ReclaimBase address
value   = selected rescued ADA and native tokens
datum   = ReclaimBaseDatum(compromised payment key hash)
```

The inline datum is the critical part. It tells the reclaim contracts which
payment key credential the future proof must match.

Transaction construction is backend-owned and uses Lucid Evolution. The browser
connects to the rescuer's wallet, reads the CIP-30 change address and used
payment addresses, sends those public addresses plus the selected token bundle
to the backend, asks the backend to build completed unsigned transaction CBOR,
then asks the wallet to sign it. Private keys and seed phrases never go to the
backend.

The current implementation lives at `apps/ownership-proof-web/app/reclaim` and
uses these web-owned API routes:

- `GET /reclaim-api/deployment`
- `POST /reclaim-api/wallet-assets`
- `POST /reclaim-api/build`
- `POST /reclaim-api/submit`

## What The Page Does Not Do

The page does not:

- ask for a recovery phrase;
- ask for a master private key;
- generate a zero-knowledge proof;
- verify the original owner's proof;
- reclaim funds back to the owner;
- prove that the rescuer was the original owner;
- let users choose an arbitrary script address.

## How It Works

1. The page loads the reclaim deployment manifest.
2. The rescuer connects a CIP-30 Cardano wallet.
3. The page checks that the wallet network matches the deployment network.
4. The rescuer enters the compromised payment key credential.
5. The page validates that the credential is exactly 28 bytes, displayed as 56
   hex characters.
6. The rescuer chooses ADA and native tokens, or UTxOs containing those assets,
   to lock.
7. The page sends the CIP-30 change address, CIP-30 used payment addresses,
   selected token bundle, network id, and compromised credential to the backend
   builder.
8. The backend validates those public addresses, queries UTxOs across the
   supplied address set, deduplicates the resulting inputs, initializes Lucid
   Evolution, selects the address-only wallet with
   `lucid.selectWallet.fromAddress(changeAddress, utxos)`, and completes an
   unsigned transaction that sends the selected value to the deployed
   `ReclaimBase` address with an inline `ReclaimBaseDatum`.
9. The page shows the transaction review and asks the wallet to sign.
10. The page sends the unsigned transaction CBOR and wallet witness set to
    `/reclaim-api/submit`, where the backend assembles and submits the signed
    transaction through the configured provider. The submit route can also
    accept fully signed transaction CBOR.
11. The page shows the transaction hash, protected value, and datum credential
    used.

## Datum Meaning

The reclaim datum is:

```haskell
data ReclaimBaseDatum = ReclaimBaseDatum
  { reclaimPaymentKeyHash :: BuiltinByteString
  }
```

`reclaimPaymentKeyHash` must be the raw 28-byte Cardano payment key hash for
the compromised credential.

It is not:

- a full Cardano address;
- a bech32 string;
- a stake key hash;
- a script hash;
- a wallet id;
- a recovery phrase hash.

If the datum is wrong, the funds may be locked for the wrong claimant. The page
must show the normalized credential before the rescuer signs.

## Why The Original Owner Can Reclaim

The `ReclaimBase` script only allows its UTxOs to be spent in a transaction that
also invokes the configured `ReclaimGlobal` rewarding script. `ReclaimGlobal`
then checks proofs for the matching `ReclaimBase` inputs.

For each matching input, the global reclaim script:

- reads the `ReclaimBaseDatum`;
- checks that the datum payment key hash is 28 bytes;
- verifies a destination-bound ownership proof for that payment key hash;
- checks that the protected input value is paid to the proof-bound destination
  output.

This means the rescuer can lock funds for a compromised credential without
knowing the owner's recovery phrase, and the owner can later reclaim only by
proving derivation to that credential and binding the reclaim to the destination
address used in the spend.

## Wallet Requirements

The page needs a browser wallet that supports CIP-30. The wallet must provide:

- connection approval;
- network id;
- `getChangeAddress()` for Lucid change;
- `getUsedAddresses()` for candidate funded payment addresses;
- transaction signing;
- transaction submission, or signed transaction handoff to the backend submit
  provider.

The backend builder receives only public transaction intent such as wallet
change address, wallet payment addresses, selected ADA/native-token quantities,
network id, and the compromised credential. It queries UTxOs for those addresses
through its configured provider and uses Lucid Evolution's address-only wallet
selection to balance and complete the unsigned transaction. It must not receive
seed phrases, private keys, wallet passwords, or signed witnesses before the
user approves signing in their wallet.

When no wallet is injected, the page should keep the connect action available
and explain which `window.cardano` providers were detected.

The current browser-wallet address handling is CIP-30-only. The page reads both
`getChangeAddress()` and `getUsedAddresses()`, accepts the standard CIP-30 hex
address payload or a bech32 address, converts each locally to `addr`/`addr_test`,
and sends `changeAddress` plus `walletAddresses[]` to the backend. The page does
not call `getUnusedAddresses()`, because unused addresses are not evidence of
spendable funds. The UI does not expose a wallet-address input field; the
rescuer does not manually type the funding or change address.

## Deployment Configuration

The page is disabled unless the backend has a pinned reclaim deployment. Configure
these environment variables:

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

Provider configuration:

- `RECLAIM_PROVIDER=koios` uses public Koios URLs by network unless
  `RECLAIM_KOIOS_URL` is set. `RECLAIM_KOIOS_TOKEN` is optional.
- `RECLAIM_PROVIDER=blockfrost` uses network-specific Blockfrost URLs unless
  `RECLAIM_BLOCKFROST_URL` is set. `RECLAIM_BLOCKFROST_PROJECT_ID` is required.

## Network Requirements

The wallet network must match the reclaim deployment manifest. A mainnet wallet
must not submit to a preprod reclaim script, and a preprod wallet must not
submit to a mainnet reclaim script.

The page should show:

- deployment network;
- wallet network;
- reclaim base address;
- reclaim base script hash;
- verifier key hash;
- contract version.

## Transaction Review

Before signing, the rescuer should see:

- the destination script address;
- the compromised credential that will be written into the datum;
- the ADA and native tokens being locked;
- the estimated fee;
- the network;
- any native assets included;
- the wallet change address and queried funding-address count;
- the deployment id or contract version.

The transaction should be rebuilt whenever the credential, selected value,
wallet state, or deployment manifest changes.

The current review shows destination, credential datum, datum CBOR, unsigned
transaction hash, and the selected multi-asset bundle. A production hardening
pass should add explicit estimated-fee display and a signed-transaction inspect
gate before enabling mainnet deposits.

## Safety Model

The page protects against accidental deposits to the wrong script or wrong
datum by pinning deployment data, validating credential shape, checking network
ids, and showing a final review before signing.

The page does not protect against:

- a rescuer entering the wrong compromised credential;
- a malicious or compromised browser wallet;
- a malicious hosted frontend deployment;
- provider outages or stale chain data;
- future owner inability to prove the recorded credential.

The page must not claim that the deposit is recoverable unless the datum
credential is correct and the reclaim contracts are deployed as shown.

## Operational Checklist

Before enabling deposits:

- Publish a valid reclaim deployment manifest.
- Verify the `ReclaimBase` address from the manifest matches the deployed
  script parameters.
- Verify the `ReclaimGlobal` verifier key hash matches the published proof
  helper/verifier key bundle.
- Run a preprod deposit from the page.
- Confirm the output has inline `ReclaimBaseDatum` with the expected payment key
  hash.
- Run a preprod reclaim spend through `ReclaimGlobal`.
- Save tx hashes and manifest version in release notes.

## Troubleshooting

### No Wallet Found

Install or enable a CIP-30 Cardano wallet in the browser. The page should list
which wallet providers it can see.

### Wrong Network

Switch the wallet to the network shown in the deployment manifest. Do not bypass
this check.

### Invalid Credential

Use the 56-hex payment key credential. Do not paste a full address unless the
page explicitly supports local address-to-credential extraction and shows the
extracted credential.

### Transaction Will Not Build

Check that the wallet has enough ADA for the script output min-ADA requirement
and the transaction fee. If native assets are selected, the required min-ADA may
be higher. Also check that the selected token quantities still exist in the
address UTxOs queried by the backend builder.

### Transaction Submitted But Owner Cannot Reclaim

Check the on-chain datum first. If the datum credential does not match a payment
key credential derivable from the owner's master private key, the proof will not
authorize reclaim for that owner.

### Wallet Address Does Not Load

Reconnect the wallet and confirm that the wallet exposes a CIP-30 change or
used payment address. The page refuses to build a transaction without a usable
CIP-30-provided payment address.
