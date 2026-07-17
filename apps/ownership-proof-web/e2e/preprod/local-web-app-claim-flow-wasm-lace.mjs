#!/usr/bin/env node
import { execFile as defaultExecFile, spawn as defaultSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { waitForAppReady } from "./app-server.mjs";
import { runWebAppClaimFlowWasmLace } from "./web-app-claim-flow-wasm-lace.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3917;
const DEFAULT_PROOF_ASSET_HOSTS = Object.freeze([
  "proof-assets.reclaim-proof.com",
  "proof-assets-2m.reclaim-proof.com",
]);
const LOCAL_ENV_FILE_ENV = "RECLAIM_E2E_LOCAL_ENV_FILE";
const PROFILE_ENV_FILE_ENV = "RECLAIM_E2E_LACE_PROFILE_ENV_FILE";
const LOCAL_MANIFEST_ENV = "RECLAIM_E2E_LOCAL_MANIFEST_PATH";

export class LocalPrClaimFlowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalPrClaimFlowError";
    this.code = code;
  }
}

export async function runLocalPrClaimFlow(options = {}) {
  if (options.livePreprod !== true) {
    throw new LocalPrClaimFlowError(
      "local_live_preprod_approval_missing",
      "The local PR lane submits real Preprod transactions; invoke it with --live-preprod.",
    );
  }
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const appDir = path.join(repoRoot, "apps", "ownership-proof-web");
  const capture = options.capture ?? createCapture(defaultExecFile);
  const spawn = options.spawn ?? defaultSpawn;
  const initialEnv = { ...(options.env ?? process.env) };
  const git = assertLocalPrContext(
    await readLocalPrContext({
      capture,
      env: initialEnv,
      fetch: options.fetch ?? globalThis.fetch,
      remote: options.remote ?? "origin",
      repoRoot,
    }),
  );

  const commonDir = (await capture("git", [
    "-C",
    repoRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])).trim();
  const sharedRoot = path.dirname(commonDir);
  const localEnvFile = resolveInputFile(
    initialEnv[LOCAL_ENV_FILE_ENV],
    [path.join(repoRoot, ".env.local"), path.join(sharedRoot, ".env.local")],
    LOCAL_ENV_FILE_ENV,
  );
  const profileEnvFile = resolveInputFile(
    initialEnv[PROFILE_ENV_FILE_ENV],
    [
      path.join(repoRoot, "output", "playwright", "lace-e2e-preprod-profile-v2", "profile.env"),
      path.join(sharedRoot, "output", "playwright", "lace-e2e-preprod-profile-v2", "profile.env"),
    ],
    PROFILE_ENV_FILE_ENV,
  );
  const loadEnvFile = options.loadEnvFile ?? ((file) => process.loadEnvFile(file));
  loadEnvFile(localEnvFile);
  loadEnvFile(profileEnvFile);

  const port = parsePort((options.env ?? process.env).RECLAIM_E2E_LOCAL_PORT ?? DEFAULT_PORT);
  const baseUrl = `http://${DEFAULT_HOST}:${port}`;
  const flowEnv = createLocalVercelEmulationEnv({
    baseEnv: { ...(options.env ?? process.env) },
    branch: git.branch,
    commitSha: git.commitSha,
    port,
    prNumber: git.prNumber,
  });
  const defaultManifestPath = path.join(appDir, "public", "proof-assets", "reclaim-deployment.json");
  const manifestPath = resolveInputFile(
    flowEnv[LOCAL_MANIFEST_ENV],
    [defaultManifestPath],
    LOCAL_MANIFEST_ENV,
  );
  const serverEnv = pinLocalDeploymentManifest(flowEnv, manifestPath);
  const runnerEnv = createLocalRunnerEnv(serverEnv);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const proofAssets = assertRemoteProofAssets(
    manifest,
    expectedProofAssetHosts(serverEnv),
  );

  console.log(`Building the local production app for PR #${git.prNumber} at ${git.commitSha.slice(0, 12)}.`);
  console.log(`Large proof assets remain remote at ${proofAssets.pkHost} and ${proofAssets.ccsHost}; bundled runtime assets use the production Next build.`);
  await runInherited("pnpm", ["build"], { cwd: appDir, env: serverEnv, spawn });

  const server = spawn("pnpm", ["start", "--hostname", DEFAULT_HOST, "--port", String(port)], {
    cwd: appDir,
    env: serverEnv,
    stdio: "inherit",
  });
  try {
    await waitForAppReady(baseUrl, {
      readyPath: "/claim-api/build-provenance",
      timeoutMs: 120_000,
    });
    const result = await runWebAppClaimFlowWasmLace({
      cwd: appDir,
      env: runnerEnv,
      repoRoot,
    });
    return { ...result, git, proofAssets };
  } finally {
    await stopChild(server);
  }
}

