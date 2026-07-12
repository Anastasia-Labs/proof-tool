import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAppliedFlags,
  buildABPlan,
  parseOptimizationFlags,
  runABPlan,
  toRuntimeTuning,
  w5WorkerTuning,
} from "../runtime/ab.mjs";
import {
  TodoGateError,
  aggregateWorkerTelemetry,
  qualifyWorkerTelemetry,
  requiredWorkerGoTelemetryFields,
} from "../runtime/common.mjs";
import { evaluateContamination } from "../runtime/contamination.mjs";
import {
  assertContractVerifierResult,
  compareRuntimeProofs,
  digestIntermediateValue,
  requiredIntermediateStages,
  selectABRepeat,
} from "../runtime/equivalence.mjs";
import {
  faultCases,
  assertFaultWorkerCount,
  persistenceAuditClean,
  runFaultCases,
  selectFaultCases,
  validateFaultWorkerCount,
} from "../fault/cases.mjs";
import {
  actualProofWorkerCount,
  assertAppliedEngineProbe,
  assertAppliedWorkerProbe,
  assertProofRuntimeOptions,
  classifyCPUFallbackFailure,
} from "../fault/browser-adapter.mjs";

test("per-W flags produce three counterbalanced baseline/candidate repeats", () => {
  const parsed = parseOptimizationFlags([
    "--case",
    "w2",
    "--opt-w2",
    "--no-opt-w3",
  ]);
  assert.deepEqual(parsed.flags, { w2: true, w3: false });
  assert.deepEqual(parsed.rest, ["--case", "w2"]);
  const plan = buildABPlan({
    casePrefix: "pair",
    candidateFlags: parsed.flags,
    commonTuning: { worker_count: 8 },
  });
  assert.equal(plan.length, 6);
  assert.deepEqual(
    plan.map((item) => item.role),
    ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate"],
  );
  assert.deepEqual(plan[0].tuning, {
    worker_count: 8,
    opt_w2: false,
    opt_w3: false,
  });
  assert.deepEqual(plan[1].tuning, {
    worker_count: 8,
    opt_w2: true,
    opt_w3: false,
  });
});

test("worker telemetry aggregates maxima per worker without inventing optional zeros", () => {
  const trace = {
    events: [
      {
        phase: "measure",
        stage: "shard",
        fields: {
          worker_id: 1,
          error: "",
          worker_go_heap_alloc_bytes: 100,
          worker_go_heap_sys_bytes: 500,
        },
      },
      {
        phase: "measure",
        stage: "shard",
        fields: {
          worker_id: 0,
          error: "",
          worker_go_heap_alloc_bytes: 300,
          worker_js_heap_used_bytes: 700,
          worker_w7_verified_cache_bytes: 64,
        },
      },
      {
        phase: "measure",
        stage: "shard",
        fields: {
          worker_id: 0,
          error: "",
          worker_go_heap_alloc_bytes: 250,
          worker_js_heap_used_bytes: 900,
          worker_w7_verified_cache_bytes: 128,
        },
      },
      {
        phase: "measure",
        stage: "shard",
        fields: {
          worker_id: 1,
          error: "worker failed",
          worker_go_heap_alloc_bytes: 9999,
        },
      },
    ],
  };
  assert.deepEqual(aggregateWorkerTelemetry(trace), {
    schema: "wasm-worker-telemetry-v1",
    successful_shards: 3,
    workers: [
      {
        worker_id: 0,
        successful_shards: 2,
        maxima: {
          worker_go_heap_alloc_bytes: 300,
          worker_js_heap_used_bytes: 900,
          worker_w7_verified_cache_bytes: 128,
        },
      },
      {
        worker_id: 1,
        successful_shards: 1,
        maxima: {
          worker_go_heap_alloc_bytes: 100,
          worker_go_heap_sys_bytes: 500,
        },
      },
    ],
    maxima: {
      worker_go_heap_alloc_bytes: 300,
      worker_go_heap_sys_bytes: 500,
      worker_js_heap_used_bytes: 900,
      worker_w7_verified_cache_bytes: 128,
    },
  });
  assert.equal(
    "worker_js_heap_used_bytes" in aggregateWorkerTelemetry(trace).workers[1].maxima,
    false,
  );
});

function workerTelemetryEvent(workerID, overrides = {}) {
  return {
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
      ...overrides,
    },
  };
}

