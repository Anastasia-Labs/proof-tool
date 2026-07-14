#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

import {
  contaminationSnapshot,
  createContaminationTracker,
  evaluateContamination,
  observeContamination,
} from "../runtime/contamination.mjs";
import { qualifyWorkerTelemetry } from "../runtime/common.mjs";
import {
  assertRedactedBenchmarkOutput,
  invalidateCaseOutput,
  writeCaseOutputAtomic,
} from "../runtime/guarded-output.mjs";
import {
  assertBenchmarkWorkerCount,
  benchmarkRuntimeTuning,
  hostEmulationSummaryFields,
  installBenchmarkPageInit,
  navigateAndProbeBenchmarkRuntime,
  validateHostEmulationOptions,
} from "../runtime/host-emulation.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const require = createRequire(import.meta.url);
const { chromium } = require(
  path.join(repoRoot, "apps/ownership-proof-web/node_modules/playwright"),
);

const defaults = {
  baseURL: "http://127.0.0.1:8788/",
  outputDir: path.join(repoRoot, "experiments/wasm-prover/output"),
  caseName: "guarded-w8-s32-rf2",
  workers: 8,
  shards: 32,
  rangeFetchConcurrency: 2,
  chunkPrefetchWindow: 2,
  artifactOverridesFile: "",
  artifactOverrides: null,
  privateInputsFile: "",
  privateInputs: null,
  browserCookieFile: "",
  browserCookies: [],
  browserProfileDir: "",
  cacheMode: "cold",
  preflightSeconds: 30,
  sampleMs: 5000,
  maxLoadPerCore: 0.35,
  minPreflightIdlePercent: 75,
  maxExternalProcessCpuPercent: 25,
  maxExternalTotalCpuPercent: 75,
  maxMemoryPressureSomeAvg10: 2,
  contaminationSamples: 3,
  abortOnContamination: true,
  allowBusyPreflight: false,
  preflightOnly: false,
  gomemlimit: "3200MiB",
  gogc: "15",
  cpuList: "",
  pinnedDecode: null,
  optW1: null,
  optW2: null,
  optW3: null,
  optW5: null,
  optW6: null,
  optW7: null,
  emulateHardwareConcurrency: null,
  emulateDeviceMemoryGiB: null,
};

const opts = parseArgs(process.argv.slice(2), defaults);
if (opts.artifactOverridesFile) {
  opts.artifactOverrides = JSON.parse(
    await fs.readFile(opts.artifactOverridesFile, "utf8"),
  );
}
if (opts.privateInputsFile) {
  opts.privateInputs = JSON.parse(
    await fs.readFile(opts.privateInputsFile, "utf8"),
  );
}
validatePrivateInputs(opts.privateInputs);
if (opts.browserCookieFile) {
  opts.browserCookies = parseNetscapeCookies(
    await fs.readFile(opts.browserCookieFile, "utf8"),
  );
}
await fs.mkdir(opts.outputDir, { recursive: true });
const affinity = await applyAffinity(opts.cpuList);

const outputPath = path.join(opts.outputDir, `${opts.caseName}.json`);
const telemetryPath = path.join(
  opts.outputDir,
  `${opts.caseName}.telemetry.jsonl`,
);
const summaryPath = path.join(opts.outputDir, `${opts.caseName}.summary.json`);

const startedAt = new Date().toISOString();
await invalidateCaseOutput(outputPath);
await fs.writeFile(telemetryPath, "");

const preflight = await runPreflight(opts);
if (!preflight.ok && !opts.allowBusyPreflight) {
  const summary = buildSummary({
    opts,
    affinity,
    startedAt,
    outputPath,
    telemetryPath,
    summaryPath,
    preflight,
    run: null,
    contaminated: true,
    aborted: true,
    abortReason: "preflight_failed",
  });
  await writeSummary(summaryPath, summary);
  console.error(JSON.stringify(summary, null, 2));
  process.exit(2);
}

