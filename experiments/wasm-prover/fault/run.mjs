#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createFaultBrowserAdapter } from './browser-adapter.mjs';
import { runFaultCases, selectFaultCases, validateFaultWorkerCount } from './cases.mjs';
import { parseOptimizationFlags, toRuntimeTuning } from '../runtime/ab.mjs';

const faultDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(faultDir, '../../..');
const parsedFlags = parseOptimizationFlags(process.argv.slice(2));
const options = parseArgs(parsedFlags.rest);
validateFaultWorkerCount(options.workers);
const cases = selectFaultCases(options.cases);
const adapter = await createFaultBrowserAdapter({
  repoRoot,
  baseURL: options.baseURL,
  tuning: { ...toRuntimeTuning(parsedFlags.flags), worker_count: options.workers },
  optimizationFlags: parsedFlags.flags,
  workerCount: options.workers,
});
try {
  const report = await runFaultCases(cases, adapter, { deadlineMs: options.deadlineMs, workerCount: options.workers });
  await fs.mkdir(options.outputDir, { recursive: true });
  const output = path.join(options.outputDir, `fault-${options.cases.join('-') || 'all'}.json`);
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(output);
} finally {
  await adapter.close();
}

function parseArgs(args) {
  const options = {
    cases: [],
    baseURL: 'http://127.0.0.1:8788/',
    outputDir: path.join(repoRoot, 'experiments/wasm-prover/output'),
    deadlineMs: 180_000,
    workers: 8,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = () => {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--case') options.cases.push(next());
    else if (arg === '--base-url') options.baseURL = next();
    else if (arg === '--output-dir') options.outputDir = path.resolve(next());
    else if (arg === '--deadline-ms') options.deadlineMs = Number(next());
    else if (arg === '--workers') options.workers = Number(next());
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}
