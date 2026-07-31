import { readFile } from 'node:fs/promises';
import path from 'node:path';

const supportedModes = new Set(['chunk-corruption', 'network-abort', 'network-recover']);

export function createFaultServerControl() {
  let state = cleanState();

  return {
    async handleControl(req, res, url) {
      if (url.pathname === '/__wasm-prover-fault/status' && req.method === 'GET') {
        sendJSON(res, 200, state);
        return true;
      }
      if (url.pathname === '/__wasm-prover-fault/reset' && req.method === 'POST') {
        state = cleanState();
        sendJSON(res, 200, state);
        return true;
      }
      if (url.pathname === '/__wasm-prover-fault/arm' && req.method === 'POST') {
        const body = await readJSONBody(req);
        if (!supportedModes.has(body.mode)) {
          sendJSON(res, 400, { error: 'unsupported fault mode' });
          return true;
        }
        state = {
          schema: 'wasm-prover-fault-server-state-v1',
          mode: body.mode,
          armed: true,
          hit_count: 0,
          retry_count: 0,
          retry_max: body.mode === 'network-abort' || body.mode === 'network-recover' ? 3 : 1,
        };
        sendJSON(res, 200, state);
        return true;
      }
      return false;
    },

    async serveFaultIfArmed(req, res, filePath, contentType) {
      if (!state.armed || req.method !== 'GET' || !/^ownership\.pk\.part\d+$/.test(path.basename(filePath))) {
        return false;
      }
      const mode = state.mode;
      const nextRetryCount = state.retry_count + 1;
      const retryCount = Math.min(nextRetryCount, state.retry_max);
      const recovering = mode === 'network-recover';
      state = {
        ...state,
        armed: mode === 'network-abort' || (recovering && retryCount < state.retry_max),
        hit_count: state.hit_count + 1,
        retry_count: retryCount,
      };
      if (recovering && retryCount >= state.retry_max) {
        // The final request is served normally by the underlying asset host;
        // the first two retryable responses prove that the same shard was
        // retried without restarting the proof.
        return false;
      }
      const raw = await readFile(filePath);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Accept-Ranges', 'bytes');
      if (mode === 'chunk-corruption') {
        const corrupted = Buffer.from(raw);
        corrupted[Math.min(1024, corrupted.length - 1)] ^= 0x01;
        res.writeHead(200, { 'Content-Length': corrupted.length });
        res.end(corrupted);
        return true;
      }
      if (recovering) {
        // Chromium may transparently replay an idempotent GET when a response
        // body is cut mid-stream. A retryable HTTP response is observable at
        // the Worker boundary and therefore proves the runtime retry path.
        const message = Buffer.from('fault injection: transient range fetch failure\n');
        res.writeHead(503, { 'Content-Length': message.length });
        res.end(message);
        return true;
      }
      if (mode === 'network-abort' && retryCount >= state.retry_max) {
        const message = Buffer.from('fault injection: bounded range fetch retries exhausted\n');
        res.writeHead(503, { 'Content-Length': message.length });
        res.end(message);
      } else {
        res.writeHead(200, { 'Content-Length': raw.length });
        res.write(raw.subarray(0, Math.min(4096, raw.length)));
        res.destroy();
      }
      return true;
    },
  };
}

function cleanState() {
  return {
    schema: 'wasm-prover-fault-server-state-v1',
    mode: '',
    armed: false,
    hit_count: 0,
    retry_count: 0,
    retry_max: 1,
  };
}

async function readJSONBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error('fault control request is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sendJSON(res, status, value) {
  const raw = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': raw.length, 'Cache-Control': 'no-store' });
  res.end(raw);
}