if (opts.preflightOnly) {
  const summary = buildSummary({
    opts,
    affinity,
    startedAt,
    outputPath,
    telemetryPath,
    summaryPath,
    preflight,
    run: null,
    contaminated: !preflight.ok,
    aborted: false,
    abortReason: "",
  });
  await writeSummary(summaryPath, summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const run = await runBrowserBenchmark(
  opts,
  outputPath,
  telemetryPath,
  preflight,
);
const summary = buildSummary({
  opts,
  affinity,
  startedAt,
  outputPath,
  telemetryPath,
  summaryPath,
  preflight,
  run,
  contaminated: !preflight.ok || run.contaminated,
  aborted: run.aborted,
  abortReason: run.abortReason,
});
await writeSummary(summaryPath, summary);

if (run.ok) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(run.aborted ? 3 : 1);
}

async function runPreflight(options) {
  const samples = [];
  const endAt = Date.now() + options.preflightSeconds * 1000;
  let previousCPU = readCPUStat();
  while (Date.now() < endAt || samples.length < 2) {
    await sleep(Math.min(1000, Math.max(250, endAt - Date.now())));
    const sample = await collectSample(
      "preflight",
      previousCPU,
      new Set([process.pid]),
      options,
    );
    previousCPU = sample.rawCPU;
    delete sample.rawCPU;
    samples.push(sample);
    await appendJSONL(telemetryPath, sample);
  }
  const contamination = evaluateContamination(
    samples.map((sample) => preflightReasons(sample, options)),
    options.contaminationSamples,
  );
  return {
    ok: !contamination.contaminated,
    reasons: contamination.confirmedReasons,
    observedReasons: contamination.observedReasons,
    maxConsecutiveContaminatedSamples: contamination.maxConsecutive,
    samples,
  };
}

async function runBrowserBenchmark(
  options,
  proofOutputPath,
  telemetryFile,
  preflight,
) {
  let browser;
  let page;
  let monitor;
  let aborted = false;
  let abortReason = "";
  const runSamples = [];
  const contamination = createContaminationTracker(
    options.contaminationSamples,
  );
  const monitorErrors = [];
  const started = Date.now();
  let hostEmulation = null;
  const deliveryResponses = [];
  const responseHeaderTasks = [];
  try {
    if (options.browserProfileDir) {
      await fs.mkdir(options.browserProfileDir, { recursive: true });
      browser = await chromium.launchPersistentContext(
        options.browserProfileDir,
        { headless: true, chromiumSandbox: false },
      );
      page = await browser.newPage();
    } else {
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: false,
      });
      page = await browser.newPage();
    }
    if (options.cacheMode === "cold") {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.clearBrowserCache");
      await cdp.detach();
    }
    if (options.browserCookies.length > 0) {
      await page.context().addCookies(options.browserCookies);
    }
    page.setDefaultTimeout(0);
    page.on("response", (response) => {
      responseHeaderTasks.push(
        response.allHeaders().then((headers) => {
          const cacheStatus = headers["cf-cache-status"];
          if (!cacheStatus) return;
          const url = response.url();
          deliveryResponses.push({
            kind: /ccs(?:$|[?.])/u.test(url)
              ? "ccs"
              : /(?:chunk|\.bin)(?:$|[/?._-])/u.test(url)
                ? "pk-chunk"
                : "public-asset",
            cache_status: cacheStatus,
            age_seconds: Number(headers.age || 0),
            status: response.status(),
          });
        }),
      );
    });
    await installBenchmarkPageInit(page, options);

    let previousCPU = readCPUStat();
    monitor = setInterval(async () => {
      try {
        const ownPids = await descendantPIDs(process.pid);
        const sample = await collectSample(
          "run",
          previousCPU,
          ownPids,
          options,
        );
        previousCPU = sample.rawCPU;
        delete sample.rawCPU;
        runSamples.push(sample);
        await appendJSONL(telemetryFile, sample);
        const reasons = runContaminationReasons(sample, options);
        observeContamination(contamination, reasons);
        if (options.abortOnContamination && contamination.contaminated) {
          aborted = true;
          abortReason = `contamination_detected:${contaminationSnapshot(contamination).confirmedReasons.join(",")}`;
          clearInterval(monitor);
          monitor = null;
          await browser.close().catch(() => {});
        }
      } catch (err) {
        monitorErrors.push(`monitor_error:${err.message}`);
      }
    }, options.sampleMs);

    hostEmulation = await navigateAndProbeBenchmarkRuntime(page, options);
    const runtimeTuning = benchmarkRuntimeTuning(options);

    const result = await page.evaluate(
      async (testCase) => {
        const req = structuredClone(globalThis.__defaultProofRequest);
        req.tuning = { ...(req.tuning || {}), ...(testCase.tuning || {}) };
        req.artifacts = {
          ...(req.artifacts || {}),
          ...(testCase.artifacts || {}),
        };
        const flowStarted = performance.now();
        const preparedStarted = performance.now();
        const prepared = await globalThis.preflightProofAssets(
          JSON.stringify({
            artifacts: req.artifacts,
            tuning: req.tuning,
          }),
        );
        const preparedMS = performance.now() - preparedStarted;
        const result = await globalThis.proveDestination(
          JSON.stringify(req),
          (progress) => {
            const stage = document.getElementById("stage");
            if (stage)
              stage.textContent = `${testCase.name}: ${progress.stage}`;
          },
        );
        const keyManifestRaw = await (
          await fetch(req.artifacts.manifest_url)
        ).text();
        const keyManifest = JSON.parse(keyManifestRaw);
        const chunkManifestRaw = await (
          await fetch(req.artifacts.chunk_manifest_url)
        ).text();
        const chunkManifest = JSON.parse(chunkManifestRaw);
        const deploymentResponse = await fetch(
          req.artifacts.deployment_manifest_url,
        );
        const deploymentManifestRaw = await deploymentResponse.text();
        if (!deploymentResponse.ok) {
          throw new Error(
            `deployment manifest fetch returned ${deploymentResponse.status}`,
          );
        }
        const sha256 = async (raw) => {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(raw),
          );
          return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        };
        const keyManifestSHA256 = await sha256(keyManifestRaw);
        if (chunkManifest.coherence.key_manifest_sha256 !== keyManifestSHA256) {
          throw new Error(
            "key manifest raw SHA-256 disagrees with chunk-manifest coherence",
          );
        }
        // The patched prover records only a numeric work count under the
        // historical `scalars` key. Rename that aggregate before it crosses
        // the diagnostic boundary; non-numeric values fail closed.
        for (const event of result.trace?.events || []) {
          if (!Object.hasOwn(event.fields || {}, "scalars")) continue;
          if (typeof event.fields.scalars !== "number") {
            throw new Error("proof trace contains non-numeric scalar data");
          }
          event.fields.scalar_count = event.fields.scalars;
          delete event.fields.scalars;
        }
        return {
          name: testCase.name,
          tuning: req.tuning,
          wall_seconds: result.wall_seconds,
          prove_ms: result.ms,
          prepared_preflight_ms: preparedMS,
          prepared_preflight: prepared,
          prepared_flow_ms: performance.now() - flowStarted,
          peak_heap_gib: result.peak_heap_gib,
          engine: result.engine,
          runtime_options: result.runtime_options,
          verified_locally: result.verified_locally,
          trace: result.trace,
          asset_identity: {
            key_manifest_sha256: keyManifestSHA256,
            key_manifest_blake2b256:
              chunkManifest.coherence.key_manifest_blake2b256,
            chunk_manifest_sha256: await sha256(chunkManifestRaw),
            deployment_manifest_sha256: await sha256(deploymentManifestRaw),
            proving_key_sha256: keyManifest.proving_key_sha256,
            proving_key_blake2b256: keyManifest.proving_key_blake2b256,
            constraint_system_hash: keyManifest.constraint_system_hash,
            verifying_key_sha256: keyManifest.verifying_key_sha256,
            vk_hash: keyManifest.vk_hash,
            circuit_id: keyManifest.circuit_id,
            key_version: keyManifest.key_version,
          },
        };
      },
      {
        name: options.caseName,
        tuning: runtimeTuning,
        artifacts: options.artifactOverrides,
      },
    );

    await Promise.all(responseHeaderTasks);
    result.delivery_observations = deliveryResponses;

    if (
      options.optW1 !== null &&
      result.runtime_options?.w1 !== options.optW1
    ) {
      throw new Error(
        `runtime did not acknowledge opt_w1=${options.optW1}: ${JSON.stringify(result.runtime_options)}`,
      );
    }
    if (
      options.optW2 !== null &&
      result.runtime_options?.w2 !== options.optW2
    ) {
      throw new Error(
        `runtime did not acknowledge opt_w2=${options.optW2}: ${JSON.stringify(result.runtime_options)}`,
      );
    }
    if (
      options.optW3 !== null &&
      result.runtime_options?.w3 !== options.optW3
    ) {
      throw new Error(
        `runtime did not acknowledge opt_w3=${options.optW3}: ${JSON.stringify(result.runtime_options)}`,
      );
    }
    if (
      options.optW6 !== null &&
      result.runtime_options?.w6 !== options.optW6
    ) {
      throw new Error(
        `runtime did not acknowledge opt_w6=${options.optW6}: ${JSON.stringify(result.runtime_options)}`,
      );
    }
    if (
      options.optW5 !== null &&
      result.runtime_options?.w5 !== options.optW5
    ) {
      throw new Error(
        `runtime did not acknowledge opt_w5=${options.optW5}: ${JSON.stringify(result.runtime_options)}`,
      );
    }
    if (
      options.optW7 !== null &&
      result.runtime_options?.w7 !== options.optW7
    ) {
      throw new Error(
        `runtime did not acknowledge opt_w7=${options.optW7}: ${JSON.stringify(result.runtime_options)}`,
      );
    }

    const workerSelection = assertBenchmarkWorkerCount(
      options,
      hostEmulation,
      result,
    );
    hostEmulation = workerSelection.hostEmulation;
    if (hostEmulation !== null) result.host_emulation = hostEmulation;

    result.worker_telemetry = qualifyWorkerTelemetry(result.trace, {
      expectedWorkerCount: workerSelection.expectedWorkerCount,
      requireW7Cache: result.runtime_options?.w7 === true,
    });
    result.playwright_wall_seconds = (Date.now() - started) / 1000;
    const contaminationResult = contaminationSnapshot(contamination);
    const contaminated =
      contaminationResult.contaminated || monitorErrors.length > 0;
    const contaminationReasons = uniqueReasons([
      ...contaminationResult.confirmedReasons,
      ...monitorErrors,
    ]);
    result.benchmark_guard = {
      telemetry_path: path.relative(repoRoot, telemetryFile),
      summary_path: path.relative(repoRoot, summaryPath),
      preflight_ok: preflight.ok,
      contaminated,
      aborted: false,
      accepted: preflight.ok && !contaminated,
      contamination_reasons: contaminationReasons,
      observed_transient_reasons: contaminationResult.observedReasons,
      max_consecutive_contaminated_samples: contaminationResult.maxConsecutive,
    };
    assertRedactedBenchmarkOutput(result, options.privateInputs);
    await writeCaseOutputAtomic(proofOutputPath, result);
    return {
      ok: true,
      aborted: false,
      abortReason: "",
      contaminated,
      contaminationReasons,
      observedContaminationReasons: contaminationResult.observedReasons,
      maxConsecutiveContaminatedSamples: contaminationResult.maxConsecutive,
      samples: runSamples,
      result: {
        output_path: proofOutputPath,
        prove_ms: result.prove_ms,
        wall_seconds: result.wall_seconds,
        playwright_wall_seconds: result.playwright_wall_seconds,
        peak_heap_gib: result.peak_heap_gib,
        verified_locally: result.verified_locally,
        trace_events:
          result.trace && result.trace.events ? result.trace.events.length : 0,
        worker_telemetry: result.worker_telemetry,
        ...(hostEmulation === null ? {} : { host_emulation: hostEmulation }),
      },
    };
  } catch (err) {
    const contaminationResult = contaminationSnapshot(contamination);
    const contaminationReasons = uniqueReasons([
      ...contaminationResult.confirmedReasons,
      ...monitorErrors,
    ]);
    return {
      ok: false,
      aborted,
      abortReason: abortReason || (aborted ? "benchmark_aborted" : ""),
      contaminated:
        aborted || contaminationResult.contaminated || monitorErrors.length > 0,
      contaminationReasons,
      observedContaminationReasons: contaminationResult.observedReasons,
      maxConsecutiveContaminatedSamples: contaminationResult.maxConsecutive,
      samples: runSamples,
      error: err && (err.stack || err.message || String(err)),
    };
  } finally {
    if (monitor) clearInterval(monitor);
    if (browser) await browser.close().catch(() => {});
  }
}

