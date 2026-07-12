import { TodoGateError } from "./common.mjs";

export const runtimeFindings = Object.freeze([
  "w1",
  "w2",
  "w3",
  "w4",
  "w5",
  "w6",
  "w7",
]);

export function parseOptimizationFlags(args) {
  const flags = {};
  const baselineFlags = {};
  const rest = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const baselineMatch =
      /^--baseline-(no-)?opt-(w[1-7])(?:=(true|false))?$/.exec(arg);
    if (baselineMatch) {
      const [, negated, finding, explicit] = baselineMatch;
      let enabled = negated ? false : true;
      if (explicit !== undefined) enabled = explicit === "true";
      baselineFlags[finding] = enabled;
      continue;
    }
    const match = /^--(no-)?opt-(w[1-7])(?:=(true|false))?$/.exec(arg);
    if (!match) {
      rest.push(arg);
      continue;
    }
    const [, negated, finding, explicit] = match;
    let enabled = negated ? false : true;
    if (explicit !== undefined) enabled = explicit === "true";
    flags[finding] = enabled;
  }
  return { flags, baselineFlags, rest };
}

export function buildABPlan({
  casePrefix,
  candidateFlags,
  baselineFlags = {},
  commonTuning = {},
  baselineTuning = {},
  candidateTuning = {},
  repeats = 3,
}) {
  assertSafeCaseName(casePrefix);
  assertPositiveInteger(repeats, "repeats");
  if (repeats < 3)
    throw new Error("counterbalanced benchmark protocol requires repeats >= 3");
  const selected = Object.keys(candidateFlags || {});
  if (selected.length === 0)
    throw new Error("at least one --opt-wN flag is required");
  for (const finding of selected) {
    if (!runtimeFindings.includes(finding))
      throw new Error(`unknown runtime finding ${finding}`);
  }
  for (const finding of Object.keys(baselineFlags)) {
    if (!selected.includes(finding))
      throw new Error(
        `baseline override ${finding} is absent from candidateFlags`,
      );
    if (typeof baselineFlags[finding] !== "boolean")
      throw new Error(`baseline override ${finding} must be boolean`);
  }
  if (!selected.some((finding) => candidateFlags[finding] === true)) {
    throw new Error(
      "candidate must enable at least one optimization; all-false candidates are invalid",
    );
  }
  for (const tuning of [commonTuning, baselineTuning, candidateTuning]) {
    for (const [key, value] of Object.entries(tuning)) {
      assertPositiveInteger(value, key);
    }
  }
  const baseline = Object.fromEntries(
    selected.map((finding) => [finding, baselineFlags[finding] ?? false]),
  );
  if (
    !selected.some((finding) => baseline[finding] !== candidateFlags[finding])
  ) {
    throw new Error(
      "baseline and candidate must differ on at least one optimization",
    );
  }
  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const roles =
      repeat % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const role of roles) {
      const flags = role === "baseline" ? baseline : candidateFlags;
      plan.push({
        name: `${casePrefix}-r${repeat}-${role}`,
        role,
        repeat,
        pair_order: roles.join("-then-"),
        optimizationFlags: { ...flags },
        tuning: {
          ...commonTuning,
          ...(role === "baseline" ? baselineTuning : candidateTuning),
          ...toRuntimeTuning(flags),
        },
      });
    }
  }
  return plan;
}

// W5 is implemented by the browser host selecting a larger explicit worker
// count. The WASM opt_w5 field is only an acknowledgement marker, so a valid
// W5 A/B plan must also vary worker_count between its two arms.
export function w5WorkerTuning({
  candidateFlags = {},
  baselineFlags = {},
  baselineWorkers,
  candidateWorkers,
}) {
  const comparesW5 =
    candidateFlags.w5 === true && (baselineFlags.w5 ?? false) === false;
  if (!comparesW5) return { baselineTuning: {}, candidateTuning: {} };
  assertPositiveInteger(baselineWorkers, "workers");
  if (candidateWorkers === null || candidateWorkers === undefined) {
    throw new Error("--candidate-workers is required for a W5 comparison");
  }
  assertPositiveInteger(candidateWorkers, "candidate_workers");
  if (candidateWorkers <= baselineWorkers) {
    throw new Error(
      "--candidate-workers must exceed --workers for a W5 comparison",
    );
  }
  if (candidateWorkers > 16) {
    throw new Error("--candidate-workers must not exceed the W5 cap of 16");
  }
  return {
    baselineTuning: { worker_count: baselineWorkers },
    candidateTuning: { worker_count: candidateWorkers },
  };
}

export function toRuntimeTuning(flags) {
  return Object.fromEntries(
    Object.entries(flags).map(([finding, enabled]) => [
      `opt_${finding}`,
      enabled,
    ]),
  );
}

export function assertFlagCapabilities(plan, capabilities = {}) {
  const supported = new Set(capabilities.optimization_flags || []);
  for (const testCase of plan) {
    for (const finding of Object.keys(testCase.optimizationFlags)) {
      if (!supported.has(finding)) {
        throw new TodoGateError(
          `runtime-${finding}`,
          `cmd/wasm-prover option and capability acknowledgement for --opt-${finding}`,
        );
      }
    }
  }
}

export function assertAppliedFlags(testCase, result) {
  const applied =
    result?.applied_optimizations ||
    result?.runtime_options ||
    result?.trace?.runtime_options;
  if (!applied) {
    throw new TodoGateError(
      `${testCase.name}-flag-ack`,
      "runtime result.runtime_options acknowledgement",
    );
  }
  for (const [finding, expected] of Object.entries(
    testCase.optimizationFlags,
  )) {
    if (applied[finding] !== expected) {
      throw new Error(
        `${testCase.name}: runtime acknowledged ${finding}=${JSON.stringify(applied[finding])}, want ${expected}`,
      );
    }
  }
}

export async function runABPlan(plan, adapter) {
  if (
    !adapter ||
    typeof adapter.capabilities !== "function" ||
    typeof adapter.runCase !== "function"
  ) {
    throw new Error(
      "A/B adapter must provide capabilities() and runCase(testCase)",
    );
  }
  const capabilities = await adapter.capabilities();
  assertFlagCapabilities(plan, capabilities);
  const runs = [];
  for (const testCase of plan) {
    const result = await adapter.runCase(testCase);
    assertAppliedFlags(testCase, result);
    const proveMS = Number(result.prove_ms ?? result.ms);
    if (!Number.isFinite(proveMS) || proveMS <= 0) {
      throw new Error(
        `${testCase.name}: result must provide positive prove_ms or ms`,
      );
    }
    runs.push({
      ...result,
      name: testCase.name,
      role: testCase.role,
      repeat: testCase.repeat,
      pair_order: testCase.pair_order,
      prove_ms: proveMS,
    });
  }
  return { schema: "wasm-prover-runtime-ab-v1", capabilities, runs };
}

export function assertSafeCaseName(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("casePrefix must be a safe filename component");
  }
}

export function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer`);
}
