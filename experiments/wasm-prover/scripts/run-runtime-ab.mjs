#!/usr/bin/env node

import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildABPlan,
  parseOptimizationFlags,
  runABPlan,
  w5WorkerTuning,
} from "../runtime/ab.mjs";
import { createBrowserAdapter } from "../runtime/browser-adapter.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const parsed = parseOptimizationFlags(process.argv.slice(2));
const options = parseArgs(parsed.rest);
const roleTuning = w5WorkerTuning({
  candidateFlags: parsed.flags,
  baselineFlags: parsed.baselineFlags,
  baselineWorkers: options.workers,
  candidateWorkers: options.candidateWorkers,
});
const plan = buildABPlan({
  casePrefix: options.casePrefix,
  candidateFlags: parsed.flags,
  baselineFlags: parsed.baselineFlags,
  commonTuning: {
    worker_count: options.workers,
    shard_count: options.shards,
    range_fetch_concurrency: options.rangeFetchConcurrency,
  },
  ...roleTuning,
  repeats: options.repeats,
});
const capabilityAdapter = await createBrowserAdapter({
  repoRoot,
  baseURL: options.baseURL,
});
const capabilities = await capabilityAdapter.capabilities();
await capabilityAdapter.close();
const adapter = {
  async capabilities() {
    return capabilities;
  },
  async runCase(testCase) {
    for (const finding of Object.keys(testCase.optimizationFlags)) {
      if (!["w1", "w2", "w3", "w5", "w6", "w7"].includes(finding))
        throw new Error(`guarded runner does not yet support ${finding}`);
    }
    const args = [
      path.join(scriptDir, "guarded-browser-benchmark.mjs"),
      "--case",
      testCase.name,
      "--base-url",
      options.baseURL,
      "--output-dir",
      options.outputDir,
      "--workers",
      String(testCase.tuning.worker_count ?? options.workers),
      "--shards",
      String(testCase.tuning.shard_count),
      "--rf",
      String(testCase.tuning.range_fetch_concurrency),
      "--gogc",
      options.gogc,
      "--gomemlimit",
      options.gomemlimit,
      "--cpu-list",
      options.cpuList,
      options.pinnedDecode ? "--pinned-decode" : "--checked-decode",
    ];
    for (const [finding, enabled] of Object.entries(
      testCase.optimizationFlags,
    )) {
      args.push(`--${enabled ? "" : "no-"}opt-${finding}`);
    }
    await runCommand(process.execPath, args);
    const output = path.join(options.outputDir, `${testCase.name}.json`);
    const summaryPath = path.join(
      options.outputDir,
      `${testCase.name}.summary.json`,
    );
    const [run, summary] = await Promise.all([
      fs.readFile(output, "utf8").then(JSON.parse),
      fs.readFile(summaryPath, "utf8").then(JSON.parse),
    ]);
    if (
      summary.preflight?.ok !== true ||
      summary.contaminated !== false ||
      summary.aborted !== false ||
      run.benchmark_guard?.accepted !== true
    ) {
      throw new Error(`${testCase.name}: guarded run was not accepted`);
    }
    return run;
  },
};
try {
  const report = await runABPlan(plan, adapter);
  await fs.mkdir(options.outputDir, { recursive: true });
  const output = path.join(options.outputDir, `${options.casePrefix}.ab.json`);
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  for (const run of report.runs) {
    await fs.writeFile(
      path.join(options.outputDir, `${run.name}.json`),
      `${JSON.stringify(run, null, 2)}\n`,
    );
  }
  console.log(output);
} finally {
  await adapter.close?.();
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${path.basename(command)} exited ${code ?? `on signal ${signal}`}`,
          ),
        );
    });
  });
}

function parseArgs(args) {
  const options = {
    casePrefix: "",
    baseURL: "http://127.0.0.1:8788/",
    outputDir: path.join(repoRoot, "experiments/wasm-prover/output"),
    workers: 8,
    candidateWorkers: null,
    shards: 32,
    rangeFetchConcurrency: 2,
    repeats: 3,
    gogc: "50",
    gomemlimit: "3000MiB",
    cpuList: "0-15",
    pinnedDecode: true,
  };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    const next = () => {
      const item = args[++index];
      if (!item) throw new Error(`${value} requires a value`);
      return item;
    };
    if (value === "--case") options.casePrefix = next();
    else if (value === "--base-url") options.baseURL = next();
    else if (value === "--output-dir") options.outputDir = path.resolve(next());
    else if (value === "--workers") options.workers = Number(next());
    else if (value === "--candidate-workers")
      options.candidateWorkers = Number(next());
    else if (value === "--shards") options.shards = Number(next());
    else if (value === "--rf") options.rangeFetchConcurrency = Number(next());
    else if (value === "--repeats") options.repeats = Number(next());
    else if (value === "--gogc") options.gogc = next();
    else if (value === "--gomemlimit") options.gomemlimit = next();
    else if (value === "--cpu-list") options.cpuList = next();
    else if (value === "--pinned-decode") options.pinnedDecode = true;
    else if (value === "--checked-decode") options.pinnedDecode = false;
    else throw new Error(`unknown argument ${value}`);
  }
  if (!options.casePrefix) throw new Error("--case is required");
  return options;
}