export function createLocalVercelEmulationEnv({ baseEnv, branch, commitSha, port, prNumber }) {
  const host = `${DEFAULT_HOST}:${parsePort(port)}`;
  const next = {
    ...baseEnv,
    NODE_ENV: "production",
    RECLAIM_E2E_TARGET_MODE: "local-production",
    RECLAIM_E2E_PREVIEW_URL: `http://${host}/`,
    RECLAIM_E2E_EXPECTED_COMMIT_SHA: commitSha,
    RECLAIM_E2E_EXPECTED_PR_NUMBER: String(prNumber),
    RECLAIM_E2E_FIXTURE_MODE: "prepare",
    RECLAIM_E2E_SUBMIT_TRANSACTIONS: "1",
    RECLAIM_E2E_OUTPUT_DIR: "output/preprod-web-app-claim-flow-wasm-lace-local",
    RECLAIM_LOCAL_VERCEL_PREVIEW_EMULATION: "1",
    VERCEL_ENV: "preview",
    VERCEL_URL: host,
    VERCEL_BRANCH_URL: host,
    VERCEL_PROJECT_PRODUCTION_URL: "proof-tool.vercel.app",
    VERCEL_GIT_COMMIT_SHA: commitSha,
    VERCEL_GIT_COMMIT_REF: branch,
    VERCEL_GIT_PULL_REQUEST_ID: String(prNumber),
  };
  delete next.RECLAIM_E2E_CLAIM_OUTREF;
  delete next.RECLAIM_E2E_PR_MERGE_SHA;
  delete next.RECLAIM_E2E_VERCEL_BYPASS_SECRET;
  return next;
}

export function pinLocalDeploymentManifest(env, manifestPath) {
  const next = {
    ...env,
    RECLAIM_DEPLOYMENT_MANIFEST_PATH: manifestPath,
  };
  delete next.RECLAIM_DEPLOYMENT_MANIFEST;
  delete next.RECLAIM_DEPLOYMENT_MANIFEST_JSON;
  delete next.RECLAIM_MANIFEST_PATH;
  return next;
}

export function createLocalRunnerEnv(serverEnv) {
  const next = { ...serverEnv };
  delete next.NODE_ENV;
  return next;
}

export function assertRemoteProofAssets(manifest, expectedHosts = DEFAULT_PROOF_ASSET_HOSTS) {
  if (!Array.isArray(expectedHosts) || expectedHosts.length === 0) {
    throw new LocalPrClaimFlowError(
      "local_remote_proof_asset_hosts_invalid",
      "At least one approved remote proof-asset host is required.",
    );
  }
  const browser = manifest?.proof?.browser_proving;
  if (!browser?.enabled) {
    throw new LocalPrClaimFlowError(
      "local_browser_wasm_unavailable",
      "The canonical Preprod manifest does not enable browser-WASM proving.",
    );
  }
  const pk = requireRemoteAsset(browser.pk_url, "pk_url", expectedHosts);
  const ccs = requireRemoteAsset(browser.ccs_url, "ccs_url", expectedHosts);
  return Object.freeze({ pkHost: pk.hostname, ccsHost: ccs.hostname });
}

export function assertLocalPrContext(context) {
  if (!/^[0-9a-f]{40}$/u.test(context.commitSha ?? "")) {
    throw new LocalPrClaimFlowError("local_commit_invalid", "The local claim lane requires a full Git commit SHA.");
  }
  if (!context.branch || context.branch === "main" || context.branch === "master" || context.branch === "HEAD") {
    throw new LocalPrClaimFlowError(
      "local_pr_branch_invalid",
      "The local claim lane must run from a named pull-request branch, never main or a detached HEAD.",
    );
  }
  if (context.status) {
    throw new LocalPrClaimFlowError(
      "local_worktree_dirty",
      "Commit every intended PR change before the local claim lane so its provenance matches exactly what will be pushed.",
    );
  }
  if (context.pr?.state !== "OPEN" || context.pr?.headRefName !== context.branch) {
    throw new LocalPrClaimFlowError(
      "local_open_pr_missing",
      "The current branch must already have an open GitHub pull request before this push command runs.",
    );
  }
  if (!Number.isInteger(context.pr?.number) || context.pr.number <= 0) {
    throw new LocalPrClaimFlowError("local_pr_number_invalid", "GitHub did not return a valid pull-request number.");
  }
  return Object.freeze({ ...context, prNumber: context.pr.number });
}

