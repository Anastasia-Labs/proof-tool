import { readFileSync } from "node:fs";
import path from "node:path";
import { blake2b } from "@noble/hashes/blake2b";
import { describe, expect, it } from "vitest";
import {
  BATCH_TRANSCRIPT_V2_DOMAIN,
  batchTranscriptChallengeV2,
  batchTranscriptMergeChallengeV2,
  buildBatchTranscriptV2,
  decodeHexBytes,
  encodeHexBytes,
} from "./batch-transcript";

type GoldenCase = {
  name: string;
  vk_file: string;
  proof_source: { file: string; rows?: number[]; repeat?: number };
  public_input_digests: string[];
  vk_hash: string;
  transcript_blake2b256: string;
  r: string;
  s: string;
};

type GoldenVectors = { domain: string; cases: GoldenCase[] };

const fixtureDir = path.resolve(process.cwd(), "../../contracts/ownership-verifier/testdata");
const vectors = JSON.parse(
  readFileSync(path.join(fixtureDir, "zk-02-batch-transcript-v2.json"), "utf8"),
) as GoldenVectors;

describe("statement-bound batch transcript v2", () => {
  it("uses the source-backed golden vectors in the browser-side implementation", () => {
    expect(vectors.domain).toBe(BATCH_TRANSCRIPT_V2_DOMAIN);
    for (const vector of vectors.cases) {
      const vk = readFixtureHex(vector.vk_file);
      const proofs = readProofs(vector.proof_source);
      const digests = vector.public_input_digests.map((digest) => decodeHexBytes(digest, "digest"));
      const vkHash = blake2b(vk, { dkLen: 32 });
      expect(encodeHexBytes(vkHash), vector.name).toBe(vector.vk_hash);
      const transcript = buildBatchTranscriptV2(vkHash, proofs, digests);
      expect(encodeHexBytes(blake2b(transcript, { dkLen: 32 })), vector.name).toBe(vector.transcript_blake2b256);
      expect(batchTranscriptChallengeV2(transcript).toString(), vector.name).toBe(vector.r);
      expect(batchTranscriptMergeChallengeV2(transcript).toString(), vector.name).toBe(vector.s);
    }
  });

  it("changes the challenge when a statement-bound component changes", () => {
    const vector = vectors.cases.find((item) => item.name === "all-distinct-two");
    if (!vector) throw new Error("all-distinct vector missing");
    const vk = readFixtureHex(vector.vk_file);
    const vkHash = blake2b(vk, { dkLen: 32 });
    const proofs = readProofs(vector.proof_source);
    const digests = vector.public_input_digests.map((digest) => decodeHexBytes(digest, "digest"));
    const baseline = batchTranscriptChallengeV2(buildBatchTranscriptV2(vkHash, proofs, digests));

    const changedVKHash = new Uint8Array(vkHash);
    changedVKHash[0] ^= 1;
    expect(batchTranscriptChallengeV2(buildBatchTranscriptV2(changedVKHash, proofs, digests))).not.toBe(baseline);

    const changedProofs = proofs.map((proof) => new Uint8Array(proof));
    changedProofs[0][0] ^= 1;
    expect(batchTranscriptChallengeV2(buildBatchTranscriptV2(vkHash, changedProofs, digests))).not.toBe(baseline);

    const changedDigests = digests.map((digest) => new Uint8Array(digest));
    changedDigests[0][0] ^= 1;
    expect(batchTranscriptChallengeV2(buildBatchTranscriptV2(vkHash, proofs, changedDigests))).not.toBe(baseline);

    expect(batchTranscriptChallengeV2(buildBatchTranscriptV2(vkHash, [proofs[0]], [digests[0]]))).not.toBe(baseline);
    expect(
      batchTranscriptChallengeV2(
        buildBatchTranscriptV2(vkHash, [proofs[1], proofs[0]], [digests[1], digests[0]]),
      ).toString(),
    ).not.toBe(baseline.toString());
    expect(
      batchTranscriptChallengeV2(buildBatchTranscriptV2(vkHash, proofs, [digests[1], digests[0]])).toString(),
    ).not.toBe(baseline.toString());
    expect(
      batchTranscriptChallengeV2(buildBatchTranscriptV2(vkHash, [proofs[1], proofs[0]], digests)).toString(),
    ).not.toBe(baseline.toString());
  });

  it("rejects malformed parallel lists before framing", () => {
    const vkHash = new Uint8Array(32);
    const proof = new Uint8Array(336);
    const digest = new Uint8Array(32);
    expect(() => buildBatchTranscriptV2(vkHash, [proof], [])).toThrow(/lengths differ/);
    expect(() => buildBatchTranscriptV2(vkHash, [proof.slice(1)], [digest])).toThrow(/proof 0/);
    expect(() => buildBatchTranscriptV2(vkHash, [proof], [digest.slice(1)])).toThrow(/digest 0/);
    expect(() => buildBatchTranscriptV2(vkHash.slice(1), [proof], [digest])).toThrow(/key hash/);
    expect(() => buildBatchTranscriptV2(new Uint8Array(33), [proof], [digest])).toThrow(/key hash/);
  });

  it("frames a zero-slot transcript without treating it as a reclaim claim", () => {
    const vkHash = new Uint8Array(32);
    for (let index = 0; index < vkHash.length; index += 1) vkHash[index] = index;
    const transcript = buildBatchTranscriptV2(vkHash, [], []);
    const domain = new TextEncoder().encode(BATCH_TRANSCRIPT_V2_DOMAIN);
    const expected = new Uint8Array(domain.length + vkHash.length + 2);
    expected.set(domain, 0);
    expected.set(vkHash, domain.length);
    expect(transcript).toEqual(expected);
  });
});

function readFixtureHex(name: string): Uint8Array {
  return decodeHexBytes(readFileSync(path.join(fixtureDir, name), "utf8").replace(/\s+/gu, ""), name);
}

function readProofs(source: GoldenCase["proof_source"]): Uint8Array[] {
  const raw = readFileSync(path.join(fixtureDir, source.file), "utf8");
  if (source.rows) {
    const fields = raw.trim().split(/\s+/u);
    return source.rows.map((row) => decodeHexBytes(fields[row * 3 + 2], `${source.file} row ${row}`));
  }
  const proof = decodeHexBytes(raw.replace(/\s+/gu, ""), source.file);
  return Array.from({ length: source.repeat ?? 1 }, () => new Uint8Array(proof));
}
