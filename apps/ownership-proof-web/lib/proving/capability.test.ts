import { afterEach, describe, expect, it, vi } from "vitest";
import { checkBrowserProvingCapability } from "./capability";
import type { BrowserProvingDescriptor } from "../reclaim/types";

function descriptor(enabled = true): BrowserProvingDescriptor {
  return {
    enabled,
    runtime_base_url: "/proof-runtime",
    manifest_url: "/proof-assets/manifest.json",
    manifest_sig_url: "/proof-assets/manifest.sig",
    manifest_public_key_hex: "aa".repeat(32),
    chunk_manifest_url: "/proof-assets/chunk-manifest.json",
    chunk_manifest_sig_url: "/proof-assets/chunk-manifest.sig",
    chunk_manifest_public_key_hex: "bb".repeat(32),
    deployment_manifest_url: "/proof-assets/reclaim-deployment.json",
    vk_url: "/proof-assets/ownership.vk",
    pk_url: "https://assets.example.com/ownership.pk",
    pk_index_url: "/proof-assets/ownership.pk.idx.json",
    ccs_url: "https://assets.example.com/ownership.ccs",
    ccs_blake2b256: "blake2b256:" + "cc".repeat(32),
    proof_wasm_url: "/proof-runtime/proof-destination.wasm",
    worker_js_url: "/proof-runtime/msm-worker.js",
    msm_worker_wasm_url: "/proof-runtime/msmworker.wasm",
  };
}

function stubCapable(overrides: { hardwareConcurrency?: number; deviceMemory?: number; nestedOk?: boolean } = {}): void {
  const nestedOk = overrides.nestedOk ?? true;
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("WebAssembly", { instantiateStreaming: () => Promise.resolve() } as unknown as typeof WebAssembly);
  vi.stubGlobal("fetch", () => Promise.resolve());
  vi.stubGlobal("SharedArrayBuffer", class {
    byteLength = 8;
  });
  vi.stubGlobal("navigator", {
    hardwareConcurrency: overrides.hardwareConcurrency ?? 8,
    deviceMemory: overrides.deviceMemory ?? 16,
  });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor() {
        queueMicrotask(() => {
          if (nestedOk) {
            this.onmessage?.({ data: { ok: true, isolated: true } });
          } else {
            this.onmessage?.({ data: { ok: false } });
          }
        });
      }
      postMessage(): void {}
      terminate(): void {}
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkBrowserProvingCapability", () => {
  it("passes on a fully capable, isolated environment", async () => {
    stubCapable();
    const report = await checkBrowserProvingCapability(descriptor());
    expect(report.ok).toBe(true);
    expect(report.failures).toHaveLength(0);
    expect(report.hardwareConcurrency).toBe(8);
    expect(report.deviceMemoryGiB).toBe(16);
  });

  it("fails with the descriptor check when browser proving is disabled", async () => {
    stubCapable();
    const report = await checkBrowserProvingCapability(descriptor(false));
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => f.check)).toContain("descriptor");
  });

  it("fails with the descriptor check when no descriptor is present", async () => {
    stubCapable();
    const report = await checkBrowserProvingCapability(null);
    expect(report.failures.map((f) => f.check)).toContain("descriptor");
  });

  it("fails cross-origin-isolation when the page is not isolated", async () => {
    stubCapable();
    vi.stubGlobal("crossOriginIsolated", false);
    const report = await checkBrowserProvingCapability(descriptor());
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => f.check)).toContain("cross-origin-isolation");
  });

  it("fails hardware-concurrency below the minimum", async () => {
    stubCapable({ hardwareConcurrency: 2 });
    const report = await checkBrowserProvingCapability(descriptor());
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => f.check)).toContain("hardware-concurrency");
  });

  it("warns but does not fail on low device memory", async () => {
    stubCapable({ deviceMemory: 4 });
    const report = await checkBrowserProvingCapability(descriptor());
    expect(report.ok).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/memory/i);
  });

  it("fails nested-worker when the probe cannot start a child worker", async () => {
    stubCapable({ nestedOk: false });
    const report = await checkBrowserProvingCapability(descriptor());
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => f.check)).toContain("nested-worker");
  });

  it("does not run the nested-worker probe when a basic check already failed", async () => {
    // Isolation fails → probe is skipped. Worker is deliberately left absent so
    // that if the probe wrongly ran it would surface, not a nested-worker pass.
    stubCapable();
    vi.stubGlobal("crossOriginIsolated", false);
    vi.stubGlobal("Worker", undefined);
    const report = await checkBrowserProvingCapability(descriptor());
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => f.check)).toContain("cross-origin-isolation");
    expect(report.failures.map((f) => f.check)).not.toContain("nested-worker");
  });
});