function buildSummary({
  opts: options,
  affinity,
  startedAt,
  outputPath,
  telemetryPath,
  summaryPath,
  preflight,
  run,
  contaminated,
  aborted,
  abortReason,
}) {
  const allSamples = [...(preflight?.samples || []), ...(run?.samples || [])];
  const runSamples = run?.samples || [];
  return {
    schema: "wasm-prover-guarded-benchmark-summary-v1",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    case_name: options.caseName,
    output_path: relative(outputPath),
    telemetry_path: relative(telemetryPath),
    summary_path: relative(summaryPath),
    tuning: {
      worker_count: options.workers,
      shard_count: options.shards,
      range_fetch_concurrency: options.rangeFetchConcurrency,
      chunk_prefetch_window: options.chunkPrefetchWindow,
      cache_mode: options.cacheMode,
      browser_profile_dir: options.browserProfileDir || "",
      gogc: options.gogc,
      gomemlimit: options.gomemlimit,
      cpu_list: options.cpuList || "",
      pinned_decode: options.pinnedDecode,
      opt_w1: options.optW1,
      opt_w2: options.optW2,
      opt_w3: options.optW3,
      opt_w5: options.optW5,
      opt_w6: options.optW6,
      opt_w7: options.optW7,
      emulated_hardware_concurrency: options.emulateHardwareConcurrency,
      emulated_device_memory_gib: options.emulateDeviceMemoryGiB,
    },
    affinity,
    thresholds: {
      preflight_seconds: options.preflightSeconds,
      sample_ms: options.sampleMs,
      max_load_1m_per_core: options.maxLoadPerCore,
      min_preflight_idle_percent: options.minPreflightIdlePercent,
      max_external_process_cpu_percent: options.maxExternalProcessCpuPercent,
      max_external_total_cpu_percent: options.maxExternalTotalCpuPercent,
      max_memory_pressure_some_avg10: options.maxMemoryPressureSomeAvg10,
      contamination_samples: options.contaminationSamples,
      abort_on_contamination: options.abortOnContamination,
    },
    preflight: {
      ok: !!preflight?.ok,
      reasons: preflight?.reasons || [],
      observed_transient_reasons: preflight?.observedReasons || [],
      max_consecutive_contaminated_samples:
        preflight?.maxConsecutiveContaminatedSamples || 0,
      samples: preflight?.samples?.length || 0,
    },
    contaminated,
    aborted,
    abort_reason: abortReason,
    contamination_reasons: uniqueReasons([
      ...(preflight?.reasons || []),
      ...(run?.contaminationReasons || []),
    ]),
    observed_transient_reasons: uniqueReasons([
      ...(preflight?.observedReasons || []),
      ...(run?.observedContaminationReasons || []),
    ]),
    max_consecutive_contaminated_samples: Math.max(
      preflight?.maxConsecutiveContaminatedSamples || 0,
      run?.maxConsecutiveContaminatedSamples || 0,
    ),
    sample_summary: summarizeSamples(allSamples, runSamples),
    benchmark: run?.result || null,
    ...hostEmulationSummaryFields(run?.result?.host_emulation),
    error: run?.error || "",
  };
}

