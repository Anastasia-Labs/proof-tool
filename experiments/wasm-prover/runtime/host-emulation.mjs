const DEFAULT_ENGINE_WORKER_CAP = 8;

export function hostEmulationConfig(options) {
  const hardwareConcurrency = options.emulateHardwareConcurrency ?? null;
  const deviceMemoryGiB = options.emulateDeviceMemoryGiB ?? null;
  if (hardwareConcurrency === null && deviceMemoryGiB === null) return null;
  return { hardwareConcurrency, deviceMemoryGiB };
}

export function validateHostEmulationOptions(options) {
  const config = hostEmulationConfig(options);
  if (config === null) return;
  if (config.hardwareConcurrency === null || config.deviceMemoryGiB === null) {
    throw new Error(
      "emulate_hardware_concurrency and emulate_device_memory_gib must be supplied together",
    );
  }
  if (
    !Number.isSafeInteger(config.hardwareConcurrency) ||
    config.hardwareConcurrency <= 0
  ) {
    throw new Error(
      "emulate_hardware_concurrency must be a positive safe integer",
    );
  }
  if (!Number.isFinite(config.deviceMemoryGiB) || config.deviceMemoryGiB <= 0) {
    throw new Error("emulate_device_memory_gib must be a positive number");
  }
  if (!Number.isSafeInteger(options.workers) || options.workers <= 0) {
    throw new Error("workers must be a positive safe integer for host emulation");
  }
  if (options.workers > DEFAULT_ENGINE_WORKER_CAP) {
    throw new Error(
      `host emulation supports at most ${DEFAULT_ENGINE_WORKER_CAP} requested workers because explicit higher counts bypass the hardware clamp`,
    );
  }
}

export function benchmarkRuntimeTuning(options) {
  return {
    worker_count: options.workers,
    shard_count: options.shards,
    range_fetch_concurrency: options.rangeFetchConcurrency,
    chunk_prefetch_window: options.chunkPrefetchWindow,
    ...(options.chunkReadahead === null || options.chunkReadahead === undefined
      ? {}
      : { chunk_readahead: options.chunkReadahead }),
    ...(options.pinnedDecode === null
      ? {}
      : { pinned_decode: options.pinnedDecode }),
    ...(options.optW1 === null ? {} : { opt_w1: options.optW1 }),
    ...(options.optW2 === null ? {} : { opt_w2: options.optW2 }),
    ...(options.optW3 === null ? {} : { opt_w3: options.optW3 }),
    ...(options.optW5 === null ? {} : { opt_w5: options.optW5 }),
    ...(options.optW6 === null ? {} : { opt_w6: options.optW6 }),
    ...(options.optW7 === null ? {} : { opt_w7: options.optW7 }),
    ...(options.optW8 === null || options.optW8 === undefined
      ? {}
      : { opt_w8: options.optW8 }),
  };
}

// AGENTS.md: master XPrvs must stay local. Injecting private inputs into a
// page hands them to every script the harness origin serves, so anything
// beyond loopback requires an explicit operator acknowledgment plus https —
// the operator is asserting they control the deployment and the inputs are
// expendable benchmark keys.
export function assertPrivateInputBoundary(options) {
  if (!options.privateInputs || typeof options.privateInputs !== "object") {
    return;
  }
  const url = new URL(options.baseURL);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (loopback) return;
  if (options.acceptRemoteHarnessPrivateInputExposure !== true) {
    throw new Error(
      "refusing to inject private inputs into the non-loopback harness origin " +
        url.origin +
        ": scripts served by that origin can read them. Pass " +
        "--accept-remote-harness-private-input-exposure only if you control " +
        "the deployment and the inputs are expendable benchmark keys.",
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      "a non-loopback harness receiving private inputs must be served over https",
    );
  }
}

export async function installBenchmarkPageInit(page, options) {
  assertPrivateInputBoundary(options);
  await page.addInitScript(
    ({ gogc, gomemlimit, hardwareConcurrency, deviceMemoryGiB, privateInputs }) => {
      globalThis.__GOGC = gogc;
      globalThis.__GOMEMLIMIT = gomemlimit;
      if (privateInputs && typeof privateInputs === "object") {
        globalThis.__benchmarkPrivateRequest = structuredClone(privateInputs);
      }
      if (Number.isSafeInteger(hardwareConcurrency) && hardwareConcurrency > 0) {
        Object.defineProperty(navigator, "hardwareConcurrency", {
          configurable: true,
          get: () => hardwareConcurrency,
        });
      }
      if (Number.isFinite(deviceMemoryGiB) && deviceMemoryGiB > 0) {
        Object.defineProperty(navigator, "deviceMemory", {
          configurable: true,
          get: () => deviceMemoryGiB,
        });
      }
    },
    {
      gogc: options.gogc,
      gomemlimit: options.gomemlimit,
      hardwareConcurrency: options.emulateHardwareConcurrency,
      deviceMemoryGiB: options.emulateDeviceMemoryGiB,
      privateInputs: options.privateInputs || null,
    },
  );
}

