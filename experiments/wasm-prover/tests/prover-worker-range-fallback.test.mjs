import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const workerSource = await readFile(
  new URL('../../../apps/ownership-proof-web/public/proof-runtime/prover-worker.js', import.meta.url),
  'utf8',
);

test('healthy proving-key 206 path adds no fallback requests', async () => {
  const calls = [];
  const healthy = new Response(new Uint8Array([2, 3]), { status: 206 });
  const context = workerContext(async (input, init) => {
    calls.push({ input: String(input), range: new Headers(init?.headers).get('range') });
    return healthy;
  });
  installRequest(context, proofRequest('11'.repeat(32)));

  const response = await context.self.fetch('https://pk.example/ownership.pk', {
    headers: { Range: 'bytes=1-2' },
  });
  assert.equal(response, healthy);
  assert.deepEqual(calls, [{ input: 'https://pk.example/ownership.pk', range: 'bytes=1-2' }]);
});

test('ignored Range switches to signed SHA-verified chunks and stays sticky', async () => {
  const fixture = await signedFixture();
  let pkRequests = 0;
  let cancellations = 0;
  let manifestRequests = 0;
  const context = workerContext(async (input) => {
    const url = String(input);
    if (url === 'https://pk.example/ownership.pk') {
      pkRequests += 1;
      return {
        status: 200,
        body: { async cancel() { cancellations += 1; } },
      };
    }
    if (url === fixture.manifestURL) {
      manifestRequests += 1;
      return new Response(fixture.manifestRaw, { status: 200 });
    }
    if (url === fixture.signatureURL) return new Response(fixture.signatureHex, { status: 200 });
    const chunk = fixture.chunksByURL.get(url);
    if (chunk) return new Response(chunk, { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  });
  installRequest(context, proofRequest(fixture.publicKeyHex));

  const first = await context.self.fetch('https://pk.example/ownership.pk', {
    headers: { Range: 'bytes=2-5' },
  });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), 'bytes 2-5/8');
  assert.equal(Buffer.from(await first.arrayBuffer()).toString(), 'cdef');

  const second = await context.self.fetch('https://pk.example/ownership.pk', {
    headers: { Range: 'bytes=6-7' },
  });
  assert.equal(Buffer.from(await second.arrayBuffer()).toString(), 'gh');
  assert.equal(pkRequests, 1, 'sticky fallback must not repeat the broken full-object request');
  assert.equal(cancellations, 1, 'the ignored-Range body must be cancelled immediately');
  assert.equal(manifestRequests, 1, 'the signed manifest is verified once per prover operation');
});

test('signed chunk fallback rejects corrupt bytes', async () => {
  const fixture = await signedFixture();
  const context = workerContext(async (input) => {
    const url = String(input);
    if (url === 'https://pk.example/ownership.pk') {
      return { status: 200, body: { async cancel() {} } };
    }
    if (url === fixture.manifestURL) return new Response(fixture.manifestRaw, { status: 200 });
    if (url === fixture.signatureURL) return new Response(fixture.signatureHex, { status: 200 });
    if (url.endsWith('/chunk-0')) return new Response('xxxx', { status: 200 });
    const chunk = fixture.chunksByURL.get(url);
    if (chunk) return new Response(chunk, { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  });
  installRequest(context, proofRequest(fixture.publicKeyHex));

  await assert.rejects(
    context.self.fetch('https://pk.example/ownership.pk', { headers: { Range: 'bytes=0-1' } }),
    /chunk 0 sha256 mismatch/,
  );
});

test('signed chunk fallback rejects an untrusted manifest signature', async () => {
  const fixture = await signedFixture();
  const context = workerContext(async (input) => {
    const url = String(input);
    if (url === 'https://pk.example/ownership.pk') {
      return { status: 200, body: { async cancel() {} } };
    }
    if (url === fixture.manifestURL) return new Response(fixture.manifestRaw, { status: 200 });
    if (url === fixture.signatureURL) return new Response(fixture.signatureHex, { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  });
  installRequest(context, proofRequest('11'.repeat(32)));

  await assert.rejects(
    context.self.fetch('https://pk.example/ownership.pk', { headers: { Range: 'bytes=0-1' } }),
    /signature verification failed/,
  );
});

test('signed chunk fallback rejects a path that escapes its transport directory', async () => {
  const fixture = await signedFixture({ paths: ['%2e%2e/chunk-0', 'chunk-1'] });
  const context = workerContext(async (input) => {
    const url = String(input);
    if (url === 'https://pk.example/ownership.pk') {
      return { status: 200, body: { async cancel() {} } };
    }
    if (url === fixture.manifestURL) return new Response(fixture.manifestRaw, { status: 200 });
    if (url === fixture.signatureURL) return new Response(fixture.signatureHex, { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  });
  installRequest(context, proofRequest(fixture.publicKeyHex));

  await assert.rejects(
    context.self.fetch('https://pk.example/ownership.pk', { headers: { Range: 'bytes=0-1' } }),
    /path escapes its base URL/,
  );
});

function workerContext(fetchImpl) {
  const self = {
    fetch: fetchImpl,
    location: { href: 'https://app.example/proof-runtime/prover-worker.js' },
    postMessage() {},
  };
  const context = vm.createContext({
    self,
    crypto: webcrypto,
    Headers,
    Response,
    TextDecoder,
    Uint8Array,
    URL,
    WebAssembly,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(workerSource, context, { filename: 'prover-worker.js' });
  return context;
}

function installRequest(context, request) {
  context.__requestJSON = JSON.stringify(request);
  vm.runInContext('activeRangeFallback = rangeFallbackContext(__requestJSON)', context);
}

function proofRequest(publicKeyHex) {
  return {
    master_xprv_hex: 'not-inspected-by-the-transport-adapter',
    artifacts: {
      pk_url: 'https://pk.example/ownership.pk',
      chunk_manifest_url: 'https://app.example/assets/chunk-manifest.json',
      chunk_manifest_sig_url: 'https://app.example/assets/chunk-manifest.sig',
      chunk_manifest_public_key_hex: publicKeyHex,
    },
  };
}

async function signedFixture({ paths = ['chunk-0', 'chunk-1'] } = {}) {
  const rawChunks = [Buffer.from('abcd'), Buffer.from('efgh')];
  const chunks = rawChunks.map((raw, index) => ({
    index,
    offset: index * 4,
    size: 4,
    path: paths[index],
    sha256: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    blake2b256: `blake2b256:${'00'.repeat(32)}`,
  }));
  const manifest = {
    schema: 'proof-tool-proof-assets-chunk-manifest-v1',
    coherence: { proving_key_size: 8 },
    transport: {
      base_url: 'https://chunks.example/base/',
      content_encoding: 'identity',
      requires_https: true,
    },
    proving_key: { chunk_size: 4, chunks },
    proving_key_index: { file_size: 8 },
  };
  const manifestRaw = new TextEncoder().encode(JSON.stringify(manifest));
  const keyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  const signature = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, manifestRaw));
  const manifestURL = 'https://app.example/assets/chunk-manifest.json';
  const signatureURL = 'https://app.example/assets/chunk-manifest.sig';
  return {
    manifestURL,
    signatureURL,
    manifestRaw,
    publicKeyHex: Buffer.from(publicKey).toString('hex'),
    signatureHex: Buffer.from(signature).toString('hex'),
    chunksByURL: new Map(rawChunks.map((raw, index) => [new URL(paths[index], 'https://chunks.example/base/').href, raw])),
  };
}