function summarizeSamples(allSamples, runSamples) {
  const externalSamples = runSamples.length > 0 ? runSamples : allSamples;
  return {
    total_samples: allSamples.length,
    run_samples: runSamples.length,
    max_load_1m_per_core: maxNumber(allSamples.map((s) => s.load_1m_per_core)),
    min_preflight_cpu_idle_percent: minNumber(
      allSamples
        .filter((s) => s.phase === "preflight")
        .map((s) => s.cpu_delta?.idle_percent),
    ),
    max_external_process_cpu_percent: maxNumber(
      externalSamples.map((s) => s.external_processes?.[0]?.pcpu || 0),
    ),
    max_external_total_cpu_percent: maxNumber(
      externalSamples.map((s) => s.external_total_cpu_percent || 0),
    ),
    max_memory_pressure_some_avg10: maxNumber(
      allSamples.map((s) => s.pressure?.memory?.some?.avg10),
    ),
    max_cpu_pressure_some_avg10: maxNumber(
      allSamples.map((s) => s.pressure?.cpu?.some?.avg10),
    ),
    top_external_processes: topExternalProcesses(externalSamples),
  };
}

async function collectSample(phase, previousCPU, ownPids, options) {
  const rawCPU = readCPUStat();
  const cpuDelta = cpuDeltaSnapshot(previousCPU, rawCPU);
  const processes = await readProcesses();
  const externalProcesses = processes
    .filter((p) => !ownPids.has(p.pid))
    .filter((p) => !isSamplerProcess(p))
    .filter((p) => p.pcpu >= 1)
    .sort((a, b) => b.pcpu - a.pcpu)
    .slice(0, 10);
  const load1 = os.loadavg()[0] || 0;
  const cpus = os.cpus().length || 1;
  return {
    schema: "wasm-prover-host-load-sample-v1",
    at: new Date().toISOString(),
    phase,
    load_1m: load1,
    load_1m_per_core: load1 / cpus,
    cpu_count: cpus,
    cpu_delta: cpuDelta,
    pressure: {
      cpu: await readPressure("/proc/pressure/cpu"),
      memory: await readPressure("/proc/pressure/memory"),
      io: await readPressure("/proc/pressure/io"),
    },
    memory: await readMemInfo(),
    external_total_cpu_percent: externalProcesses.reduce(
      (sum, p) => sum + p.pcpu,
      0,
    ),
    external_processes: externalProcesses,
    thresholds: {
      max_load_1m_per_core: options.maxLoadPerCore,
      min_preflight_idle_percent: options.minPreflightIdlePercent,
      max_external_process_cpu_percent: options.maxExternalProcessCpuPercent,
      max_external_total_cpu_percent: options.maxExternalTotalCpuPercent,
      max_memory_pressure_some_avg10: options.maxMemoryPressureSomeAvg10,
    },
    rawCPU,
  };
}

