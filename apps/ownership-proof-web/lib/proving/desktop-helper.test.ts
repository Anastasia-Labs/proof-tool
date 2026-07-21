import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimDraftResponse } from "../claim/types";
import {
  DesktopHelperCancelledError,
  DESTINATION_PREFLIGHT_CAPABILITY,
  preflightDestinationViaHelper,
  proveDestinationViaHelper,
} from "./desktop-helper";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proveDestinationViaHelper", () => {
  it("preflights the exact proof endpoint without sending a secret", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ preflight_only: true });
      expect(init).toMatchObject({ method: "POST", targetAddressSpace: "loopback" });
      return {
        ok: true,
        async json() {
          return { ok: true, capability: DESTINATION_PREFLIGHT_CAPABILITY };
        },
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      preflightDestinationViaHelper({
        helperUrl: "http://127.0.0.1:3001/",
        helperToken: "test-token",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts the exact no-secret rejection returned by the published v0.2.1 helper", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ preflight_only: true });
      return new Response(
        JSON.stringify({
          code: "invalid_request",
          error: "The destination proof request was not valid JSON.",
        }),
        { status: 400 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      preflightDestinationViaHelper({
        helperUrl: "http://127.0.0.1:3001/",
        helperToken: "test-token",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects near-miss legacy responses instead of treating arbitrary failures as a preflight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "invalid_request",
              error: "The destination proof request was not valid.",
            }),
            { status: 400 },
          ),
      ),
    );

    await expect(
      preflightDestinationViaHelper({
        helperUrl: "http://127.0.0.1:3001/",
        helperToken: "test-token",
      }),
    ).rejects.toThrow("The destination proof request was not valid.");
  });

  it("requests one proof per distinct statement and expands exact artifacts back to draft order", async () => {
    let postedRequests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
        postedRequests = body.requests;
        return {
          ok: true,
          async json() {
            return {
              profile: "single-destination",
              artifacts: [
                { out_ref: "tx0#0", artifact: { cardano: { proof_hex: "aa" } } },
                { out_ref: "tx2#2", artifact: { cardano: { proof_hex: "bb" } } },
              ],
            };
          },
        } as Response;
      }),
    );
    const repeatedRequest = {
      target_credential: "11".repeat(28),
      destination_address_encoding: "destination-address-v1" as const,
      destination_address: "22".repeat(58),
    };
    const draft = {
      proofProfile: "single-destination",
      proofRequests: [
        { ...repeatedRequest, out_ref: "tx0#0" },
        { ...repeatedRequest, out_ref: "tx1#1" },
        { ...repeatedRequest, out_ref: "tx2#2", target_credential: "33".repeat(28) },
      ],
    } as ClaimDraftResponse;

    const response = await proveDestinationViaHelper({
      masterXPrv: new Uint8Array([1, 2, 3]),
      draft,
      helperUrl: "http://127.0.0.1:3001/",
      helperToken: "test-token",
    });

    expect(postedRequests).toHaveLength(2);
    expect(response.artifacts?.map((item) => item.out_ref)).toEqual(["tx0#0", "tx1#1", "tx2#2"]);
    expect(response.artifacts?.[1]?.artifact).toEqual(response.artifacts?.[0]?.artifact);
    expect(response.artifacts?.[2]?.artifact).not.toEqual(response.artifacts?.[0]?.artifact);
  });

  it("streams aggregate discovery and proving progress before the terminal result", async () => {
    const progress = vi.fn();
    const draft = destinationDraft();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Accept")).toBe("application/x-ndjson");
        const events = [
          {
            type: "progress",
            stage: "locating-keys",
            account: 3,
            role: 2,
            discovery: {
              candidates_scanned: 24,
              candidates_total: 30_000,
              candidates_per_second: 1_200,
              eta_seconds: 25,
              matched: 1,
              targets: 1,
            },
          },
          { type: "progress", stage: "prove", current: 1, total: 1 },
          {
            type: "result",
            result: {
              profile: "single-destination",
              artifacts: [{ out_ref: "tx0#0", artifact: { cardano: { proof_hex: "aa" } } }],
            },
          },
        ];
        return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
        });
      }),
    );

    const response = await proveDestinationViaHelper({
      masterXPrv: new Uint8Array([1, 2, 3]),
      draft,
      helperUrl: "http://127.0.0.1:3001/",
      helperToken: "test-token",
      onProgress: progress,
    });

    expect(response.artifacts).toHaveLength(1);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls[0]?.[0]).toEqual({
      provider: "desktop-helper",
      stage: "locating-keys",
      frac: 24 / 30_000,
      discovery: {
        candidatesScanned: 24,
        candidatesTotal: 30_000,
        candidatesPerSecond: 1_200,
        etaSeconds: 25,
        matched: 1,
        targets: 1,
      },
    });
    expect(progress.mock.calls[0]?.[0]).not.toHaveProperty("account");
    expect(progress.mock.calls[0]?.[0]).not.toHaveProperty("role");
    expect(progress.mock.calls[1]?.[0]).toMatchObject({
      provider: "desktop-helper",
      stage: "prove",
      current: 1,
      total: 1,
      frac: 1,
    });
  });

  it("aborts the loopback request and reports a typed cancellation", async () => {
    const controller = new AbortController();
    const draft = destinationDraft();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        });
      }),
    );

    const pending = proveDestinationViaHelper({
      masterXPrv: new Uint8Array([1, 2, 3]),
      draft,
      helperUrl: "http://127.0.0.1:3001/",
      helperToken: "test-token",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(DesktopHelperCancelledError);
  });
});

function destinationDraft(): ClaimDraftResponse {
  return {
    proofProfile: "single-destination",
    proofRequests: [
      {
        out_ref: "tx0#0",
        target_credential: "11".repeat(28),
        destination_address_encoding: "destination-address-v1",
        destination_address: "22".repeat(58),
      },
    ],
  } as ClaimDraftResponse;
}
