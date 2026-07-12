import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// A failed rerun must not leave a prior accepted case artifact in place. The
// summary/telemetry sidecars record the new failure, while the proof result is
// absent until every in-memory qualification gate has passed.
export async function invalidateCaseOutput(file) {
  await fs.rm(file, { force: true });
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
