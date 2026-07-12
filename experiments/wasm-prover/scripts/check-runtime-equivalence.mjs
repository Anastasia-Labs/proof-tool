#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { TodoGateError } from '../runtime/common.mjs';
import {
  assertContractVerifierResult,
  compareRuntimeProofs,
  selectABRepeat,
} from '../runtime/equivalence.mjs';

const options = parseArgs(process.argv.slice(2));
let pairs;
if (options.abReport) {
  const abReport = JSON.parse(await readFile(options.abReport, 'utf8'));
  if (options.repeat !== null) {
    pairs = [{ repeat: options.repeat, ...selectABRepeat(abReport, options.repeat) }];
  } else {
    const repeats = [...new Set(abReport.runs?.map((run) => run.repeat) || [])]
      .filter((repeat) => Number.isSafeInteger(repeat) && repeat > 0)
      .sort((left, right) => left - right);
    if (repeats.length < 3) throw new Error('promotion equivalence requires at least three A/B repeats');
    pairs = repeats.map((repeat) => ({ repeat, ...selectABRepeat(abReport, repeat) }));
  }
} else {
  pairs = [{
    repeat: null,
    baseline: JSON.parse(await readFile(options.baseline, 'utf8')),
    candidate: JSON.parse(await readFile(options.candidate, 'utf8')),
  }];
}
const tmp = await mkdtemp(path.join(os.tmpdir(), 'runtime-equivalence-'));
try {
  if (!options.contractVerifier) {
    throw new TodoGateError(
      'contract-path-verification',
      '--contract-verifier module exporting verifyContractArtifact({label, run})',
    );
  }
  const verifier = await import(pathToModule(options.contractVerifier));
  if (typeof verifier.verifyContractArtifact !== 'function') {
    throw new Error('contract verifier must export verifyContractArtifact({label, run})');
  }
  const reports = [];
  for (const pair of pairs) {
    const suffix = pair.repeat === null ? '' : `-r${pair.repeat}`;
    if (options.abReport) {
      assertGuardAccepted(pair.baseline, `baseline${suffix}`);
      assertGuardAccepted(pair.candidate, `candidate${suffix}`);
    }
    await verifyLocal(`baseline${suffix}`, pair.baseline, tmp, options.keysDir);
    await verifyLocal(`candidate${suffix}`, pair.candidate, tmp, options.keysDir);
    const report = compareRuntimeProofs(pair.baseline, pair.candidate, options);
    assertContractVerifierResult(
      await verifier.verifyContractArtifact({ label: `baseline${suffix}`, run: pair.baseline, keysDir: options.keysDir }),
      `baseline${suffix}`,
    );
    assertContractVerifierResult(
      await verifier.verifyContractArtifact({ label: `candidate${suffix}`, run: pair.candidate, keysDir: options.keysDir }),
      `candidate${suffix}`,
    );
    report.checks.push('baseline:contract-path-verify', 'candidate:contract-path-verify');
    reports.push({ repeat: pair.repeat, ...report });
  }
  const performance = summarizePerformance(pairs);
  const promotionMode = options.abReport && options.repeat === null;
  const primaryImprovement = options.primaryMetric === 'prove-ms'
    ? performance.prove_time_improvement_percent
    : performance.peak_heap_improvement_percent;
  const secondaryImprovement = options.primaryMetric === 'prove-ms'
    ? performance.peak_heap_improvement_percent
    : performance.prove_time_improvement_percent;
  performance.primary_metric = options.primaryMetric;
  performance.primary_improvement_percent = primaryImprovement;
  performance.secondary_improvement_percent = secondaryImprovement;
  if (promotionMode && primaryImprovement < options.minImprovementPercent) {
    throw new Error(
      `promotion requires designated primary metric ${options.primaryMetric} to improve >= ${options.minImprovementPercent}%; ` +
      `observed time=${performance.prove_time_improvement_percent.toFixed(3)}%, ` +
      `heap=${performance.peak_heap_improvement_percent.toFixed(3)}%`,
    );
  }
  if (promotionMode && secondaryImprovement < -options.maxSecondaryRegressionPercent) {
    throw new Error(
      `promotion secondary metric regressed ${(-secondaryImprovement).toFixed(3)}%, ` +
      `limit ${options.maxSecondaryRegressionPercent}%`,
    );
  }
  console.log(JSON.stringify({
    schema: 'wasm-prover-runtime-equivalence-batch-v1',
    ok: true,
    promotion_mode: promotionMode,
    repeat_count: pairs.length,
    guarded_runs_checked: options.abReport ? pairs.length * 2 : 0,
    performance,
    reports,
  }, null, 2));
} finally {
  await rm(tmp, { recursive: true, force: true });
}