function isSamplerProcess(processInfo) {
  return (
    processInfo.comm === "ps" &&
    processInfo.args === "ps -eo pid=,ppid=,pcpu=,comm=,args="
  );
}

function preflightReasons(sample, options) {
  const reasons = [];
  if (sample.load_1m_per_core > options.maxLoadPerCore) {
    reasons.push(`load_1m_per_core>${options.maxLoadPerCore}`);
  }
  if (
    sample.cpu_delta &&
    Number.isFinite(sample.cpu_delta.idle_percent) &&
    sample.cpu_delta.idle_percent < options.minPreflightIdlePercent
  ) {
    reasons.push(`preflight_idle_percent<${options.minPreflightIdlePercent}`);
  }
  reasons.push(...externalProcessReasons(sample, options));
  const memorySome = sample.pressure?.memory?.some?.avg10 || 0;
  if (memorySome > options.maxMemoryPressureSomeAvg10) {
    reasons.push(
      `memory_pressure_some_avg10>${options.maxMemoryPressureSomeAvg10}`,
    );
  }
  return reasons;
}

function runContaminationReasons(sample, options) {
  return externalProcessReasons(sample, options);
}

function externalProcessReasons(sample, options) {
  const reasons = [];
  const maxExternal = sample.external_processes?.[0]?.pcpu || 0;
  if (maxExternal > options.maxExternalProcessCpuPercent) {
    const top = sample.external_processes[0];
    reasons.push(
      `external_process_cpu>${options.maxExternalProcessCpuPercent}:${top.comm}:${top.pid}`,
    );
  }
  if (sample.external_total_cpu_percent > options.maxExternalTotalCpuPercent) {
    reasons.push(`external_total_cpu>${options.maxExternalTotalCpuPercent}`);
  }
  return reasons;
}