test("worker telemetry qualification rejects stale Worker assets", () => {
  assert.throws(
    () =>
      qualifyWorkerTelemetry(
        {
          events: [
            {
              phase: "measure",
              stage: "shard",
              fields: { operation: "MSMG1Section", worker_id: 0, error: "" },
            },
          ],
        },
        { expectedWorkerCount: 1 },
      ),
    /missing valid worker_go_heap_alloc_bytes/,
  );
});

test("worker telemetry qualification rejects a partial Go MemStats sample", () => {
  const event = workerTelemetryEvent(0);
  delete event.fields.worker_go_stack_sys_bytes;
  assert.throws(
    () =>
      qualifyWorkerTelemetry(
        { events: [event] },
        { expectedWorkerCount: 1 },
      ),
    /missing valid worker_go_stack_sys_bytes/,
  );
});

test("worker telemetry qualification requires every expected worker", () => {
  assert.throws(
    () =>
      qualifyWorkerTelemetry(
        { events: [workerTelemetryEvent(0)] },
        { expectedWorkerCount: 2 },
      ),
    /missing successful section-shard samples for worker_id=1/,
  );
  assert.throws(
    () =>
      qualifyWorkerTelemetry(
        { events: [workerTelemetryEvent(0), workerTelemetryEvent(2)] },
        { expectedWorkerCount: 2 },
      ),
    /unexpected worker_id=2, want 0\.\.1/,
  );
});

test("worker telemetry qualification does not count error-only workers", () => {
  assert.throws(
    () =>
      qualifyWorkerTelemetry(
        {
          events: [
            workerTelemetryEvent(0, { error: "worker failed" }),
            workerTelemetryEvent(1),
          ],
        },
        { expectedWorkerCount: 2 },
      ),
    /missing successful section-shard samples for worker_id=0/,
  );
});

test("worker telemetry qualification requires W7 cache bytes only with W7", () => {
  const trace = { events: [workerTelemetryEvent(0)] };
  assert.doesNotThrow(() =>
    qualifyWorkerTelemetry(trace, { expectedWorkerCount: 1 }),
  );
  assert.throws(
    () =>
      qualifyWorkerTelemetry(trace, {
        expectedWorkerCount: 1,
        requireW7Cache: true,
      }),
    /missing valid worker_w7_verified_cache_bytes/,
  );
});

test("worker telemetry qualification accepts complete samples with optional JS heap absent", () => {
  const trace = {
    events: [
      workerTelemetryEvent(0, { worker_w7_verified_cache_bytes: 256 }),
      workerTelemetryEvent(1, { worker_w7_verified_cache_bytes: 512 }),
    ],
  };
  const telemetry = qualifyWorkerTelemetry(trace, {
    expectedWorkerCount: 2,
    requireW7Cache: true,
  });
  assert.equal(telemetry.qualification.verified, true);
  assert.equal(telemetry.qualification.expected_worker_count, 2);
  assert.equal(telemetry.qualification.successful_section_shards, 2);
  assert.deepEqual(
    telemetry.workers.map((worker) => worker.worker_id),
    [0, 1],
  );
  assert.equal("worker_js_heap_used_bytes" in telemetry.maxima, false);
  assert.equal(telemetry.maxima.worker_w7_verified_cache_bytes, 512);
});

test("W6 is independently parsed, tuned, and acknowledged", async () => {
  const parsed = parseOptimizationFlags(["--opt-w6"]);
  assert.deepEqual(parsed.flags, { w6: true });
  assert.deepEqual(toRuntimeTuning(parsed.flags), { opt_w6: true });
  const plan = buildABPlan({ casePrefix: "w6", candidateFlags: parsed.flags });
  const report = await runABPlan(plan, {
    capabilities: async () => ({ optimization_flags: ["w6"] }),
    runCase: async (testCase) => ({
      runtime_options: testCase.optimizationFlags,
      prove_ms: 1,
    }),
  });
  assert.equal(report.runs.length, 6);
});

test("W5 is independently parsed, tuned, and acknowledged", async () => {
  const parsed = parseOptimizationFlags(["--opt-w5"]);
  assert.deepEqual(parsed.flags, { w5: true });
  assert.deepEqual(toRuntimeTuning(parsed.flags), { opt_w5: true });
  const roleTuning = w5WorkerTuning({
    candidateFlags: parsed.flags,
    baselineWorkers: 8,
    candidateWorkers: 16,
  });
  const plan = buildABPlan({
    casePrefix: "w5",
    candidateFlags: parsed.flags,
    ...roleTuning,
  });
  assert.deepEqual(
    plan.map((item) => [item.role, item.tuning.worker_count]),
    [
      ["baseline", 8],
      ["candidate", 16],
      ["candidate", 16],
      ["baseline", 8],
      ["baseline", 8],
      ["candidate", 16],
    ],
  );
  const report = await runABPlan(plan, {
    capabilities: async () => ({ optimization_flags: ["w5"] }),
    runCase: async (testCase) => ({
      runtime_options: testCase.optimizationFlags,
      prove_ms: 1,
    }),
  });
  assert.equal(report.runs.length, 6);
});

