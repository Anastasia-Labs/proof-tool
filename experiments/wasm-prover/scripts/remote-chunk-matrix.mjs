#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const guarded = path.join(scriptDir, "guarded-browser-benchmark.mjs");
const loadHelper = path.join(scriptDir, "controlled-host-load.mjs");
const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
if (configIndex < 0 || !args[configIndex + 1]) {
  throw new Error("usage: remote-chunk-matrix.mjs --config FILE [--dry-run]");
}
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const configPath = path.resolve(args[configIndex + 1]);
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
validateConfig(config);
const outputDir = path.resolve(config.output_dir);
const profileDir = path.resolve(config.browser_profile_dir);
await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(profileDir, { recursive: true });
const cases = buildCases(config);
const index = {
  schema: "browser-proving-remote-chunk-matrix-v1",
  generated_at: new Date().toISOString(),
  config_path: configPath,
  harness_base_url: config.harness_base_url,
  browser_profile_dir: profileDir,
  dry_run: dryRun,
  resume,
  cases: [],
};

for (const testCase of cases) {
  const overridePath = path.join(outputDir, testCase.name + ".artifacts.json");
  await fs.writeFile(overridePath, JSON.stringify(testCase.artifacts, null, 2) + "\n", { mode: 0o600 });
  const command = [
    guarded,
    "--base-url", config.harness_base_url,
    "--output-dir", outputDir,
    "--case", testCase.name,
    "--workers", String(testCase.workers),
    "--shards", String(testCase.workers),
    "--rf", "2",
    "--chunk-prefetch-window", String(testCase.prefetchWindow),
    "--artifact-overrides", overridePath,
    "--private-inputs-file", path.resolve(config.private_inputs_file),
    "--browser-profile-dir", profileDir,
    ...(config.browser_cookie_file
      ? ["--browser-cookie-file", path.resolve(config.browser_cookie_file)]
      : []),
    "--cache-mode", testCase.cacheMode,
    "--pinned-decode",
    "--opt-w1", "--opt-w2", "--opt-w3", "--opt-w5", "--opt-w6", "--opt-w7",
    ...(testCase.hostCondition === "loaded"
      ? ["--allow-busy-preflight", "--no-abort-on-contamination"]
      : []),
    ...(config.guard_args || []),
  ];
  const entry = {
    ...testCase,
    artifacts: undefined,
    artifact_overrides_path: overridePath,
    command: [process.execPath, ...command],
    status: dryRun ? "planned" : "running",
  };
  index.cases.push(entry);
  await writeIndex(outputDir, index);
  if (dryRun) continue;

  if (resume && await hasValidExistingResult(outputDir, testCase)) {
    entry.status = "complete-existing";
    await writeIndex(outputDir, index);
    continue;
  }

  let load = null;
  try {
    if (testCase.hostCondition === "loaded") {
      load = spawn(process.execPath, [loadHelper, String(config.host_load_workers || 2)], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "inherit"],
      });
      await waitForReady(load);
    }
    let idlePreflightRetries = 0;
    for (;;) {
      try {
        await run(process.execPath, command);
        break;
      } catch (error) {
        const retryLimit = Number(config.idle_preflight_retry_limit || 0);
        const retryableContamination =
          error.exitCode === 2 ||
          (error.exitCode === 3 && testCase.delivery === "hit");
        if (
          testCase.hostCondition !== "idle" ||
          !retryableContamination ||
          idlePreflightRetries >= retryLimit
        ) {
          throw error;
        }
        idlePreflightRetries += 1;
        entry.status = "waiting-for-idle";
        entry.idle_preflight_retries = idlePreflightRetries;
        await writeIndex(outputDir, index);
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        entry.status = "running";
        await writeIndex(outputDir, index);
      }
    }
    entry.status = "complete";
  } catch (error) {
    entry.status = "failed";
    entry.error = error.message;
    await writeIndex(outputDir, index);
    throw error;
  } finally {
    if (load) {
      load.kill("SIGTERM");
      await new Promise((resolve) => load.once("exit", resolve));
    }
  }
  await writeIndex(outputDir, index);
}

await writeIndex(outputDir, index);
console.log(JSON.stringify(index, null, 2));

