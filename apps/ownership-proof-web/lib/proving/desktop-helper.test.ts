import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimDraftResponse } from "../claim/types";
import {
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

    await expect(preflightDestinationViaHelper({
      helperUrl: "http://127.0.0.1:3001/",
      helperToken: "test-token",
    })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts the exact no-secret rejection returned by the published v0.2.1 helper", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ preflight_only: true });
      return new Response(JSON.stringify({
        code: "invalid_request",
        error: "The destination proof request was not valid JSON.",
      }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(preflightDestinationViaHelper({
      helperUrl: "http://127.0.0.1:3001/",
      helperToken: "test-token",
    })).resolves.toBeUndefined();
  });

  it("rejects near-miss legacy responses instead of treating arbitrary failures as a preflight", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "invalid_request",
      error: "The destination proof request was not valid.",
    }), { status: 400 })));

    await expect(preflightDestinationViaHelper({
      helperUrl: "http://127.0.0.1:3001/",
      helperToken: "test-token",
    })).rejects.toThrow("The destination proof request was not valid.");
  });

  it("requests one proof per distinct statement and expands exact artifacts back to draft order", async () => {
    let postedRequests: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
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
    }));
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
    expect(response.artifacts?.map((item) => item.out_ref)).toEqual([
      "tx0#0",
      "tx1#1",
      "tx2#2",
    ]);
    expect(response.artifacts?.[1]?.artifact).toEqual(response.artifacts?.[0]?.artifact);
    expect(response.artifacts?.[2]?.artifact).not.toEqual(response.artifacts?.[0]?.artifact);
  });
});
