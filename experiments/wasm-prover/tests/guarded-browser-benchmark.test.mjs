import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  qualifyWorkerTelemetry,
  requiredWorkerGoTelemetryFields,
} from "../runtime/common.mjs";
import {
  assertRedactedBenchmarkOutput,
  invalidateCaseOutput,
  writeCaseOutputAtomic,
} from "../runtime/guarded-output.mjs";
import {
  assertBenchmarkWorkerCount,
  assertHostEmulationProbe,
  assertHostEmulationTrace,
  benchmarkRuntimeTuning,
  hostEmulationSummaryFields,
  prepareBenchmarkRuntime,
  validateHostEmulationOptions,
} from "../runtime/host-emulation.mjs";

function options(overrides = {}) {
  return {
    baseURL: "http://127.0.0.1:8788/",
    workers: 8,
    shards: 16,
    rangeFetchConcurrency: 2,
    chunkPrefetchWindow: 2,
    gogc: "15",
    gomemlimit: "2400MiB",
    pinnedDecode: true,
    optW1: true,
    optW2: true,
    optW3: true,
    optW5: false,
    optW6: true,
    optW7: true,
    emulateHardwareConcurrency: 4,
    emulateDeviceMemoryGiB: 8,
    ...overrides,
  };
}

test("guarded benchmark CLI accepts bounded chunk prefetch windows", () => {
  const script = path.resolve(
    "experiments/wasm-prover/scripts/guarded-browser-benchmark.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [script, "--chunk-prefetch-window", "4", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--chunk-prefetch-window/);
});

test("small-host CLI values must be paired and valid", () => {
  assert.doesNotThrow(() => validateHostEmulationOptions(options()));
  assert.doesNotThrow(() =>
    validateHostEmulationOptions(
      options({
        emulateHardwareConcurrency: null,
        emulateDeviceMemoryGiB: null,
      }),
    ),
  );
  assert.throws(
    () =>
      validateHostEmulationOptions(
        options({ emulateDeviceMemoryGiB: null }),
      ),
    /must be supplied together/,
  );
  assert.throws(
    () =>
      validateHostEmulationOptions(
        options({ emulateHardwareConcurrency: 4.5 }),
      ),
    /positive safe integer/,
  );
  assert.throws(
    () =>
      validateHostEmulationOptions(options({ emulateDeviceMemoryGiB: 0 })),
    /positive number/,
  );
  assert.throws(
    () => validateHostEmulationOptions(options({ workers: 8.5 })),
    /workers must be a positive safe integer/,
  );
  assert.throws(
    () => validateHostEmulationOptions(options({ workers: 16 })),
    /at most 8 requested workers because explicit higher counts bypass the hardware clamp/,
  );
});

test("normal-host tuning remains unchanged when emulation is disabled", () => {
  assert.deepEqual(
    benchmarkRuntimeTuning(
      options({
        emulateHardwareConcurrency: null,
        emulateDeviceMemoryGiB: null,
      }),
    ),
    {
      worker_count: 8,
      shard_count: 16,
      range_fetch_concurrency: 2,
      chunk_prefetch_window: 2,
      pinned_decode: true,
      opt_w1: true,
      opt_w2: true,
      opt_w3: true,
      opt_w5: false,
      opt_w6: true,
      opt_w7: true,
    },
  );
  assert.deepEqual(hostEmulationSummaryFields(null), {});
});

test("init overrides are visible before runtime load and the w8 probe applies four workers", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const originalRequest = globalThis.__defaultProofRequest;
  const originalProbe = globalThis.probeMSMEngine;
  const events = [];
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { hardwareConcurrency: 32, deviceMemory: 64 },
    });
    globalThis.__defaultProofRequest = { tuning: {}, artifacts: {} };
    globalThis.probeMSMEngine = async (requestJSON) => {
      const request = JSON.parse(requestJSON);
      events.push(["probe", request.tuning.worker_count]);
      return {
        engine: "sharded",
        requested_tuning: request.tuning,
        applied_tuning: {
          worker_count: 4,
          shard_count: 16,
          range_fetch_concurrency: 2,
          pinned_decode: true,
          opt_w7: true,
        },
      };
    };
    const page = {
      async addInitScript(init, payload) {
        events.push(["addInitScript"]);
        init(payload);
      },
      async goto() {
        events.push([
          "runtime-load",
          navigator.hardwareConcurrency,
          navigator.deviceMemory,
        ]);
        globalThis.__proverLoaded = true;
      },
      async waitForFunction() {
        events.push(["runtime-ready"]);
      },
      async evaluate(callback, argument) {
        events.push(["evaluate"]);
        return callback(argument);
      },
    };

    const evidence = await prepareBenchmarkRuntime(page, options());
    assert.deepEqual(events.slice(0, 4), [
      ["addInitScript"],
      ["runtime-load", 4, 8],
      ["runtime-ready"],
      ["evaluate"],
    ]);
    assert.equal(evidence.verified, true);
    assert.equal(evidence.requested_worker_count, 8);
    assert.equal(evidence.expected_applied_worker_count, 4);
    assert.equal(evidence.observed_hardware_concurrency, 4);
    assert.equal(evidence.observed_device_memory_gib, 8);
    assert.equal(evidence.applied_tuning.worker_count, 4);
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      delete globalThis.navigator;
    }
    if (originalRequest === undefined) delete globalThis.__defaultProofRequest;
    else globalThis.__defaultProofRequest = originalRequest;
    if (originalProbe === undefined) delete globalThis.probeMSMEngine;
    else globalThis.probeMSMEngine = originalProbe;
    delete globalThis.__proverLoaded;
  }
});

