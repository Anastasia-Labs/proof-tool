import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimDraftResponse } from "../claim/types";
import type { BrowserProvingDescriptor } from "../reclaim/types";
import {
  ProvingCancelledError,
  checkBrowserProving,
  disposePreparedBrowserProvingSession,
  proveDestinationInBrowser,
  resolveBrowserWorkerCount,
  sanitizeProverError,
} from "./browser-wasm";
import type { ProverWorkerLike, ProverWorkerResponse } from "./types";

const EXPECTED_VK_HASH =
  "blake2b256:6057da91b15dea8f8e93997f1b1944c35bc2c86faf9a9de17b814f6a172d430a";

// A scripted stand-in for public/proof-runtime/prover-worker.js. Each handler
// receives the posted request and returns the responses to emit (progress
// events plus a terminal reply). Every message it sees is recorded so tests can
// assert nothing secret is echoed back.
type WorkerScript = {
  init?: (message: Record<string, unknown>) => ProverWorkerResponse[];
  preflight?: (message: Record<string, unknown>) => ProverWorkerResponse[];
  prove?: (message: Record<string, unknown>) => ProverWorkerResponse[];
};

class FakeProverWorker implements ProverWorkerLike {
  readonly seen: Record<string, unknown>[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: never) => void>>();
  constructor(private readonly script: WorkerScript) {}