test("W5 A/B setup rejects an absent, identical, or above-cap candidate count", () => {
  const input = { candidateFlags: { w5: true }, baselineWorkers: 8 };
  assert.throws(() => w5WorkerTuning(input), /--candidate-workers is required/);
  assert.throws(
    () => w5WorkerTuning({ ...input, candidateWorkers: 8 }),
    /must exceed/,
  );
  assert.throws(
    () => w5WorkerTuning({ ...input, candidateWorkers: 17 }),
    /cap of 16/,
  );
});

test("W7 is independently parsed, tuned, and acknowledged", async () => {
  const parsed = parseOptimizationFlags(["--opt-w7"]);
  assert.deepEqual(parsed.flags, { w7: true });
  assert.deepEqual(toRuntimeTuning(parsed.flags), { opt_w7: true });
  const plan = buildABPlan({ casePrefix: "w7", candidateFlags: parsed.flags });
  const report = await runABPlan(plan, {
    capabilities: async () => ({ optimization_flags: ["w7"] }),
    runCase: async (testCase) => ({
      runtime_options: testCase.optimizationFlags,
      prove_ms: 1,
    }),
  });
  assert.equal(report.runs.length, 6);
});

test("A/B plan rejects false-pass configuration and unsafe output names", () => {
  assert.throws(
    () => buildABPlan({ casePrefix: "pair", candidateFlags: { w2: false } }),
    /all-false/,
  );
  assert.throws(
    () =>
      buildABPlan({ casePrefix: "../escape", candidateFlags: { w2: true } }),
    /safe filename/,
  );
  assert.throws(
    () =>
      buildABPlan({
        casePrefix: "pair",
        candidateFlags: { w2: true },
        repeats: 2,
      }),
    /repeats >= 3/,
  );
  for (const commonTuning of [
    { worker_count: 0 },
    { shard_count: 1.5 },
    { range_fetch_concurrency: NaN },
  ]) {
    assert.throws(
      () =>
        buildABPlan({
          casePrefix: "pair",
          candidateFlags: { w2: true },
          commonTuning,
        }),
      /positive integer/,
    );
  }
});

test("A/B plan can hold prerequisite findings enabled in both arms", () => {
  const parsed = parseOptimizationFlags([
    "--opt-w1",
    "--opt-w2",
    "--opt-w3",
    "--baseline-opt-w2",
    "--baseline-opt-w3",
  ]);
  const plan = buildABPlan({
    casePrefix: "w1-cumulative",
    candidateFlags: parsed.flags,
    baselineFlags: parsed.baselineFlags,
  });
  assert.deepEqual(plan[0].optimizationFlags, {
    w1: false,
    w2: true,
    w3: true,
  });
  assert.deepEqual(plan[1].optimizationFlags, { w1: true, w2: true, w3: true });
  assert.throws(
    () =>
      buildABPlan({
        casePrefix: "same",
        candidateFlags: { w2: true },
        baselineFlags: { w2: true },
      }),
    /must differ/,
  );
});

test("contamination gate ignores isolated spikes but rejects the configured streak", () => {
  const isolated = evaluateContamination([[], ["external:sed"], [], []], 3);
  assert.equal(isolated.contaminated, false);
  assert.equal(isolated.maxConsecutive, 1);
  assert.deepEqual(isolated.observedReasons, ["external:sed"]);

  const sustained = evaluateContamination(
    [[], ["external:sed"], ["external:sed"], ["external:sed"]],
    3,
  );
  assert.equal(sustained.contaminated, true);
  assert.equal(sustained.maxConsecutive, 3);
  assert.deepEqual(sustained.confirmedReasons, ["external:sed"]);
});