function buildCases(input) {
  const out = [];
  const windows = input.chunk_prefetch_windows || [2];
  for (const size of [2, 4, 8, 16]) {
    for (const delivery of ["hit", "fresh"]) {
      for (const workers of [8, 16]) {
        for (const hostCondition of ["idle", "loaded"]) {
          for (const prefetchWindow of windows) {
            for (const cacheMode of ["cold", "warm"]) {
              out.push({
                name: [
                  "v2", size + "m", delivery, cacheMode,
                  "w" + workers, hostCondition, "pf" + prefetchWindow,
                ].join("-"),
                chunkSizeMiB: size,
                delivery,
                cacheMode,
                workers,
                hostCondition,
                prefetchWindow,
                artifacts: artifactsForCase(input, {
                  size,
                  delivery,
                  workers,
                  hostCondition,
                  prefetchWindow,
                }),
              });
            }
          }
        }
      }
    }
  }
  return out;
}

function freshVariantKey({ workers, hostCondition, prefetchWindow }) {
  return `w${workers}-${hostCondition}-pf${prefetchWindow}`;
}

function artifactsForCase(input, testCase) {
  const set = input.artifact_sets[String(testCase.size)];
  if (testCase.delivery === "hit") return set.hit;
  return set.fresh[freshVariantKey(testCase)];
}

function validateConfig(input) {
  if (!/^https?:\/\//u.test(input.harness_base_url || "")) {
    throw new Error("harness_base_url must be http(s)");
  }
  for (const field of ["output_dir", "browser_profile_dir", "private_inputs_file"]) {
    if (typeof input[field] !== "string" || input[field] === "") {
      throw new Error(field + " is required");
    }
  }
  if (input.chunk_prefetch_windows && !input.chunk_prefetch_windows.every((value) => [1, 2, 3, 4].includes(value))) {
    throw new Error("chunk_prefetch_windows may contain only 1, 2, 3, or 4");
  }
  const required = [
    "manifest_url", "manifest_sig_url", "manifest_public_key_hex",
    "vk_url", "pk_url", "pk_index_url", "ccs_url", "ccs_blake2b256",
    "chunk_manifest_url", "chunk_manifest_sig_url",
    "chunk_manifest_public_key_hex", "deployment_manifest_url",
    "proof_wasm_url", "worker_js_url", "msm_worker_wasm_url",
  ];
  for (const size of [2, 4, 8, 16]) {
    const set = input.artifact_sets?.[String(size)];
    if (!set?.hit) throw new Error("missing signed artifact set " + size + "MiB/hit");
    const variants = [{ delivery: "hit", key: "hit", artifacts: set.hit }];
    for (const workers of [8, 16]) {
      for (const hostCondition of ["idle", "loaded"]) {
        for (const prefetchWindow of input.chunk_prefetch_windows || [2]) {
          const key = freshVariantKey({ workers, hostCondition, prefetchWindow });
          variants.push({
            delivery: "fresh",
            key,
            artifacts: set.fresh?.[key],
          });
        }
      }
    }
    const manifestURLs = new Set();
    for (const { delivery, key, artifacts } of variants) {
      if (!artifacts) {
        throw new Error("missing signed artifact set " + size + "MiB/" + delivery + "/" + key);
      }
      for (const field of required) {
        if (typeof artifacts[field] !== "string" || artifacts[field] === "") {
          throw new Error(size + "MiB/" + delivery + "/" + key + " is missing " + field);
        }
      }
      if (manifestURLs.has(artifacts.chunk_manifest_url)) {
        throw new Error(size + "MiB signed variants must use distinct manifest URLs");
      }
      manifestURLs.add(artifacts.chunk_manifest_url);
    }
  }
}

async function waitForReady(child) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("controlled host load did not become ready")), 10_000);
    child.once("error", reject);
    child.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
  });
}

async function run(file, commandArgs) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, commandArgs, { cwd: repoRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error("benchmark exited " + code);
      error.exitCode = code;
      reject(error);
    });
  });
}

async function writeIndex(dir, value) {
  await fs.writeFile(
    path.join(dir, "matrix-index.json"),
    JSON.stringify(value, null, 2) + "\n",
  );
}

async function hasValidExistingResult(dir, testCase) {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(dir, testCase.name + ".json"), "utf8"),
    );
    return Boolean(value.name === testCase.name &&
      value.verified_locally === true &&
      value.trace?.worker_count === testCase.workers &&
      value.trace?.chunk_prefetch_window === testCase.prefetchWindow &&
      value.asset_identity?.chunk_manifest_sha256);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}
