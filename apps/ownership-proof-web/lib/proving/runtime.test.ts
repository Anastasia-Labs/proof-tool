// @vitest-environment node
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import deployment from "../../public/proof-assets/reclaim-deployment.json";
import type { BrowserProvingDescriptor } from "../reclaim/types";
import { loadVerifiedRuntime } from "./runtime";

const descriptor = deployment.proof.browser_proving as BrowserProvingDescriptor;
const origin = "https://app.test";

function publishedAssets(tamper?: string) {
  vi.stubGlobal("window", { location: { origin } });
  vi.stubGlobal("crypto", webcrypto);
  const fetchAsset = vi.fn(async (url: string) => {
    const filename = new URL(url).pathname;
    const bytes = new Uint8Array(readFileSync(path.join(process.cwd(), "public", filename)));
    if (filename.endsWith(tamper ?? "\0")) bytes[0] ^= 1;
    return new Response(bytes);
  });
  vi.stubGlobal("fetch", fetchAsset);
  return fetchAsset;
}

afterEach(() => vi.unstubAllGlobals());

describe("runtime authentication", () => {
  it("authenticates the published signed manifest and all five executables", async () => {
    const fetching = publishedAssets();
    const runtime = await loadVerifiedRuntime(descriptor);
    try {
      expect(Object.keys(runtime.config.assets)).toHaveLength(5);
      expect(Object.values(runtime.config.assets).every((url) => url.startsWith("blob:"))).toBe(true);
      expect(fetching).toHaveBeenCalledTimes(7);
    } finally {
      runtime.dispose();
    }
  });

  it("rejects a modified signed manifest before fetching executables", async () => {
    const fetching = publishedAssets("chunk-manifest.json");
    await expect(loadVerifiedRuntime(descriptor)).rejects.toThrow("Chunk manifest authentication failed");
    expect(fetching).toHaveBeenCalledTimes(2);
  });

  it.each([
    "prover-worker.js",
    "wasm_exec.js",
    "proof-destination.wasm",
  ])("rejects modified %s bytes", async (filename) => {
    publishedAssets(filename);
    await expect(loadVerifiedRuntime(descriptor)).rejects.toThrow("Prover executable authentication failed");
  });

  it("rejects an unpinned runtime release before making any request", async () => {
    const fetching = publishedAssets();
    await expect(
      loadVerifiedRuntime({ ...descriptor, runtime_manifest_url: "/untrusted/runtime-manifest.json" }),
    ).rejects.toThrow("application release");
    expect(fetching).not.toHaveBeenCalled();
  });
});