  postMessage(message: Record<string, unknown>): void {
    this.seen.push(message);
    const handler = this.script[message.type as keyof WorkerScript];
    const responses: ProverWorkerResponse[] = handler
      ? handler(message)
      : [{ id: message.id as string, type: "error", message: "unhandled" }];
    queueMicrotask(() => {
      for (const response of responses) {
        this.dispatch({
          ...response,
          id: response.id || (message.id as string),
        } as ProverWorkerResponse);
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ProverWorkerResponse>) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(
    type: "message" | "error",
    listener: (event: never) => void,
  ): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<ProverWorkerResponse>) => void,
  ): void;
  removeEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener(
    type: "message" | "error",
    listener: (event: never) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(response: ProverWorkerResponse): void {
    for (const listener of this.listeners.get("message") ?? []) {
      (listener as (event: MessageEvent<ProverWorkerResponse>) => void)({
        data: response,
      } as MessageEvent<ProverWorkerResponse>);
    }
  }
}

function descriptor(
  overrides: Partial<BrowserProvingDescriptor> = {},
): BrowserProvingDescriptor {
  return {
    enabled: true,
    runtime_base_url: "/proof-runtime",
    manifest_url: "/proof-assets/manifest.json",
    manifest_sig_url: "/proof-assets/manifest.sig",
    manifest_public_key_hex: "aa".repeat(32),
    chunk_manifest_url: "/proof-assets/chunk-manifest.json",
    chunk_manifest_sig_url: "/proof-assets/chunk-manifest.sig",
    chunk_manifest_public_key_hex: "bb".repeat(32),
    deployment_manifest_url: "/proof-assets/reclaim-deployment.json",
    vk_url: "/proof-assets/ownership.vk",
    pk_url: "https://assets.example.com/ownership.pk",
    pk_index_url: "/proof-assets/ownership.pk.idx.json",
    ccs_url: "https://assets.example.com/ownership.ccs",
    ccs_blake2b256: "blake2b256:" + "cc".repeat(32),
    proof_wasm_url: "/proof-runtime/proof-destination.wasm",
    worker_js_url: "/proof-runtime/msm-worker.js",
    msm_worker_wasm_url: "/proof-runtime/msmworker.wasm",
    ...overrides,
  };
}

function draftWith(requestCount: number): ClaimDraftResponse {
  const proofRequests = Array.from({ length: requestCount }, (_, index) => ({
    out_ref: `txhash${index}#${index}`,
    target_credential: `${index}`.repeat(56).slice(0, 56),
    destination_address_encoding: "destination-address-v1" as const,
    destination_address: "de".repeat(58),
  }));
  return {
    draftId: "draft-1",
    deploymentId: "preprod:deadbeef",
    network: "Preprod",
    networkId: 0,
    proofProfile: "single-destination",
    batchCap: { requested: requestCount, default: 4, hardMax: 5 },
    orderedInputs: proofRequests.map((r) => ({
      outRef: { txHash: r.out_ref.split("#")[0], outputIndex: 0 },
      outRefId: r.out_ref,
      value: {},
      paymentCredential: r.target_credential,
      datumCbor: "00",
      confirmation: { slot: 1 },
    })),
    orderedPaymentCredentials: proofRequests.map((r) => r.target_credential),
    destinationOutputs: [],
    proofRequests,
    expectedDestinationOutputStartIndex: 0,
    safeWallet: {
      changeAddress: "addr_test1safe",
      addresses: ["addr_test1safe"],
      totalLovelace: "0",
      minimumRequiredLovelace: "0",
      utxoCount: 0,
    },
    reductions: [],
    buildSupported: true,
  };
}

function readyPreflight(vkHash = EXPECTED_VK_HASH): ProverWorkerResponse[] {
  return [
    { id: "", type: "preflight-result", result: { ok: true, vk_hash: vkHash } },
  ];
}

function proveArtifact(): Record<string, unknown> {
  return {
    schema: "root-ownership-proof-artifact-v1",
    vk_hash: EXPECTED_VK_HASH,
  };
}

const masterXPrv = new Uint8Array(96).fill(7);

describe("W5 host-gated worker count", () => {
  const adaptive = descriptor({ tuning: { opt_w5: true } });

  it.each([
    [32, 8, 16],
    [18, 8, 16],
    [17, 8, 15],
    [12, 8, 10],
    [10, 8, 8],
    [4, 8, 8],
    [32, 4, 8],
  ])(
    "maps hardwareConcurrency=%i deviceMemory=%i to %i workers",
    (hardwareConcurrency, deviceMemoryGiB, expected) => {
      expect(
        resolveBrowserWorkerCount(adaptive, {
          hardwareConcurrency,
          deviceMemoryGiB,
        }),
      ).toBe(expected);
    },
  );

  it("keeps the safe floor when either host signal is absent", () => {
    expect(
      resolveBrowserWorkerCount(adaptive, {
        hardwareConcurrency: null,
        deviceMemoryGiB: 8,
      }),
    ).toBe(8);
    // Firefox never reports deviceMemory; unknown memory must not unlock
    // 12-16 workers on a host that may only have 4-8 GiB.
    expect(
      resolveBrowserWorkerCount(adaptive, {
        hardwareConcurrency: 32,
        deviceMemoryGiB: null,
      }),
    ).toBe(8);
  });

  it("preserves explicit tuning and legacy descriptors", () => {
    expect(
      resolveBrowserWorkerCount(
        descriptor({ tuning: { worker_count: 12, opt_w5: true } }),
        { hardwareConcurrency: 32, deviceMemoryGiB: 8 },
      ),
    ).toBe(12);
    expect(
      resolveBrowserWorkerCount(descriptor({ tuning: { worker_count: 8 } }), {
        hardwareConcurrency: 32,
        deviceMemoryGiB: 8,
      }),
    ).toBe(8);
    expect(
      resolveBrowserWorkerCount(descriptor(), {
        hardwareConcurrency: 32,
        deviceMemoryGiB: 8,
      }),
    ).toBe(8);
  });

  it("caps raw explicit tuning at the advertised 16-worker maximum", () => {
    const host = { hardwareConcurrency: 32, deviceMemoryGiB: 8 };
    expect(
      resolveBrowserWorkerCount(
        descriptor({ tuning: { worker_count: 17, opt_w5: true } }),
        host,
      ),
    ).toBe(16);
    expect(
      resolveBrowserWorkerCount(
        descriptor({ tuning: { worker_count: 16, opt_w5: true } }),
        host,
      ),
    ).toBe(16);
  });
});

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { origin: "https://claim.example.com" },
  });
});

afterEach(() => {
  disposePreparedBrowserProvingSession();
  vi.unstubAllGlobals();
});

