# Non-Technical Ownership Proof Runbook

## Test Commands

From `/home/gumbo/playground/proof-zk-recovery/proof-tool`:

```bash
go test ./...
```

```bash
cd packages/client-ts
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

```bash
cd apps/ownership-proof-web
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Fixture UI Flow

Fixture mode is only for browser control-flow testing. It does not prove a real
credential.

Terminal 1:

```bash
go run ./cmd/proof-tool serve-verifier \
  --fixture \
  --addr 127.0.0.1:18081 \
  --allowed-origin http://localhost:3002,http://127.0.0.1:3002
```

Terminal 2:

```bash
cd apps/ownership-proof-web
PROOF_VERIFIER_DEV_URL=http://127.0.0.1:18081 pnpm dev --hostname 127.0.0.1 --port 3002
```

Terminal 3:

```bash
go run ./cmd/proof-tool serve-helper \
  --fixture \
  --addr 127.0.0.1:0 \
  --site-url http://127.0.0.1:3002
```

The helper opens the website with a one-time pairing fragment. If the browser
does not open automatically, copy the `opening_site:` URL from the helper output
into the browser. Users should not type a pairing token.

The website posts proof artifacts to its own `/api/verify` route. In local
Next-only development, `PROOF_VERIFIER_DEV_URL` is a developer-only rewrite to
the local Go verifier. The production Vercel configuration does not deploy this
legacy verifier or expose `/api/verify`. Use the three fixture commands above
for this fixture-only flow.

## Real Prover/Verifier Smoke

The CLI `prove --master-xprv` path is for the existing development interface and
test vectors only. The production-shaped helper path sends the master XPrv in
the local request body instead of on the helper process command line.

Start the pinned Go verifier and the local credential-proof webapp together:

```bash
scripts/dev-credential-proof.sh
```

Build the binary:

```bash
go build -o output/proof-tool ./cmd/proof-tool
```

Use the published ceremony bundle as the key directory. Replace
`output/ceremony/ownership-v1-YYYYMMDD` below with the signed bundle produced by
`proof-tool setup-ceremony`; do not point these commands at an empty directory.

Generate the golden-vector proof:

```bash
mkdir -p output/real-proof
./output/proof-tool prove \
  --keys-dir output/ceremony/ownership-v1-YYYYMMDD \
  --master-xprv c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620 \
  --target-credential 19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4 \
  --account 0 \
  --role 0 \
  --index 0 \
  --out output/real-proof/ownership-proof.json
```

Verify the generated proof:

```bash
./output/proof-tool verify \
  --keys-dir output/ceremony/ownership-v1-YYYYMMDD \
  output/real-proof/ownership-proof.json
```

Export Cardano smart-contract verifier inputs:

```bash
./output/proof-tool export-cardano \
  --keys-dir output/ceremony/ownership-v1-YYYYMMDD \
  --out-dir output/cardano-proof \
  output/real-proof/ownership-proof.json
```

This writes `proof.hex` as the 336-byte committed Groth16 redeemer bytes,
`vk.hex` as the 672-byte committed verifier key bytes, and `pub.hex` as the
32-byte ownership public-input digest fixture. Contract code should normally
recompute that digest from the payment key hash instead of trusting `pub.hex`;
see `contracts/ownership-verifier/src/Ownership/Verify.hs`.

Run the real verifier API:

```bash
./output/proof-tool serve-verifier \
  --addr 127.0.0.1:18082 \
  --keys-dir output/ceremony/ownership-v1-YYYYMMDD \
  --allowed-origin http://localhost:3002,http://127.0.0.1:3002
```

Run the real helper API:

```bash
./output/proof-tool serve-helper \
  --addr 127.0.0.1:0 \
  --keys-dir output/ceremony/ownership-v1-YYYYMMDD \
  --site-url http://127.0.0.1:3002
```

The helper returns a backend-bound artifact without `path` by default. Use
`include_debug_path: true` only for an explicit local debug export.

## Vercel Deployment Shape

Create a standard Next.js Vercel project with Root Directory
`apps/ownership-proof-web`. The app-local `vercel.json` pins the framework and
build commands. Keep Vercel's **Include source files outside of the Root
Directory** setting enabled so the `file:../../packages/client-ts` dependency is
available during installation.

- Pages, `/claim-api/*`, and `/reclaim-api/*` deploy together as one Next.js
  project; Route Handlers become Vercel Functions automatically.
- `/dev/credential-proof` and `/api/verify` both return 404 in Vercel Preview
  and Production deployments.
- `scripts/dev-credential-proof.sh` starts the Go verifier and Next.js with the
  developer-only `/api/*` rewrite for local development.

The local Go verifier pins the verifying key with hash
`blake2b256:e896ad2b9bceac9abe80de7a4ec91a9e41a55582b9b58fe3797bc203662b7c03`.
Local helper builds must prove with the matching published proving-key
bundle. Do not let production helpers silently create a fresh local Groth16 key
bundle, because those proofs will not match the pinned local verifier.
