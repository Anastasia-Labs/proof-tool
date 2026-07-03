# Proof Helper Desktop Tauri Plan

## Verdict

The proposed direction makes sense. Use Tauri v2 as the non-technical user's
installer, updater, and lifecycle wrapper, and keep the existing Go proof-tool
binary as the native sidecar that performs local proving.

This is a better product path than raw GoReleaser packages alone because the
helper needs visible status, pairing, key download progress, cleanup controls,
signed updates, and a friendly install/open flow. GoReleaser can still be useful
for producing standalone CLI artifacts, but it should not be the primary user
experience for Proof Helper.

The important refinement is to treat the Tauri app, the Go sidecar, the hosted
website, the verifier, and the proving-key bundle as separate trust and release
surfaces. Tauri updater signatures protect app updates. They do not, by
themselves, authenticate the downloaded 2 GB proving key. The proving-key bundle
needs its own signed manifest, checksums, versioning, and fail-closed validation.

## Goals

- Keep Vercel as the public website and verifier entrypoint host.
- Keep proving on the user's machine.
- Install a small native Proof Helper app for macOS, Windows, and Linux.
- Bundle the Go helper/prover sidecar for the user's OS and architecture.
- Do not store seed phrases.
- Do not upload seed phrases, entropy, or master XPrv values to Vercel or any
  hosted backend.
- Do not include the large proving key in the Vercel deployment.
- Download, verify, and cache the proving key in the user's app data directory.
- Pair the helper with the website automatically through a loopback URL and
  random per-session token.
- Let the user delete the proving-key cache after proving.

## Current Repo Baseline

The repo already has most of the protocol surface that the desktop app should
wrap:

- `cmd/proof-tool/main.go` exposes `serve-helper`.
- `serve-helper` binds only to loopback, creates a random token, opens the site
  with `#helper=http://127.0.0.1:PORT&pair=TOKEN`, and serves `/status`,
  `/prove`, and `/shutdown`.
- `internal/helper/server.go` enforces allowed origins and
  `X-Proof-Tool-Token`.
- `internal/helper/helper.go` accepts the master XPrv in the request body, not
  on the process command line.
- `artifact.BackendProofArtifact` strips derivation path metadata from the
  backend-bound artifact.
- `apps/ownership-proof-web` already handles the pairing fragment and talks to
  the helper.
- `docs/non-technical-ownership-proof-runbook.md` documents the current local
  helper/verifier/website flow.

The Tauri work should build on that shape instead of replacing it.

## Product Flow

1. User opens the Vercel-hosted website.
2. Website does not find a paired helper and shows `Install Proof Helper`.
3. User downloads the installer for their OS.
4. Installer installs Proof Helper:
   - Tauri app binary.
   - Go `proof-tool` sidecar for the current OS/architecture.
   - Icons, app metadata, updater configuration, and minimal UI assets.
5. User opens Proof Helper.
6. Proof Helper checks for the proving-key bundle in the app data directory.
7. On first run, Proof Helper downloads the key bundle, verifies the signed
   manifest, verifies checksums, verifies the expected `circuit_id` and
   `vk_hash`, then stores the bundle atomically.
8. User clicks `Connect to website`.
9. Proof Helper starts the Go sidecar on `127.0.0.1:<random-port>`.
10. Proof Helper opens:

```text
https://your-site.vercel.app/#helper=http://127.0.0.1:PORT&pair=TOKEN
```

11. Website reads the fragment, clears it from browser history, and sends the
    token in `X-Proof-Tool-Token` for local helper requests.
12. Website derives the master XPrv locally and sends it only to the local
    helper.
13. Helper returns a backend-bound proof artifact without derivation path
    metadata.
14. Website submits only public proof material to the hosted verifier.
15. Website calls helper `/shutdown` after proving or when the user chooses to
    stop the helper.
16. Proof Helper offers `Remove proving key cache` as an explicit cleanup
    action. Normal OS uninstall removes the app, but app-data cleanup should not
    be assumed across all installer types.

## Architecture