describe("proveDestinationInBrowser", () => {
  it("proves every request sequentially and normalizes to the helper response shape", async () => {
    let proveCalls = 0;
    const worker = new FakeProverWorker({
      init: (m) => [{ id: m.id as string, type: "ready" }],
      preflight: (m) => [
        {
          id: m.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: EXPECTED_VK_HASH },
        },
      ],
      prove: (m) => {
        proveCalls += 1;
        return [
          { id: m.id as string, type: "progress", stage: "prove", frac: 0.5 },
          {
            id: m.id as string,
            type: "prove-result",
            result: {
              verified_locally: true,
              artifact: proveArtifact(),
              engine: "streampk-sharded-groth16",
            },
          },
        ];
      },
    });
    const progress: string[] = [];
    const response = await proveDestinationInBrowser(
      {
        masterXPrv,
        draft: draftWith(3),
        expectedVkHash: EXPECTED_VK_HASH,
        browserProving: descriptor(),
        onProgress: (event) =>
          progress.push(`${event.current}/${event.total}:${event.stage}`),
      },
      { createWorker: () => worker },
    );

    expect(proveCalls).toBe(3);
    expect(response.profile).toBe("single-destination");
    expect(response.artifacts).toHaveLength(3);
    expect(response.artifacts?.[0]?.out_ref).toBe("txhash0#0");
    expect(progress).toContain("1/3:prove");
    expect(progress).toContain("3/3:prove");
    const defaultRequest = worker.seen.find((item) => item.type === "preflight") as {
      requestJson: string;
    };
    expect(JSON.parse(defaultRequest.requestJson).tuning).toMatchObject({
      worker_count: 8,
      shard_count: 8,
      range_fetch_concurrency: 2,
      pinned_decode: true,
      opt_w1: true,
      opt_w2: true,
      opt_w3: true,
      opt_w5: true,
      opt_w6: true,
      opt_w7: true,
    });
    expect(worker.terminated).toBe(true);
  });

  it("proves an identical credential and destination statement once and reuses exact artifact bytes", async () => {
    let proveCalls = 0;
    const draft = draftWith(3);
    draft.proofRequests = draft.proofRequests.map((request) => ({
      ...request,
      target_credential: "ab".repeat(28),
    }));
    const worker = new FakeProverWorker({
      init: (m) => [{ id: m.id as string, type: "ready" }],
      preflight: (m) => [
        {
          id: m.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: EXPECTED_VK_HASH },
        },
      ],
      prove: (m) => {
        proveCalls += 1;
        return [
          {
            id: m.id as string,
            type: "prove-result",
            result: {
              verified_locally: true,
              artifact: proveArtifact(),
            },
          },
        ];
      },
    });
    const progress: string[] = [];
    const response = await proveDestinationInBrowser(
      {
        masterXPrv,
        draft,
        expectedVkHash: EXPECTED_VK_HASH,
        browserProving: descriptor(),
        onProgress: (event) => progress.push(`${event.current}/${event.total}:${event.stage}`),
      },
      { createWorker: () => worker },
    );

    expect(proveCalls).toBe(1);
    expect(response.artifacts?.map((item) => item.out_ref)).toEqual([
      "txhash0#0",
      "txhash1#1",
      "txhash2#2",
    ]);
    expect(response.artifacts?.[1]?.artifact).toEqual(response.artifacts?.[0]?.artifact);
    expect(progress).toContain("2/3:reuse-proof");
    expect(progress).toContain("3/3:reuse-proof");
  });

  it("passes master_xprv_hex to the worker but never surfaces it in progress events", async () => {
    const progressEvents: unknown[] = [];
    const worker = new FakeProverWorker({
      init: (m) => [{ id: m.id as string, type: "ready" }],
      preflight: (m) => [
        {
          id: m.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: EXPECTED_VK_HASH },
        },
      ],
      prove: (m) => [
        {
          id: m.id as string,
          type: "progress",
          stage: "prove 50.0%",
          frac: 0.5,
        },
        {
          id: m.id as string,
          type: "prove-result",
          result: { verified_locally: true, artifact: proveArtifact() },
        },
      ],
    });
    await proveDestinationInBrowser(
      {
        masterXPrv,
        draft: draftWith(1),
        expectedVkHash: EXPECTED_VK_HASH,
        browserProving: descriptor(),
        onProgress: (event) => progressEvents.push(event),
      },
      { createWorker: () => worker },
    );

    // The prove message carries the hex; the serialized progress stream must not.
    const proveMessage = worker.seen.find((m) => m.type === "prove");
    expect(
      String((proveMessage as { requestJson: string }).requestJson),
    ).toContain("master_xprv_hex");
    const serializedProgress = JSON.stringify(progressEvents);
    expect(serializedProgress).not.toContain("master_xprv");
    expect(serializedProgress).not.toMatch(/[0-9a-f]{32,}/u);
  });

  it("sends acknowledged W1/W2/W3/W5/W6/W7 options to both preflight and prove", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 32, deviceMemory: 8 });
    const worker = new FakeProverWorker({
      init: (m) => [{ id: m.id as string, type: "ready" }],
      preflight: (m) => [
        {
          id: m.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: EXPECTED_VK_HASH },
        },
      ],
      prove: (m) => [
        {
          id: m.id as string,
          type: "prove-result",
          result: { verified_locally: true, artifact: proveArtifact() },
        },
      ],
    });
    await proveDestinationInBrowser(
      {
        masterXPrv,
        draft: draftWith(1),
        expectedVkHash: EXPECTED_VK_HASH,
        browserProving: descriptor({
          tuning: { opt_w1: true, opt_w2: true, opt_w3: true, opt_w5: true, opt_w6: true, opt_w7: true },
        }),
      },
      { createWorker: () => worker },
    );

    for (const type of ["preflight", "prove"]) {
      const message = worker.seen.find((item) => item.type === type) as {
        requestJson: string;
      };
      expect(JSON.parse(message.requestJson).tuning.opt_w1).toBe(true);
      expect(JSON.parse(message.requestJson).tuning.opt_w2).toBe(true);
      expect(JSON.parse(message.requestJson).tuning.opt_w3).toBe(true);
      expect(JSON.parse(message.requestJson).tuning.opt_w5).toBe(true);
      expect(JSON.parse(message.requestJson).tuning.opt_w6).toBe(true);
      expect(JSON.parse(message.requestJson).tuning.opt_w7).toBe(true);
      expect(JSON.parse(message.requestJson).tuning.worker_count).toBe(16);
      expect(JSON.parse(message.requestJson).tuning.shard_count).toBe(16);
    }
  });

  it.each([
    {
      name: "small adaptive host",
      tuning: { shard_count: 8, opt_w5: true },
      host: { hardwareConcurrency: 4, deviceMemory: 8 },
      expected: { worker_count: 8, shard_count: 8 },
    },
    {
      name: "adaptive host without a deviceMemory signal",
      tuning: { shard_count: 8, opt_w5: true },
      host: { hardwareConcurrency: 32 },
      expected: { worker_count: 8, shard_count: 8 },
    },
    {
      name: "explicit worker pool above configured shards",
      tuning: { worker_count: 12, shard_count: 8, opt_w5: true },
      host: { hardwareConcurrency: 32, deviceMemory: 8 },
      expected: { worker_count: 12, shard_count: 12 },
    },
  ])("applies worker/shard floor for $name", async ({ tuning, host, expected }) => {
    vi.stubGlobal("navigator", host);
    const worker = new FakeProverWorker({
      init: (message) => [{ id: message.id as string, type: "ready" }],
      preflight: (message) => [
        {
          id: message.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: EXPECTED_VK_HASH },
        },
      ],
      prove: (message) => [
        {
          id: message.id as string,
          type: "prove-result",
          result: { verified_locally: true, artifact: proveArtifact() },
        },
      ],
    });

    await expect(
      proveDestinationInBrowser(
        {
          masterXPrv,
          draft: draftWith(1),
          expectedVkHash: EXPECTED_VK_HASH,
          browserProving: descriptor({ tuning }),
        },
        { createWorker: () => worker },
      ),
    ).resolves.toMatchObject({
      profile: "single-destination",
    });

    const message = worker.seen.find((item) => item.type === "preflight") as {
      requestJson: string;
    };
    expect(JSON.parse(message.requestJson).tuning).toMatchObject(expected);
  });

  it("rejects when a proof is not verified locally", async () => {
    const worker = new FakeProverWorker({
      init: (m) => [{ id: m.id as string, type: "ready" }],
      preflight: (m) => [
        {
          id: m.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: EXPECTED_VK_HASH },
        },
      ],
      prove: (m) => [
        {
          id: m.id as string,
          type: "prove-result",
          result: { verified_locally: false, artifact: proveArtifact() },
        },
      ],
    });
    await expect(
      proveDestinationInBrowser(
        {
          masterXPrv,
          draft: draftWith(1),
          expectedVkHash: EXPECTED_VK_HASH,
          browserProving: descriptor(),
        },
        { createWorker: () => worker },
      ),
    ).rejects.toThrow(/verify/i);
    expect(worker.terminated).toBe(true);
  });

  it("rejects when the preflight vk_hash does not match the deployment", async () => {
    const worker = new FakeProverWorker({
      init: (m) => [{ id: m.id as string, type: "ready" }],
      preflight: (m) => [
        {
          id: m.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: "blake2b256:" + "00".repeat(32) },
        },
      ],
    });
    await expect(
      proveDestinationInBrowser(
        {
          masterXPrv,
          draft: draftWith(1),
          expectedVkHash: EXPECTED_VK_HASH,
          browserProving: descriptor(),
        },
        { createWorker: () => worker },
      ),
    ).rejects.toThrow(/verifier key/i);
  });

  it("throws when the descriptor is disabled", async () => {
    await expect(
      proveDestinationInBrowser(
        {
          masterXPrv,
          draft: draftWith(1),
          expectedVkHash: EXPECTED_VK_HASH,
          browserProving: descriptor({ enabled: false }),
        },
        { createWorker: () => new FakeProverWorker({}) },
      ),
    ).rejects.toThrow(/not enabled/i);
  });

  it("terminates the worker and raises ProvingCancelledError on abort during proving", async () => {
    const controller = new AbortController();
    const worker = new FakeProverWorker({
      init: (m) => [{ id: m.id as string, type: "ready" }],
      preflight: (m) => [
        {
          id: m.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: EXPECTED_VK_HASH },
        },
      ],
      // Never resolves prove — the abort must be what ends it.
      prove: () => [],
    });
    const promise = proveDestinationInBrowser(
      {
        masterXPrv,
        draft: draftWith(2),
        expectedVkHash: EXPECTED_VK_HASH,
        browserProving: descriptor(),
        signal: controller.signal,
      },
      { createWorker: () => worker },
    );
    // Once the worker has seen a prove request, preparation is over and the
    // abort listener is armed — this abort exercises the in-proof path.
    await vi.waitFor(() =>
      expect(worker.seen.some((m) => m.type === "prove")).toBe(true),
    );
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ProvingCancelledError);
    expect(worker.terminated).toBe(true);
  });

  it("cancel during session preparation rejects promptly and parks the worker for reuse", async () => {
    const controller = new AbortController();
    const worker = new FakeProverWorker({
      init: (m) => [{ id: m.id as string, type: "ready" }],
      preflight: (m) => [
        {
          id: m.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: EXPECTED_VK_HASH },
        },
      ],
      prove: () => [],
    });
    const promise = proveDestinationInBrowser(
      {
        masterXPrv,
        draft: draftWith(2),
        expectedVkHash: EXPECTED_VK_HASH,
        browserProving: descriptor(),
        signal: controller.signal,
      },
      { createWorker: () => worker },
    );
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ProvingCancelledError);
    // The abandoned preparation finishes in the background and parks itself
    // as the prepared session (reclaimed by the expiry timer); explicit
    // disposal must reach the worker.
    await vi.waitFor(() => {
      disposePreparedBrowserProvingSession();
      expect(worker.terminated).toBe(true);
    });
  });

  it("sanitizes worker error messages that contain long hex", async () => {
    const worker = new FakeProverWorker({
      init: (m) => [{ id: m.id as string, type: "ready" }],
      preflight: (m) => [
        {
          id: m.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: EXPECTED_VK_HASH },
        },
      ],
      prove: (m) => [
        {
          id: m.id as string,
          type: "error",
          message: `boom for ${"ab".repeat(48)}`,
        },
      ],
    });
    await expect(
      proveDestinationInBrowser(
        {
          masterXPrv,
          draft: draftWith(1),
          expectedVkHash: EXPECTED_VK_HASH,
          browserProving: descriptor(),
        },
        { createWorker: () => worker },
      ),
    ).rejects.toThrow(/\[redacted\]/);
  });
});

