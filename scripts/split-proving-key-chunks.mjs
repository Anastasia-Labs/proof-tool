#!/usr/bin/env node
// Slice ownership.pk into the part files named by an existing signed chunk
// manifest. Does not rewrite or re-sign the manifest.
import { createHash } from "node:crypto";
import { open, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const PART_PATH = /^ownership\.pk\.part(\d{4})$/u;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--pk") options.pk = value;
    else if (flag === "--chunk-manifest") options.chunkManifest = value;
    else if (flag === "--out-dir") options.outDir = value;
    else {
      fail(`unknown argument: ${flag}`);
      return null;
    }
    if (!value || value.startsWith("--")) {
      fail(`${flag} requires a value`);
      return null;
    }
    index += 1;
  }
  if (!options.pk || !options.chunkManifest || !options.outDir) {
    fail("usage: split-proving-key-chunks.mjs --pk <ownership.pk> --chunk-manifest <chunk-manifest.json> --out-dir <dir>");
    return null;
  }
  return options;
}

function sha256Field(value) {
  const match = /^sha256:([0-9a-f]{64})$/iu.exec(value ?? "");
  return match ? match[1].toLowerCase() : null;
}

function validateChunks(chunks, chunkSize, provingKeySize) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("proving_key.chunk_size must be a positive integer");
  }
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("proving_key.chunks is empty");
  }
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const size = chunk?.size;
    const last = index === chunks.length - 1;
    const pathMatch = PART_PATH.exec(chunk?.path ?? "");
    if (
      chunk?.index !== index ||
      chunk?.offset !== offset ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > chunkSize ||
      (!last && size !== chunkSize) ||
      !pathMatch ||
      Number(pathMatch[1]) !== index ||
      !sha256Field(chunk?.sha256)
    ) {
      throw new Error(`chunk ${index} is not a canonical ownership.pk.part pin`);
    }
    offset += size;
  }
  if (offset !== provingKeySize) {
    throw new Error(`chunk sizes sum to ${offset}, proving key size is ${provingKeySize}`);
  }
}

async function readExact(handle, size, offset) {
  const bytes = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const { bytesRead } = await handle.read(bytes, got, size - got, offset + got);
    if (bytesRead === 0) {
      throw new Error(`proving key ended at byte ${offset + got}, need ${offset + size}`);
    }
    got += bytesRead;
  }
  return bytes;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const manifest = JSON.parse(await readFile(options.chunkManifest, "utf8"));
  const provingKeySize = manifest?.coherence?.proving_key_size;
  const chunkSize = manifest?.proving_key?.chunk_size;
  const chunks = manifest?.proving_key?.chunks;
  if (!Number.isSafeInteger(provingKeySize) || provingKeySize <= 0) {
    throw new Error("coherence.proving_key_size must be a positive integer");
  }
  validateChunks(chunks, chunkSize, provingKeySize);

  const pkStat = await stat(options.pk);
  if (pkStat.size !== provingKeySize) {
    throw new Error(`proving key is ${pkStat.size} bytes, manifest size is ${provingKeySize}`);
  }

  await mkdir(options.outDir, { recursive: true });
  const handle = await open(options.pk, "r");
  try {
    for (const chunk of chunks) {
      const dest = path.join(options.outDir, chunk.path);
      try {
        await stat(dest);
        throw new Error(`${dest} already exists`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const bytes = await readExact(handle, chunk.size, chunk.offset);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const expected = sha256Field(chunk.sha256);
      if (digest !== expected) {
        throw new Error(`${chunk.path} sha256 mismatch: got ${digest}, want ${expected}`);
      }
      await writeFile(dest, bytes, { mode: 0o600, flag: "wx" });
      console.log(`${chunk.path} ${chunk.size} ${digest}`);
    }
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
