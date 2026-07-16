# Proof Helper Desktop

## Architecture

`apps/proof-helper-desktop` is a Tauri v2 React application that installs and
verifies the destination proving-key bundle, supervises the Go `proof-tool`
sidecar, and opens the web claim flow with fragment-only pairing data.

The boundaries are deliberate:

- React (`src/App.tsx`) owns product state and presentation.
- `src/desktopApi.ts` is the typed Tauri IPC boundary.
- Rust (`src-tauri/src`) owns filesystem paths, release download/activation,
  sidecar processes, runtime diagnostics, and safe external URL opening.
- `key-bundle-core` is a pure Rust signed-bundle validator/atomic installer.
- `sidecar-core` is a pure Rust argument and startup-JSON validator.
- The Go helper in `internal/helper` performs derivation/path search/proving and
  serves only loopback HTTP.

The destination endpoint accepts an opt-in NDJSON response for aggregate key
discovery, key-open, and per-proof progress. The web client requests it when
available and falls back to the ordinary JSON response used by already
published helper versions. Aborting the fetch closes the loopback request and
cancels the helper's Go context; decoded master-key bytes are cleared when the
handler returns.

The default UI is the non-technical product shell. Diagnostics are available
without exposing raw helper secrets. Developer-only source paths, fixture mode,
sidecar overrides, and local key controls require
`VITE_PROOF_HELPER_DEV_CONTROLS=1`.

## Sidecar Lifecycle

Tauri resolves the bundled target-triple sidecar (or an explicit development
path), starts `proof-tool serve-helper` with loopback binding and `--no-open`,
and reads the `proof_tool_helper_ready` JSON line. `sidecar-core` rejects a
non-loopback helper URL, query-based pairing, helper/origin mismatch, or missing
fragment values before the browser is opened.

The pairing URL carries `helper` and `pair` only in the fragment. The browser
clears the fragment after reading it. Tauri stops the child on explicit stop
and application exit.

Relevant IPC commands are:

- `start_helper`, `stop_helper`, `helper_process_status`;
- `key_status`, `install_proof_assets_release`, `activate_key_bundle`,
  `cancel_key_bundle_activation`, `delete_key_cache`;
- `runtime_diagnostics`, `open_url`.

Progress events are `proof-asset-install-progress` for the published archive
and `key-bundle-progress` for developer source-directory activation.

## Proof-Asset Installation

The production installer descriptor in `proof_assets_release.rs` pins release
tag, HTTPS archive URL, archive size, SHA-256 and BLAKE2b-256, bundle prefix,
key version, circuit ID, VK hash, manifest signer, manifest public key, Cardano
VK hash, and minimum free space.

Installation is fail-closed:

1. check descriptor, HTTPS URL, and disk space;
2. download into a restart-safe temporary directory while hashing;
3. safely extract only required files (no traversal/symlink escape);
4. verify archive size and both hashes;
5. verify the signed key manifest and every pinned bundle file;
6. write release metadata;
7. atomically activate the verified directory.

Cancellation or any error removes staging and preserves the previously active
bundle. Deleting the cache returns the app to the missing-key state.

## Local Development

Install frontend dependencies and validate Linux native prerequisites:

```bash
pnpm --dir apps/proof-helper-desktop install --frozen-lockfile
pnpm --dir apps/proof-helper-desktop check:tauri-prereqs
```

Build a development sidecar using the target triple expected by Tauri:

```bash
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' \
  -o apps/proof-helper-desktop/src-tauri/binaries/proof-tool-x86_64-unknown-linux-gnu \
  ./cmd/proof-tool
```

Run the frontend or full app:

```bash
pnpm --dir apps/proof-helper-desktop dev
pnpm --dir apps/proof-helper-desktop tauri dev
```

For an explicit sidecar during tests or development, use
`PROOF_HELPER_SIDECAR_PATH`. Do not use fixture mode or key creation as release
evidence.

## Verification

```bash
pnpm --dir apps/proof-helper-desktop test
pnpm --dir apps/proof-helper-desktop typecheck
pnpm --dir apps/proof-helper-desktop build

cargo test --manifest-path apps/proof-helper-desktop/src-tauri/key-bundle-core/Cargo.toml
cargo test --manifest-path apps/proof-helper-desktop/src-tauri/sidecar-core/Cargo.toml
cargo check --manifest-path apps/proof-helper-desktop/src-tauri/Cargo.toml
```

The Tauri IPC smoke starts and stops a real sidecar when
`PROOF_HELPER_SIDECAR_PATH` is set:

```bash
PROOF_HELPER_SIDECAR_PATH="$PWD/apps/proof-helper-desktop/src-tauri/binaries/proof-tool-x86_64-unknown-linux-gnu" \
  cargo test --manifest-path apps/proof-helper-desktop/src-tauri/Cargo.toml
```

The credential-discovery integration check uses the installed signed V2
bundle, automatic account/role/index search, and an account-3 role-2 fixture.
It produced and verified real destination proofs in 20.154 seconds cold and
4.378 seconds with the bundle/CCS cache warm. Run it explicitly because the
bundle is too large for ordinary CI:

```bash
PROOF_TOOL_BUNDLE_DIR=/path/to/installed/ownership-destination-v2 \
  go test ./internal/helper \
  -run '^TestGenerateDestinationProofsAgainstInstalledBundle$' -count=1 -v
```

## Release Boundary

The workflow `.github/workflows/release-proof-helper.yml` builds draft release
artifacts and is safe-by-default as draft/prerelease. Packaging success is not
publication approval. Authenticode signing, packaged Windows validation,
updater/signing metadata, public proof-assets availability, and release notes
remain governed by `proof-helper-windows-release-plan.md` and
`proof-helper-windows-release-runbook.md`.

Review `proof-helper-desktop-security-review.md` before changing CSP, URL
opening, helper origins/tokens, key download, updater behavior, or telemetry.
