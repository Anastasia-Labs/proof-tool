# Contributing

Read `AGENTS.md` first — it defines the trust boundary this repo protects
(secrets stay local, the proof claim stays narrow, artifact sets stay
coherent). This file only covers the mechanics.

## One-time setup

```bash
pnpm install                 # repo root: installs Biome + lefthook, registers git hooks
bash scripts/bootstrap-vendor.sh   # required: vendors gnark with the local ProveStream patch
```

Never run plain `go mod vendor`; it drops the hand-applied patch. Use the
bootstrap script, and `scripts/check-vendor-drift.sh` to verify.

Optional but recommended (CI enforces it either way):

```bash
go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `pnpm lint` / `pnpm lint:fix` | Biome lint + format check (fix) for all TS/JS packages |
| `golangci-lint run ./...` | Go linting (gofmt, staticcheck, errcheck, …) |
| `pnpm test:all` | Full aggregate gate — see below |
| `pnpm test:fast` | Same, minus the slow circuit/full-proof/contract suites |

Git hooks (via lefthook) format and vet staged files on commit and run the
repo-wide linters on push.

## The aggregate test gate

`pnpm test:all` (= `scripts/test-all.sh`) is the "can we ship this?" command.
A full green run covers:

- Go engine: build, vet, lint, every package test, **including the real
  Groth16 ownership/multi/destination round-trips with tamper cases**
  (`PROOF_TOOL_RUN_FULL_PROOF=1`).
- WASM prover + MSM worker builds (`GOOS=js GOARCH=wasm`).
- `packages/client-ts`: build + tests (CIP-3 golden vectors, worker protocol).
- Web app: typecheck, all vitest suites (components, claim/reclaim libs,
  claim API route contracts, real-CBOR claim tx building, e2e-harness units),
  plus `verify:proof-release` — the signed proof-asset coherence check.
- Desktop app: typecheck + tests; the three Rust crates when `cargo` exists.
- Plutus validators: `cabal test ownership-verifier-test` — the full suite
  running the compiled validators with real proof fixtures and negative
  paths — when `cabal` exists.

The authoritative section list lives in the header of `scripts/test-all.sh`;
if this summary and the script disagree, the script wins.

Sections whose tools are missing are reported as SKIP, not silently dropped.
CI (`.github/workflows/ci.yml`) runs every section on each PR.

What test-all does **not** cover (needs credentials/hardware): the live
preprod claim journey (`pnpm --dir apps/ownership-proof-web test:e2e:preprod`)
and real browser-WASM proving in an actual browser.

## Pull requests

CI must be green. The PR template checklist mirrors the AGENTS.md risk model —
take it seriously, especially the artifact-coherence and no-secrets items.
