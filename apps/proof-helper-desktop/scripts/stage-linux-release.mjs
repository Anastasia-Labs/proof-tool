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
  release_tag: "proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1",
  profile: "preprod-single-destination",
  archive_url:
    "https://github.com/Anastasia-Labs/proof-tool-release/releases/download/proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1/proof-assets-ownership-destination-v3-preprod-191ca93-opt-r1.tar",
  archive_size: 1_167_165_440,
  archive_sha256: "sha256:3da800387c9690ba8b3b558978d12600d4f1adfea96c4256b523bd753e9a217a",
  archive_blake2b256: "blake2b256:12264a7a47a9dd77fcf39b2d9176df62c35d6ab419c7ae5313c9f840297f2bfa",
  expected_key_version: "ownership-destination-v3",
  expected_circuit_id: "root-ownership-destination-v3/bls12-381/groth16",
  expected_vk_hash: "blake2b256:bb62fb1ab0bbc2d63f0e86dca668ee339dba8d3bc3c83f063a781261b2462ce7",
  expected_signature_key_id: "preprod-local-destination-v3-191ca93-20260829",
  trusted_manifest_public_key_hex: "e5924495fbf85b40f909856e4b39151897871f65b4b329c2f9fb07e680ec855b",
  expected_cardano_vk_blake2b256: "blake2b256:b953a5133901bee9832254df08b76f28a8f5e5aba58683815623f6e1ec660fa7",
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
    `Release tag: \`${releaseTag}\`. The app downloads and verifies the signed V3 Preprod proof ` +
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