describe("prepared browser prover session", () => {
  it("reuses readiness preflight for the proof flow", async () => {
    stubCapableEnvironment();
    let initCalls = 0;
    let preflightCalls = 0;
    let proveCalls = 0;
    const worker = new FakeProverWorker({
      init: (message) => {
        initCalls += 1;
        return [{ id: message.id as string, type: "ready" }];
      },
      preflight: (message) => {
        preflightCalls += 1;
        return readyPreflight().map((response) => ({
          ...response,
          id: message.id as string,
        }));
      },
      prove: (message) => {
        proveCalls += 1;
        return [{
          id: message.id as string,
          type: "prove-result",
          result: { verified_locally: true, artifact: proveArtifact() },
        }];
      },
    });
    const provingDescriptor = descriptor();
    const options = { createWorker: () => worker };
    await expect(
      checkBrowserProving(provingDescriptor, EXPECTED_VK_HASH, options),
    ).resolves.toMatchObject({ status: "ready" });
    expect(worker.terminated).toBe(false);
    await expect(
      proveDestinationInBrowser(
        {
          masterXPrv,
          draft: draftWith(1),
          expectedVkHash: EXPECTED_VK_HASH,
          browserProving: provingDescriptor,
        },
        options,
      ),
    ).resolves.toMatchObject({ profile: "single-destination" });
    expect({ initCalls, preflightCalls, proveCalls }).toEqual({
      initCalls: 1,
      preflightCalls: 1,
      proveCalls: 1,
    });
    expect(worker.terminated).toBe(true);
  });
});

