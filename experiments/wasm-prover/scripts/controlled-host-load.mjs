#!/usr/bin/env node

import os from "node:os";
import process from "node:process";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (!isMainThread) {
  let value = 1;
  for (;;) {
    for (let index = 0; index < 5_000_000; index += 1) {
      value = (value * 1664525 + 1013904223) >>> 0;
    }
    parentPort.postMessage(value);
  }
}

const requested = Number(process.argv[2] || 2);
if (!Number.isSafeInteger(requested) || requested < 1 || requested >= os.cpus().length) {
  throw new Error("load worker count must be positive and leave at least one host CPU free");
}
const workers = Array.from(
  { length: requested },
  () => new Worker(new URL(import.meta.url)),
);
const stop = async () => {
  await Promise.all(workers.map((worker) => worker.terminate()));
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(JSON.stringify({ ready: true, workers: requested }));
