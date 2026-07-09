# Proof Helper Windows Release Plan

## Goal

Ship a Windows x64 Proof Helper desktop release that normal Windows users can
install and run without WSL, Node, Rust, pnpm, or a local dev server.

This plan targets Windows 10/11 x64 first. ARM64 is out of scope for the first
Windows desktop release.

## Current Status

- Native Windows GUI build has been proven locally.
- The current local build is a debug build that loads the frontend from
  `http://127.0.0.1:1420`.
- The existing public helper release assets are portable fixture-helper bundles,
  not signed Tauri desktop installers.
- The preprod proof-assets release exists in
  `Anastasia-Labs/proof-tool-release`; see
  `docs/proof-assets-release-inventory.md`.
- `Anastasia-Labs/proof-tool-release` is private at the time of verification, so
  the proof-assets release is not yet an anonymous public download route for
  end users.

## Phase 1: Remove Dev-Only Assumptions

Status: implemented in repo; packaged Windows validation pending.

1. Build the desktop app with the Windows MSVC target.
2. Bundle the frontend with `pnpm --dir apps/proof-helper-desktop build`.
3. Ensure the packaged app loads `frontendDist`, not the Vite dev server.
4. Bundle the Windows sidecar as
   `proof-tool-x86_64-pc-windows-msvc.exe`.
5. Ensure the packaged app does not require `PROOF_HELPER_SIDECAR_PATH`.
6. Keep ignored local binaries out of the release process.

Implementation:

- `.github/workflows/release-proof-helper.yml` builds the Windows MSVC sidecar
  from `cmd/proof-tool` in CI and copies it to the Tauri `binaries/` directory.
- `apps/proof-helper-desktop/src-tauri/tauri.conf.json` already uses
  `frontendDist` for packaged builds.
- `apps/proof-helper-desktop/src-tauri/src/sidecar.rs` resolves bundled sidecar
  candidates before falling back to `proof-tool`.
- The desktop Diagnostics drawer now reports the Tauri runtime OS, architecture,
  executable path, resource directory, and bundled sidecar candidates.

Acceptance criteria:

- Installed app starts without WSL.
- Installed app starts without Node, pnpm, Rust, or a dev server.
- Platform diagnostics report Windows, not Linux.

## Phase 2: Make Proof Assets Release-Usable

Status: partially complete.

Completed:

- The preprod proof-assets archive is published as a GitHub release in
  `Anastasia-Labs/proof-tool-release`.
- The release includes the tar archive, SHA-256 sidecar, BLAKE2b-256 sidecar,
  release manifest, Cardano verifier-key metadata, and preprod reclaim
  deployment manifest.
- The archive size and digests needed by the app descriptor are recorded in
  `docs/proof-assets-release-inventory.md`.

Still open:

1. Choose an anonymous public download route for desktop users, or publish a
   signed public release index that points to immutable assets.
2. Update the app-pinned proof-assets descriptor with the final public archive
   URL and exact archive size plus hashes.
3. Verify a fresh Windows profile can install proof assets through the GUI.
4. Verify bad hash, bad signature, wrong verifier key, missing proving key, and
   interrupted download all fail closed.

This phase is not fully complete for an end-user release while the only archive
URL is in a private repository.

## Phase 3: Package the App

Status: implemented in GitHub Actions; artifact validation pending.

1. Add a Windows release build path, preferably GitHub Actions on
   `windows-latest`.
2. Build or fetch the Windows sidecar during CI.
3. Copy the sidecar into
   `apps/proof-helper-desktop/src-tauri/binaries/proof-tool-x86_64-pc-windows-msvc.exe`.
4. Run `pnpm --dir apps/proof-helper-desktop tauri build`.
5. Produce:
   - Windows installer, likely `.msi` or NSIS `.exe`.
   - Optional portable `.zip`.
   - `.sha256` checksum files.
   - Release manifest recording app version, sidecar hash, and proof-assets
     descriptor identity.

Acceptance criteria:

- The installer is built from a clean checkout.
- The installer embeds the built frontend and Windows sidecar.
- The packaged app can start helper from the bundled sidecar.

Implementation:

- Workflow: `.github/workflows/release-proof-helper.yml`.
- Staging script:
  `apps/proof-helper-desktop/scripts/stage-windows-release.mjs`.
- The workflow produces normalized Windows artifact names, `.sha256` files, and
  `proof-helper-windows-release-manifest.json`.

## Phase 4: Signing

Status: open.

1. Sign the Tauri app executable.
2. Sign the sidecar executable.
3. Sign the installer.
4. Timestamp signatures.

If code signing is unavailable, label the artifact as an unsigned preview. An
unsigned artifact is not a general Windows end-user release because Windows
SmartScreen will warn or block many users.

## Phase 5: Local Release-Build Validation

Status: open.

Run the packaged release build on this Windows machine. This is the required
validation target for the first Windows release pass.

This check is intentionally weaker than clean-machine validation: it proves the
release artifact works on the current Windows host, but it does not prove that a
machine without prior developer tooling, cached WebView2/runtime state, or repo
history behaves the same way.

Acceptance criteria:

1. Installer launches and installs normally.
2. App opens as a Windows GUI.
3. App is launched from the packaged release install location or packaged
   portable release directory, not from `target/debug`.
4. No dev server is required.
5. No WSL process is used by the app at runtime.
6. No Linux platform text appears.
7. No proxy lookup failure is shown.
8. Proof assets install through the GUI from the chosen public route.
9. Helper starts from the bundled sidecar.
10. Website pairing works through the loopback token flow.
11. Repo-backed golden-vector proof flow succeeds.
12. Corrupt proof-assets releases fail closed.
13. Uninstall does not delete user secrets unexpectedly.

## Phase 6: Publish

Status: open.

1. Create a new release tag for the Tauri desktop installer.
2. Upload installer, optional portable zip, checksums, and release notes.
3. Update website download links to point directly to the Windows desktop
   installer.
4. State whether the release is signed, production-keyed, fixture-only, or
   preview.

Do not reuse `proof-helper-v0.1.0` for the Tauri installer. That release
currently represents portable fixture-helper bundles.

## Recommended Implementation Order

1. Add Windows MSVC CI packaging for the Tauri app.
2. Fix packaging issues until the installer starts without dev tooling.
3. Move proof-assets distribution from private release input to public
   app-downloadable route.
4. Fill the app descriptor with the final public archive URL, size, and hashes.
5. Run local Windows release-build validation on this machine.
6. Sign and publish.

## Release Runbook

The repeatable process for creating the Windows release is documented in
`docs/proof-helper-windows-release-runbook.md`.
