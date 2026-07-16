import assert from 'node:assert/strict';
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const requireFromWebapp = createRequire(path.join(root, 'apps/ownership-proof-web/package.json'));
const { chromium } = requireFromWebapp('playwright');

const files = new Map([
  ['/prover-worker.js', {
    path: path.join(root, 'apps/ownership-proof-web/public/proof-runtime/prover-worker.js'),
    type: 'text/javascript',
  }],
  ['/proof-destination.wasm', {
    path: process.env.PROOF_WASM || path.join(root, 'dist/proof-runtime/proof-destination.wasm'),
    type: 'application/wasm',
  }],
  ['/msmworker.wasm', {
    path: process.env.MSMWORKER_WASM || path.join(root, 'dist/proof-runtime/msmworker.wasm'),
    type: 'application/wasm',
  }],
  ['/wasm_exec.js', {
    path: process.env.WASM_EXEC_JS || path.join(root, 'dist/proof-runtime/wasm_exec.js'),
    type: 'text/javascript',
  }],
]);

const canonicalMasterXPrvHex = 'c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620';
const accountThreeCredential = 'b80e56697c8c5d69e2338d85db277d40b7c75833039d8e07e31ffdcd';

for (const entry of files.values()) {
  statSync(entry.path);
}

function serveFile(response, entry) {
  response.writeHead(200, {
    'Content-Type': entry.type,
    'Cache-Control': 'no-store',
  });
  createReadStream(entry.path).pipe(response);
}

async function startServer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><meta charset="utf-8"><title>key discovery benchmark</title>');
      return;
    }
    const entry = files.get(request.url || '');
    if (!entry) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    serveFile(response, entry);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function benchmarkAtRate(page, cdp, rate) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return await page.evaluate(async ({ canonicalMasterXPrvHex: master, accountThreeCredential: credential }) => {
    const worker = new Worker('/prover-worker.js');
    let nextID = 0;
    const pending = new Map();
    worker.onmessage = ({ data }) => {
      const entry = pending.get(data.id);
      if (!entry) return;
      if (data.type === 'progress') {
        entry.progress.push(data);
        return;
      }
      pending.delete(data.id);
      if (data.type === 'error') entry.reject(new Error(data.message || 'worker error'));
      else entry.resolve({ data, progress: entry.progress });
    };
    const request = (message) => new Promise((resolve, reject) => {
      const id = `bench-${++nextID}`;
      pending.set(id, { resolve, reject, progress: [] });
      worker.postMessage({ id, ...message });
    });
    try {
      await request({
        type: 'init',
        wasmUrl: '/proof-destination.wasm',
        wasmExecUrl: '/wasm_exec.js',
        msmWorkerWasmUrl: '/msmworker.wasm',
        gogc: 50,
        gomemlimit: '3000MiB',
      });
      const discoveryRequest = (target) => JSON.stringify({
        master_xprv_hex: master,
        target_credentials_hex: [target],
        search: { max_account: 9, max_index: 999 },
      });
      const run = async (target, expectMatch) => {
        const started = performance.now();
        let reply = null;
        let error = null;
        try {
          reply = await request({ type: 'discover', requestJson: discoveryRequest(target) });
        } catch (caught) {
          error = caught;
        }
        const milliseconds = performance.now() - started;
        const progress = reply?.progress || [];
        if (expectMatch) {
          if (error) throw error;
          if (reply.data.result.candidates_scanned !== 4) throw new Error('account-3 candidate count mismatch');
        } else {
          if (!error || !/credentials were not found/u.test(error.message)) throw new Error('full miss did not reject safely');
        }
        for (const event of progress) {
          for (const forbidden of ['account', 'role', 'index', 'credential', 'master_xprv']) {
            if (forbidden in event) throw new Error(`progress leaked ${forbidden}`);
          }
        }
        return milliseconds;
      };
      const accountThree = [];
      for (let i = 0; i < 5; i += 1) accountThree.push(await run(credential, true));
      const fullMiss = await run('ff'.repeat(28), false);
      return { accountThree, fullMiss, hardwareConcurrency: navigator.hardwareConcurrency };
    } finally {
      worker.terminate();
    }
  }, { canonicalMasterXPrvHex, accountThreeCredential }).then((raw) => ({
    cpuThrottleRate: rate,
    hardwareConcurrency: raw.hardwareConcurrency,
    accountThreeMilliseconds: median(raw.accountThree),
    fullMissMilliseconds: raw.fullMiss,
  }));
}

async function main() {
  const { server, origin } = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const cdp = await page.context().newCDPSession(page);
    const results = [];
    for (const rate of [1, 4]) {
      results.push(await benchmarkAtRate(page, cdp, rate));
    }
    console.log(JSON.stringify({ status: 'PASS', runtime: 'chromium-worker-go-wasm', results }));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