async function readLocalPrContext({ capture, env, fetch, remote, repoRoot }) {
  const [commitSha, branch, status, remoteUrl] = await Promise.all([
    capture("git", ["-C", repoRoot, "rev-parse", "HEAD"]),
    capture("git", ["-C", repoRoot, "symbolic-ref", "--short", "HEAD"]),
    capture("git", ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=normal"]),
    capture("git", ["-C", repoRoot, "remote", "get-url", remote]),
  ]);
  const branchName = branch.trim();
  const pr = await resolveOpenPullRequest({
    branch: branchName,
    env,
    fetch,
    repository: githubRepositoryFromRemote(remoteUrl.trim()),
  });
  return {
    commitSha: commitSha.trim().toLowerCase(),
    branch: branchName,
    status: status.trim(),
    pr,
  };
}

export function githubRepositoryFromRemote(remoteUrl) {
  const match = String(remoteUrl ?? "").trim().match(
    /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/u,
  );
  if (!match) {
    throw new LocalPrClaimFlowError(
      "local_github_remote_invalid",
      "The selected Git remote must identify a GitHub owner/repository over SSH or HTTPS.",
    );
  }
  return Object.freeze({ owner: match[1], repo: match[2] });
}

export async function resolveOpenPullRequest({ branch, env = process.env, fetch, repository }) {
  if (typeof fetch !== "function") {
    throw new LocalPrClaimFlowError("local_pr_lookup_failed", "A fetch implementation is required to resolve the open PR.");
  }
  const head = `${repository.owner}:${branch}`;
  const url = new URL(`https://api.github.com/repos/${repository.owner}/${repository.repo}/pulls`);
  url.searchParams.set("state", "open");
  url.searchParams.set("head", head);
  url.searchParams.set("per_page", "2");
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "proof-tool-local-claim-flow",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = String(env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "").trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new LocalPrClaimFlowError(
      "local_pr_lookup_failed",
      `GitHub PR lookup failed with HTTP ${response.status}; check network access or an optional GH_TOKEN/GITHUB_TOKEN.`,
    );
  }
  const matches = await response.json();
  if (!Array.isArray(matches) || matches.length !== 1) {
    throw new LocalPrClaimFlowError(
      "local_open_pr_missing",
      `Expected exactly one open pull request for ${head}; found ${Array.isArray(matches) ? matches.length : 0}.`,
    );
  }
  const pr = matches[0];
  return Object.freeze({
    headRefName: pr.head?.ref ?? "",
    number: pr.number,
    state: String(pr.state ?? "").toUpperCase(),
  });
}

function resolveInputFile(configured, candidates, field) {
  if (configured) {
    const resolved = path.resolve(configured);
    if (!existsSync(resolved)) {
      throw new LocalPrClaimFlowError("local_input_file_missing", `${field} does not exist.`);
    }
    return resolved;
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new LocalPrClaimFlowError(
      "local_input_file_missing",
      `Set ${field}; neither the current worktree nor the primary checkout contains the required ignored file.`,
    );
  }
  return found;
}

function requireRemoteAsset(value, field, expectedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LocalPrClaimFlowError("local_remote_proof_assets_missing", `browser_proving.${field} must be an HTTPS URL.`);
  }
  if (url.protocol !== "https:" || !expectedHosts.includes(url.hostname) || url.username || url.password) {
    throw new LocalPrClaimFlowError(
      "local_remote_proof_assets_missing",
      `browser_proving.${field} must use an approved remote proof-asset host.`,
    );
  }
  return url;
}

function expectedProofAssetHosts(env) {
  const configured = String(env.RECLAIM_E2E_EXPECTED_PROOF_ASSET_HOSTS ?? "").trim();
  if (!configured) {
    return [...DEFAULT_PROOF_ASSET_HOSTS];
  }
  return configured.split(",").map((value) => value.trim()).filter(Boolean);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new LocalPrClaimFlowError("local_port_invalid", "RECLAIM_E2E_LOCAL_PORT must be a TCP port between 1 and 65535.");
  }
  return port;
}

function createCapture(execFile) {
  const execute = promisify(execFile);
  return async (command, args, options = {}) => {
    const result = await execute(command, args, { cwd: options.cwd, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  };
}

function runInherited(command, args, { cwd, env, spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new LocalPrClaimFlowError(
        "local_command_failed",
        `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`,
      ));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: pnpm test:e2e:preprod:web-app-claim-flow-wasm-lace:local-pr -- --live-preprod");
    return;
  }
  try {
    const result = await runLocalPrClaimFlow({ livePreprod: process.argv.includes("--live-preprod") });
    console.log(`Local production claim completed: ${result.result.transactionHash}`);
    console.log(`Evidence: ${result.outputDir}`);
  } catch (error) {
    console.error(`${error?.code ?? "local_pr_claim_flow_failed"}: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
