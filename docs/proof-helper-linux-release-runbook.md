# Proof Helper Linux AppImage Release Runbook

The public Linux package is a portable x86-64 AppImage. It bundles the Go
sidecar and downloads the separately published, signed V2 Preprod proof bundle
on first launch. Packaging success alone is not publication approval.

## Release gates

Before publishing or updating the website download link:

1. Build from a committed source revision with the production site URL and
   preview-origin allow-list baked into the frontend.
2. Run Go, desktop frontend, Rust, sidecar, and release-staging tests.
3. Extract the AppImage and confirm the bundled target-triple sidecar exists and
   reports the destination-preflight capability.
4. Publish the AppImage, `.sha256`, Linux release manifest, and verification
   instructions together.
5. Download those public assets again and run `sha256sum --check`.
6. Start the published AppImage and verify the real remote claim flow with both
   granted and denied loopback permission. The denied case must happen before
   the recovery phrase is read or cleared.

This release is unsigned and Preprod-only. The SHA-256 file detects accidental
or malicious modification only when the GitHub release page is itself trusted.

## Build

```bash
pnpm --dir apps/proof-helper-desktop check:tauri-prereqs
mkdir -p apps/proof-helper-desktop/src-tauri/binaries
go build -trimpath -ldflags="-s -w" \
  -o apps/proof-helper-desktop/src-tauri/binaries/proof-tool-x86_64-unknown-linux-gnu \
  ./cmd/proof-tool

VITE_PROOF_SITE_URL=https://proof-tool.vercel.app \
VITE_PROOF_HELPER_ALLOWED_ORIGINS=https://proof-tool-git-*.vercel.app \
VITE_PROOF_HELPER_APP_VERSION=0.2.2 \
pnpm --dir apps/proof-helper-desktop tauri build --bundles appimage
```

Stage the release using the full source commit:

```bash
pnpm --dir apps/proof-helper-desktop release:stage-linux -- \
  --tag proof-helper-desktop-v0.2.2 \
  --appimage src-tauri/target/release/bundle/appimage/Proof\ Helper_0.2.2_amd64.AppImage \
  --sidecar src-tauri/binaries/proof-tool-x86_64-unknown-linux-gnu \
  --out-dir ../../dist/proof-helper-linux-x86_64 \
  --source-commit "$(git rev-parse HEAD)"
```

## User verification

Download the AppImage and its `.sha256` file into the same directory, then run:

```bash
sha256sum --check proof-helper_0.2.2_linux_x86_64.AppImage.sha256
chmod +x proof-helper_0.2.2_linux_x86_64.AppImage
./proof-helper_0.2.2_linux_x86_64.AppImage
```

If FUSE is unavailable:

```bash
./proof-helper_0.2.2_linux_x86_64.AppImage --appimage-extract-and-run
```

Never enter a recovery phrase into the desktop app. The desktop app installs
and verifies proof assets, starts the loopback-only helper, and opens the paired
remote claim flow; phrase handling remains in that browser flow.
