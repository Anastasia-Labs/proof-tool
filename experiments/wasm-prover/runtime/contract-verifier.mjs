import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(runtimeDir, '../../..');
const contractDir = path.join(repoRoot, 'contracts/ownership-verifier');

const exportedVKs = new Map();

export async function verifyContractArtifact({ label, run, keysDir }) {
  const artifact = run?.artifact;
  const proofHex = artifact?.cardano?.proof_hex;
  const credentialHex = artifact?.target_credential;
  const destinationHex = artifact?.destination_address;
  if (typeof keysDir !== 'string' || keysDir.length === 0) {
    throw new Error(`${label}: keysDir is required for a coherence-bound Cardano verifier key`);
  }
  const manifestRaw = readFileSync(path.join(keysDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  if (artifact?.vk_hash !== manifest.vk_hash || run?.asset_identity?.vk_hash !== manifest.vk_hash) {
    throw new Error(`${label}: artifact/key-bundle vk_hash mismatch`);
  }
  const manifestDigest = createHash('sha256').update(manifestRaw).digest('hex');
  const vkPath = exportCardanoVK(keysDir, `${manifest.vk_hash}:${manifestDigest}`);
  const vkHex = readFileSync(vkPath, 'utf8').replace(/\s+/g, '');
  if (!/^[0-9a-f]+$/i.test(vkHex) || vkHex.length / 2 !== 672) {
    throw new Error(`${label}: Cardano verifier key must be exactly 672 bytes`);
  }
  for (const [name, value] of Object.entries({ proofHex, credentialHex, destinationHex })) {
    if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
      throw new Error(`${label}: ${name} must be even-length hex`);
    }
  }
  for (const [name, value, expectedBytes] of [
    ['proofHex', proofHex, 336],
    ['credentialHex', credentialHex, 28],
    ['destinationHex', destinationHex, 58],
  ]) {
    if (value.length / 2 !== expectedBytes) {
      throw new Error(`${label}: ${name} is ${value.length / 2} bytes, want ${expectedBytes}`);
    }
  }
  const result = spawnSync(
    'cabal',
    ['run', 'verify-destination-proof', '--', vkPath, proofHex, credentialHex, destinationHex],
    { cwd: contractDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`${label}: contract verifier failed\n${result.stdout}\n${result.stderr}`);
  }
  if (result.stdout.trim().split(/\r?\n/).at(-1) !== 'ok') {
    throw new Error(`${label}: contract verifier did not return ok`);
  }
  return { ok: true };
}

function exportCardanoVK(keysDir, bundleIdentity) {
  const cacheKey = `${keysDir}\0${bundleIdentity}`;
  const cached = exportedVKs.get(cacheKey);
  if (cached) return cached;
  const slug = createHash('sha256').update(cacheKey).digest('hex').slice(0, 16);
  const outDir = path.join(os.tmpdir(), `proof-tool-contract-vk-${slug}`);
  mkdirSync(outDir, { recursive: true });
  const vkPath = path.join(outDir, 'vk.hex');
  const formatPath = path.join(outDir, 'format.txt');
  const result = spawnSync(
    'go',
    [
      'run', './cmd/proof-tool', 'export-cardano-vk',
      '--keys-dir', keysDir,
      '--out', vkPath,
      '--format-out', formatPath,
    ],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`export Cardano verifier key failed\n${result.stdout}\n${result.stderr}`);
  }
  exportedVKs.set(cacheKey, vkPath);
  return vkPath;
}