async function descendantPIDs(rootPid) {
  const processes = await readProcesses();
  const childrenByParent = new Map();
  for (const p of processes) {
    if (!childrenByParent.has(p.ppid)) childrenByParent.set(p.ppid, []);
    childrenByParent.get(p.ppid).push(p.pid);
  }
  const out = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    for (const child of childrenByParent.get(pid) || []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}

async function readProcesses() {
  const stdout = await execFileText("ps", [
    "-eo",
    "pid=,ppid=,pcpu=,comm=,args=",
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s*(.*)$/.exec(line);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pcpu: Number(match[3]),
        comm: match[4],
        args: match[5] || "",
      };
    })
    .filter(Boolean);
}

function readCPUStat() {
  const raw = readFileSyncText("/proc/stat");
  const line = raw.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) throw new Error("missing aggregate cpu line in /proc/stat");
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;
  return {
    user,
    nice,
    system,
    idle,
    iowait,
    irq,
    softirq,
    steal,
    total: parts.reduce((a, b) => a + b, 0),
  };
}

function cpuDeltaSnapshot(previous, current) {
  if (!previous || !current) return null;
  const total = current.total - previous.total;
  if (total <= 0) return null;
  const idle = current.idle - previous.idle;
  const iowait = current.iowait - previous.iowait;
  const steal = current.steal - previous.steal;
  return {
    idle_percent: (idle / total) * 100,
    iowait_percent: (iowait / total) * 100,
    steal_percent: (steal / total) * 100,
    busy_percent: ((total - idle) / total) * 100,
  };
}

