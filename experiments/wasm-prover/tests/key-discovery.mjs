import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';

const wasm = process.env.PROOF_WASM;
const wasmExec = process.env.WASM_EXEC_JS
  || path.join(process.env.GOROOT || '', 'lib/wasm/wasm_exec.js');

if (!wasm || !wasmExec) {
  throw new Error('PROOF_WASM and GOROOT or WASM_EXEC_JS are required');
}

const masterXPrvHex = 'c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620';
const accountThreeCredential = 'b80e56697c8c5d69e2338d85db277d40b7c75833039d8e07e31ffdcd';
const aggregateProgressKeys = new Set([
  'stage',
  'frac',
  'candidates_scanned',
  'candidates_total',
  'candidates_per_second',
  'eta_seconds',
  'matched',
  'targets',
]);

async function loadProver() {
  vm.runInThisContext(readFileSync(wasmExec, 'utf8'));
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiate(readFileSync(wasm), go.importObject);
  void go.run(instance);
  const deadline = performance.now() + 30_000;
  while (!globalThis.__wasmProverReady) {
    if (performance.now() >= deadline) {
      throw new Error('WASM prover did not become ready');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(typeof globalThis.discoverCredentialPaths, 'function');
}

function request(target) {
  return JSON.stringify({
    master_xprv_hex: masterXPrvHex,
    target_credentials_hex: [target],
    search: { max_account: 9, max_index: 999 },
  });
}

function aggregateProgressCollector(events) {
  return (event) => {
    for (const key of Object.keys(event)) {
      assert.ok(aggregateProgressKeys.has(key), `progress exposed forbidden field ${key}`);
    }
    events.push({ ...event });
  };
}

async function benchmarkDiscovery(target, expectMatch) {
  const events = [];
  const started = performance.now();
  let result = null;
  let error = null;
  try {
    result = await globalThis.discoverCredentialPaths(
      request(target),
      aggregateProgressCollector(events),
    );
  } catch (caught) {
    error = caught;
  }
  const wallMilliseconds = performance.now() - started;
  assert.ok(events.length >= 2, 'discovery must report initial and terminal progress');
  const terminal = events.at(-1);
  assert.equal(terminal.candidates_total, 30_000);
  if (expectMatch) {
    assert.equal(error, null);
    assert.equal(result.ok, true);
    assert.equal(result.matched, 1);
    assert.equal(result.targets, 1);
    assert.equal(result.candidates_scanned, 4);
    assert.equal(terminal.candidates_scanned, 4);
  } else {
    assert.ok(error instanceof Error);
    assert.match(error.message, /credentials were not found/u);
    assert.equal(terminal.candidates_scanned, 30_000);
  }
  return wallMilliseconds;
}

async function main() {
  await loadProver();
  const accountThreeMilliseconds = await benchmarkDiscovery(accountThreeCredential, true);
  const fullMissMilliseconds = await benchmarkDiscovery('ff'.repeat(28), false);
  console.log(JSON.stringify({
    status: 'PASS',
    runtime: 'node-go-wasm',
    candidates: { account_three: 4, full_miss: 30_000 },
    milliseconds: {
      account_three: Math.round(accountThreeMilliseconds * 100) / 100,
      full_miss: Math.round(fullMissMilliseconds * 100) / 100,
    },
  }));
}

main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