```text
Vercel website
  |
  | install link / pairing fragment / public proof verification
  v
Proof Helper Tauri app
  |
  | starts, monitors, and stops
  v
Go proof-tool sidecar
  |
  | reads verified key bundle from app data
  v
Local proving key cache
```

The hosted verifier remains separate:

```text
Website -> /api/verify -> Go verifier with pinned verifying key
```

## Tauri App Responsibilities

- Show key bundle status: missing, downloading, verifying, ready, failed,
  update required.
- Download large artifacts with progress and cancellation.
- Verify the downloaded manifest, checksums, signature, circuit id, key version,
  and expected verifying-key hash.
- Store the key bundle under Tauri's app data directory, which resolves from the
  configured bundle identifier.
- Spawn and stop the Go sidecar.
- Open the official website with the helper URL and pairing token in the URL
  fragment, not the query string.
- Surface helper version, sidecar version, circuit id, key version, and verifier
  compatibility.
- Provide a cleanup button that deletes the proving-key cache.
- Offer app updates through Tauri's updater once signing is configured.

The first Tauri version can keep the seed phrase in the hosted website flow.
If the threat model later needs less trust in hosted JavaScript, a follow-up
version should move the seed phrase screen into the signed Tauri app.

## Go Sidecar Responsibilities

Use the existing `proof-tool serve-helper` mode, with these production
hardening changes:

- Add a production key-loading mode that refuses to create a new Groth16 key
  bundle if the expected bundle is missing or invalid.
- Add machine-readable startup output, such as JSON on stdout, so Tauri does not
  parse human stderr to discover the selected port.
- Add richer `/status` output:
  - sidecar version
  - protocol version
  - circuit id
  - key version
  - key hash
  - key readiness
  - supported website origins
- Add support for Chrome Private Network Access preflights by returning
  `Access-Control-Allow-Private-Network: true` when the request includes
  `Access-Control-Request-Private-Network`.
- Keep binding restricted to `127.0.0.1` or a verified loopback address.
- Keep exact-origin allowlisting.
- Keep token comparison constant-time.
- Never log request bodies, seed phrases, entropy, master XPrv, or proof
  witness data.
- Keep `/shutdown` token-protected and origin-protected.

## Proving-Key Bundle

Do not put the 2 GB proving key in Vercel.

Recommended artifact layout:

```text
ownership-v1/
  manifest.json
  manifest.sig
  ownership.pk
  ownership.vk
  checksums.txt
  checksums.txt.sig
```

Recommended `manifest.json` fields:

- `schema`
- `key_version`
- `circuit_id`
- `curve`
- `backend`
- `vk_hash`
- `proving_key_sha256`
- `proving_key_blake2b256`
- `proving_key_size`
- `verifying_key_sha256`
- `constraint_system_hash`
- `circuit_source_commit`
- `proof_tool_version`
- `gnark_version`
- `setup_transcript_hash`
- `published_at`
- `artifact_urls`
- `signature_key_id`

The helper should verify the manifest signature before trusting any hash inside
it, then verify downloaded file sizes and digests before moving files into the
active cache directory.

Use atomic install semantics:

```text
app-data/
  keys/
    ownership-v1/
      active/
      downloading.tmp/
```

Download into a temporary directory, verify everything, then atomically rename
or swap into `active/`.

GitHub Releases are acceptable for the first release because they pair well with
Tauri release automation. R2, S3, or GCS are also fine if download bandwidth,
regional control, or staged rollout matters more.

## App Data Locations

Use Tauri's `appDataDir()` or the Rust-side equivalent rather than hardcoding
paths. Configure a stable bundle identifier, for example:

```text
app.proofzkrecovery.proof-helper
```

Expected user-facing locations are roughly:

- macOS: `~/Library/Application Support/<bundle-identifier>/...`
- Windows: `%APPDATA%\<bundle-identifier>\...`
- Linux: `~/.local/share/<bundle-identifier>/...`

The product copy can call this "Proof Helper app data", but code should use the
Tauri path API so sandboxing, bundle identifiers, and platform differences stay
centralized.