test("A/B orchestration refuses unacknowledged engine flags", async () => {
  const plan = buildABPlan({
    casePrefix: "pair",
    candidateFlags: { w2: true },
  });
  await assert.rejects(
    runABPlan(plan, {
      capabilities: async () => ({ optimization_flags: [] }),
      runCase: async () => ({}),
    }),
    (error) => error instanceof TodoGateError && error.gate === "runtime-w2",
  );
});

test("A/B orchestration normalizes prove_ms and checks applied flags", async () => {
  const plan = buildABPlan({
    casePrefix: "pair",
    candidateFlags: { w2: true },
  });
  const report = await runABPlan(plan, {
    capabilities: async () => ({ optimization_flags: ["w2"] }),
    runCase: async (testCase) => ({
      runtime_options: { ...testCase.optimizationFlags, w7: false },
      ms: 123,
      artifact: {},
    }),
  });
  assert.equal(report.runs.length, 6);
  assert.equal(report.runs[0].prove_ms, 123);
  assert.equal(report.runs[0].repeat, 1);
  assert.throws(
    () => assertAppliedFlags(plan[1], { runtime_options: { w2: false } }),
    /acknowledged/,
  );
  await assert.rejects(
    runABPlan(plan, {
      capabilities: async () => ({ optimization_flags: ["w2"] }),
      runCase: async (testCase) => ({
        runtime_options: testCase.optimizationFlags,
        ms: 0,
      }),
    }),
    /positive prove_ms/,
  );
});

test("equivalence selects a complete pair from a repeated A/B report", () => {
  const report = {
    schema: "wasm-prover-runtime-ab-v1",
    runs: [
      { role: "candidate", repeat: 2, id: "c" },
      { role: "baseline", repeat: 2, id: "b" },
    ],
  };
  assert.deepEqual(selectABRepeat(report, 2), {
    baseline: report.runs[1],
    candidate: report.runs[0],
  });
  assert.throws(() => selectABRepeat(report, 1), /no complete/);
});

test("equivalence ignores randomized proofs but pins deployment and asset identities", () => {
  const baseline = sampleRun("proof-a", "aa".repeat(336));
  const candidate = sampleRun("proof-b", "bb".repeat(336));
  const report = compareRuntimeProofs(baseline, candidate);
  assert.equal(report.ok, true);
  assert.equal(report.raw_proof_compared, false);
  candidate.asset_identity.deployment_manifest_sha256 = "sha256:changed";
  assert.throws(
    () => compareRuntimeProofs(baseline, candidate),
    /deployment_manifest_sha256/,
  );
});

test("intermediate digest hook requires every versioned stage and field", () => {
  const baseline = sampleRun("same", "aa".repeat(336));
  const candidate = sampleRun("same", "aa".repeat(336));
  assert.throws(
    () =>
      compareRuntimeProofs(baseline, candidate, {
        requireIntermediateDigests: true,
      }),
    /intermediate_digests/,
  );
  baseline.intermediate_digests = completeIntermediateDigests();
  candidate.intermediate_digests = completeIntermediateDigests();
  delete candidate.intermediate_digests.stages.K.result;
  assert.throws(
    () => compareRuntimeProofs(baseline, candidate),
    /stages.K.result/,
  );
  candidate.intermediate_digests = completeIntermediateDigests();
  assert.equal(
    compareRuntimeProofs(baseline, candidate).intermediate_digests,
    "compared",
  );
  candidate.intermediate_digests.stages.K = {
    ...candidate.intermediate_digests.stages.Z,
  };
  assert.throws(
    () => compareRuntimeProofs(baseline, candidate),
    /placeholder digests/,
  );
});

test("intermediate digest known answers bind stage, field, and corresponding bytes", () => {
  assert.equal(
    digestIntermediateValue(
      "Basis",
      "scalar_inputs",
      Buffer.from("known-answer"),
    ),
    "sha256:734f7c7941c7f8dda240c6ffbd96d9fd7408749589bcdb679bbb1e42aade2a43",
  );
  for (const stage of requiredIntermediateStages) {
    for (const field of ["scalar_inputs", "point_inputs", "result"]) {
      const before = digestIntermediateValue(
        stage,
        field,
        Buffer.from("fixture-input-a"),
      );
      const after = digestIntermediateValue(
        stage,
        field,
        Buffer.from("fixture-input-b"),
      );
      assert.notEqual(before, after, `${stage}.${field}`);
    }
  }
});

