import pins from "./runtime-pins.json";
import deployment from "../../public/proof-assets/reclaim-deployment.json";
import type { BrowserProvingDescriptor } from "../reclaim/types";

export type VerifiedRuntimeConfig = {
  runtimeBase: string;
  assets: Record<string, string>;
  outerWorker: string;
  nestedWorker: string;
};

type AssetRead = { type: "asset-fetch"; url: string; method: string; headers: string[][]; hasBody: boolean };
type ChunkManifest = {
  transport: { base_url: string };
  proving_key: { path: string; chunks: Array<{ path: string; size: number }> };
  proving_key_index: { file_size: number };
  assets: Record<string, { path: string; size: number; compressed?: { path: string; size: number } }>;
};
const RUNTIME_FIELDS = {
  "prover-worker.js": "prover_worker_js_url",
  "wasm_exec.js": "wasm_exec_js_url",
  "proof-destination.wasm": "proof_wasm_url",
  "msm-worker.js": "worker_js_url",
  "msmworker.wasm": "msm_worker_wasm_url",
} as const;

// One immutable public release per page. Worker state and secrets are never
// cached; each session creates and disposes its own Blob URLs.
let verifiedExecutables: { base: string; files: Array<{ url: string; blob: Blob }> } | null = null;

function absolute(url: string): string {
  return new URL(url, window.location.origin).href;
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || !response.body) throw new Error("Unable to fetch authenticated proving assets.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("Proving asset exceeds its pinned size.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value: string, bytes: number): Uint8Array<ArrayBuffer> {
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "u").test(value)) throw new Error("Invalid manifest authentication.");
  return Uint8Array.from({ length: bytes }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

// Pins are compiled into the trusted app, rather than accepted from the runtime
// being checked. verify:proof-release keeps them coherent with the active release.
export async function loadVerifiedRuntime(descriptor: BrowserProvingDescriptor) {
  if (
    absolute(descriptor.runtime_manifest_url) !== absolute(pins.runtime_manifest_url) ||
    descriptor.chunk_manifest_public_key_hex !== deployment.proof.browser_proving.chunk_manifest_public_key_hex
  ) {
    throw new Error("Prover runtime does not match the application release.");
  }
  const runtimeBase = absolute(descriptor.runtime_base_url);
  const assets: Record<string, string> = {};
  const blobs: string[] = [];
  const reads = new Set<() => void>();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 120_000);
  const fetchBytes = async (url: string, size: number) =>
    readLimited(
      await fetch(absolute(url), {
        cache: "force-cache",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      }),
      size,
    );
  const dispose = () => {
    controller.abort();
    for (const cancel of reads) cancel();
    for (const blob of blobs) URL.revokeObjectURL(blob);
  };
  try {
    for (const filename of Object.keys(RUNTIME_FIELDS) as Array<keyof typeof RUNTIME_FIELDS>) {
      if (absolute(descriptor[RUNTIME_FIELDS[filename]]) !== new URL(filename, `${runtimeBase}/`).href)
        throw new Error("Runtime executable URL is inconsistent.");
    }
    const [manifestBytes, signatureBytes] = await Promise.all([
      fetchBytes(descriptor.chunk_manifest_url, 8 * 1024 * 1024),
      fetchBytes(descriptor.chunk_manifest_sig_url, 4096),
    ]);
    const key = await crypto.subtle.importKey(
      "raw",
      decodeHex(descriptor.chunk_manifest_public_key_hex, 32),
      "Ed25519",
      false,
      ["verify"],
    );
    const signature = decodeHex(new TextDecoder().decode(signatureBytes).trim(), 64);
    if (!(await crypto.subtle.verify("Ed25519", key, signature, manifestBytes)))
      throw new Error("Chunk manifest authentication failed.");
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ChunkManifest;
    const allowed = publicAssetReads(descriptor, manifest);
    const executables =
      verifiedExecutables?.base === runtimeBase
        ? verifiedExecutables.files
        : await Promise.all(
            pins.files.map(async (pin) => {
              const url = new URL(pin.filename, `${runtimeBase}/`).href;
              const bytes = await fetchBytes(url, pin.size_bytes);
              if (
                bytes.byteLength !== pin.size_bytes ||
                hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) !== pin.sha256
              )
                throw new Error("Prover executable authentication failed.");
              return {
                url,
                blob: new Blob([bytes], {
                  type: pin.filename.endsWith(".wasm") ? "application/wasm" : "text/javascript",
                }),
              };
            }),
          );
    // Complete every executable check before creating any Worker or sending a key.
    verifiedExecutables = { base: runtimeBase, files: executables };
    for (const { url, blob } of executables) {
      const objectURL = URL.createObjectURL(blob);
      blobs.push(objectURL);
      assets[url] = objectURL;
    }
    const config: VerifiedRuntimeConfig = {
      runtimeBase,
      assets,
      outerWorker: absolute(descriptor.prover_worker_js_url),
      nestedWorker: `${absolute(descriptor.worker_js_url)}?gogc=50&gomemlimit=512MiB`,
    };
    return {
      config,
      dispose,
      onMessage(event: MessageEvent) {
        if (event.data?.type !== "asset-fetch") return;
        const port = event.ports[0];
        if (port) void serveAssetRead(event.data, port, allowed, reads);
      },
    };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

function publicAssetReads(descriptor: BrowserProvingDescriptor, manifest: ChunkManifest): Map<string, number> {
  const allowed = new Map<string, number>();
  for (const url of [
    descriptor.manifest_url,
    descriptor.manifest_sig_url,
    descriptor.chunk_manifest_url,
    descriptor.chunk_manifest_sig_url,
    descriptor.deployment_manifest_url,
    descriptor.pk_index_url,
    descriptor.vk_url,
  ]) {
    allowed.set(absolute(url), 8 * 1024 * 1024);
  }
  const base = new URL(manifest.transport.base_url);
  if (base.protocol !== "https:" || base.search || base.hash || base.username || base.password)
    throw new Error("Unsafe proving asset transport.");
  const add = (path: string, size: number) => {
    if (
      !/^[A-Za-z0-9._/-]+$/u.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !Number.isSafeInteger(size) ||
      size <= 0
    )
      throw new Error("Invalid public proving asset.");
    const url = new URL(path, base);
    if (!url.href.startsWith(base.href)) throw new Error("Proving asset leaves its pinned transport.");
    allowed.set(url.href, size);
  };
  add(manifest.proving_key.path, manifest.proving_key_index.file_size);
  const ccs = manifest.assets["ownership-destination.ccs"];
  add(ccs.path, ccs.size);
  if (ccs.compressed) add(ccs.compressed.path, ccs.compressed.size);
  for (const chunk of manifest.proving_key.chunks) add(chunk.path, chunk.size);
  if (!allowed.has(absolute(descriptor.pk_url)) || !allowed.has(absolute(descriptor.ccs_url)))
    throw new Error("Public asset URLs are inconsistent.");
  return allowed;
}

async function serveAssetRead(
  read: AssetRead,
  port: MessagePort,
  allowed: Map<string, number>,
  reads: Set<() => void>,
) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const cancel = () => {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
    port.close();
    reads.delete(cancel);
  };
  reads.add(cancel);
  port.onmessage = ({ data }) => {
    if (data.cancel) cancel();
  };
  try {
    const limit = allowed.get(read.url);
    if (!limit || read.hasBody || read.method !== "GET" || reads.size > 64)
      throw new Error("Disallowed asset request.");
    const headers = new Headers();
    for (const [name, value] of read.headers) {
      if (name.toLowerCase() === "accept-encoding" && value === "identity") continue;
      if (name.toLowerCase() !== "range") throw new Error("Disallowed asset header.");
      const range = /^bytes=(\d+)-(\d+)$/u.exec(value);
      if (!range || Number(range[1]) > Number(range[2]) || Number(range[2]) >= limit)
        throw new Error("Invalid asset range.");
      headers.set("Range", value);
    }
    const response = await fetch(read.url, {
      headers,
      cache: "force-cache",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    reader = response.body?.getReader() ?? null;
    let received = 0;
    port.onmessage = async ({ data }) => {
      if (data.cancel) return cancel();
      if (!data.pull) return;
      try {
        const part = reader ? await reader.read() : { done: true as const, value: undefined };
        if (part.done) {
          port.postMessage({ done: true });
          cancel();
          return;
        }
        received += part.value.byteLength;
        if (received > limit) throw new Error("Asset response exceeded its pinned size.");
        port.postMessage({ chunk: part.value }, [part.value.buffer]);
      } catch {
        port.postMessage({ error: true });
        cancel();
      }
    };
    port.postMessage({ status: response.status, headers: [...response.headers] });
  } catch {
    port.postMessage({ error: true });
    cancel();
  }
}