export async function navigateAndProbeBenchmarkRuntime(page, options) {
  await page.goto(options.baseURL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.__proverLoaded === true, null, {
    timeout: 0,
  });
  const config = hostEmulationConfig(options);
  if (config === null) return null;
  const tuning = benchmarkRuntimeTuning(options);
  const observed = await page.evaluate(async (runtimeTuning) => {
    if (typeof globalThis.probeMSMEngine !== "function") {
      throw new Error("host emulation requires probeMSMEngine");
    }
    const request = structuredClone(globalThis.__defaultProofRequest);
    request.tuning = { ...(request.tuning || {}), ...runtimeTuning };
    return {
      hardware_concurrency: navigator.hardwareConcurrency,
      device_memory_gib:
        typeof navigator.deviceMemory === "number"
          ? navigator.deviceMemory
          : null,
      engine_probe: await globalThis.probeMSMEngine(JSON.stringify(request)),
    };
  }, tuning);
  return assertHostEmulationProbe(options, observed);
}

export async function prepareBenchmarkRuntime(page, options) {
  await installBenchmarkPageInit(page, options);
  return navigateAndProbeBenchmarkRuntime(page, options);
}

export function assertHostEmulationProbe(options, observed) {
  validateHostEmulationOptions(options);
  const config = hostEmulationConfig(options);
  if (config === null) return null;
  if (observed?.hardware_concurrency !== config.hardwareConcurrency) {
    throw new Error(
      `host emulation observed navigator.hardwareConcurrency=${String(observed?.hardware_concurrency)}, want ${config.hardwareConcurrency}`,
    );
  }
  if (observed?.device_memory_gib !== config.deviceMemoryGiB) {
    throw new Error(
      `host emulation observed navigator.deviceMemory=${String(observed?.device_memory_gib)}, want ${config.deviceMemoryGiB}`,
    );
  }
  const expectedWorkerCount = Math.min(
    options.workers,
    config.hardwareConcurrency,
    DEFAULT_ENGINE_WORKER_CAP,
  );
  const expectedEngine = expectedWorkerCount > 1 ? "sharded" : "cpu";
  const probe = observed?.engine_probe;
  const appliedWorkerCount = probe?.applied_tuning?.worker_count;
  if (
    probe?.requested_tuning?.worker_count !== options.workers ||
    probe?.engine !== expectedEngine ||
    appliedWorkerCount !== expectedWorkerCount
  ) {
    throw new Error(
      `host emulation engine probe requested=${String(probe?.requested_tuning?.worker_count)} selected=${String(probe?.engine)} applied_worker_count=${String(appliedWorkerCount)}, want ${options.workers}/${expectedEngine}/${expectedWorkerCount}`,
    );
  }
  return {
    schema: "wasm-prover-host-emulation-evidence-v1",
    verified: true,
    requested_worker_count: options.workers,
    expected_applied_worker_count: expectedWorkerCount,
    observed_hardware_concurrency: observed.hardware_concurrency,
    observed_device_memory_gib: observed.device_memory_gib,
    engine: probe.engine,
    applied_tuning: probe.applied_tuning,
  };
}

export function assertHostEmulationTrace(evidence, result) {
  if (evidence === null) return null;
  const traceWorkerCount = result?.trace?.worker_count;
  const engine = String(result?.engine || "");
  if (
    !engine.includes(`-${evidence.engine}-`) ||
    traceWorkerCount !== evidence.expected_applied_worker_count
  ) {
    throw new Error(
      `host emulation proof trace selected=${engine || "unknown"} worker_count=${String(traceWorkerCount)}, want ${evidence.engine}/${evidence.expected_applied_worker_count}`,
    );
  }
  return { ...evidence, proof_trace_worker_count: traceWorkerCount };
}

// Host emulation has a separately verified applied count. A normal reference
// run has no such override, so its proof trace itself must independently prove
// that the requested worker count was honored. This prevents a complete
// four-worker telemetry shape from qualifying a requested-eight reference.
export function assertBenchmarkWorkerCount(options, evidence, result) {
  if (evidence !== null) {
    const qualifiedEvidence = assertHostEmulationTrace(evidence, result);
    return {
      expectedWorkerCount: qualifiedEvidence.expected_applied_worker_count,
      hostEmulation: qualifiedEvidence,
    };
  }
  const traceWorkerCount = result?.trace?.worker_count;
  if (traceWorkerCount !== options.workers) {
    throw new Error(
      `non-emulated benchmark trace.worker_count=${String(traceWorkerCount)}, want requested ${options.workers}`,
    );
  }
  return {
    expectedWorkerCount: options.workers,
    hostEmulation: null,
  };
}

export function hostEmulationSummaryFields(evidence) {
  return evidence === null || evidence === undefined
    ? {}
    : { host_emulation: evidence };
}