test("emulation rejects host-worker false passes in both probe and proof trace", () => {
  const emulationOptions = options();
  assert.throws(
    () =>
      assertHostEmulationProbe(emulationOptions, {
        hardware_concurrency: 4,
        device_memory_gib: 8,
        engine_probe: {
          engine: "sharded",
          requested_tuning: { worker_count: 8 },
          applied_tuning: { worker_count: 8 },
        },
      }),
    /applied_worker_count=8, want 8\/sharded\/4/,
  );
  const evidence = assertHostEmulationProbe(emulationOptions, {
    hardware_concurrency: 4,
    device_memory_gib: 8,
    engine_probe: {
      engine: "sharded",
      requested_tuning: { worker_count: 8 },
      applied_tuning: { worker_count: 4 },
    },
  });
  assert.throws(
    () =>
      assertHostEmulationTrace(evidence, {
        engine: "streampk-sharded-groth16",
        trace: { worker_count: 8 },
      }),
    /worker_count=8, want sharded\/4/,
  );
  assert.equal(
    assertHostEmulationTrace(evidence, {
      engine: "streampk-sharded-groth16",
      trace: { worker_count: 4 },
    }).proof_trace_worker_count,
    4,
  );
  assert.deepEqual(hostEmulationSummaryFields(evidence), {
    host_emulation: evidence,
  });
});

function completeSectionTrace(workerCount) {
  return {
    worker_count: workerCount,
    events: Array.from({ length: workerCount }, (_, workerID) => ({
      phase: "measure",
      stage: "shard",
      fields: {
        operation: "MSMG1Section",
        worker_id: workerID,
        error: "",
        ...Object.fromEntries(
          requiredWorkerGoTelemetryFields.map((field, index) => [
            field,
            1000 + workerID * 100 + index,
          ]),
        ),
      },
    })),
  };
}

test("non-emulated reference rejects requested eight with a complete four-worker trace", () => {
  const referenceOptions = options({
    emulateHardwareConcurrency: null,
    emulateDeviceMemoryGiB: null,
  });
  const trace = completeSectionTrace(4);
  assert.doesNotThrow(() =>
    qualifyWorkerTelemetry(trace, { expectedWorkerCount: 4 }),
  );
  assert.throws(
    () =>
      assertBenchmarkWorkerCount(referenceOptions, null, {
        engine: "streampk-sharded-groth16",
        trace,
      }),
    /trace\.worker_count=4, want requested 8/,
  );
});

test("failed worker gate cannot leave a stale case output sentinel", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "guarded-output-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "case.json");
  await fs.writeFile(output, "STALE_ACCEPTED_SENTINEL\n");

  await invalidateCaseOutput(output);
  assert.throws(
    () =>
      assertBenchmarkWorkerCount(
        options({
          emulateHardwareConcurrency: null,
          emulateDeviceMemoryGiB: null,
        }),
        null,
        { trace: completeSectionTrace(4) },
      ),
    /want requested 8/,
  );
  await assert.rejects(fs.readFile(output), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(directory), []);
});

test("qualified case output is atomically published without temporary residue", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "guarded-output-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "case.json");
  const result = { accepted: true, worker_count: 8 };

  await writeCaseOutputAtomic(output, result);
  assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), result);
  assert.deepEqual(await fs.readdir(directory), ["case.json"]);
});

test("benchmark output redaction rejects secret values and prohibited request fields", () => {
  const privateInputs = {
    master_xprv_hex: "private-master-xprv-sentinel",
    search: { account: 0, role: 0, index: 0 },
  };
  assert.doesNotThrow(() =>
    assertRedactedBenchmarkOutput(
      {
        trace: { scalar_bytes: 4096, credential_path_redacted: true },
        artifact: { proof: "public-proof", public_inputs: ["01"] },
      },
      privateInputs,
    ),
  );
  assert.throws(
    () =>
      assertRedactedBenchmarkOutput(
        { trace: { message: `leak:${privateInputs.master_xprv_hex}` } },
        privateInputs,
      ),
    /private input value/,
  );
  for (const key of ["master_xprv_hex", "credential_path", "scalars", "proof_request"]) {
    assert.throws(
      () => assertRedactedBenchmarkOutput({ [key]: "sentinel" }, privateInputs),
      /forbidden field/,
    );
  }
});