test("fixed-random proof comparison and contract adapter results are strict", () => {
  const baseline = sampleRun("same", "aa".repeat(336));
  const candidate = sampleRun("same", "aa".repeat(336));
  assert.throws(
    () => compareRuntimeProofs(baseline, candidate, { exactProof: true }),
    /deterministic_randomness/,
  );
  baseline.deterministic_randomness = true;
  candidate.deterministic_randomness = true;
  assert.equal(
    compareRuntimeProofs(baseline, candidate, { exactProof: true }).ok,
    true,
  );
  assert.doesNotThrow(() => assertContractVerifierResult(true, "baseline"));
  assert.doesNotThrow(() =>
    assertContractVerifierResult({ ok: true }, "candidate"),
  );
  for (const falsePass of [undefined, false, {}, { ok: false }]) {
    assert.throws(
      () => assertContractVerifierResult(falsePass, "candidate"),
      /must return true/,
    );
  }
});

test("fault runner fails unsupported hooks and external deadline closes adapter", async () => {
  const workerCase = selectFaultCases(["worker-kill"]);
  await assert.rejects(
    runFaultCases(workerCase, {
      capabilities: async () => ({ faults: [] }),
      runFault: async () => ({}),
    }),
    (error) => error instanceof TodoGateError && error.gate === "worker-kill",
  );
  let aborted = false;
  await assert.rejects(
    runFaultCases(
      workerCase,
      {
        capabilities: async () => ({ faults: ["worker_kill_mid_shard"] }),
        runFault: async () => new Promise(() => {}),
        abortFault: async () => {
          aborted = true;
        },
      },
      { deadlineMs: 10 },
    ),
    /hung=true/,
  );
  assert.equal(aborted, true);
  const started = Date.now();
  await assert.rejects(
    runFaultCases(
      workerCase,
      {
        capabilities: async () => ({ faults: ["worker_kill_mid_shard"] }),
        runFault: async () => new Promise(() => {}),
        abortFault: async () => new Promise(() => {}),
      },
      { deadlineMs: 10 },
    ),
    /hung=true/,
  );
  assert.ok(
    Date.now() - started < 100,
    "hung cleanup must not delay deadline rejection",
  );
});

test("fault worker count rejects unsupported and false-pass acknowledgements", () => {
  assert.equal(validateFaultWorkerCount(16), 16);
  for (const value of [0, -1, 1.5, 17, NaN]) {
    assert.throws(() => validateFaultWorkerCount(value), /positive integer/);
  }
  const supported = { worker_count: { explicit: true, max: 16 }, applied_worker_count: 16 };
  assert.doesNotThrow(() => assertFaultWorkerCount(supported, 16));
  assert.throws(
    () => assertFaultWorkerCount({ ...supported, applied_worker_count: 8 }, 16),
    /engine probe applied worker_count=8, want 16/,
  );
  assert.throws(
    () => assertFaultWorkerCount({ worker_count: { explicit: false, max: 16 }, applied_worker_count: 16 }, 16),
    (error) => error instanceof TodoGateError && error.gate === "fault-worker-count",
  );
  assert.throws(
    () => assertFaultWorkerCount({ worker_count: { explicit: true, max: 8 }, applied_worker_count: 16 }, 16),
    (error) => error instanceof TodoGateError && error.gate === "fault-worker-count",
  );
});

test("live fault adapter accepts only applied probe and proof-trace worker evidence", () => {
  const requestEcho = {
    engine: "sharded",
    requested_tuning: { worker_count: 16 },
  };
  assert.throws(
    () => assertAppliedWorkerProbe(requestEcho, 16),
    /worker_count=undefined, want sharded\/16/,
  );
  assert.throws(
    () => assertAppliedWorkerProbe({ engine: "cpu", applied_tuning: { worker_count: 16 } }, 16),
    /selected cpu/,
  );
  assert.equal(
    assertAppliedWorkerProbe({ engine: "sharded", applied_tuning: { worker_count: 16 } }, 16),
    16,
  );
  assert.throws(
    () => assertAppliedEngineProbe(
      { engine: "sharded", applied_tuning: { worker_count: 16, opt_w7: false } },
      { worker_count: 16, opt_w7: true },
    ),
    /applied opt_w7=false, want true/,
  );
  assert.equal(
    assertAppliedEngineProbe(
      {
        engine: "sharded",
        applied_tuning: {
          worker_count: 16,
          shard_count: 64,
          range_fetch_concurrency: 4,
          pinned_decode: true,
          opt_w7: true,
        },
      },
      {
        worker_count: 16,
        shard_count: 64,
        range_fetch_concurrency: 4,
        pinned_decode: true,
        opt_w7: true,
      },
    ),
    16,
  );

  assert.throws(
    () => actualProofWorkerCount({ engine: "streampk-sharded-groth16", requested_tuning: { worker_count: 16 } }, 16),
    /trace\.worker_count=undefined/,
  );
  assert.throws(
    () => actualProofWorkerCount({ engine: "streampk-sharded-groth16", trace: { worker_count: 8 } }, 16),
    /trace\.worker_count=8, want sharded\/16/,
  );
  assert.equal(
    actualProofWorkerCount({ engine: "streampk-sharded-groth16", trace: { worker_count: 16 } }, 16),
    16,
  );

  assert.throws(
    () => assertProofRuntimeOptions(
      { runtime_options: { w7: true }, trace: {} },
      { w7: true },
    ),
    /trace=undefined, want true/,
  );
  assert.equal(
    assertProofRuntimeOptions(
      { runtime_options: { w2: true, w7: true }, trace: { runtime_options: { w2: true, w7: true } } },
      { w2: true, w7: true },
    ),
    true,
  );
});

