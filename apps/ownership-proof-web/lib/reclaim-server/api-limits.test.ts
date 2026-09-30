// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

async function limits() {
  vi.resetModules();
  return import("./api-limits");
}

describe("API admission", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("rejects declared and streamed oversized bodies before handling them", async () => {
    const { withApiLimits } = await limits();
    const handler = vi.fn(async () => new Response());
    const route = withApiLimits(handler);
    const declared = new NextRequest("http://localhost/claim-api/build", {
      method: "POST",
      headers: { "Content-Length": "524289" },
      body: "{}",
    });
    expect((await route(declared)).status).toBe(413);
    const streamed = new NextRequest("http://localhost/claim-api/build", { method: "POST", body: " ".repeat(524289) });
    expect((await route(streamed)).status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("admits a valid body after a malformed one and releases failed handlers", async () => {
    const { withApiLimits, readApiJson } = await limits();
    const handler = vi.fn(async (request: NextRequest) => {
      const body = await readApiJson(request);
      return Response.json(body);
    });
    const route = withApiLimits(handler, { build: true });
    expect((await route(new NextRequest("http://localhost/api", { method: "POST", body: "{" }))).status).toBe(400);
    expect(
      await (await route(new NextRequest("http://localhost/api", { method: "POST", body: '{"valid":true}' }))).json(),
    ).toEqual({ valid: true });
    expect(handler).toHaveBeenCalledTimes(1);
    const failing = withApiLimits(
      async () => {
        throw new Error("offline");
      },
      { build: true },
    );
    await expect(failing(new NextRequest("http://localhost/api"))).rejects.toThrow("offline");
    expect((await route(new NextRequest("http://localhost/api", { method: "POST", body: "{}" }))).status).toBe(200);
  });

  it("bounds concurrent builds and applies rate admission before work", async () => {
    const { withApiLimits } = await limits();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn(async () => {
      await blocked;
      return new Response();
    });
    const route = withApiLimits(handler, { build: true });
    const first = route(new NextRequest("http://localhost/api"));
    const rejected = await route(new NextRequest("http://localhost/api"));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("5");
    expect(handler).toHaveBeenCalledTimes(1);
    finish();
    await first;
    const fast = vi.fn(async () => new Response());
    const limited = withApiLimits(fast, { build: true });
    for (let i = 0; i < 11; i += 1) expect((await limited(new NextRequest("http://localhost/api"))).status).toBe(200);
    expect((await limited(new NextRequest("http://localhost/api"))).status).toBe(429);
    expect(fast).toHaveBeenCalledTimes(11);
  });

  it.each(["timeout", "disconnect"])("aborts upstream work and releases the build slot on %s", async (reason) => {
    vi.useFakeTimers();
    const { withApiLimits } = await limits();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            upstreamSignal = init.signal ?? undefined;
            upstreamSignal?.addEventListener("abort", () => reject(upstreamSignal?.reason), { once: true });
            started();
          }),
      ),
    );
    const route = withApiLimits(async () => fetch("https://provider.test/utxos"), { build: true });
    const client = new AbortController();
    const response = route(new NextRequest("http://localhost/api", { signal: client.signal }));
    await ready;
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(120_000);
    else client.abort();
    expect((await response).status).toBe(408);
    expect(upstreamSignal?.aborted).toBe(true);
    const next = withApiLimits(async () => new Response(), { build: true });
    expect((await next(new NextRequest("http://localhost/api"))).status).toBe(200);
  });

  it("keeps concurrent request signals separate and leaves unrelated fetches alone", async () => {
    const { withApiLimits } = await limits();
    const seen: Array<AbortSignal | undefined> = [];
    const underlying = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      return new Response();
    });
    vi.stubGlobal("fetch", underlying);
    const route = withApiLimits(async () => fetch("https://provider.test/utxos"));
    await Promise.all([route(new NextRequest("http://localhost/a")), route(new NextRequest("http://localhost/b"))]);
    await fetch("https://unrelated.test");
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBeInstanceOf(AbortSignal);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[2]).toBeUndefined();
  });
});
