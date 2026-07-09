# Proof Helper Windows Release Runbook

This runbook is the repeatable process for producing the Windows x64 Proof
Helper desktop release. It creates release artifacts; it does not by itself make
an unsigned or proof-assets-blocked build safe for general end users.

## Release Gates

Before publishing as an end-user release, verify all of the following:

1. The proof-assets descriptor points at a public HTTPS download route and pins
   archive size, SHA-256, BLAKE2b-256, manifest signer, verifier-key hash, and
   Cardano verifier-key hash.
2. The app executable, bundled sidecar, and installer are Authenticode signed
   and timestamped.
3. The packaged app passes the local Windows release-build validation checklist
   in `docs/proof-helper-windows-release-plan.md`.
4. Release notes state the exact status: signed or unsigned, production-keyed or
   preprod, and fixture-only or real proof-assets backed.

If any gate is open, leave the GitHub release as a draft or label it as an
unsigned preview.

## Preflight

Use a desktop-specific tag. Do not reuse `proof-helper-v0.1.0`; that tag is for
portable fixture-helper bundles.

Recommended tag shape:

```sh
proof-helper-desktop-v0.1.0-windows-preview.1
```

Confirm the app versions match:

```sh
node -e "const p=require('./apps/proof-helper-desktop/package.json'); const t=require('./apps/proof-helper-desktop/src-tauri/tauri.conf.json'); console.log({package:p.version, tauri:t.version})"
rg -n '^version = ' apps/proof-helper-desktop/src-tauri/Cargo.toml
```

Confirm the proof-assets inventory is current:

```sh
gh repo view Anastasia-Labs/proof-tool-release --json nameWithOwner,visibility,url
gh release view proof-assets-ownership-destination-v1-preprod-d2c944d-r3 \
  --repo Anastasia-Labs/proof-tool-release \
  --json tagName,name,isPrerelease,isDraft,publishedAt,url,assets
```

### Local Windows Tooling Discovery

On Philip's Windows host, the MSVC build tools are installed under
`C:\BuildTools`, not under the usual Visual Studio locations reported by
`vswhere`. Do not conclude MSVC is missing only because `vswhere` returns no
instances or because WSL-launched PowerShell has a thin `PATH`.

Known-good paths observed on this machine:

```text
C:\BuildTools\Common7\Tools\VsDevCmd.bat
C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat
C:\BuildTools\MSBuild\Current\Bin\MSBuild.exe
C:\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\cl.exe
C:\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\lib.exe
C:\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\link.exe
C:\Users\phili\.cargo\bin\rustup.exe
C:\Users\phili\.cargo\bin\cargo.exe
C:\Users\phili\.cargo\bin\rustc.exe
```

The Windows Rust install was observed with only `x86_64-pc-windows-gnu`
installed. Before a local MSVC release build, add the MSVC target:

```bat
C:\Users\phili\.cargo\bin\rustup.exe target add x86_64-pc-windows-msvc
```

At the time this note was written, normal Windows installs of Node, pnpm, Go,
WiX, and NSIS were not found on `PATH` or in the common install locations. The
real local Windows release build needs Windows-side `node`, `pnpm`, and `go`
available in the same shell that runs Tauri. Cursor's embedded `node.exe` is not
a release build toolchain.

Useful verification commands from PowerShell:

```powershell
Test-Path 'C:\BuildTools\Common7\Tools\VsDevCmd.bat'
Test-Path 'C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
Test-Path 'C:\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\lib.exe'
& "$env:USERPROFILE\.cargo\bin\rustup.exe" target list --installed
Get-Command node,pnpm,go,cargo -ErrorAction SilentlyContinue
```

Useful verification commands from WSL:

```sh
cmd.exe /C "%USERPROFILE%\\.cargo\\bin\\rustup.exe target list --installed"
powershell.exe -NoProfile -Command "Test-Path 'C:\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat'"
powershell.exe -NoProfile -Command "Test-Path 'C:\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\lib.exe'"
```

## Build Draft Release

Dispatch the workflow from a clean pushed commit:

```sh
gh workflow run release-proof-helper.yml \
  --ref main \
  -f tag=proof-helper-desktop-v0.1.0-windows-preview.1 \
  -f publish_release=false \
  -f signed_release=false
```

Watch the run:

```sh
gh run list --workflow release-proof-helper.yml --limit 5
gh run watch <run-id>
```

The workflow:

