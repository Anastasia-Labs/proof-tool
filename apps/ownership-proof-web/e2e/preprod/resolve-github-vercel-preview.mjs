import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_HOST_PREFIX = "proof-tool-";
const PRODUCTION_HOST = "proof-tool.vercel.app";

export class GitHubVercelPreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GitHubVercelPreviewError";
    this.code = code;
  }
}

export async function resolveGitHubVercelPreview({
  repository,
  sha,
  token,
  expectedHostPrefix = DEFAULT_HOST_PREFIX,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  fetchFn = globalThis.fetch,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const normalizedRepository = validateRepository(repository);
  const normalizedSha = validateCommitSha(sha);
  const normalizedToken = requireString(token, "GITHUB_TOKEN");
  const normalizedPrefix = validateHostPrefix(expectedHostPrefix);
  if (typeof fetchFn !== "function") {
    throw new GitHubVercelPreviewError("github_fetch_unavailable", "A Fetch-compatible GitHub API client is required.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new GitHubVercelPreviewError("preview_resolver_timing_invalid", "Preview resolver timing values must be non-negative numbers.");
  }

  const deadline = now() + timeoutMs;
  do {
    const candidates = await successfulPreviewCandidates({
      repository: normalizedRepository,
      sha: normalizedSha,
      token: normalizedToken,
      expectedHostPrefix: normalizedPrefix,
      fetchFn,
    });
    if (candidates.length === 1) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      const hosts = candidates.map(({ url }) => new URL(url).hostname).sort();
      throw new GitHubVercelPreviewError(
        "preview_deployment_ambiguous",
        `More than one successful Vercel Preview matches the expected commit: ${hosts.join(", ")}.`,
      );
    }
    if (now() >= deadline) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  } while (now() <= deadline);

  throw new GitHubVercelPreviewError(
    "preview_deployment_not_ready",
    "No successful immutable Vercel Preview deployment was reported for the expected PR-head commit before the timeout.",
  );
}

export function validateVercelPreviewOrigin(value, expectedHostPrefix = DEFAULT_HOST_PREFIX) {
  const normalizedPrefix = validateHostPrefix(expectedHostPrefix);
  let url;
  try {
    url = new URL(requireString(value, "RECLAIM_E2E_PREVIEW_URL"));
  } catch (error) {
    if (error instanceof GitHubVercelPreviewError) {
      throw error;
    }
    throw new GitHubVercelPreviewError("preview_url_invalid", "The resolved Preview URL must be a valid HTTPS URL.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    hostname === PRODUCTION_HOST ||
    !hostname.endsWith(".vercel.app") ||
    !hostname.startsWith(normalizedPrefix)
  ) {
    throw new GitHubVercelPreviewError(
      "preview_url_invalid",
      "The resolved target must be the credential-free HTTPS origin of the expected non-production Vercel deployment.",
    );
  }
  return url.origin + "/";
}

export function writeGitHubOutput(outputPath, key, value) {
  const normalizedPath = requireString(outputPath, "GITHUB_OUTPUT");
  const normalizedKey = requireString(key, "GitHub output key");
  const normalizedValue = requireString(value, `GitHub output ${normalizedKey}`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalizedKey) || /[\r\n]/u.test(normalizedValue)) {
    throw new GitHubVercelPreviewError("github_output_invalid", "GitHub output names and values must be single-line safe values.");
  }
  appendFileSync(normalizedPath, `${normalizedKey}=${normalizedValue}\n`, { encoding: "utf8" });
}

async function successfulPreviewCandidates({ repository, sha, token, expectedHostPrefix, fetchFn }) {
  const deploymentsUrl = new URL(`https://api.github.com/repos/${repository}/deployments`);
  deploymentsUrl.searchParams.set("sha", sha);
  deploymentsUrl.searchParams.set("per_page", "100");
  const deployments = await githubJson(fetchFn, deploymentsUrl, token);
  if (!Array.isArray(deployments)) {
    throw new GitHubVercelPreviewError("github_deployments_invalid", "GitHub returned an invalid deployments response.");
  }

  const candidates = [];
  for (const deployment of deployments) {
    const deploymentId = String(deployment?.id ?? "");
    if (
      String(deployment?.sha ?? "").toLowerCase() !== sha ||
      !/preview/iu.test(String(deployment?.environment ?? "")) ||
      !/^[1-9][0-9]*$/u.test(deploymentId)
    ) {
      continue;
    }
    const statusesUrl = new URL(`https://api.github.com/repos/${repository}/deployments/${deploymentId}/statuses`);
    statusesUrl.searchParams.set("per_page", "100");
    const statuses = await githubJson(fetchFn, statusesUrl, token);
    if (!Array.isArray(statuses)) {
      throw new GitHubVercelPreviewError("github_deployment_statuses_invalid", "GitHub returned an invalid deployment-status response.");
    }
    const latest = [...statuses].sort(compareDeploymentStatuses)[0];
    if (latest?.state !== "success" || !latest.environment_url) {
      continue;
    }
    let url;
    try {
      url = validateVercelPreviewOrigin(latest.environment_url, expectedHostPrefix);
    } catch (error) {
      if (error instanceof GitHubVercelPreviewError && error.code === "preview_url_invalid") {
        continue;
      }
      throw error;
    }
    candidates.push(Object.freeze({
      deploymentId,
      environment: String(deployment.environment),
      sha,
      url,
    }));
  }

  return [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()];
}

async function githubJson(fetchFn, url, token) {
  const response = await fetchFn(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });
  if (!response?.ok) {
    throw new GitHubVercelPreviewError(
      "github_api_failed",
      `GitHub deployment lookup failed with HTTP ${response?.status ?? "unknown"}.`,
    );
  }
  return response.json();
}

