// Served as trusted application code with a network-denying Worker CSP. Keep
// this function self-contained: nested workers execute its serialized source.
export function installProverBroker(config) {
  const nativeFetch = self.fetch.bind(self);
  const nativeImport = self.importScripts.bind(self);
  const NativeWorker = self.Worker;
  const resolve = (url) => new URL(String(url), `${config.runtimeBase}/`).href;
  self.importScripts = (...urls) => {
    const verified = urls.map((url) => {
      const mapped = config.assets[resolve(url)];
      if (mapped) return mapped;
      if (Object.values(config.assets).includes(url)) return url;
      throw new Error("Unverified executable import rejected.");
    });
    nativeImport(...verified);
  };
  self.fetch = (input, init = {}) => {
    const url = resolve(typeof input === "object" && !(input instanceof URL) ? input.url : input);
    // Go authenticates the same worker URL that it uses to launch MSM workers.
    const executable = url === config.nestedWorker ? url.split("?")[0] : url;
    if (config.assets[executable]) return nativeFetch(config.assets[executable], { signal: init.signal });
    return new Promise((resolveResponse, reject) => {
      const { port1, port2 } = new MessageChannel();
      let controller;
      let responseStarted = false;
      const close = () => {
        init.signal?.removeEventListener("abort", abort);
        port1.close();
      };
      const abort = () => {
        port1.postMessage({ cancel: true });
        const error = new DOMException("Asset read cancelled.", "AbortError");
        if (responseStarted) controller?.error(error);
        else reject(error);
        close();
      };
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener("abort", abort, { once: true });
      port1.onmessage = ({ data }) => {
        if (data.error) {
          const error = new Error("Public proving asset read failed.");
          if (responseStarted) controller?.error(error);
          else reject(error);
          close();
        } else if (data.status) {
          responseStarted = true;
          const body = new ReadableStream({
            start(value) {
              controller = value;
            },
            pull() {
              port1.postMessage({ pull: true });
            },
            cancel() {
              port1.postMessage({ cancel: true });
              close();
            },
          });
          resolveResponse(new Response(body, { status: data.status, headers: data.headers }));
        } else if (data.done) {
          controller.close();
          close();
        } else {
          controller.enqueue(data.chunk);
        }
      };
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      self.postMessage(
        {
          type: "asset-fetch",
          url,
          method: init.method ?? (input instanceof Request ? input.method : "GET"),
          headers: [...headers],
          hasBody: init.body != null || (input instanceof Request && input.body != null),
        },
        [port2],
      );
    });
  };
  self.Worker = class extends NativeWorker {
    constructor(url) {
      if (resolve(url) !== config.nestedWorker) throw new Error("Unverified nested worker rejected.");
      const source = `(${installProverBroker.toString()})(${JSON.stringify(config)}); importScripts(${JSON.stringify(config.nestedWorker.split("?")[0])});`;
      const blob = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      super(blob);
      URL.revokeObjectURL(blob);
      this.addEventListener("message", (event) => {
        if (event.data?.type !== "asset-fetch") return;
        event.stopImmediatePropagation();
        self.postMessage(event.data, [event.ports[0]]);
      });
    }
  };
}

export const PROVER_BOOTSTRAP_CSP =
  "default-src 'none'; script-src blob: 'wasm-unsafe-eval'; connect-src blob:; worker-src blob:";

export function proverBootstrapSource() {
  return `const installProverBroker = ${installProverBroker.toString()};
let initialized = false;
self.addEventListener('message', ({data}) => {
  if (data.type !== 'bootstrap') return;
  try {
    if (initialized) throw new Error('Prover already initialized.');
    initialized = true;
    installProverBroker(data.config);
    importScripts(data.config.outerWorker);
    self.postMessage({id: data.id, type: 'bootstrapped'});
  } catch (_) {
    self.postMessage({id: data.id, type: 'error', message: 'Verified prover initialization failed.'});
  }
});`;
}
