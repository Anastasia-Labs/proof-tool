import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// A failed rerun must not leave a prior accepted case artifact in place. The
// summary/telemetry sidecars record the new failure, while the proof result is
// absent until every in-memory qualification gate has passed.
export async function invalidateCaseOutput(file) {
  await fs.rm(file, { force: true });
}

const forbiddenOutputKeys = new Set([
  "credential_path",
  "master_xprv_hex",
  "mnemonic",
  "phrase",
  "proof_request",
  "scalars",
  "seed_phrase",
  "xprv",
]);

// Benchmark outputs may contain the public proof artifact and public inputs,
// but never the local proving request or any secret carried by it. Keep this
// gate immediately before the atomic write so future result-shape changes fail
// closed instead of silently extending the diagnostic surface.
export function assertRedactedBenchmarkOutput(value, privateInputs) {
  const secretStrings = [
    privateInputs?.master_xprv_hex,
    privateInputs?.seed_phrase,
    privateInputs?.mnemonic,
    privateInputs?.phrase,
  ].filter((secret) => typeof secret === "string" && secret.length > 0);

  const visit = (current) => {
    if (typeof current === "string") {
      if (secretStrings.some((secret) => current.includes(secret))) {
        throw new Error("benchmark output contains a private input value");
      }
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      if (forbiddenOutputKeys.has(key.toLowerCase())) {
        throw new Error(`benchmark output contains forbidden field ${key}`);
      }
      visit(item);
    }
  };

  visit(value);
}

// Publish within the destination directory so rename is atomic on the same
// filesystem. The temporary artifact is never a valid case output and is
// removed on either success or failure.
export async function writeCaseOutputAtomic(file, value) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
