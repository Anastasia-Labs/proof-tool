import type { BrowserProvingDescriptor } from "../reclaim/types";
import type { BrowserCapabilityFailure, BrowserCapabilityReport } from "./types";

const NESTED_WORKER_PROBE_TIMEOUT_MS = 4000;
export const MIN_HARDWARE_CONCURRENCY = 4;
const RECOMMENDED_DEVICE_MEMORY_GIB = 8;

// Capability preflight for browser proving. Every check here runs before the
// browser method is enabled, and again immediately before proving — always
// before the recovery phrase is read. The asset preflight (signed manifests,
// vk_hash pin) is separate: see checkBrowserProving in browser-wasm.ts.
export async function checkBrowserProvingCapability(
  descriptor: BrowserProvingDescriptor | null | undefined,
): Promise<BrowserCapabilityReport> {
  const failures: BrowserCapabilityFailure[] = [];
  const warnings: string[] = [];

  if (!descriptor || !descriptor.enabled) {
    failures.push({ check: "descriptor", message: "Browser proving is not enabled for this deployment." });
  }
  if (typeof WebAssembly === "undefined" || typeof WebAssembly.instantiateStreaming !== "function") {
    failures.push({ check: "webassembly", message: "This browser does not support streaming WebAssembly." });
  }
  if (typeof Worker === "undefined") {
    failures.push({ check: "worker", message: "This browser does not support web workers." });
  }
  if (typeof fetch !== "function") {
    failures.push({ check: "fetch", message: "This browser does not support fetch." });
  }
  if (typeof crossOriginIsolated === "undefined" || crossOriginIsolated !== true) {
    failures.push({
      check: "cross-origin-isolation",
      message: "This page is not cross-origin isolated, so multi-core proving is unavailable.",
    });
  }
  if (!sharedArrayBufferAvailable()) {
    failures.push({ check: "shared-array-buffer", message: "SharedArrayBuffer is unavailable in this browser." });
  }

  const hardwareConcurrency = typeof navigator !== "undefined" && Number.isFinite(navigator.hardwareConcurrency)
    ? navigator.hardwareConcurrency
    : null;
  if (hardwareConcurrency !== null && hardwareConcurrency < MIN_HARDWARE_CONCURRENCY) {
    failures.push({
      check: "hardware-concurrency",
      message: `Proving needs at least ${MIN_HARDWARE_CONCURRENCY} CPU cores; this device reports ${hardwareConcurrency}.`,
    });
  }

  const deviceMemoryGiB = readDeviceMemoryGiB();
  if (deviceMemoryGiB !== null && deviceMemoryGiB < RECOMMENDED_DEVICE_MEMORY_GIB) {
    warnings.push(
      `This device reports ${deviceMemoryGiB} GiB of memory; proving peaks around 2.4 GiB and may fail on low-memory machines.`,
    );
  }

  // Only probe nested workers when the basics hold; the probe needs Worker + SAB.
  if (failures.length === 0) {
    const nested = await probeNestedWorkers();
    if (!nested.ok) {
      failures.push({ check: "nested-worker", message: nested.message });
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    hardwareConcurrency,
    deviceMemoryGiB,
    warnings,
  };
}

function sharedArrayBufferAvailable(): boolean {
  try {
    return typeof SharedArrayBuffer !== "undefined" && new SharedArrayBuffer(8).byteLength === 8;
  } catch {
    return false;
  }
}

function readDeviceMemoryGiB(): number | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The Go orchestrator runs in a dedicated worker and spawns the MSM workers
// itself, so nested Worker construction (plus SharedArrayBuffer transfer
// between workers) must function. Probed with inline blob workers to avoid
// touching the real runtime files.
async function probeNestedWorkers(): Promise<{ ok: boolean; message: string }> {
  const childSource = `self.onmessage = (event) => { self.postMessage({ gotSab: event.data instanceof SharedArrayBuffer }); };`;
  const parentSource = `
    const childUrl = URL.createObjectURL(new Blob([${JSON.stringify(childSource)}], { type: "text/javascript" }));
    try {
      const child = new Worker(childUrl);
      child.onmessage = (event) => {
        self.postMessage({ ok: event.data && event.data.gotSab === true, isolated: self.crossOriginIsolated === true });
        child.terminate();
      };
      child.onerror = () => { self.postMessage({ ok: false, error: "nested worker failed to start" }); };
      child.postMessage(new SharedArrayBuffer(8));
    } catch (error) {
      self.postMessage({ ok: false, error: "nested worker construction threw" });
    }
  `;
  const parentUrl = URL.createObjectURL(new Blob([parentSource], { type: "text/javascript" }));
  const workerRef: { current: Worker | null } = { current: null };
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<{ ok: boolean; message: string }>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({ ok: false, message: "Nested worker support check timed out." });
      }, NESTED_WORKER_PROBE_TIMEOUT_MS);
      let worker: Worker;
      try {
        worker = new Worker(parentUrl);
      } catch {
        resolve({ ok: false, message: "This browser blocked worker creation." });
        return;
      }
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<{ ok?: boolean; isolated?: boolean; error?: string }>) => {
        if (event.data?.ok === true && event.data.isolated === true) {
          resolve({ ok: true, message: "" });
        } else if (event.data?.ok === true) {
          resolve({ ok: false, message: "Workers are not cross-origin isolated in this browser." });
        } else {
          resolve({ ok: false, message: "This browser cannot start nested workers." });
        }
      };
      worker.onerror = () => {
        resolve({ ok: false, message: "This browser cannot start the proving worker." });
      };
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    workerRef.current?.terminate();
    URL.revokeObjectURL(parentUrl);
  }
}
