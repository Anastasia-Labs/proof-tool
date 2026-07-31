// Counterbalanced A/B proving-time gate for the bounded shard-recovery change.
//
// The recovery work must not cost proving time. This harness runs the guarded
// browser benchmark alternately against an unmodified "baseline" runtime and
// the "candidate" runtime built from the same source with only the recovery
// patch applied, then compares paired medians under a hard regression ceiling.
//
// Both runtimes are served from prebuilt asset trees rather than rebuilt here,
// so a run measures only the runtime delta. Build them with the staging
// scripts and place them at <dir>/{baseline,candidate}-assets. The tree holds
// real per-role prover-worker.js / msmworker.wasm / proof-destination.wasm / worker.js /
// chunk-manifest.{json,sig}; the heavy proving-key chunks are symlinks into
// the shared release stage, so the two roles differ only by runtime.
//
// The fixtures directory carries a witness-bearing private-inputs file and is
// therefore expected to live under the gitignored output/ tree. Never move it
// into a tracked path.
//
//   node experiments/wasm-prover/scripts/recovery-perf-ab.mjs cold
//   node experiments/wasm-prover/scripts/recovery-perf-ab.mjs warm
//
// Accepted samples are cached: rerunning resumes at the first role/repeat that
// has no clean artifact, so a host-contamination abort never discards work
// that already passed its guards.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, "../../..");

const mode = process.argv[2];
if (mode !== "cold" && mode !== "warm") {
  throw new Error("usage: node recovery-perf-ab.mjs cold|warm");
}

const abDir = path.resolve(
  process.env.RECOVERY_AB_DIR || path.join(repo, "output/recovery-perf-ab"),
);
const fixtures = path.join(abDir, "fixtures");
const outputDir = path.join(abDir, "bench", mode);
mkdirSync(outputDir, { recursive: true });

const roles = {
  baseline: {
    port: 8789,
    assets: path.join(abDir, "baseline-assets"),
    overrides: path.join(fixtures, "overrides-baseline.json"),
    profile: path.join(abDir, "profile-baseline"),
  },
  candidate: {
    port: 8788,
    assets: path.join(abDir, "candidate-assets"),
    overrides: path.join(fixtures, "overrides-candidate.json"),
    profile: path.join(abDir, "profile-candidate"),
  },
};

// Counterbalanced ABBA-style order: neither role systematically occupies the
// warmest or coldest position in the session, so slow thermal drift cannot
// masquerade as a runtime difference.
const sequence = [
  ["baseline", 1],
  ["candidate", 1],
  ["candidate", 2],
  ["baseline", 2],
  ["baseline", 3],
  ["candidate", 3],
];

const acceptance = {
  maximum_median_proving_regression_percent: 0.5,
  maximum_median_heap_regression_percent: 1.0,
};

for (const [role, selected] of Object.entries(roles)) {
  for (const required of ["chunk-manifest.json", "prover-worker.js", "msmworker.wasm", "proof-destination.wasm", "worker.js"]) {
    const candidatePath = path.join(selected.assets, required);
    if (!existsSync(candidatePath)) {
      throw new Error(`${role} asset tree is missing ${required} (${candidatePath})`);
    }
  }
  if (!existsSync(selected.overrides)) {
    throw new Error(`${role} artifact overrides missing: ${selected.overrides}`);
  }
}
const privateInputs = path.join(fixtures, "private-inputs.json");
if (!existsSync(privateInputs)) {
  throw new Error(`private inputs fixture missing: ${privateInputs}`);
}

// server.mjs refuses to guess GOROOT (it serves wasm_exec.js from the active
// toolchain), so resolve it here rather than depending on the caller's shell.
const goRoot =
  process.env.GOROOT ||
  execFileSync("go", ["env", "GOROOT"], { cwd: repo, encoding: "utf8" }).trim();
if (!goRoot) throw new Error("unable to resolve GOROOT for the asset servers");

const servers = [];
function startServer(role) {
  const selected = roles[role];
  const child = spawn(process.execPath, ["experiments/wasm-prover/web/server.mjs"], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GOROOT: goRoot,
      PORT: String(selected.port),
      PROOF_CHUNK_ASSETS_DIR: selected.assets,
      PROOF_KEY_BUNDLE_DIR: selected.assets,
    },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(`[${role}] ${chunk}`));
  child.on("exit", (code, signal) => {
    child.exitInfo = `exited ${code ?? signal}`;
  });
  servers.push(child);
  return child;
}

