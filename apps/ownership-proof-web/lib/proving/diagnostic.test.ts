import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserProvingDiagnosticCollector,
  clearBrowserProvingDiagnosticForTest,
  getLastBrowserProvingDiagnostic,
} from "./diagnostic";

afterEach(() => clearBrowserProvingDiagnosticForTest());

describe("browser proving diagnostic", () => {
  it("keeps only allowlisted timings and counters", () => {
    const collector = new BrowserProvingDiagnosticCollector({
      hardwareConcurrency: 16,
      deviceMemoryGiB: null,
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      wasmStreaming: true,
      online: true,
      calibration: {
        attemptedWorkerCounts: [8, 12, 16],
        appliedWorkerCount: 16,
        durationMs: 12,
        reason: "calibration-passed",
      },
    });
    collector.recordInitialization(101.25);
    collector.recordPreflight(202.5, {
      ok: true,
      applied_tuning: {
        worker_count: 16,
        shard_count: 16,
        range_fetch_concurrency: 2,
        chunk_prefetch_window: 2,
      },
      timings: {
        ccs_fetch_ms: 11,
        ccs_decode_ms: 22,
        ccs_hash_ms: 3,
        ccs_bytes_fetched: 4096,
        ccs_browser_prefetch_ms: 9,
        ccs_browser_prefetch_bytes: 4096,
      },
    });
    collector.recordPreparedSessionReuse(55);
    collector.addProof({
      wall_seconds: 1.5,
      verified_locally: true,
      trace: {
        worker_count: 16,
        shard_count: 16,
        range_fetch_concurrency: 2,
        chunk_prefetch_window: 2,
        master_xprv_hex: "sensitive-value",
        credential_path: "sensitive-path",
        events: [
          { phase: "start", stage: "solver", at_ms: 10 },
          { phase: "end", stage: "solver", at_ms: 30 },
          { phase: "start", stage: "computeH / FFT", at_ms: 31 },
          { phase: "end", stage: "computeH / FFT", at_ms: 71 },
          { phase: "start", stage: "verify", at_ms: 72 },
          { phase: "end", stage: "verify", at_ms: 80 },
          {
            phase: "measure",
            stage: "shard",
            at_ms: 50,
            fields: {
              worker_id: 3,
              fetch_requests: 2,
              cache_hits: 1,
              cache_misses: 1,
              range_bytes_fetched: 2097152,
              range_bytes_cache_hit: 2097152,
              range_bytes_used: 3000000,
              fetch_ms: 4,
              hash_ms: 2,
              decode_ms: 6,
              kernel_ms: 8,
              queue_wait_ms: 1,
              scalar_bytes: 1234,
            },
          },
        ],
      },
    });

    const result = collector.finish();
    expect(result.lifecycle).toMatchObject({
      initialization_ms: 101.25,
      preflight_ms: 202.5,
      prepared_session_reused: true,
      proof_count: 1,
      proof_wall_ms: 1500,
    });
    expect(result.ccs).toMatchObject({
      fetch_ms: 11,
      decode_ms: 22,
      hash_ms: 3,
      bytes_fetched: 4096,
    });
    expect(result.workers).toEqual([
      expect.objectContaining({
        worker_id: 3,
        requests: 2,
        cache_hits: 1,
        cache_misses: 1,
        bytes_fetched: 2097152,
        bytes_from_cache: 2097152,
        fetch_ms: 4,
        hash_ms: 2,
        decode_ms: 6,
        kernel_ms: 8,
        queue_ms: 1,
      }),
    ]);
    expect(result.stages).toEqual({
      solve_ms: 20,
      compute_h_fft_ms: 40,
      verification_ms: 8,
    });
    const encoded = JSON.stringify(result).toLowerCase();
    expect(encoded).not.toContain("sensitive-value");
    expect(encoded).not.toContain("sensitive-path");
    expect(encoded).not.toContain("master_xprv");
    expect(encoded).not.toContain("credential_path");
    expect(encoded).not.toContain("scalar");
    expect(getLastBrowserProvingDiagnostic()).toEqual(result);
  });
});
