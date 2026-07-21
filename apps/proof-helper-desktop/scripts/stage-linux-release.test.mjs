import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("stages a versioned executable AppImage with matching checksum and provenance", async () => {
  const root = await fsp.mkdtemp("/tmp/proof-helper-linux-stage-");
  tempDirs.push(root);
  const app = path.join(root, "apps", "proof-helper-desktop");
  await fsp.mkdir(path.join(app, "src-tauri"), { recursive: true });
  await fsp.writeFile(path.join(app, "package.json"), '{"version":"0.2.2"}\n');
  await fsp.writeFile(
    path.join(app, "src-tauri", "tauri.conf.json"),
    '{"version":"0.2.2","productName":"Proof Helper"}\n',
  );
  await fsp.writeFile(
    path.join(app, "src-tauri", "Cargo.toml"),
    '[package]\nname = "proof-helper-desktop"\nversion = "0.2.2"\n',
  );
  const appImage = path.join(root, "input.AppImage");
  const sidecar = path.join(root, "proof-tool-x86_64-unknown-linux-gnu");
  const out = path.join(root, "out");
  await fsp.writeFile(appImage, "appimage-bytes");
  await fsp.writeFile(sidecar, "sidecar-bytes");

  execFileSync(process.execPath, [
    path.resolve("scripts/stage-linux-release.mjs"),
    "--repo-root",
    root,
    "--tag",
    "proof-helper-desktop-v0.2.2",
    "--appimage",
    appImage,
    "--sidecar",
    sidecar,
    "--out-dir",
    out,
    "--source-commit",
    "a".repeat(40),
  ]);

  const artifact = "proof-helper_0.2.2_linux_x86_64.AppImage";
  const bytes = await fsp.readFile(path.join(out, artifact));
  const digest = createHash("sha256").update(bytes).digest("hex");
  expect(await fsp.readFile(path.join(out, `${artifact}.sha256`), "utf8")).toBe(`${digest}  ${artifact}\n`);
  expect((await fsp.stat(path.join(out, artifact))).mode & 0o111).toBe(0o111);
  const manifest = JSON.parse(await fsp.readFile(path.join(out, "proof-helper-linux-release-manifest.json"), "utf8"));
  expect(manifest.source_commit).toBe("a".repeat(40));
  expect(manifest.artifact.sha256).toBe(`sha256:${digest}`);
  expect(manifest.proof_assets_descriptor.expected_key_version).toBe("ownership-destination-v2");
  expect(await fsp.readFile(path.join(out, "VERIFY-LINUX.md"), "utf8")).toMatch(/sha256sum --check/u);
});