async function waitForServer(role) {
  const { port } = roles[role];
  const child = roles[role].process;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    // Fail fast when the server died on startup instead of burning the
    // full readiness budget on a process that will never listen.
    if (child?.exitInfo) {
      throw new Error(`${role} server ${child.exitInfo} before becoming ready (see [${role}] output above)`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${role} server did not become ready on port ${port}`);
}

function stopServers() {
  for (const child of servers) {
    if (!child.killed) child.kill("SIGTERM");
  }
}
process.on("exit", stopServers);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopServers();
    process.exit(130);
  });
}

function acceptedArtifact(artifact, summary) {
  return (
    artifact?.verified_locally === true &&
    artifact.benchmark_guard?.accepted === true &&
    summary?.preflight?.ok === true &&
    (summary.observed_transient_reasons || []).length === 0 &&
    summary.contaminated === false &&
    summary.aborted === false
  );
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repo, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${args[2]} exited ${code ?? signal}`));
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

for (const role of Object.keys(roles)) {
  roles[role].process = startServer(role);
}
await Promise.all(Object.keys(roles).map((role) => waitForServer(role)));

const runs = [];
for (const [role, repeat] of sequence) {
  const selected = roles[role];
  const name = `recovery-${mode}-r${repeat}-${role}`;
  const args = [
    "experiments/wasm-prover/scripts/guarded-browser-benchmark.mjs",
    "--case", name,
    "--base-url", `http://127.0.0.1:${selected.port}/`,
    "--output-dir", outputDir,
    "--workers", "16",
    "--shards", "16",
    "--rf", "2",
    "--chunk-prefetch-window", "2",
    "--artifact-overrides", selected.overrides,
    "--prover-worker-url", `http://127.0.0.1:${selected.port}/proof-assets/prover-worker.js`,
    "--private-inputs-file", privateInputs,
    "--browser-profile-dir", selected.profile,
    "--cache-mode", mode,
    "--preflight-seconds", "8",
    "--sample-ms", "2000",
    "--max-load-per-core", "0.35",
    "--min-preflight-idle-percent", "85",
    "--max-external-process-cpu-percent", "110",
    "--max-external-total-cpu-percent", "250",
    "--contamination-samples", "3",
    "--gogc", "15",
    "--gomemlimit", "3200MiB",
    "--cpu-list", "16-31",
    "--pinned-decode",
    "--opt-w1", "--opt-w2", "--opt-w3", "--opt-w5", "--opt-w6", "--opt-w7",
  ];
  const artifactPath = path.join(outputDir, `${name}.json`);
  const summaryPath = path.join(outputDir, `${name}.summary.json`);
  let artifact;
  let summary;
  if (existsSync(artifactPath) && existsSync(summaryPath)) {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  }
  if (acceptedArtifact(artifact, summary)) {
    process.stdout.write(`[resume] reusing clean sample ${name} (${artifact.prove_ms} ms)\n`);
  } else {
    await run(process.execPath, args);
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  }
  if (!acceptedArtifact(artifact, summary)) {
    throw new Error(`${name} did not pass its guarded acceptance checks`);
  }
  runs.push({
    role,
    repeat,
    name,
    prove_ms: artifact.prove_ms,
    wall_seconds: artifact.wall_seconds,
    peak_heap_gib: artifact.peak_heap_gib,
    engine: artifact.engine,
    worker_count: artifact.trace?.worker_count,
    runtime_options: artifact.runtime_options,
    contamination: summary.sample_summary,
  });
}

stopServers();

const baseline = runs.filter((entry) => entry.role === "baseline");
const candidate = runs.filter((entry) => entry.role === "candidate");
const baselineMedianMS = median(baseline.map((entry) => entry.prove_ms));
const candidateMedianMS = median(candidate.map((entry) => entry.prove_ms));
const baselineMedianHeap = median(baseline.map((entry) => entry.peak_heap_gib));
const candidateMedianHeap = median(candidate.map((entry) => entry.peak_heap_gib));
const provingRegressionPercent = (candidateMedianMS / baselineMedianMS - 1) * 100;
const heapRegressionPercent = (candidateMedianHeap / baselineMedianHeap - 1) * 100;

const report = {
  schema: "proof-recovery-performance-ab-v1",
  mode,
  protocol: {
    sequence,
    cpu_list: "16-31",
    note:
      "Browser and runner pinned to CPUs 16-31. Per-process background CPU capped at 110%, " +
      "aggregate background at 250%, and any transient threshold violation rejects the run.",
    acceptance,
  },
  runs,
  summary: {
    baseline_median_prove_ms: baselineMedianMS,
    candidate_median_prove_ms: candidateMedianMS,
    proving_regression_percent: provingRegressionPercent,
    baseline_median_peak_heap_gib: baselineMedianHeap,
    candidate_median_peak_heap_gib: candidateMedianHeap,
    heap_regression_percent: heapRegressionPercent,
    accepted:
      provingRegressionPercent <= acceptance.maximum_median_proving_regression_percent &&
      heapRegressionPercent <= acceptance.maximum_median_heap_regression_percent,
  },
};

writeFileSync(
  path.join(outputDir, `recovery-${mode}-ab.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
if (!report.summary.accepted) process.exitCode = 4;
