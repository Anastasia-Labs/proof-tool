// Immutable pre-W7 capability fixture. It models the signed worker protocol
// before the optW7 acknowledgement existed, so the main runtime must reject
// it when W7 is requested. Keep this independent from public runtime assets:
// those assets legitimately advance with the production candidate.

function resolveChunkURL(baseURL, relPath) {
  const base = String(baseURL).endsWith("/") ? String(baseURL) : `${baseURL}/`;
  return new URL(relPath, base).href;
}

async function fetchVerifiedChunk(baseURL, chunk) {
  const response = await fetch(resolveChunkURL(baseURL, chunk.path), { cache: "force-cache" });
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.byteLength !== chunk.size) {
    throw new Error(`chunk ${chunk.index} size mismatch`);
  }
  const digestError = self.__msmengineVerifyChunkBytes(raw, chunk.sha256, chunk.blake2b256);
  if (digestError) throw new Error(digestError);
  return raw;
}

async function fetchSectionPointBytes(plan, sectionName, lo, hi, g2) {
  const section = plan.sections && plan.sections[sectionName];
  if (!section) throw new Error(`section ${sectionName} not found in pk section plan`);

  const elementSize = g2 ? 192 : 96;
  const start = section.offset + lo * elementSize;
  const end = section.offset + hi * elementSize;
  const pointsRaw = new Uint8Array(end - start);
  const timings = { fetch_ms: 0, hash_ms: 0, slice_ms: 0 };
  const bytes = { fetched: 0, used: pointsRaw.byteLength };

  for (const chunk of plan.chunks || []) {
    const chunkStart = chunk.offset;
    const chunkEnd = chunk.offset + chunk.size;
    if (chunkEnd <= start || chunkStart >= end) continue;
    const raw = await fetchVerifiedChunk(plan.base_url, chunk);
    bytes.fetched += raw.byteLength;
    const useStart = Math.max(start, chunkStart);
    const useEnd = Math.min(end, chunkEnd);
    pointsRaw.set(raw.subarray(useStart - chunkStart, useEnd - chunkStart), useStart - start);
  }

  return { pointsRaw, timings, bytes };
}