function compareDeploymentStatuses(left, right) {
  const leftTime = Date.parse(left?.created_at ?? "") || 0;
  const rightTime = Date.parse(right?.created_at ?? "") || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return Number(right?.id ?? 0) - Number(left?.id ?? 0);
}

function validateRepository(value) {
  const repository = requireString(value, "GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new GitHubVercelPreviewError("github_repository_invalid", "GITHUB_REPOSITORY must be an owner/name pair.");
  }
  return repository;
}

function validateCommitSha(value) {
  const sha = requireString(value, "RECLAIM_E2E_EXPECTED_COMMIT_SHA").toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new GitHubVercelPreviewError("preview_commit_invalid", "The expected PR-head commit must be a full Git SHA.");
  }
  return sha;
}

function validateHostPrefix(value) {
  const prefix = requireString(value, "RECLAIM_E2E_VERCEL_PROJECT_HOST_PREFIX").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(prefix)) {
    throw new GitHubVercelPreviewError("preview_host_prefix_invalid", "The Vercel project host prefix is invalid.");
  }
  return prefix;
}

function requireString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new GitHubVercelPreviewError(`${field.toLowerCase().replace(/[^a-z0-9]+/gu, "_")}_missing`, `${field} is required.`);
  }
  return normalized;
}

async function main(env = process.env) {
  const expectedHostPrefix = env.RECLAIM_E2E_VERCEL_PROJECT_HOST_PREFIX || DEFAULT_HOST_PREFIX;
  const result = await resolveGitHubVercelPreview({
    repository: env.GITHUB_REPOSITORY,
    sha: env.RECLAIM_E2E_EXPECTED_COMMIT_SHA,
    token: env.GITHUB_TOKEN,
    expectedHostPrefix,
    timeoutMs: Number(env.RECLAIM_E2E_PREVIEW_RESOLVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  });

  writeGitHubOutput(env.GITHUB_OUTPUT, "preview_url", result.url);
  writeGitHubOutput(env.GITHUB_OUTPUT, "deployment_id", result.deploymentId);
  console.log(JSON.stringify({
    deploymentId: result.deploymentId,
    previewHost: new URL(result.url).hostname,
    sha: result.sha,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof GitHubVercelPreviewError ? error.code : "preview_resolver_failed";
    console.error(`::error title=${code}::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