describe("checkBrowserProving asset preflight", () => {
  it("reports asset-error when the preflight vk_hash mismatches", async () => {
    // Force the capability gate to pass so the asset preflight is reached.
    stubCapableEnvironment();
    const worker = new FakeProverWorker({
      init: (m) => [{ id: m.id as string, type: "ready" }],
      preflight: (m) => [
        {
          id: m.id as string,
          type: "preflight-result",
          result: { ok: true, vk_hash: "blake2b256:" + "11".repeat(32) },
        },
      ],
    });
    const result = await checkBrowserProving(descriptor(), EXPECTED_VK_HASH, {
      createWorker: () => worker,
    });
    expect(result.status).toBe("asset-error");
    expect(result.capability.failures.some((f) => f.check === "vk-hash")).toBe(
      true,
    );
  });

  it("returns unsupported without touching the worker when the descriptor is disabled", async () => {
    let created = false;
    const result = await checkBrowserProving(
      descriptor({ enabled: false }),
      EXPECTED_VK_HASH,
      {
        createWorker: () => {
          created = true;
          return new FakeProverWorker({});
        },
      },
    );
    expect(result.status).toBe("unsupported");
    expect(created).toBe(false);
  });
});

describe("sanitizeProverError", () => {
  it("redacts long hex runs and keeps short text", () => {
    expect(sanitizeProverError(new Error(`fail ${"ff".repeat(40)}`))).toBe(
      "fail [redacted]",
    );
    expect(sanitizeProverError("short message")).toBe("short message");
    expect(sanitizeProverError(undefined)).toBe("Browser proving failed.");
  });
});

function stubCapableEnvironment(): void {
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("WebAssembly", {
    instantiateStreaming: () => Promise.resolve(),
  } as unknown as typeof WebAssembly);
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal("fetch", () => Promise.resolve());
  vi.stubGlobal(
    "SharedArrayBuffer",
    class {
      byteLength = 8;
      constructor() {}
    },
  );
  vi.stubGlobal("navigator", { hardwareConcurrency: 8, deviceMemory: 16 });
  // Nested-worker probe uses URL.createObjectURL + Worker; short-circuit it by
  // making the probe worker post a success message synchronously.
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:probe",
      revokeObjectURL: () => {},
    }),
  );
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor() {
        queueMicrotask(() =>
          this.onmessage?.({ data: { ok: true, isolated: true } }),
        );
      }
      postMessage(): void {}
      terminate(): void {}
    },
  );
}
