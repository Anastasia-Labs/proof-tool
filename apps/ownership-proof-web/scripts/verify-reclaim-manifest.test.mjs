import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const verifierPath = path.join(__dirname, "verify-reclaim-manifest.mjs");
const publicManifestPath = path.join(
  repoRoot,
  "apps",
  "ownership-proof-web",
  "public",
  "proof-assets",
  "reclaim-deployment.json",
);
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("verify-reclaim-manifest V2 coherence", () => {
  it("accepts matched statement-bound V2 metadata", async () => {
    const manifest = publicManifest();
    manifest.reclaim_global.proof_slot_encoding =
      "full-proof-plus-public-input-digest-v2";
    manifest.reclaim_global.batch_transcript_vk_hash =
      manifest.proof.cardano_vk_blake2b256;

    const { stdout } = await verify(manifest);
    const result = JSON.parse(stdout);
    expect(result.proof_slot_encoding).toBe(
      "full-proof-plus-public-input-digest-v2",
    );
  });

  it("rejects a mismatched V2 transcript verifier-key hash", async () => {
    const manifest = publicManifest();
    manifest.reclaim_global.proof_slot_encoding =
      "full-proof-plus-public-input-digest-v2";
    manifest.reclaim_global.batch_transcript_vk_hash =
      "blake2b256:" + "00".repeat(32);

    await expect(verify(manifest)).rejects.toMatchObject({
      stderr: expect.stringContaining("reclaim_global.batch_transcript_vk_hash"),
    });
  });
});

function publicManifest() {
  return JSON.parse(readFileSync(publicManifestPath, "utf8"));
}

async function verify(manifest) {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-v2-manifest-"));
  tempDirs.push(dir);
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  return execFileAsync(process.execPath, [verifierPath, manifestPath], {
    cwd: repoRoot,
  });
}
