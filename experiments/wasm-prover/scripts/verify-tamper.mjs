import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const artifactPath =
  process.argv[2] || path.join(repoRoot, 'experiments/wasm-prover/output/destination-proof.json');
const keysDir =
  process.argv[3] ||
  path.join(
    repoRoot,
    'output/release/proof-assets-ownership-destination-v1-preprod-d2c944d-r3/stage/key-bundle/ownership-destination-v1-preprod-d2c944d-r3',
  );

const loaded = JSON.parse(await readFile(artifactPath, 'utf8'));
const proof = loaded?.artifact ?? loaded;
if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
  throw new Error('input must be a proof artifact or a browser run containing artifact');
}
const tmp = await mkdtemp(path.join(os.tmpdir(), 'wasm-prover-tamper-'));

try {
  await check('valid artifact', proof, true);
  await check('tampered target credential', { ...proof, target_credential: flipHex(proof.target_credential) }, false);
  await check('tampered destination address', { ...proof, destination_address: flipHex(proof.destination_address) }, false);
  await check('tampered public input', { ...proof, public_input: flipPublicInput(proof.public_input) }, false);
  await check('tampered proof bytes', { ...proof, proof: proof.proof.slice(0, -4) + 'AAAA' }, false);
  await check('wrong vk_hash', { ...proof, vk_hash: flipLastHexNibble(proof.vk_hash) }, false);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

async function check(label, value, shouldPass) {
  const p = path.join(tmp, slug(label) + '.json');
  await writeFile(p, JSON.stringify(value, null, 2) + '\n');
  const res = spawnSync(
    'go',
    ['run', './cmd/proof-tool', 'verify-destination', '--keys-dir', keysDir, '--destination-proof', p],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  const passed = res.status === 0;
  if (passed !== shouldPass) {
    console.error(res.stdout);
    console.error(res.stderr);
    throw new Error(`${label}: expected pass=${shouldPass}, got status=${res.status}`);
  }
  console.log(`${label}: ${passed ? 'verified true' : 'rejected'}`);
}

// flipLastHexNibble produces a WELL-FORMED wrong digest: same prefix, same
// length, last hex nibble changed. This keeps the tamper case exercising the
// digest-equality check rather than format validation (and unlike the old
// replace-with-'0', it is never a no-op).
function flipLastHexNibble(value) {
  const last = value[value.length - 1];
  const flipped = last === '0' ? '1' : '0';
  return value.slice(0, -1) + flipped;
}

function flipHex(value) {
  const first = value[0] === '0' ? '1' : '0';
  return first + value.slice(1);
}

function flipPublicInput(value) {
  if (!value.startsWith('0x')) return '0x1';
  return value.endsWith('1') ? value.slice(0, -1) + '2' : value.slice(0, -1) + '1';
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