async function readPressure(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const out = {};
    for (const line of raw.trim().split("\n")) {
      const [kind, ...fields] = line.split(/\s+/);
      out[kind] = {};
      for (const field of fields) {
        const [key, value] = field.split("=");
        out[kind][key] = Number(value);
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function readMemInfo() {
  const raw = await fs.readFile("/proc/meminfo", "utf8");
  const values = {};
  for (const line of raw.split("\n")) {
    const match = /^([^:]+):\s+(\d+)/.exec(line);
    if (match) values[match[1]] = Number(match[2]);
  }
  const memTotal = values.MemTotal || 0;
  const memAvailable = values.MemAvailable || 0;
  const swapTotal = values.SwapTotal || 0;
  const swapFree = values.SwapFree || 0;
  return {
    mem_total_mib: kibToMiB(memTotal),
    mem_available_mib: kibToMiB(memAvailable),
    mem_available_percent:
      memTotal > 0 ? (memAvailable / memTotal) * 100 : null,
    swap_total_mib: kibToMiB(swapTotal),
    swap_used_mib: kibToMiB(Math.max(0, swapTotal - swapFree)),
  };
}

function topExternalProcesses(samples) {
  const byKey = new Map();
  for (const sample of samples) {
    for (const p of sample.external_processes || []) {
      const key = `${p.pid}:${p.comm}`;
      const current = byKey.get(key) || {
        pid: p.pid,
        comm: p.comm,
        max_pcpu: 0,
        args: p.args,
      };
      if (p.pcpu > current.max_pcpu) current.max_pcpu = p.pcpu;
      byKey.set(key, current);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.max_pcpu - a.max_pcpu)
    .slice(0, 10);
}

async function appendJSONL(file, value) {
  await fs.appendFile(file, JSON.stringify(value) + "\n");
}

async function writeSummary(file, summary) {
  await fs.writeFile(file, JSON.stringify(summary, null, 2) + "\n");
}

async function applyAffinity(cpuList) {
  if (!cpuList) {
    return { requested: false, ok: false, cpu_list: "", output: "", error: "" };
  }
  try {
    const output = await execFileText("taskset", [
      "-pc",
      cpuList,
      String(process.pid),
    ]);
    return {
      requested: true,
      ok: true,
      cpu_list: cpuList,
      output: output.trim(),
      error: "",
    };
  } catch (err) {
    return {
      requested: true,
      ok: false,
      cpu_list: cpuList,
      output: "",
      error: err.message,
    };
  }
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${file} ${args.join(" ")} failed: ${stderr || err.message}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function readFileSyncText(file) {
  return require("node:fs").readFileSync(file, "utf8");
}

function parseArgs(args, base) {
  const options = { ...base };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [name, inlineValue] = arg.split("=", 2);
    const nextValue = () =>
      inlineValue !== undefined ? inlineValue : args[++i];
    switch (name) {
      case "--base-url":
        options.baseURL = nextValue();
        break;
      case "--output-dir":
        options.outputDir = path.resolve(nextValue());
        break;
      case "--case":
        options.caseName = nextValue();
        break;
      case "--workers":
        options.workers = Number(nextValue());
        break;
      case "--shards":
        options.shards = Number(nextValue());
        break;
      case "--rf":
      case "--range-fetch-concurrency":
        options.rangeFetchConcurrency = Number(nextValue());
        break;
      case "--chunk-prefetch-window":
        options.chunkPrefetchWindow = Number(nextValue());
        break;
      case "--artifact-overrides":
        options.artifactOverridesFile = path.resolve(nextValue());
        break;
      case "--private-inputs-file":
        options.privateInputsFile = path.resolve(nextValue());
        break;
      case "--browser-profile-dir":
        options.browserProfileDir = path.resolve(nextValue());
        break;
      case "--browser-cookie-file":
        options.browserCookieFile = path.resolve(nextValue());
        break;
      case "--cache-mode":
        options.cacheMode = nextValue();
        break;
      case "--preflight-seconds":
        options.preflightSeconds = Number(nextValue());
        break;
      case "--sample-ms":
        options.sampleMs = Number(nextValue());
        break;
      case "--max-load-per-core":
        options.maxLoadPerCore = Number(nextValue());
        break;
      case "--min-preflight-idle-percent":
        options.minPreflightIdlePercent = Number(nextValue());
        break;
      case "--max-external-process-cpu-percent":
        options.maxExternalProcessCpuPercent = Number(nextValue());
        break;
      case "--max-external-total-cpu-percent":
        options.maxExternalTotalCpuPercent = Number(nextValue());
        break;
      case "--max-memory-pressure-some-avg10":
        options.maxMemoryPressureSomeAvg10 = Number(nextValue());
        break;
      case "--contamination-samples":
        options.contaminationSamples = Number(nextValue());
        break;
      case "--gogc":
        options.gogc = nextValue();
        break;
      case "--gomemlimit":
        options.gomemlimit = nextValue();
        break;
      case "--cpu-list":
        options.cpuList = nextValue();
        break;
      case "--pinned-decode":
        options.pinnedDecode = true;
        break;
      case "--checked-decode":
        options.pinnedDecode = false;
        break;
      case "--opt-w1":
        options.optW1 = true;
        break;
      case "--no-opt-w1":
        options.optW1 = false;
        break;
      case "--opt-w2":
        options.optW2 = true;
        break;
      case "--no-opt-w2":
        options.optW2 = false;
        break;
      case "--opt-w3":
        options.optW3 = true;
        break;
      case "--no-opt-w3":
        options.optW3 = false;
        break;
      case "--opt-w5":
        options.optW5 = true;
        break;
      case "--no-opt-w5":
        options.optW5 = false;
        break;
      case "--opt-w6":
        options.optW6 = true;
        break;
      case "--no-opt-w6":
        options.optW6 = false;
        break;
      case "--opt-w7":
        options.optW7 = true;
        break;
      case "--no-opt-w7":
        options.optW7 = false;
        break;
      case "--emulate-hardware-concurrency":
        options.emulateHardwareConcurrency = Number(nextValue());
        break;
      case "--emulate-device-memory-gib":
        options.emulateDeviceMemoryGiB = Number(nextValue());
        break;
      case "--allow-busy-preflight":
        options.allowBusyPreflight = true;
        break;
      case "--no-abort-on-contamination":
        options.abortOnContamination = false;
        break;
      case "--preflight-only":
        options.preflightOnly = true;
        break;
      case "--help":
      case "-h":
        printHelpAndExit();
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  validateOptions(options);
  options.outputDir = path.resolve(options.outputDir);
  return options;
}

function validatePrivateInputs(value) {
  if (!value || typeof value !== "object") {
    throw new Error("--private-inputs-file is required");
  }
  for (const field of [
    "master_xprv_hex",
    "target_credential_hex",
    "destination_address_hex",
  ]) {
    if (typeof value[field] !== "string" || value[field] === "") {
      throw new Error(`private benchmark inputs are missing ${field}`);
    }
  }
  if (!value.search || typeof value.search !== "object") {
    throw new Error("private benchmark inputs are missing search");
  }
}

function parseNetscapeCookies(raw) {
  const cookies = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line === "" || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const httpOnly = fields[0].startsWith("#HttpOnly_");
    const domain = fields[0].replace(/^#HttpOnly_/u, "");
    cookies.push({
      domain,
      path: fields[2] || "/",
      secure: fields[3] === "TRUE",
      expires: Number(fields[4]),
      name: fields[5],
      value: fields.slice(6).join("\t"),
      httpOnly,
      sameSite: "Lax",
    });
  }
  if (cookies.length === 0) throw new Error("browser cookie file contains no cookies");
  return cookies;
}

function validateOptions(options) {
  for (const [name, value] of [
    ["workers", options.workers],
    ["shards", options.shards],
    ["range_fetch_concurrency", options.rangeFetchConcurrency],
    ["chunk_prefetch_window", options.chunkPrefetchWindow],
    ["preflight_seconds", options.preflightSeconds],
    ["sample_ms", options.sampleMs],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number`);
    }
  }
  if (![1, 2, 3, 4].includes(options.chunkPrefetchWindow)) {
    throw new Error("chunk_prefetch_window must be one of 1, 2, 3, or 4");
  }
  if (!["cold", "warm"].includes(options.cacheMode)) {
    throw new Error("cache_mode must be cold or warm");
  }
  validateHostEmulationOptions(options);
}

function printHelpAndExit() {
  console.log(`Usage:
  node experiments/wasm-prover/scripts/guarded-browser-benchmark.mjs [options]

Options:
  --case NAME                         Output case name.
  --workers N                         Worker count. Default: ${defaults.workers}
  --shards N                          Shard count. Default: ${defaults.shards}
  --rf N                              Range fetch concurrency. Default: ${defaults.rangeFetchConcurrency}
  --chunk-prefetch-window N           Verified chunk window (1-4). Default: 2
  --artifact-overrides FILE           Public artifact URL overrides JSON.
  --private-inputs-file FILE          Local proof inputs injected before navigation; never served.
  --browser-profile-dir DIR           Persistent Chromium profile for cold/warm runs.
  --browser-cookie-file FILE           Local Netscape cookie file; values are never written to output.
  --cache-mode cold|warm              Clear or retain that profile cache.
  --base-url URL                      Browser harness URL. Default: ${defaults.baseURL}
  --preflight-seconds N               Idle gate duration. Default: ${defaults.preflightSeconds}
  --sample-ms N                       During-run sample interval. Default: ${defaults.sampleMs}
  --max-load-per-core N               Preflight max load/core. Default: ${defaults.maxLoadPerCore}
  --min-preflight-idle-percent N      Preflight min CPU idle. Default: ${defaults.minPreflightIdlePercent}
  --max-external-process-cpu-percent N Sustained non-benchmark process limit. Default: ${defaults.maxExternalProcessCpuPercent}
  --max-external-total-cpu-percent N  Sustained total non-benchmark CPU limit. Default: ${defaults.maxExternalTotalCpuPercent}
  --contamination-samples N           Consecutive samples before abort. Default: ${defaults.contaminationSamples}
  --gogc VALUE                        Go GC setting. Default: ${defaults.gogc}
  --gomemlimit VALUE                  Go memory limit. Default: ${defaults.gomemlimit}
  --cpu-list LIST                     Pin runner/browser descendants with taskset, e.g. 0-15.
  --pinned-decode                     Force digest-pinned worker decode.
	--opt-w1                            Dispatch witness-only MSMs before computeH.
	--no-opt-w1                         Retain synchronous MSM/computeH ordering.
  --opt-w2                            Skip proving-key domain precompute.
  --no-opt-w2                         Retain legacy proving-key domain precompute.
  --opt-w3                            Release the CCS immediately after Solve.
  --no-opt-w3                         Retain the CCS through the proof.
  --opt-w5                            Label host-gated worker-count candidate runs.
  --no-opt-w5                         Retain the descriptor or worker-8 default.
  --opt-w6                            Reuse scoped computeH coset tables.
  --no-opt-w6                         Rebuild computeH coset tables per FFT.
  --opt-w7                            Reuse verified PK chunks per worker.
  --no-opt-w7                         Re-fetch and re-hash every overlapping chunk.
  --emulate-hardware-concurrency N    Override navigator.hardwareConcurrency before runtime load; pair with device memory.
  --emulate-device-memory-gib N       Override navigator.deviceMemory before runtime load; pair with hardware concurrency.
  --checked-decode                    Force checked worker decode.
  --allow-busy-preflight              Record but do not fail busy preflight.
  --no-abort-on-contamination         Mark contaminated instead of aborting.
  --preflight-only                    Only run the idle gate and write sidecars.
`);
  process.exit(0);
}

function uniqueReasons(reasons) {
  return [...new Set(reasons.filter(Boolean))];
}

function maxNumber(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

function minNumber(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? Math.min(...nums) : null;
}

function kibToMiB(kib) {
  return Math.round((kib / 1024) * 1000) / 1000;
}

function relative(file) {
  return path.relative(repoRoot, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
