import { blake2b } from "@noble/hashes/blake2b";

export const BATCH_TRANSCRIPT_V2_DOMAIN = "ROOT-OWNERSHIP-POK-BATCH-v2";
export const BATCH_TRANSCRIPT_V2_VK_HASH_BYTES = 32;
export const BATCH_TRANSCRIPT_V2_PROOF_BYTES = 336;
export const BATCH_TRANSCRIPT_V2_DIGEST_BYTES = 32;
export const BATCH_TRANSCRIPT_V2_MAX_SLOTS = 65_535;

const scalarFieldOrder = BigInt("52435875175126190479447740508185965837690552500527637822603658699938581184513");

const encoder = new TextEncoder();

export function buildBatchTranscriptV2(
  vkHash: Uint8Array,
  proofs: readonly Uint8Array[],
  publicInputDigests: readonly Uint8Array[],
): Uint8Array {
  if (vkHash.length !== BATCH_TRANSCRIPT_V2_VK_HASH_BYTES) {
    throw new Error(`verifier key hash is ${vkHash.length} bytes, want ${BATCH_TRANSCRIPT_V2_VK_HASH_BYTES}`);
  }
  if (proofs.length !== publicInputDigests.length) {
    throw new Error(`proof/digest list lengths differ: ${proofs.length} proofs, ${publicInputDigests.length} digests`);
  }
  if (proofs.length > BATCH_TRANSCRIPT_V2_MAX_SLOTS) {
    throw new Error(`batch has ${proofs.length} slots, maximum is ${BATCH_TRANSCRIPT_V2_MAX_SLOTS}`);
  }

  const domain = encoder.encode(BATCH_TRANSCRIPT_V2_DOMAIN);
  const out = new Uint8Array(
    domain.length +
      vkHash.length +
      2 +
      proofs.length * (BATCH_TRANSCRIPT_V2_PROOF_BYTES + BATCH_TRANSCRIPT_V2_DIGEST_BYTES),
  );
  let offset = 0;
  out.set(domain, offset);
  offset += domain.length;
  out.set(vkHash, offset);
  offset += vkHash.length;
  out[offset++] = proofs.length >>> 8;
  out[offset++] = proofs.length & 0xff;
  proofs.forEach((proof, index) => {
    const digest = publicInputDigests[index];
    if (proof.length !== BATCH_TRANSCRIPT_V2_PROOF_BYTES) {
      throw new Error(`proof ${index} is ${proof.length} bytes, want ${BATCH_TRANSCRIPT_V2_PROOF_BYTES}`);
    }
    if (digest.length !== BATCH_TRANSCRIPT_V2_DIGEST_BYTES) {
      throw new Error(
        `public input digest ${index} is ${digest.length} bytes, want ${BATCH_TRANSCRIPT_V2_DIGEST_BYTES}`,
      );
    }
    out.set(proof, offset);
    offset += proof.length;
    out.set(digest, offset);
    offset += digest.length;
  });
  return out;
}

export function batchTranscriptChallengeV2(transcript: Uint8Array): bigint {
  return hashToNonzeroScalar(transcript);
}

export function batchTranscriptMergeChallengeV2(transcript: Uint8Array): bigint {
  const suffixSeparated = new Uint8Array(transcript.length + 1);
  suffixSeparated.set(transcript);
  suffixSeparated[transcript.length] = 0x01;
  return hashToNonzeroScalar(suffixSeparated);
}

export function decodeHexBytes(input: string, field: string): Uint8Array {
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  if (!/^[0-9a-f]*$/iu.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`${field} must be even-length hexadecimal`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function encodeHexBytes(input: Uint8Array): string {
  return Array.from(input, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeBlake2b256(input: string, field: string): Uint8Array {
  const raw = input.startsWith("blake2b256:") ? input.slice("blake2b256:".length) : input;
  return decodeHexBytes(raw, field);
}

function hashToNonzeroScalar(input: Uint8Array): bigint {
  const digest = blake2b(input, { dkLen: 32 });
  let value = 0n;
  for (const byte of digest) {
    value = (value << 8n) | BigInt(byte);
  }
  return (value % (scalarFieldOrder - 1n)) + 1n;
}
