import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  APP_URL_ENV,
  DEFAULT_APP_PORT,
  preparePreprodAppTarget,
  startPreprodAppServer,
  waitForAppReady,
} from "./app-server.mjs";

describe("preprod app server helper", () => {
  it("uses an explicit app URL without spawning Next", async () => {
    const target = await preparePreprodAppTarget({
      env: {
        [APP_URL_ENV]: "https://preprod.example.test/",
      },
      spawn() {
        throw new Error("must not spawn when app URL is configured");
      },
    });

    expect(target).toMatchObject({
      baseUrl: "https://preprod.example.test",
      external: true,
      command: null,
      args: [],
    });
    await expect(target.stop()).resolves.toBeUndefined();
  });

  it("rejects app URLs that embed credentials", async () => {
    await expect(
      preparePreprodAppTarget({
        env: {
          [APP_URL_ENV]: "https://user:pass@preprod.example.test",
        },
      }),
    ).rejects.toMatchObject({
      code: "app_url_contains_credentials",
    });
  });

  it("starts Next locally and waits for the deployment endpoint", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const fetch = vi.fn().mockRejectedValueOnce(new Error("not listening yet")).mockResolvedValueOnce({ status: 200 });
    const target = await startPreprodAppServer({
      env: {},
      spawn,
      fetch,
      sleep: async () => undefined,
    });

    expect(target.baseUrl).toBe(`http://127.0.0.1:${DEFAULT_APP_PORT}`);
    expect(target.external).toBe(false);
    expect(spawn).toHaveBeenCalledWith(
      "pnpm",
      ["dev", "--hostname", "127.0.0.1", "--port", String(DEFAULT_APP_PORT)],
      expect.objectContaining({
        cwd: expect.stringContaining("apps/ownership-proof-web"),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(String(fetch.mock.calls.at(-1)[0])).toBe(`http://127.0.0.1:${DEFAULT_APP_PORT}/reclaim-api/deployment`);

    await target.stop();
    expect(child.killed).toBe(true);
  });

  it("kills the child and redacts captured logs when readiness times out", async () => {
    const child = fakeChild();
    const promise = startPreprodAppServer({
      env: {},
      spawn: () => child,
      fetch: async () => ({ status: 503 }),
      sleep: async () => undefined,
      timeoutMs: 0,
    });
    child.stderr.emit("data", "RECLAIM_REVIEW_TOKEN_SECRET=abc123\nready soon");

    await expect(promise).rejects.toMatchObject({
      code: "app_server_ready_timeout",
    });
    await expect(promise).rejects.not.toThrow("abc123");
    await expect(promise).rejects.toThrow("RECLAIM_REVIEW_TOKEN_SECRET=[redacted]");
    expect(child.killed).toBe(true);
  });

  it("refuses to start under NODE_ENV=production", async () => {
    await expect(
      startPreprodAppServer({
        env: {
          NODE_ENV: "production",
        },
        spawn() {
          throw new Error("must not spawn in production mode");
        },
      }),
    ).rejects.toMatchObject({
      code: "production_node_env",
    });
  });

  it("treats 4xx deployment responses as app-ready fail-closed responses", async () => {
    await expect(
      waitForAppReady("http://127.0.0.1:3000", {
        fetch: async () => ({ status: 503 }),
        sleep: async () => undefined,
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({
      code: "app_server_ready_timeout",
    });

    await expect(
      waitForAppReady("http://127.0.0.1:3000", {
        fetch: async () => ({ status: 404 }),
        sleep: async () => undefined,
        timeoutMs: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
    return true;
  };
  return child;
}
