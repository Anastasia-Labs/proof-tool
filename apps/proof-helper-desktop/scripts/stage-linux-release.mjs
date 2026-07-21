#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TARGET = "x86_64-unknown-linux-gnu";
const SOURCE_COMMIT_RE = /^[0-9a-f]{40}$/u;
const RESERVED_TAGS = new Set(["proof-helper-v0.1.0"]);

// Mirrors active_descriptor() in src-tauri/src/proof_assets_release.rs. The
// release manifest makes the package's production trust root reviewable
// without starting the desktop application.
const proofAssetsDescriptor = {
  release_tag: "proof-assets-ownership-destination-v2-preprod-9fac96b-g3a",
  profile: "preprod-single-destination",
  archive_url:
    "https://github.com/Anastasia-Labs/proof-tool-release/releases/download/proof-assets-ownership-destination-v2-preprod-9fac96b-g3a/proof-assets-ownership-destination-v2-preprod-9fac96b-g3a.tar",
  archive_size: 1_417_943_040,
  archive_sha256: "sha256:ee2f232f828da815428965ceb7d57719e32b706fce3373cff603de73a29fdff9",
  archive_blake2b256: "blake2b256:2a44af40ef01cbdca91728098c96978af247ca65dd7ea632090393709a516a28",
  expected_key_version: "ownership-destination-v2",
  expected_circuit_id: "root-ownership-destination-v2/bls12-381/groth16",
  expected_vk_hash: "blake2b256:b1c03cf24376bcd6c743cb372169ff71f93b210e0d8d52b2c6831808f50ded80",
  expected_signature_key_id: "preprod-local-destination-v2-9fac96b-g3a",
  trusted_manifest_public_key_hex: "2af3b300b9e641ede236d4b7d48b43eccfb843ffa9aca74abb38f98e7211eccb",
  expected_cardano_vk_blake2b256: "blake2b256:06ce913c931a53561fe5d022ed45a5fbc033b06d80eebdd9f646d23a05b7d5c4",
};

const args = parseArgs(process.argv.slice(2));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(args.repoRoot ?? path.join(scriptDir, "..", "..", ".."));
const appDir = path.resolve(args.appDir ?? path.join(repoRoot, "apps", "proof-helper-desktop"));
const releaseTag = requiredArg(args.tag, "--tag");
const appImagePath = path.resolve(appDir, requiredArg(args.appimage, "--appimage"));
const sidecarPath = path.resolve(appDir, requiredArg(args.sidecar, "--sidecar"));
const outDir = path.resolve(appDir, requiredArg(args.outDir, "--out-dir"));
const sourceCommit = requiredArg(args.sourceCommit, "--source-commit").toLowerCase();

if (RESERVED_TAGS.has(releaseTag)) {
  fail(`${releaseTag} is reserved for portable fixture-helper bundles`);
}
if (!SOURCE_COMMIT_RE.test(sourceCommit)) {
  fail("--source-commit must be a full 40-character lowercase Git commit");
}

const packageJson = await readJson(path.join(appDir, "package.json"));
const tauriConfig = await readJson(path.join(appDir, "src-tauri", "tauri.conf.json"));
const cargoToml = await fs.readFile(path.join(appDir, "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const appVersion = packageJson.version;

if (!appVersion || appVersion !== tauriConfig.version || appVersion !== cargoVersion) {
  fail(
    `app version mismatch: package.json=${appVersion ?? "missing"}, tauri.conf.json=${
      tauriConfig.version ?? "missing"
    }, Cargo.toml=${cargoVersion ?? "missing"}`,
  );
}
if (releaseTag !== `proof-helper-desktop-v${appVersion}`) {
  fail(`release tag ${releaseTag} does not match app version ${appVersion}`);
}

await assertFile(appImagePath, "Linux AppImage");
await assertFile(sidecarPath, "Linux sidecar");
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const artifactName = `proof-helper_${appVersion}_linux_x86_64.AppImage`;
const checksumName = `${artifactName}.sha256`;
const destination = path.join(outDir, artifactName);
await fs.copyFile(appImagePath, destination);
await fs.chmod(destination, 0o755);

const [artifactDigest, sidecarDigest] = await Promise.all([digestFile(destination), digestFile(sidecarPath)]);
await fs.writeFile(path.join(outDir, checksumName), `${artifactDigest.sha256}  ${artifactName}\n`, "utf8");

const manifest = {
  schema: "proof-helper-linux-release-manifest-v1",
  release_tag: releaseTag,
  generated_at: new Date().toISOString(),
  source_commit: sourceCommit,
  target: TARGET,
  product_name: tauriConfig.productName,
  app_version: appVersion,
  package_format: "AppImage",
  signing_status: "unsigned-sha256-published",
  sidecar: {
    name: path.basename(sidecarPath),
    target: TARGET,
    size: sidecarDigest.size,
    sha256: `sha256:${sidecarDigest.sha256}`,
  },
  proof_assets_descriptor: proofAssetsDescriptor,
  artifact: {
    name: artifactName,
    size: artifactDigest.size,
    sha256: `sha256:${artifactDigest.sha256}`,
    checksum: checksumName,
  },
};
await fs.writeFile(
  path.join(outDir, "proof-helper-linux-release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(outDir, "VERIFY-LINUX.md"),
  verificationInstructions({ artifactName, checksumName, releaseTag }),
  "utf8",
);

console.log(JSON.stringify({ out_dir: outDir, artifact: manifest.artifact }, null, 2));

function verificationInstructions({ artifactName, checksumName, releaseTag }) {
  return (
    `# Verify and run Proof Helper for Linux\n\n` +
    `This is an unsigned **Preprod** AppImage. Verify the SHA-256 file downloaded from the same ` +
    `GitHub release before running it.\n\n` +
    `\`\`\`bash\n` +
    `sha256sum --check ${checksumName}\n` +
    `chmod +x ${artifactName}\n` +
    `./${artifactName}\n` +
    `\`\`\`\n\n` +
    `If FUSE is unavailable, AppImage extraction mode avoids requiring a system install:\n\n` +
    `\`\`\`bash\n` +
    `./${artifactName} --appimage-extract-and-run\n` +
    `\`\`\`\n\n` +
    `Release tag: \`${releaseTag}\`. The app downloads and verifies the signed V2 Preprod proof ` +
    `bundle before enabling the helper. Never enter a recovery phrase into the desktop app; the ` +
    `phrase is handled only by the paired browser flow and sent only to the local loopback helper.\n`
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function requiredArg(value, name) {
  if (!value) fail(`missing ${name}`);
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function assertFile(filePath, label) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) fail(`${label} is missing or empty: ${filePath}`);
}

async function digestFile(filePath) {
  const hash = createHash("sha256");
  const stat = await fs.stat(filePath);
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });
  return { size: stat.size, sha256: hash.digest("hex") };
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
