import type { BrowserProvingDescriptor } from "../reclaim/types";
import type { BrowserCapabilityFailure, BrowserCapabilityReport } from "./types";
import type { BrowserCalibrationSummary } from "./diagnostic";

const NESTED_WORKER_PROBE_TIMEOUT_MS = 4000;
export const MIN_HARDWARE_CONCURRENCY = 4;
const RECOMMENDED_DEVICE_MEMORY_GIB = 8;
const CALIBRATION_TIMEOUT_MS = 3000;
const CALIBRATION_WORKER_BYTES = 2 * 1024 * 1024;
const CALIBRATION_FLOOR = 8;
const CALIBRATION_CAP = 16;
const CALIBRATION_RESERVED_THREADS = 2;

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


// W5 grows from the safe eight-worker floor only after this browser proves it
// can create and touch the additional worker memory. deviceMemory is advisory:
// browsers that omit it can still reach 12/16 when CPU and calibration agree.
export async function calibrateBrowserWorkerCapacity(
  descriptor: BrowserProvingDescriptor,
): Promise<BrowserCalibrationSummary> {
  const startedAt = performance.now();
  const explicit = descriptor.tuning?.worker_count;
  if (Number.isSafeInteger(explicit) && Number(explicit) > 0) {
    return calibrationResult([], Math.min(CALIBRATION_CAP, Number(explicit)), startedAt, "deployment-pinned");
  }
  if (descriptor.tuning?.opt_w5 !== true) {
    return calibrationResult([], CALIBRATION_FLOOR, startedAt, "adaptive-workers-disabled");
  }
  const memory = readDeviceMemoryGiB();
  if (memory !== null && memory < RECOMMENDED_DEVICE_MEMORY_GIB) {
    return calibrationResult([], CALIBRATION_FLOOR, startedAt, "reported-memory-below-floor");
  }
  const cores =
    typeof navigator !== "undefined" && Number.isFinite(navigator.hardwareConcurrency)
      ? Math.floor(navigator.hardwareConcurrency)
      : null;
  if (cores === null || cores - CALIBRATION_RESERVED_THREADS < 12) {
    return calibrationResult([], CALIBRATION_FLOOR, startedAt, "insufficient-or-unknown-cpu-capacity");
  }
  const target = Math.min(CALIBRATION_CAP, cores - CALIBRATION_RESERVED_THREADS);
  const stages = [CALIBRATION_FLOOR, 12, 16].filter((count) => count <= target);
  const attemptedWorkerCounts: number[] = [];
  const workers: Worker[] = [];
  const source =
    "self.onmessage=()=>{try{const b=new Uint8Array(" +
    CALIBRATION_WORKER_BYTES +
    ");for(let i=0;i<b.length;i+=4096)b[i]=i&255;self.postMessage({ok:true});}catch(e){self.postMessage({ok:false});}}";
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  let applied = CALIBRATION_FLOOR;
  try {
    for (const count of stages) {
      attemptedWorkerCounts.push(count);
      if (!(await growCalibrationPool(workers, count, url))) {
        return calibrationResult(attemptedWorkerCounts, applied, startedAt, "calibration-stopped");
      }
      applied = count;
    }
    return calibrationResult(attemptedWorkerCounts, applied, startedAt, "calibration-passed");
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(url);
  }
}

async function growCalibrationPool(
  workers: Worker[],
  count: number,
  url: string,
): Promise<boolean> {
  const additions: Worker[] = [];
  try {
    while (workers.length < count) {
      const worker = new Worker(url);
      workers.push(worker);
      additions.push(worker);
    }
  } catch {
    return false;
  }
  return await Promise.race([
    Promise.all(
      additions.map(
        (worker) =>
          new Promise<boolean>((resolve) => {
            worker.onmessage = (event: MessageEvent<{ ok?: boolean }>) =>
              resolve(event.data?.ok === true);
            worker.onerror = () => resolve(false);
            worker.postMessage(null);
          }),
      ),
    ).then((values) => values.every(Boolean)),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), CALIBRATION_TIMEOUT_MS),
    ),
  ]);
}

function calibrationResult(
  attemptedWorkerCounts: number[],
  appliedWorkerCount: number,
  startedAt: number,
  reason: string,
): BrowserCalibrationSummary {
  return {
    attemptedWorkerCounts,
    appliedWorkerCount,
    durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    reason,
  };
}