async function verifyLocal(label, run, tempDir, keysDir) {
  const artifactPath = path.join(tempDir, `${label}.json`);
  await writeFile(artifactPath, `${JSON.stringify(run.artifact, null, 2)}\n`);
  const result = spawnSync(
    'go',
    ['run', './cmd/proof-tool', 'verify-destination', '--keys-dir', keysDir, '--destination-proof', artifactPath],
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`${label}: local verifier failed\n${result.stdout}\n${result.stderr}`);
  }
  run.verified_locally = true;
}

function parseArgs(args) {
  const out = {
    expectedCardanoProofBytes: 336,
    requireIntermediateDigests: false,
    exactProof: false,
    repeat: null,
    minImprovementPercent: 8,
    maxSecondaryRegressionPercent: 5,
    primaryMetric: 'prove-ms',
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = () => {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--baseline') out.baseline = path.resolve(next());
    else if (arg === '--candidate') out.candidate = path.resolve(next());
    else if (arg === '--ab-report') out.abReport = path.resolve(next());
    else if (arg === '--repeat') out.repeat = Number(next());
    else if (arg === '--min-improvement-percent') out.minImprovementPercent = Number(next());
    else if (arg === '--max-secondary-regression-percent') out.maxSecondaryRegressionPercent = Number(next());
    else if (arg === '--primary-metric') out.primaryMetric = next();
    else if (arg === '--keys-dir') out.keysDir = path.resolve(next());
    else if (arg === '--contract-verifier') out.contractVerifier = path.resolve(next());
    else if (arg === '--require-intermediate-digests') out.requireIntermediateDigests = true;
    else if (arg === '--exact-proof') out.exactProof = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!out.keysDir) throw new Error('--keys-dir is required');
  if (out.abReport && (out.baseline || out.candidate)) throw new Error('--ab-report cannot be combined with --baseline/--candidate');
  if (!out.abReport && (!out.baseline || !out.candidate)) throw new Error('use --ab-report or both --baseline and --candidate');
  if (out.repeat !== null && (!Number.isSafeInteger(out.repeat) || out.repeat <= 0)) {
    throw new Error('--repeat must be a positive integer');
  }
  if (!Number.isFinite(out.minImprovementPercent) || out.minImprovementPercent <= 0) {
    throw new Error('--min-improvement-percent must be positive');
  }
  if (!Number.isFinite(out.maxSecondaryRegressionPercent) || out.maxSecondaryRegressionPercent < 0) {
    throw new Error('--max-secondary-regression-percent must be non-negative');
  }
  if (!['prove-ms', 'peak-heap-gib'].includes(out.primaryMetric)) {
    throw new Error('--primary-metric must be prove-ms or peak-heap-gib');
  }
  return out;
}

function assertGuardAccepted(run, label) {
  const guard = run?.benchmark_guard;
  if (!guard || guard.accepted !== true || guard.preflight_ok !== true || guard.contaminated !== false || guard.aborted !== false) {
    throw new Error(`${label}: guarded benchmark was not accepted`);
  }
  if (!Array.isArray(guard.contamination_reasons) || guard.contamination_reasons.length !== 0) {
    throw new Error(`${label}: contamination telemetry is not clean`);
  }
}

function summarizePerformance(pairs) {
  const baselineTimes = pairs.map(({ baseline }) => Number(baseline.prove_ms ?? baseline.ms));
  const candidateTimes = pairs.map(({ candidate }) => Number(candidate.prove_ms ?? candidate.ms));
  const baselineHeaps = pairs.map(({ baseline }) => Number(baseline.peak_heap_gib));
  const candidateHeaps = pairs.map(({ candidate }) => Number(candidate.peak_heap_gib));
  for (const [label, values] of [
    ['baseline prove_ms', baselineTimes],
    ['candidate prove_ms', candidateTimes],
    ['baseline peak_heap_gib', baselineHeaps],
    ['candidate peak_heap_gib', candidateHeaps],
  ]) {
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`${label} must be positive for every repeat`);
    }
  }
  const baselineMedianMS = median(baselineTimes);
  const candidateMedianMS = median(candidateTimes);
  const baselineMedianHeap = median(baselineHeaps);
  const candidateMedianHeap = median(candidateHeaps);
  const timeImprovement = ((baselineMedianMS - candidateMedianMS) / baselineMedianMS) * 100;
  const heapImprovement = ((baselineMedianHeap - candidateMedianHeap) / baselineMedianHeap) * 100;
  return {
    baseline_median_prove_ms: baselineMedianMS,
    candidate_median_prove_ms: candidateMedianMS,
    prove_time_improvement_percent: timeImprovement,
    baseline_median_peak_heap_gib: baselineMedianHeap,
    candidate_median_peak_heap_gib: candidateMedianHeap,
    peak_heap_improvement_percent: heapImprovement,
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pathToModule(file) {
  return pathToFileURL(file).href;
}