test("CPU fallback evidence recognizes joined retries and rejects unknown failure state", () => {
  assert.deepEqual(
    classifyCPUFallbackFailure(
      "primary sharded prove: memory pressure; cpu retry prove: out of memory guidance",
    ),
    { state: "observed" },
  );
  assert.deepEqual(
    classifyCPUFallbackFailure('msmengine: demoting from "sharded" to cpu after error: boom'),
    { state: "observed" },
  );
  assert.deepEqual(
    classifyCPUFallbackFailure("oom-guidance: out of memory; reduce workload"),
    { state: "unknown" },
  );
  assert.deepEqual(
    classifyCPUFallbackFailure(
      "page.evaluate: Error: groth16 ProveStream: range-fetch-aborted: fetch chunk returned 503",
    ),
    { state: "none" },
  );
  assert.deepEqual(
    classifyCPUFallbackFailure("out of memory guidance"),
    { state: "unknown" },
  );
});

test("fault runner checks worker capability and preflight acknowledgement before a case", async () => {
  const workerCase = selectFaultCases(["worker-kill"]);
  let ran = false;
  await assert.rejects(
    runFaultCases(
      workerCase,
      {
        capabilities: async () => ({
          faults: ["worker_kill_mid_shard"],
          worker_count: { explicit: true, max: 16 },
          applied_worker_count: 8,
        }),
        runFault: async () => {
          ran = true;
          return safeFaultOutcomes()["worker-kill"];
        },
      },
      { workerCount: 16 },
    ),
    /engine probe applied worker_count=8, want 16/,
  );
  assert.equal(ran, false);
});

