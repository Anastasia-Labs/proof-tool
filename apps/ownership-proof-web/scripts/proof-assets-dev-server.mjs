import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const assetsDir = path.resolve(
  repoRoot,
  process.env.PROOF_ASSETS_DIR || "output/proof-assets-stage-proof-assets-ownership-destination-v2-preprod-9fac96b-g3a",
);
const port = Number(process.env.PROOF_ASSETS_PORT || 8788);
const host = process.env.PROOF_ASSETS_HOST || "127.0.0.1";

const server = http.createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", process.env.PROOF_ASSETS_ALLOW_ORIGIN || "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  response.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, Content-Encoding");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("method not allowed\n");
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
  const filePath = resolveProofAsset(url.pathname);
  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`not found: ${url.pathname}\n`);
    return;
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`not found: ${url.pathname}\n`);
    return;
  }
  serveFile(request, response, filePath, stat);
});

server.listen(port, host, () => {
  console.log(`proof assets dev server: http://${host}:${port}/proof-assets/`);
  console.log(`serving: ${assetsDir}`);
});

function resolveProofAsset(pathname) {
  const prefix = "/proof-assets/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  if (!rel || rel.includes("\\") || rel.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }
  const resolved = path.resolve(assetsDir, rel);
  return resolved.startsWith(`${assetsDir}${path.sep}`) ? resolved : null;
}

function serveFile(request, response, filePath, stat) {
  const range = request.headers.range;
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Encoding", "identity");
  response.setHeader("Content-Type", contentType(filePath));

  if (range) {
    const match = /^bytes=(\d+)-(\d+)?$/u.exec(range);
    if (!match) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      response.end();
      return;
    }
    const start = Number(match[1]);
    let end = match[2] ? Number(match[2]) : stat.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= stat.size || end < start) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      response.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    response.writeHead(206, {
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, { "Content-Length": stat.size });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

function contentType(filePath) {
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".wasm")) {
    return "application/wasm";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".hex") || filePath.endsWith(".sig")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}
