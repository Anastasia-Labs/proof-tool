// @vitest-environment node
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import deployment from "../../public/proof-assets/reclaim-deployment.json";
import preprodDeployment from "../../public/proof-releases/proof-assets-ownership-destination-v3-preprod-191ca93-opt-reclaim-07d48bc5-r1/assets/reclaim-deployment.json";
import type { BrowserProvingDescriptor } from "../reclaim/types";
let loadVerifiedRuntime: typeof import("./runtime").loadVerifiedRuntime;

const descriptor = deployment.proof.browser_proving as BrowserProvingDescriptor;
const origin = "https://app.test";

function publishedAssets(tamper?: string, pageOrigin = origin) {
  vi.stubGlobal("window", { location: { origin: pageOrigin } });
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  vi.resetModules();
  ({ loadVerifiedRuntime } = await import("./runtime"));
});

describe("runtime authentication", () => {
  it("authenticates the separately pinned Preprod runtime only for the local test build", async () => {
    vi.stubEnv("NEXT_PUBLIC_RECLAIM_LOCAL_PREPROD", "1");
    const fetching = publishedAssets(undefined, "http://127.0.0.1:3917");
    const runtime = await loadVerifiedRuntime(preprodDeployment.proof.browser_proving as BrowserProvingDescriptor);
    try {
      expect(Object.keys(runtime.config.assets)).toHaveLength(5);
      expect(fetching).toHaveBeenCalledTimes(7);
    } finally {
      runtime.dispose();
    }
  });

  it("rejects Preprod runtime substitution in a normal localhost build", async () => {
    vi.stubEnv("NEXT_PUBLIC_RECLAIM_LOCAL_PREPROD", "0");
    const fetching = publishedAssets(undefined, "http://127.0.0.1:3917");
    await expect(
      loadVerifiedRuntime(preprodDeployment.proof.browser_proving as BrowserProvingDescriptor),
    ).rejects.toThrow("application release");
    expect(fetching).not.toHaveBeenCalled();
  });

  it("rejects Preprod runtime substitution on a hosted origin even with the local flag", async () => {
    vi.stubEnv("NEXT_PUBLIC_RECLAIM_LOCAL_PREPROD", "1");
    const fetching = publishedAssets();
    await expect(
      loadVerifiedRuntime(preprodDeployment.proof.browser_proving as BrowserProvingDescriptor),
    ).rejects.toThrow("application release");
    expect(fetching).not.toHaveBeenCalled();
  });

  it("still rejects altered executable bytes in the local Preprod runtime", async () => {
    vi.stubEnv("NEXT_PUBLIC_RECLAIM_LOCAL_PREPROD", "1");
    publishedAssets("msmworker.wasm", "http://127.0.0.1:3917");
    await expect(
      loadVerifiedRuntime(preprodDeployment.proof.browser_proving as BrowserProvingDescriptor),
    ).rejects.toThrow("Prover executable authentication failed");
  });

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
    "msm-worker.js",
    "msmworker.wasm",
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

  it("reuses immutable verified bytes with fresh session URLs and still authenticates the manifest", async () => {
    const fetching = publishedAssets();
    const first = await loadVerifiedRuntime(descriptor);
    first.dispose();
    const second = await loadVerifiedRuntime(descriptor);
    try {
      expect(fetching).toHaveBeenCalledTimes(9);
      expect(Object.values(second.config.assets)).not.toEqual(Object.values(first.config.assets));
    } finally {
      second.dispose();
    }
    publishedAssets("chunk-manifest.json");
    await expect(loadVerifiedRuntime(descriptor)).rejects.toThrow("Chunk manifest authentication failed");
  });

  it("does not cache a failed executable check", async () => {
    publishedAssets("msmworker.wasm");
    await expect(loadVerifiedRuntime(descriptor)).rejects.toThrow("Prover executable authentication failed");
    const fetching = publishedAssets();
    const runtime = await loadVerifiedRuntime(descriptor);
    runtime.dispose();
    expect(fetching).toHaveBeenCalledTimes(7);
  });

  it("checks executable URLs even when verified bytes are cached", async () => {
    const fetching = publishedAssets();
    const runtime = await loadVerifiedRuntime(descriptor);
    runtime.dispose();
    await expect(loadVerifiedRuntime({ ...descriptor, prover_worker_js_url: "/untrusted/worker.js" })).rejects.toThrow(
      "Runtime executable URL is inconsistent",
    );
    expect(fetching).toHaveBeenCalledTimes(7);
  });

  it("authenticates another runtime base instead of reusing the previous base's cache", async () => {
    publishedAssets();
    const runtime = await loadVerifiedRuntime(descriptor);
    runtime.dispose();
    const changed = { ...descriptor };
    for (const field of [
      "runtime_base_url",
      "prover_worker_js_url",
      "wasm_exec_js_url",
      "proof_wasm_url",
      "worker_js_url",
      "msm_worker_wasm_url",
    ] as const)
      changed[field] = new URL(descriptor[field], "https://other.test").href;
    const fetching = publishedAssets("msmworker.wasm");
    await expect(loadVerifiedRuntime(changed)).rejects.toThrow("Prover executable authentication failed");
    expect(fetching).toHaveBeenCalledTimes(7);
  });
});