## Website Integration

Add or refine website behavior:

- If no pairing fragment is present, show install/open Proof Helper.
- Detect OS and architecture from browser hints when available, with manual
  download choices as a fallback.
- Link to GitHub Release assets or a stable download redirect controlled by the
  project.
- If helper `/status` reports an unsupported sidecar, key, protocol, or circuit
  version, show an update-required state.
- If the helper is downloading keys, show that the user should return to Proof
  Helper or wait for readiness.
- Keep all master XPrv traffic pointed at the paired loopback helper only.
- Submit only backend-bound proof artifacts to `/api/verify`.

The URL fragment token is appropriate because fragments are not sent to the
Vercel server. It is still visible to website JavaScript, so only the official
site origin should be allowlisted by the helper.

## Security Notes

- Tauri updater signatures, OS code signing, and proving-key signatures are
  three separate controls. Keep all three explicit.
- The public proving key is not secret, but it is integrity-critical.
- The hosted website flow still trusts the JavaScript served for that session.
  This is acceptable for the current hosted-helper plan if documented clearly.
  Moving seed entry into Tauri is the higher-assurance follow-up.
- Browser-to-loopback requests need CORS hardening and Private Network Access
  compatibility testing across Chrome, Edge, Firefox, and Safari.
- Do not use cookies for helper authentication.
- Do not accept wildcard origins.
- Do not bind the helper to `0.0.0.0`.
- Do not let production helper builds silently regenerate proving keys.
- Do not expose a manual token entry field unless it is a support fallback.
- Do not leave path metadata in backend-bound artifacts.

## Proposed Repo Layout

```text
apps/proof-helper-desktop/
  package.json
  src/
    App.tsx
    main.tsx
    styles.css
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/
      default.json
    icons/
    binaries/
      proof-tool-x86_64-pc-windows-msvc.exe
      proof-tool-x86_64-apple-darwin
      proof-tool-aarch64-apple-darwin
      proof-tool-x86_64-unknown-linux-gnu
    src/
      main.rs
      sidecar.rs
      key_bundle.rs
      commands.rs

cmd/proof-tool/
  main.go

.github/workflows/
  release-proof-helper.yml
```

Tauri sidecars are configured with `bundle.externalBin`; the files on disk need
the target-triple suffix expected by Tauri. The capability file must grant the
specific shell sidecar permission needed to spawn the bundled helper.

## CI And Release Matrix

Use native GitHub-hosted runners for the first production path:

