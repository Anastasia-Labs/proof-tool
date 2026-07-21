import { spawn as defaultSpawn } from "node:child_process";
import { setTimeout as defaultSleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_URL_ENV = "RECLAIM_E2E_APP_URL";
export const APP_PORT_ENV = "RECLAIM_E2E_APP_PORT";
export const DEFAULT_APP_HOST = "127.0.0.1";
export const DEFAULT_APP_PORT = 3917;

const DEFAULT_READY_PATH = "/reclaim-api/deployment";
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_READY_INTERVAL_MS = 500;
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export class PreprodAppServerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodAppServerError";
    this.code = code;
  }
}

export async function preparePreprodAppTarget(options = {}) {
  const env = options.env ?? process.env;
  const configuredUrl = env[APP_URL_ENV]?.trim();
  if (configuredUrl) {
    return externalAppTarget(configuredUrl);
  }
  return startPreprodAppServer(options);
}

export async function startPreprodAppServer(options = {}) {
  const env = options.env ?? process.env;
  if ((env.NODE_ENV ?? "").trim() === "production") {
    throw new PreprodAppServerError(
      "production_node_env",
      "The preprod E2E app server must not start with NODE_ENV=production.",
    );
  }

  const host = options.host ?? DEFAULT_APP_HOST;
  const port = parsePort(options.port ?? env[APP_PORT_ENV] ?? DEFAULT_APP_PORT);
  const baseUrl = `http://${host}:${port}`;
  const appDir = options.appDir ?? APP_DIR;
  const command = options.command ?? "pnpm";
  const args = options.args ?? ["dev", "--hostname", host, "--port", String(port)];
  const spawn = options.spawn ?? defaultSpawn;
  const child = spawn(command, args, {
    cwd: appDir,
    env: {
      ...process.env,
      ...env,
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  const capture = (chunk) => {
    const text = String(chunk ?? "");
    if (!text) {
      return;
    }
    logs.push(...text.split(/\r?\n/u).filter(Boolean).map(redactLogLine));
    while (logs.length > 80) {
      logs.shift();
    }
  };
  child.stdout?.on?.("data", capture);
  child.stderr?.on?.("data", capture);

  try {
    await waitForAppReady(baseUrl, {
      fetch: options.fetch,
      sleep: options.sleep,
      readyPath: options.readyPath,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
    });
  } catch (error) {
    await stopChildProcess(child);
    throw new PreprodAppServerError(
      error?.code ?? "app_server_not_ready",
      `${error?.message ?? "Next app server did not become ready."}${logs.length ? ` Last logs: ${logs.slice(-5).join(" | ")}` : ""}`,
    );
  }

  return {
    baseUrl,
    external: false,
    command,
    args,
    appDir,
    logs,
    async stop() {
      await stopChildProcess(child);
    },
  };
}

export async function waitForAppReady(baseUrl, options = {}) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new PreprodAppServerError("fetch_unavailable", "fetch is required to wait for the preprod app server.");
  }
  const readyPath = options.readyPath ?? DEFAULT_READY_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const response = await fetchFn(new URL(readyPath, baseUrl));
      if (response && response.status >= 200 && response.status < 500) {
        return;
      }
      lastError = new Error(`ready endpoint returned HTTP ${response?.status ?? "unknown"}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new PreprodAppServerError(
    "app_server_ready_timeout",
    `Next app server did not become ready at ${baseUrl}${readyPath}: ${lastError?.message ?? "timeout"}`,
  );
}

function externalAppTarget(configuredUrl) {
  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new PreprodAppServerError("app_url_invalid", `${APP_URL_ENV} must be an absolute http(s) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PreprodAppServerError("app_url_invalid", `${APP_URL_ENV} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new PreprodAppServerError("app_url_contains_credentials", `${APP_URL_ENV} must not include credentials.`);
  }
  url.hash = "";
  return {
    baseUrl: url.toString().replace(/\/$/u, ""),
    external: true,
    command: null,
    args: [],
    appDir: null,
    logs: [],
    async stop() {},
  };
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new PreprodAppServerError("app_port_invalid", `${APP_PORT_ENV} must be a TCP port between 1 and 65535.`);
  }
  return port;
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once?.("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill?.("SIGTERM");
  });
}

function redactLogLine(line) {
  return String(line).replace(
    /\b([A-Z0-9_]*(?:MNEMONIC|SEED|PHRASE|XPRV|PRIVATE|SECRET|TOKEN|WITNESS|PROOF|CBOR|PASSWORD)[A-Z0-9_]*)=\S+/giu,
    "$1=[redacted]",
  );
}
