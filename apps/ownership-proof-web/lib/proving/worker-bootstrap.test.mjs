// @vitest-environment node
import { createContext, runInContext } from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { installProverBroker, proverBootstrapSource } from "./worker-bootstrap.mjs";

function broker() {
  const runtimeBase = "https://app.test/runtime";
  const nestedWorker = `${runtimeBase}/msm-worker.js?gogc=50&gomemlimit=512MiB`;
  const nativeFetch = vi.fn(async () => new Response("verified fixture"));
  const imports = vi.fn();
  const context = createContext({
    URL,
    Request,
    Response,
    Headers,
    Blob,
    MessageChannel,
    DOMException,
    ReadableStream,
    self: {
      fetch: nativeFetch,
      importScripts: imports,
      Worker: class {},
      addEventListener: vi.fn(),
      postMessage: vi.fn((_message, [port]) => {
        port.postMessage({ error: true });
        port.close();
      }),
    },
    config: {
      runtimeBase,
      nestedWorker,
      outerWorker: `${runtimeBase}/prover-worker.js`,
      assets: { [`${runtimeBase}/msm-worker.js`]: "blob:verified-worker" },
    },
  });
  runInContext(`(${installProverBroker.toString()})(config)`, context);
  return { context, nativeFetch, nestedWorker, runtimeBase };
}

describe("authenticated worker broker", () => {
  it("authenticates the tuned URL used by Go preflight through the verified Blob", async () => {
    const { context, nativeFetch, nestedWorker, runtimeBase } = broker();
    await context.self.fetch(`${runtimeBase}/msm-worker.js`);
    expect(await (await context.self.fetch(nestedWorker)).text()).toBe("verified fixture");
    expect(nativeFetch.mock.calls.map(([url]) => url)).toEqual(["blob:verified-worker", "blob:verified-worker"]);
  });

  it("rejects unknown URL variants without importing or fetching them directly", async () => {
    const { context, nativeFetch, runtimeBase } = broker();
    await expect(context.self.fetch(`${runtimeBase}/msm-worker.js?untrusted=1`)).rejects.toThrow(
      "Public proving asset read failed",
    );
    expect(() => context.self.importScripts(`${runtimeBase}/msm-worker.js?untrusted=1`)).toThrow(
      "Unverified executable import rejected",
    );
    expect(() => new context.self.Worker(`${runtimeBase}/msm-worker.js?untrusted=1`)).toThrow(
      "Unverified nested worker rejected",
    );
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("emits a self-contained launcher", () => {
    const { context } = broker();
    expect(() => runInContext(proverBootstrapSource(), context)).not.toThrow();
  });
});
