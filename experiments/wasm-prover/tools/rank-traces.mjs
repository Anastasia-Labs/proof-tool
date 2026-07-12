#!/usr/bin/env node

import fs from 'node:fs';

const CANDIDATES = [
  {
    name: 'MSM scheduling',
    stages: ['commitment Basis MSM', 'commitment BasisExpSigma MSM', 'G2B', 'A', 'B', 'Z', 'K'],
    implementation_risk: 'medium',
    cryptographic_risk: 'low/medium',
    product_impact: 'high',
  },
  {
    name: 'Proving-key transport',
    stages: ['open-keys', 'G2B', 'A', 'B', 'Z', 'K'],
    implementation_risk: 'medium',
    cryptographic_risk: 'low',
    product_impact: 'medium/high',
  },
  {
    name: 'CCS transport',
    stages: ['open-ccs'],
    implementation_risk: 'low/medium',
    cryptographic_risk: 'low',
    product_impact: 'medium',
  },
  {
    name: 'Memory/GC tuning',
    stages: ['solver', 'computeH / FFT', 'G2B', 'A', 'B', 'Z', 'K'],
    implementation_risk: 'low',
    cryptographic_risk: 'low',
    product_impact: 'medium',
  },
  {
    name: 'Worker kernel optimization',
    stages: ['G2B', 'A', 'B', 'Z', 'K'],
    implementation_risk: 'medium',
    cryptographic_risk: 'low/medium',
    product_impact: 'medium',
  },
  {
    name: 'Artifact/key format changes',
    stages: ['open-keys', 'open-ccs', 'G2B', 'A', 'B', 'Z', 'K'],
    implementation_risk: 'high',
    cryptographic_risk: 'medium',
    product_impact: 'high',
  },
];

function usage() {
  console.error('usage: rank-traces.mjs trace-or-result.json [...]');
  process.exit(2);
}

function readTrace(path) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const trace = value.trace || value;
  if (!trace || !Array.isArray(trace.events)) {
    throw new Error(`${path}: expected a proof result with .trace or a raw trace`);
  }
  return {
    path,
    result: value,
    trace,
    wall_seconds: Number(value.wall_seconds || 0),
    peak_heap_gib: Number(value.peak_heap_gib || peakHeapGiB(trace)),
  };
}

function peakHeapGiB(trace) {
  const peak = Math.max(0, ...trace.events.map((e) => Number(e.mem?.heap_sys || 0)));
  return peak / 2 ** 30;
}

function stageDurations(trace) {
  const open = new Map();
  const totals = new Map();
  for (const e of trace.events) {
    const key = e.stage;
    if (e.phase === 'start') {
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(e.at_ms);
    } else if (e.phase === 'end') {
      const stack = open.get(key);
      if (!stack || stack.length === 0) continue;
      const started = stack.pop();
      totals.set(key, (totals.get(key) || 0) + Math.max(0, e.at_ms - started));
    }
  }
  return totals;
}

function sumStages(durations, stages) {
  let ms = 0;
  for (const stage of stages) ms += durations.get(stage) || 0;
  return ms / 1000;
}

function classify(savedSeconds, peakGiB, reliabilityGain) {
  if (peakGiB >= 3.5 || reliabilityGain >= 2) return 'P0';
  if (savedSeconds >= 60 || peakGiB >= 0.25 || reliabilityGain >= 1) return 'P1';
  if (savedSeconds >= 5 || peakGiB >= 0.05) return 'P2';
  return 'P3';
}

function confidence(runs, stageSeconds) {
  if (runs.length >= 3) return 'medium/high';
  if (runs.length >= 2) return 'medium';
  if (stageSeconds > 0) return 'single-trace';
  return 'low';
}

if (process.argv.length < 3) usage();

const runs = process.argv.slice(2).map(readTrace);
const baseline = runs[0];
const scored = CANDIDATES.map((candidate) => {
  const perRun = runs.map((run) => {
    const durations = stageDurations(run.trace);
    return {
      file: run.path,
      seconds: sumStages(durations, candidate.stages),
      wall_seconds: run.wall_seconds,
      peak_heap_gib: run.peak_heap_gib,
      engine: run.trace.engine || run.result.engine,
      worker_count: run.trace.worker_count,
      shard_count: run.trace.shard_count,
      range_fetch_concurrency: run.trace.range_fetch_concurrency,
      pk_range_requests: run.trace.pk_range_stats?.requests,
      pk_range_bytes: run.trace.pk_range_stats?.bytes,
    };
  });
  const baselineSeconds = perRun[0].seconds;
  const bestSeconds = Math.min(...perRun.map((r) => r.seconds || Number.POSITIVE_INFINITY));
  const savedSeconds = Number.isFinite(bestSeconds) ? Math.max(0, baselineSeconds - bestSeconds) : 0;
  const stageSeconds = baselineSeconds;
  const peakGiB = Math.max(0, baseline.peak_heap_gib - Math.min(...runs.map((r) => r.peak_heap_gib || baseline.peak_heap_gib)));
  const reliabilityGain = baseline.peak_heap_gib >= 3.5 && candidate.name !== 'CCS transport' ? 2 : 0;
  const impact = savedSeconds + peakGiB * 120 + reliabilityGain * 60;
  return {
    candidate: candidate.name,
    priority: classify(savedSeconds || stageSeconds, peakGiB, reliabilityGain),
    impact_score: Number(impact.toFixed(2)),
    measured_stage_seconds: Number(stageSeconds.toFixed(2)),
    saved_seconds_vs_baseline: Number(savedSeconds.toFixed(2)),
    peak_memory_saved_gib_vs_baseline: Number(peakGiB.toFixed(3)),
    wall_clock_impact: savedSeconds > 0 ? `${savedSeconds.toFixed(1)}s saved in measured matrix` : `${stageSeconds.toFixed(1)}s measured in baseline stages`,
    peak_memory_impact: peakGiB > 0 ? `${peakGiB.toFixed(3)} GiB saved in measured matrix` : 'not yet isolated',
    implementation_risk: candidate.implementation_risk,
    cryptographic_correctness_risk: candidate.cryptographic_risk,
    product_impact: candidate.product_impact,
    confidence_from_measurement: confidence(runs, stageSeconds),
    evidence: perRun,
    guardrails: [
      'proof verifies against current VK',
      'Cardano artifact shape unchanged',
      'tamper checks still fail',
      'no secret leaves WASM/local boundary',
      'no unpinned artifact accepted',
      'benchmark trace before/after recorded',
    ],
  };
}).sort((a, b) => b.impact_score - a.impact_score || a.priority.localeCompare(b.priority));

console.log(JSON.stringify({
  schema: 'browser-wasm-optimization-backlog-v1',
  baseline: {
    file: baseline.path,
    wall_seconds: baseline.wall_seconds,
    peak_heap_gib: baseline.peak_heap_gib,
    engine: baseline.trace.engine || baseline.result.engine,
  },
  backlog: scored,
}, null, 2));
