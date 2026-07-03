# Proof Helper Desktop Security Review

This review covers the first Tauri-based Proof Helper implementation surface in
this repository. It is a local implementation handoff, not a sign-off for a
public release.

## Scope

- Hosted ownership-proof website.
- Pairing fragment from Proof Helper to website.
- Tauri desktop shell under `apps/proof-helper-desktop`.
- Go `proof-tool serve-helper` sidecar.
- Local proving-key cache.
- Hosted verifier API and backend-bound proof artifact.
- Draft release automation in `.github/workflows/release-proof-helper.yml`.

## Implemented Controls

- `serve-helper` still binds only to loopback and rejects non-loopback listen
  addresses.
- Helper proof and shutdown requests still require exact allowed origins and
  `X-Proof-Tool-Token`.
- Token comparison remains constant-time.
- Helper CORS now answers Chrome Private Network Access preflights for allowed
  origins with `Access-Control-Allow-Private-Network: true`.
- Production helper proving now loads an existing key bundle with
  `LoadOwnershipProver`; it does not silently create Groth16 keys unless
  `--dev-create-keys` is explicitly set.
- Key manifests now carry key version, file digest, file size, tool version,
  gnark version, and signature-key metadata fields.
- Key verification streams file digests instead of reading large proving keys
  into memory.
- `/status` now reports sidecar version, protocol version, circuit id, key
  version, key hash, key readiness, compatibility, and supported origins.
- Sidecar startup emits one machine-readable JSON line on stdout for Tauri.
- Backend-bound proof artifacts still strip derivation path metadata by default.
- The website now treats helper compatibility states as distinct: offline,
  ready, key missing, key downloading, and update required.
- The Tauri shell computes app-data key-cache paths, can delete the active and
  temporary cache directories, and starts the sidecar with `--no-open` so the
  app controls when the pairing URL is opened.

## Secret-Handling Review

- The hosted verifier receives only proof artifacts and public target fields.
- The website still derives the master XPrv in the browser worker and sends it
  only to the paired loopback helper.
- The helper accepts master XPrv in the local request body, not on the process
  command line.
- New status, startup, and release-note fields do not include seed phrases,
  entropy, master XPrv, private witness values, or derivation paths.
- The startup JSON includes the per-session pairing token because the desktop
  app needs it to open the fragment URL. Treat stdout from production sidecar
  supervision as local-sensitive process output.

## Compatibility Notes

- Chrome Private Network Access preflight behavior is covered by Go unit tests
  for allowed origins.
- Browser-specific loopback behavior across Chrome, Edge, Firefox, and Safari
  still needs manual target-browser testing.
- Linux Tauri native checks are blocked in this WSL environment by missing
  `dbus-1` development files. `cargo tree -i libdbus-sys` shows the dependency
  chain `tao -> tauri-runtime-wry -> tauri`.
- The current user cannot install the missing package here because passwordless
  `sudo` is unavailable.

## Release Gates

Do not publish a ready release until these are complete:

- Apple Developer ID signing and notarization are configured and verified.
- Windows Authenticode signing is configured and verified.
- Tauri updater signing keys and updater metadata are configured and verified.
- The proving-key bundle is generated in controlled release infrastructure.
- `manifest.json`, `manifest.sig`, checksums, and checksum signatures are
  published together.
- Fresh install, corrupt download, wrong signature, wrong digest, delete-cache,
  update, and rollback behavior are tested on target OSes.
- Website release links point to actual installer assets or stable redirects.

## Accepted For Local MVP

- The first desktop shell keeps seed phrase entry in the hosted website. This
  keeps the current local-helper architecture intact but still trusts the
  JavaScript served for that session.
- The desktop shell supports an explicit dev sidecar path and fixture mode for
  local validation. Production packaging should use bundled sidecars.
- Linux `.rpm`, Windows ARM64, production auto-update enablement, and moving
  seed entry into Tauri remain follow-up decisions.

## Local Evidence

- `go test ./...` passed after helper hardening.
- `pnpm test && pnpm typecheck && pnpm build` passed in
  `apps/ownership-proof-web`.
- `pnpm test && pnpm typecheck && pnpm build` passed in
  `apps/proof-helper-desktop`.
- `cargo fmt` passed in `apps/proof-helper-desktop/src-tauri`.
- `cargo check` is not yet verified because the local Linux Tauri prerequisites
  are incomplete.
