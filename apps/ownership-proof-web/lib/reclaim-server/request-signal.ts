import { AsyncLocalStorage } from "node:async_hooks";

type FetchScope = { signals: AsyncLocalStorage<AbortSignal>; fetch: typeof fetch };
const server = globalThis as typeof globalThis & { __proofApiFetchScope?: FetchScope };

// Lucid's Blockfrost/Koios adapters call global fetch and don't accept a signal
// for most operations. Decorate fetch once, preserving Next's fetch properties;
// outside an admitted API request it behaves exactly as before.
export function withRequestSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const scope = server.__proofApiFetchScope ?? {
    signals: new AsyncLocalStorage<AbortSignal>(),
    fetch: globalThis.fetch,
  };
  if (!server.__proofApiFetchScope || scope.fetch !== globalThis.fetch) {
    const original = globalThis.fetch;
    const scopedFetch: typeof fetch = (input, init) => {
      const current = scope.signals.getStore();
      if (!current) return original(input, init);
      current.throwIfAborted();
      const supplied = init?.signal ?? (input instanceof Request ? input.signal : null);
      const combined = supplied && supplied !== current ? AbortSignal.any([current, supplied]) : current;
      return original(input, { ...init, signal: combined });
    };
    globalThis.fetch = Object.assign(scopedFetch, original);
    scope.fetch = globalThis.fetch;
    server.__proofApiFetchScope = scope;
  }
  return scope.signals.run(signal, work);
}
