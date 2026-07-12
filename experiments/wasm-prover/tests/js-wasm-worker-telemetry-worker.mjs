import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

const { wasm, wasmExec, workerID, points, scalars, pointSize, scalarSize } = workerData;

async function loadKernel() {
  vm.runInThisContext(readFileSync(wasmExec, 'utf8'));
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiate(readFileSync(wasm), go.importObject);
  go.run(instance);
  while (!globalThis.__msmengineReady) await new Promise((resolve) => setTimeout(resolve, 0));
}

try {
  await loadKernel();
  parentPort.on('message', ({ id, lo, hi }) => {
    try {
      const pointView = new Uint8Array(points, lo * pointSize, (hi - lo) * pointSize);
      const scalarView = new Uint8Array(scalars, lo * scalarSize, (hi - lo) * scalarSize);
      const result = globalThis.__msmengineShardG1Timed(
        new Uint8Array(pointView),
        new Uint8Array(scalarView),
        true,
      );
      const partial = result.partial;
      const timings = {
        ...(result.timings || {}),
        ...globalThis.__msmengineWorkerMemStats(),
      };
      parentPort.postMessage({ id, worker_id: workerID, partial, timings }, [partial.buffer]);
    } catch (error) {
      parentPort.postMessage({ id, error: String(error?.message || error) });
    }
  });
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'init-error', error: String(error?.message || error) });
}