test("every fault outcome rejects each reviewed false-pass shape", () => {
  const safe = safeFaultOutcomes();
  for (const testCase of faultCases) {
    assert.equal(testCase.accept(safe[testCase.id]), true, testCase.id);
    assert.equal(
      testCase.accept({ ...safe[testCase.id], hung: true }),
      false,
      `${testCase.id} hung`,
    );
  }
  const workerKill = faultCases.find((item) => item.id === "worker-kill");
  assert.equal(
    workerKill.accept({
      ...safe["worker-kill"],
      cpu_fallback: null,
      cpu_fallback_state: "unknown",
    }),
    false,
  );
  const network = faultCases.find((item) => item.id === "network-abort");
  assert.equal(
    network.accept({ ...safe["network-abort"], partial_proof: true }),
    false,
  );
  assert.equal(
    network.accept({ ...safe["network-abort"], cpu_fallback: true }),
    false,
  );
  assert.equal(
    network.accept({
      ...safe["network-abort"],
      cpu_fallback: null,
      cpu_fallback_state: "unknown",
    }),
    false,
  );
  assert.equal(
    network.accept({ ...safe["network-abort"], retry_count: 4, retry_max: 3 }),
    false,
  );
  assert.equal(
    network.accept({ ...safe["network-abort"], retry_count: 0 }),
    false,
  );
  assert.equal(
    network.accept({
      ...safe["network-abort"],
      retries_bounded: true,
      retry_count: undefined,
    }),
    false,
  );
  const memory = faultCases.find((item) => item.id === "memory-pressure");
  const completedMemory = {
    ...safe["memory-pressure"],
    status: "completed",
    error_class: undefined,
    within_envelope: true,
    verified_locally: true,
    worker_count: 4,
    worker_count_override: { profile: "4-core/8-GB", requested: 16, applied: 4, source: "proof-trace" },
  };
  assert.equal(memory.accept(completedMemory), true);
  assert.equal(
    memory.accept({
      status: "completed",
      within_envelope: true,
      verified_locally: false,
      hung: false,
    }),
    false,
  );
  assert.equal(
    memory.accept({ ...safe["memory-pressure"], worker_count_probe: undefined }),
    false,
    "OOM safety needs a separate applied worker-4 probe",
  );
  assert.equal(
    memory.accept({
      ...safe["memory-pressure"],
      cpu_fallback: null,
      cpu_fallback_state: "unknown",
    }),
    false,
  );
  const prefixedOOMFallback = classifyCPUFallbackFailure(
    "oom-guidance: out of memory; guidance: reduce workers",
  );
  assert.equal(
    memory.accept({
      ...safe["memory-pressure"],
      error: "oom-guidance: out of memory; guidance: reduce workers",
      cpu_fallback: prefixedOOMFallback.state === "none" ? false : null,
      cpu_fallback_state: prefixedOOMFallback.state,
    }),
    false,
    "unstructured OOM guidance cannot self-attest that CPU fallback did not run",
  );
  assert.equal(
    memory.accept({
      ...safe["memory-pressure"],
      cpu_fallback: true,
      cpu_fallback_state: "observed",
    }),
    false,
  );
  assert.equal(
    memory.accept({ ...safe["memory-pressure"], worker_count: 16 }),
    false,
  );
  assert.equal(
    memory.accept({ ...safe["memory-pressure"], worker_count_override: undefined }),
    false,
  );
  assert.equal(
    memory.accept({
      ...safe["memory-pressure"],
      worker_count_override: { profile: "4-core/8-GB", applied: 4 },
    }),
    false,
  );
  assert.equal(
    memory.accept({
      ...safe["memory-pressure"],
      worker_count: 4,
      worker_count_override: { profile: "4-core/8-GB", requested: 16, applied: 4, source: "proof-trace" },
      worker_count_probe: undefined,
      status: "completed",
      within_envelope: true,
      verified_locally: true,
    }),
    false,
  );
  assert.equal(
    memory.accept({
      ...safe["memory-pressure"],
      worker_count: 4,
      worker_count_override: { profile: "4-core/8-GB", requested: 16, applied: 4, source: "proof-trace" },
    }),
    false,
    "OOM without a proof must not self-attest worker_count=4",
  );
  const reload = faultCases.find((item) => item.id === "reload-retry");
  assert.equal(
    reload.accept({ ...safe["reload-retry"], first_attempt_terminated: false }),
    false,
  );
  assert.equal(
    reload.accept({ ...safe["reload-retry"], proof_stage_started: false }),
    false,
  );
  assert.equal(
    reload.accept({ ...safe["reload-retry"], worker_count: 8 }),
    false,
  );
  const incomplete = structuredClone(safe["reload-retry"]);
  incomplete.persistence_audit.sources.indexed_db.inspected = false;
  assert.equal(reload.accept(incomplete), false);
  const leaked = structuredClone(safe["reload-retry"]);
  leaked.persistence_audit.sources.opfs.marker_hits.push("opfs:proof-state");
  assert.equal(reload.accept(leaked), false);
  const changed = structuredClone(safe["reload-retry"]);
  changed.persistence_audit.sources.indexed_db.inventory_unchanged = false;
  assert.equal(reload.accept(changed), false);
});

test("persistence audit requires every source or an explicit unsupported reason", () => {
  const audit = cleanPersistenceAudit();
  assert.equal(persistenceAuditClean(audit), true);
  delete audit.sources.cookies;
  assert.equal(persistenceAuditClean(audit), false);
  const unsupported = cleanPersistenceAudit();
  unsupported.sources.opfs = {
    supported: false,
    inspected: false,
    marker_hits: [],
    unavailable_reason: "not available",
  };
  assert.equal(persistenceAuditClean(unsupported), true);
  delete unsupported.sources.opfs.unavailable_reason;
  assert.equal(persistenceAuditClean(unsupported), false);
  const noBaseline = cleanPersistenceAudit();
  delete noBaseline.sources.indexed_db.baseline_inventory_sha256;
  assert.equal(persistenceAuditClean(noBaseline), false);
  const countChanged = cleanPersistenceAudit();
  countChanged.sources.cache_storage.entries_unchanged = false;
  assert.equal(persistenceAuditClean(countChanged), false);
});

