#!/usr/bin/env node
import { execFile as defaultExecFile, spawn as defaultSpawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalPrClaimFlowError, runLocalPrClaimFlow } from "./local-web-app-claim-flow-wasm-lace.mjs";

export async function runPrPushWithLocalClaimFlow(options = {}) {
  const parsed = parsePrPushArgs(options.argv ?? []);
  const repoRoot = options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const capture = options.capture ?? createCapture(defaultExecFile);
  const spawn = options.spawn ?? defaultSpawn;
  const localRunner = options.localRunner ?? runLocalPrClaimFlow;
  const initialBranch = (await capture(
    "git",
    ["-C", repoRoot, "symbolic-ref", "--short", "HEAD"],
  )).trim();
  try {
    await runInherited(
      "git",
      buildPushArgs({ branch: initialBranch, dryRun: true, remote: parsed.remote, repoRoot }),
      { spawn },
    );
  } catch {
    throw new LocalPrClaimFlowError(
      "local_push_preflight_failed",
      `Git cannot update ${parsed.remote}/${initialBranch}; fix authentication, permissions, or a non-fast-forward branch before spending Preprod funds.`,
    );
  }
  const result = await localRunner({
    livePreprod: parsed.livePreprod,
    remote: parsed.remote,
    repoRoot,
  });

  const afterSha = (await capture("git", ["-C", repoRoot, "rev-parse", "HEAD"])).trim().toLowerCase();
  const afterBranch = (await capture("git", ["-C", repoRoot, "symbolic-ref", "--short", "HEAD"])).trim();
  const afterStatus = (await capture("git", [
    "-C",
    repoRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ])).trim();
  assertPushHeadStable({
    afterBranch,
    afterSha,
    afterStatus,
    testedBranch: result.git.branch,
    testedSha: result.git.commitSha,
  });

  await runInherited(
    "git",
    buildPushArgs({ branch: afterBranch, dryRun: false, remote: parsed.remote, repoRoot }),
    { spawn },
  );
  return {
    branch: afterBranch,
    commitSha: afterSha,
    prNumber: result.git.prNumber,
    remote: parsed.remote,
    transactionHash: result.result.transactionHash,
  };
}

export function buildPushArgs({ branch, dryRun, remote, repoRoot }) {
  return [
    "-C",
    repoRoot,
    "push",
    ...(dryRun ? ["--dry-run", "--no-verify"] : []),
    remote,
    `HEAD:refs/heads/${branch}`,
  ];
}

export function parsePrPushArgs(argv) {
  const args = [...argv];
  let livePreprod = false;
  let remote = "origin";
  while (args.length) {
    const arg = args.shift();
    if (arg === "--live-preprod") {
      livePreprod = true;
    } else if (arg === "--remote") {
      remote = String(args.shift() ?? "").trim();
    } else {
      throw new LocalPrClaimFlowError("local_push_argument_invalid", `Unknown PR-push argument: ${arg}`);
    }
  }
  if (!livePreprod) {
    throw new LocalPrClaimFlowError(
      "local_live_preprod_approval_missing",
      "Use --live-preprod to acknowledge that this command funds and submits real Preprod transactions before pushing.",
    );
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(remote)) {
    throw new LocalPrClaimFlowError("local_push_remote_invalid", "The Git remote name is invalid.");
  }
  return Object.freeze({ livePreprod, remote });
}

export function assertPushHeadStable({ afterBranch, afterSha, afterStatus, testedBranch, testedSha }) {
  if (afterBranch !== testedBranch || afterSha !== testedSha || afterStatus) {
    throw new LocalPrClaimFlowError(
      "local_push_head_changed",
      "The branch, commit, or worktree changed during the browser claim. Nothing was pushed; commit and rerun the lane.",
    );
  }
}

function createCapture(execFile) {
  const execute = promisify(execFile);
  return async (command, args) => {
    const result = await execute(command, args, { maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  };
}

function runInherited(command, args, { spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new LocalPrClaimFlowError(
        "local_push_failed",
        `git push failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`,
      ));
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runPrPushWithLocalClaimFlow({ argv });
    console.log(`Pushed ${result.branch}@${result.commitSha.slice(0, 12)} after live local claim ${result.transactionHash}.`);
  } catch (error) {
    console.error(`${error?.code ?? "local_pr_push_failed"}: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