| Platform | Runner | Sidecar target | Installer targets |
| --- | --- | --- | --- |
| macOS Apple Silicon | `macos-latest` | `aarch64-apple-darwin` | `.app`, `.dmg` |
| macOS Intel | `macos-latest` | `x86_64-apple-darwin` | `.app`, `.dmg` |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` | NSIS `.exe`, optional MSI |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | AppImage, `.deb`, optional `.rpm` |

Release pipeline:

1. Run Go tests.
2. Run TypeScript package tests/build.
3. Run web app tests/typecheck/build.
4. Build sidecar binaries for each target.
5. Place sidecars under `apps/proof-helper-desktop/src-tauri/binaries/` with
   Tauri's expected target-triple names.
6. Build Tauri app on each OS runner.
7. Code-sign and notarize macOS artifacts.
8. Code-sign Windows artifacts.
9. Generate Tauri updater artifacts and signatures.
10. Upload installers, updater metadata, checksums, and release notes to GitHub
    Releases.
11. Publish or update the proving-key manifest separately.

Use draft releases until signing, updater metadata, and key bundle validation
have all passed.

## Implementation Phases

### Phase 1: Helper Production Hardening

- Add production fail-closed key loading.
- Add key manifest fields and verification helpers.
- Add PNA preflight header support.
- Add machine-readable sidecar startup output.
- Expand `/status`.
- Add tests for PNA preflight, production missing-key failure, wrong key hash,
  and status compatibility fields.

Exit criteria:

- `go test ./...` passes.
- Production helper cannot create fresh keys silently.
- Website can distinguish helper offline, helper ready, key missing, key
  downloading, and update required.

### Phase 2: Tauri Shell MVP

- Scaffold `apps/proof-helper-desktop`.
- Build a minimal app UI with key status, start/stop helper, connect to website,
  and cleanup actions.
- Spawn the bundled sidecar through Tauri.
- Open the website with helper URL and token fragment.
- Stop the sidecar on app exit or `/shutdown`.

Exit criteria:

- Local debug build starts the Go sidecar.
- Clicking connect opens the website and pairs automatically.
- Existing browser flow can generate and verify a proof through the Tauri-started
  sidecar.

### Phase 3: Key Download And Cache

- Choose artifact storage: GitHub Releases first unless bandwidth or rollout
  control pushes this to R2/S3/GCS.
- Implement manifest fetch, signature verification, streaming download,
  checksum verification, and atomic activation.
- Add resumable or restart-safe behavior for interrupted downloads.
- Add delete-cache action.
- Add disk-space check before download.

Exit criteria:

- Fresh install downloads and verifies the key bundle.
- Corrupt downloads fail before activation.
- Wrong manifest signature fails.
- Delete-cache removes the active bundle and returns the app to missing-key
  state.

### Phase 4: Website Installer UX

- Add OS-specific install links.
- Add helper offline/install state.
- Add helper incompatible/update-required state.
- Add user copy that explains the key download without implying seed storage.
- Keep manual token entry out of the main path.

Exit criteria:

- A non-technical user can move from website to installer to helper pairing
  without typing a token.
- Network inspection shows no seed phrase, entropy, or master XPrv leaves the
  device except to the paired loopback helper.

### Phase 5: Release Automation

- Add GitHub Actions release workflow.
- Build all supported Tauri targets.
- Add macOS signing and notarization secrets.
- Add Windows signing.
- Add Tauri updater signing keys and configure updater endpoint.
- Generate checksums and release notes that include app version, sidecar
  version, circuit id, key version, and `vk_hash`.

Exit criteria:

- A draft GitHub Release contains installers for macOS, Windows, and Linux.
- Update artifacts are signed.
- The website can link users to the correct installer.

### Phase 6: Security And Compatibility Review

- Threat-model hosted website, pairing fragment, local helper, Tauri app,
  sidecar, key download, app update, and verifier.
- Test Chrome, Edge, Firefox, and Safari where possible.
- Test Windows Defender/Gatekeeper/notarization behavior.
- Verify no secret-bearing fields enter logs, crash reports, command lines, or
  release telemetry.
- Review all product copy against the exact credential-proof claim.

Exit criteria:

- Security review findings are resolved or explicitly accepted.
- Browser-to-loopback behavior is known for target browsers.
- Signed installers install and launch without scary avoidable warnings.

## Open Decisions

- Artifact host: GitHub Releases, R2, S3, or GCS.
- Signing identity ownership for Apple Developer ID and Windows Authenticode.
- Whether the first helper release supports Linux `.rpm` or only AppImage and
  `.deb`.
- Whether to support Windows ARM64 in the first release.
- Whether the first product keeps seed entry in the hosted website or moves it
  into the signed Tauri app for higher assurance.
- Whether key download should happen automatically on first app launch or only
  after an explicit user click.
- Whether auto-update is enabled for the first beta or held until signing and
  rollback behavior are fully tested.

## Useful References

- [Tauri v2 configuration](https://v2.tauri.app/reference/config/)
- [Tauri v2 sidecars](https://v2.tauri.app/develop/sidecar/)
- [Tauri v2 updater](https://v2.tauri.app/plugin/updater/)
- [Tauri GitHub release pipeline](https://v2.tauri.app/distribute/pipelines/github/)
- [tauri-apps/tauri-action](https://github.com/tauri-apps/tauri-action)
- [Tauri path API `appDataDir`](https://v2.tauri.app/reference/javascript/api/namespacepath/#appdatadir)
- [Chrome Private Network Access preflights](https://developer.chrome.com/blog/private-network-access-preflight)
- [MDN secure contexts and loopback origins](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)
