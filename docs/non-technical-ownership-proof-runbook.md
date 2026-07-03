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
the local Go verifier. On Vercel, `/api/*` is routed directly to the Go verifier
service from the root `vercel.json`; users never see or type a verifier URL.

## Real Prover/Verifier Smoke

The CLI `prove --master-xprv` path is for the existing development interface and
test vectors only. The production-shaped helper path sends the master XPrv in
the local request body instead of on the helper process command line.

Build the binary:

```bash
go build -o output/proof-tool ./cmd/proof-tool
```

Generate the golden-vector proof:

```bash
mkdir -p output/real-proof output/real-keys
./output/proof-tool prove \
  --keys-dir output/real-keys \
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
  --keys-dir output/real-keys \
  output/real-proof/ownership-proof.json
```

Export Cardano smart-contract verifier inputs:

```bash
./output/proof-tool export-cardano \
  --keys-dir output/real-keys \
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
  --keys-dir output/real-keys \
  --allowed-origin http://localhost:3002,http://127.0.0.1:3002
```

Run the real helper API:

```bash
./output/proof-tool serve-helper \
  --addr 127.0.0.1:0 \
  --keys-dir output/real-keys \
  --site-url http://127.0.0.1:3002
```

The helper returns a backend-bound artifact without `path` by default. Use
`include_debug_path: true` only for an explicit local debug export.

## Vercel Deployment Shape

Deploy from `/home/gumbo/playground/proof-zk-recovery/proof-tool` so Vercel
uses the root `vercel.json`.

- `web` is the Next.js service rooted at `apps/ownership-proof-web`.
- `verifier` is the Go service rooted at this repo and built from
  `cmd/api/main.go`.
- Public `/api/:path*` requests route to the Go verifier service.
- All other public requests route to the Next.js web service.

The Go verifier pins the verifying key with hash
`blake2b256:0bd2f0fd3e3f1f3a671ca9f5fa92be04771a19f5dab5d09bfdcfae8ca6ce9731`.
Production helper builds must prove with the matching published proving-key
bundle. Do not let production helpers silently create a fresh local Groth16 key
bundle, because those proofs will not match the hosted verifier.