1. Runs Go, client, website, desktop frontend, and desktop Rust checks.
2. Builds `cmd/proof-tool` as
   `proof-tool-x86_64-pc-windows-msvc.exe`.
3. Copies that sidecar into
   `apps/proof-helper-desktop/src-tauri/binaries/`.
4. Runs `pnpm tauri build --target x86_64-pc-windows-msvc`.
5. Stages installers, `.sha256` files, and
   `proof-helper-windows-release-manifest.json`.
6. Creates a draft prerelease unless `publish_release=true`.

## Local Windows Build

The canonical release path is still the GitHub Actions workflow above. Use this
local path only when intentionally rebuilding the Windows MSI/NSIS bundle on
Philip's Windows host.

Open `cmd.exe` or PowerShell, initialize the `C:\BuildTools` MSVC environment,
and build from the Windows-visible checkout. `cmd.exe` cannot use a UNC path as
the current directory directly, so use `pushd` if building from the WSL share.

```bat
call C:\BuildTools\Common7\Tools\VsDevCmd.bat -arch=x64
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
where cl
where lib
where link
rustup target add x86_64-pc-windows-msvc
```

If Windows-side Go, Node, and pnpm are installed and on `PATH`, rebuild the
fixed sidecar and Tauri bundle:

```bat
pushd \\wsl.localhost\Ubuntu\home\gumbo\playground\proof-zk-recovery\proof-tool
set GOOS=windows
set GOARCH=amd64
go build -trimpath -ldflags="-s -w" -o apps\proof-helper-desktop\src-tauri\binaries\proof-tool-x86_64-pc-windows-msvc.exe .\cmd\proof-tool
popd

pushd \\wsl.localhost\Ubuntu\home\gumbo\playground\proof-zk-recovery\proof-tool\apps\proof-helper-desktop
pnpm install --frozen-lockfile
pnpm tauri build --target x86_64-pc-windows-msvc
popd
```

Expected output:

```text
apps/proof-helper-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/
apps/proof-helper-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
```

Then stage the release artifacts from the same app directory:

```bat
pushd \\wsl.localhost\Ubuntu\home\gumbo\playground\proof-zk-recovery\proof-tool\apps\proof-helper-desktop
pnpm release:stage-windows -- --tag proof-helper-desktop-v0.1.0-windows-preview.1 --bundle-dir src-tauri\target\x86_64-pc-windows-msvc\release\bundle --sidecar src-tauri\binaries\proof-tool-x86_64-pc-windows-msvc.exe --out-dir ..\..\dist\proof-helper-windows-x64
popd
```

## Inspect Artifacts

Download the draft assets:

```sh
gh release download proof-helper-desktop-v0.1.0-windows-preview.1 \
  --dir /tmp/proof-helper-windows-release \
  --clobber
```

Verify checksums:

```sh
cd /tmp/proof-helper-windows-release
sha256sum -c *.sha256
jq . proof-helper-windows-release-manifest.json
```

Check the manifest fields before testing:

- `target` is `x86_64-pc-windows-msvc`.
- `sidecar.name` is `proof-tool-x86_64-pc-windows-msvc.exe`.
- `sidecar.sha256` is present.
- `proof_assets_descriptor.download_configured` matches the intended release
  status.
- `signed` matches the Authenticode status that was actually verified.

## Windows Validation

Run this on the Windows host from the packaged installer or staged portable
directory, not from `target/debug`.

1. Install or launch the packaged artifact.
2. Open the app and expand Diagnostics.
3. Confirm Platform is `Windows / x86_64`.
4. Confirm Executable and Resources point to the installed app location.
5. Confirm Bundled sidecar includes
   `proof-tool-x86_64-pc-windows-msvc.exe`.
6. Confirm no Vite dev server, Node, pnpm, Rust, WSL process, or
   `PROOF_HELPER_SIDECAR_PATH` is required.
7. Install proof assets through the GUI from the selected public route.
8. Start helper and confirm the browser pairs through the loopback fragment.
9. Run the repo-backed golden-vector proof flow.
10. Test corrupt proof-assets archives and verify they fail closed.
11. Uninstall and confirm user secrets are not deleted unexpectedly.

Record the exact artifact names, hashes, and validation result in the release
notes before publishing.

## Publish

Only publish after the gates and Windows validation pass:

```sh
gh release edit proof-helper-desktop-v0.1.0-windows-preview.1 --draft=false
```

Then update the website download link to the direct Windows installer asset.
Do not point normal users to the generic release page when a direct installer
asset exists.