function safeFaultOutcomes() {
  return {
    "worker-kill": {
      status: "failed-closed",
      error_class: "worker-terminated",
      cpu_fallback: false,
      cpu_fallback_state: "none",
      hung: false,
      partial_proof: false,
    },
    "chunk-corruption": {
      status: "failed-closed",
      error_class: "chunk-digest-mismatch",
      cpu_fallback: false,
      cpu_fallback_state: "none",
      partial_proof: false,
      hung: false,
      server_hit_count: 1,
    },
    "network-abort": {
      status: "failed-closed",
      error_class: "range-fetch-aborted",
      retry_count: 3,
      retry_max: 3,
      partial_proof: false,
      cpu_fallback: false,
      cpu_fallback_state: "none",
      hung: false,
    },
    "reload-retry": {
      status: "recovered",
      proof_stage_started: true,
      first_attempt_terminated: true,
      fresh_verified: true,
      requested_worker_count: 16,
      worker_count: 16,
      persistence_audit: cleanPersistenceAudit(),
      hung: false,
    },
    "memory-pressure": {
      status: "failed-closed",
      error_class: "oom-guidance",
      partial_proof: false,
      cpu_fallback: false,
      cpu_fallback_state: "none",
      hung: false,
      worker_count: null,
      worker_count_probe: { engine: "sharded", applied: 4 },
      worker_count_override: { profile: "4-core/8-GB", requested: 16, applied: null, source: "unknown-no-proof" },
    },
  };
}

function cleanPersistenceAudit() {
  const names = [
    "local_storage",
    "session_storage",
    "indexed_db",
    "cache_storage",
    "cookies",
    "history_state",
    "window_name",
    "opfs",
  ];
  return {
    schema: "wasm-prover-persistence-audit-v1",
    complete: true,
    sources: Object.fromEntries(
      names.map((name) => [
        name,
        {
          supported: true,
          inspected: true,
          marker_hits: [],
          entries: 0,
          baseline_entries: 0,
          inventory_sha256: `sha256:${"44".repeat(32)}`,
          baseline_inventory_sha256: `sha256:${"44".repeat(32)}`,
          inventory_unchanged: true,
          entries_unchanged: true,
          ...(name === "cookies"
            ? {
                context_inventory_sha256: `sha256:${"55".repeat(32)}`,
                baseline_context_inventory_sha256: `sha256:${"55".repeat(32)}`,
                browser_context_cookie_count: 0,
                baseline_browser_context_cookie_count: 0,
                context_inventory_unchanged: true,
                context_entries_unchanged: true,
              }
            : {}),
        },
      ]),
    ),
  };
}

function completeIntermediateDigests() {
  return {
    schema: "wasm-prover-intermediate-digests-v1",
    stages: Object.fromEntries(
      requiredIntermediateStages.map((stage) => [
        stage,
        {
          scalar_inputs: digestIntermediateValue(
            stage,
            "scalar_inputs",
            Buffer.from(`${stage}:scalars`),
          ),
          point_inputs: digestIntermediateValue(
            stage,
            "point_inputs",
            Buffer.from(`${stage}:points`),
          ),
          result: digestIntermediateValue(
            stage,
            "result",
            Buffer.from(`${stage}:result`),
          ),
        },
      ]),
    ),
  };
}

function sampleRun(proof, proofHex) {
  return {
    verified_locally: true,
    artifact: {
      schema: "root-ownership-proof-artifact-v1",
      circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
      vk_hash: "blake2b256:vk",
      target_credential: "11".repeat(28),
      destination_address_encoding: "destination-address-v1",
      destination_address: "22".repeat(58),
      public_input_encoding: "single-credential-destination-v1",
      public_input: "0x1234",
      proof,
      cardano: {
        format: "groth16-bls12-381-bsb22",
        proof_hex: proofHex,
        public_input_digest_hex: "33".repeat(32),
      },
    },
    asset_identity: {
      key_manifest_sha256: "sha256:key",
      key_manifest_blake2b256: "blake2b256:key",
      chunk_manifest_sha256: "sha256:chunk",
      deployment_manifest_sha256: "sha256:deployment",
      proving_key_sha256: "sha256:pk",
      proving_key_blake2b256: "blake2b256:pk",
      constraint_system_hash: "blake2b256:ccs",
      verifying_key_sha256: "sha256:vk",
      vk_hash: "blake2b256:vk",
      circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
      key_version: "ownership-destination-v1",
    },
  };
}
